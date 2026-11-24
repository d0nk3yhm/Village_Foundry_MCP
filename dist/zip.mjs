/**
 * Small, dependency-free ZIP32 writer for generated browser assets.
 * Files use STORE (no compression), UTF-8 names and a deterministic timestamp.
 * Blob contents are read in chunks for CRC calculation and reused in the ZIP.
 */

const encoder = new TextEncoder();
const ZIP32_SENTINEL = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const CRC_CHUNK_SIZE = 1024 * 1024;
const UTF8_FLAG = 0x0800;
const DOS_DATE = 33; // 1980-01-01; a legal, deterministic DOS timestamp.

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  crcTable[n] = value >>> 0;
}

async function crc32(blob) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += CRC_CHUNK_SIZE) {
    const bytes = new Uint8Array(
      await blob.slice(offset, offset + CRC_CHUNK_SIZE).arrayBuffer(),
    );
    for (let index = 0; index < bytes.length; index += 1) {
      crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checkZip32Size(size, label) {
  // 0xffffffff is reserved for a ZIP64 extended size/offset.
  if (!Number.isSafeInteger(size) || size < 0 || size >= ZIP32_SENTINEL) {
    throw new RangeError(`${label} exceeds the ZIP32 limit; archives of 4 GiB or larger require ZIP64.`);
  }
}

function archiveName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Each ZIP entry needs a non-empty string name.");
  }
  const normalized = name.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`ZIP entry names must be safe relative file paths: ${JSON.stringify(name)}`);
  }
  const bytes = encoder.encode(normalized);
  if (bytes.length > 0xffff) {
    throw new RangeError("A ZIP entry name exceeds 65,535 UTF-8 bytes.");
  }
  return { name: normalized, bytes };
}

function localHeader(entry, crc) {
  const bytes = new Uint8Array(30 + entry.nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // Version needed: 2.0.
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, 0, true); // STORE.
  view.setUint16(10, 0, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, entry.blob.size, true);
  view.setUint32(22, entry.blob.size, true);
  view.setUint16(26, entry.nameBytes.length, true);
  view.setUint16(28, 0, true);
  bytes.set(entry.nameBytes, 30);
  return bytes;
}

function centralHeader(entry, crc) {
  const bytes = new Uint8Array(46 + entry.nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true); // Made by ZIP 2.0, DOS attributes.
  view.setUint16(6, 20, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, entry.blob.size, true);
  view.setUint32(24, entry.blob.size, true);
  view.setUint16(28, entry.nameBytes.length, true);
  // Extra/comment lengths, disk number and attributes remain zero.
  view.setUint32(42, entry.offset, true);
  bytes.set(entry.nameBytes, 46);
  return bytes;
}

/**
 * Build a ZIP Blob from [{ name, blob }]. Names may contain relative folders.
 * Rejects duplicate names, unsafe paths and values requiring ZIP64.
 * An empty entries array creates a valid empty ZIP archive.
 *
 * @param {{name: string, blob: Blob}[]} entries
 * @returns {Promise<Blob>}
 */
export async function zipBlobs(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("zipBlobs expects an array of { name, blob } entries.");
  }
  if (entries.length > MAX_ENTRIES) {
    throw new RangeError("ZIP32 supports at most 65,535 entries; ZIP64 is not supported.");
  }

  const names = new Set();
  const prepared = [];
  let localSize = 0;
  let centralSize = 0;

  // Validate the entire archive before reading potentially large Blobs.
  for (const entry of entries) {
    if (!entry || !(entry.blob instanceof Blob)) {
      throw new TypeError("Every ZIP entry must contain a Blob (or File).");
    }
    const { name, bytes } = archiveName(entry.name);
    if (names.has(name)) {
      throw new TypeError(`Duplicate ZIP entry name: ${JSON.stringify(name)}`);
    }
    names.add(name);
    checkZip32Size(entry.blob.size, `File ${JSON.stringify(name)}`);
    prepared.push({ nameBytes: bytes, blob: entry.blob, offset: localSize });
    localSize += 30 + bytes.length + entry.blob.size;
    centralSize += 46 + bytes.length;
    checkZip32Size(localSize + centralSize + 22, "Archive");
  }

  const localParts = [];
  const centralParts = [];
  for (const entry of prepared) {
    const crc = await crc32(entry.blob);
    localParts.push(localHeader(entry, crc), entry.blob);
    centralParts.push(centralHeader(entry, crc));
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, prepared.length, true);
  endView.setUint16(10, prepared.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localSize, true);
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function truncateUtf8(value, byteLimit) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const length = encoder.encode(character).length;
    if (bytes + length > byteLimit) break;
    result += character;
    bytes += length;
  }
  return result;
}

/**
 * Sanitize a basename and reserve a case-insensitively unique name in usedSet.
 * Preserves a short extension and adds " (2)", " (3)", etc. for collisions.
 * Result is at most 240 UTF-8 bytes and uses portable filename characters.
 */
export function uniqueFilename(name, usedSet = new Set()) {
  if (!(usedSet instanceof Set)) {
    throw new TypeError("uniqueFilename expects a Set as its second argument.");
  }
  const original = String(name ?? "").replace(/\\/g, "/").split("/").pop();
  let clean = original.normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!clean || clean === "." || clean === "..") clean = "asset";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `_${clean}`;

  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 ? truncateUtf8(clean.slice(dot), 32) : "";
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const occupied = new Set([...usedSet].map((value) => String(value).normalize("NFC").toLowerCase()));
  let counter = 1;
  let candidate;
  do {
    const suffix = counter === 1 ? "" : ` (${counter})`;
    const budget = 240 - encoder.encode(extension + suffix).length;
    candidate = truncateUtf8(stem, budget) + suffix + extension;
    counter += 1;
  } while (occupied.has(candidate.toLowerCase()));
  usedSet.add(candidate);
  return candidate;
}
