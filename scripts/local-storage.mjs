/** Disk-backed subset of R2 used by the shared scene Worker. Node built-ins only. */
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {homedir, platform} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';

const queues = new Map();
const missing = error => error?.code === 'ENOENT';

export function defaultDataDirectory(env = process.env, os = platform(), home = homedir()) {
  if (env.VILLAGE_FOUNDRY_DATA_DIR) return resolve(env.VILLAGE_FOUNDRY_DATA_DIR);
  if (os === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'VillageFoundry');
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'VillageFoundry');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'village-foundry');
}

async function serial(key, action) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

/** One server owns a data directory. A stale PID lock is recoverable after a crash. */
export async function acquireDataDirectory(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const path = join(directory, 'server.lock'), token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({pid: process.pid, token, startedAt: new Date().toISOString()}));
      await handle.sync(); await handle.close();
      return async () => {
        try { const lock = JSON.parse(await readFile(path, 'utf8')); if (lock.token === token) await unlink(path); }
        catch (error) { if (!missing(error)) throw error; }
      };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); }
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try { lock = JSON.parse(await readFile(path, 'utf8')); }
      catch (readError) {
        if (missing(readError)) continue;
        throw new Error(`Cannot read the local storage lock at ${path}. If no Village Foundry server is running, remove this lock file and retry.`);
      }
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error(`Invalid local storage lock at ${path}.`);
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (killError) { if (killError.code === 'ESRCH') alive = false; }
      if (alive) throw new Error(`Another Village Foundry server is using ${directory} (process ${lock.pid}). Stop it or select a different --data-dir.`);
      // Recheck ownership before removing a stale lock another launch may have replaced.
      try { const current = JSON.parse(await readFile(path, 'utf8')); if (current.token === lock.token) await unlink(path); }
      catch (readError) { if (!missing(readError)) throw readError; }
    }
  }
  throw new Error('The local data directory is being opened by another process. Retry shortly.');
}

export class LocalBucket {
  constructor(directory) { this.directory = resolve(directory, 'objects'); }
  async init() { await mkdir(this.directory, {recursive: true, mode: 0o700}); return this; }
  path(key) {
    if (typeof key !== 'string' || !key || key.length > 2048) throw new TypeError('Storage keys must be nonempty strings of at most 2048 characters.');
    return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }
  async record(key) {
    try {
      const value = JSON.parse(await readFile(this.path(key), 'utf8'));
      if (value.key !== key || typeof value.etag !== 'string' || typeof value.data !== 'string') throw new Error('Invalid local object record.');
      return value;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async get(key) {
    const value = await this.record(key); if (!value) return null;
    const data = Buffer.from(value.data, 'base64');
    return {key, etag: value.etag, httpEtag: `"${value.etag}"`, size: data.byteLength,
      httpMetadata: {...value.httpMetadata}, customMetadata: {...value.customMetadata},
      body: new Response(data).body,
      json: async () => JSON.parse(data.toString('utf8')), text: async () => data.toString('utf8'),
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)};
  }
  async put(key, value, options = {}) {
    const path = this.path(key);
    return serial(path, async () => {
      const current = await this.record(key), condition = options.onlyIf || {};
      if (condition.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
      if (condition.etagDoesNotMatch === '*' && current) return null;
      if (condition.etagDoesNotMatch !== undefined && condition.etagDoesNotMatch !== '*' && current?.etag === condition.etagDoesNotMatch) return null;
      const bytes = typeof value === 'string' ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(await new Response(value).arrayBuffer());
      const entry = {key, etag: randomUUID(), httpMetadata: {...options.httpMetadata}, customMetadata: {...options.customMetadata}, data: bytes.toString('base64')};
      const temporary = `${path}.${randomUUID()}.tmp`; let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(entry)); await handle.sync(); await handle.close(); handle = null;
        // Body and metadata commit together, so a restart cannot pair mismatched files.
        await rename(temporary, path);
      } finally { if (handle) await handle.close().catch(() => {}); await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
      return {key, etag: entry.etag, httpEtag: `"${entry.etag}"`, size: bytes.byteLength};
    });
  }
}
