import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import worker from '../src/worker.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const encode = new TextEncoder();
const decode = new TextDecoder();
const ORIGIN = 'https://house-foundry.example';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64'));
// A real 16 × 8 RGBA PNG: eight 2-pixel columns and four 2-pixel rows.
const SHEET_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAjSURBVCiRY2CgEDAyMDAwzMlx+k+O5pQp+xiZKHXBqAFUAACwSQQMnDXlYwAAAABJRU5ErkJggg==', 'base64'));

// Produce real small-height PNGs for wide-sheet acceptance. Rejected size
// probes need only their IHDR, avoiding huge allocations for invalid images.
function rgbaPng(width, height, headerOnly = false) {
  function chunk(type, content) {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(content.length); let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, content])) {
      crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, name, content, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  if (!headerOnly) parts.push(chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

class MockR2 {
  constructor() { this.objects = new Map(); this.version = 0; this.putCount = 0; this.getCount = 0; this.beforeNextPut = null; }
  async get(key) {
    this.getCount++;
    const entry = this.objects.get(key); if (!entry) return null;
    const data = entry.data.slice();
    return { key, etag: entry.etag, httpEtag: `"${entry.etag}"`, size: data.byteLength,
      customMetadata: { ...entry.customMetadata }, httpMetadata: { ...entry.httpMetadata },
      body: new Response(data).body, json: async () => JSON.parse(decode.decode(data)),
      text: async () => decode.decode(data), arrayBuffer: async () => data.buffer,
    };
  }
  async put(key, value, options = {}) {
    this.putCount++;
    if (this.beforeNextPut) { const hook = this.beforeNextPut; this.beforeNextPut = null; await hook(key, options); }
    const current = this.objects.get(key), condition = options.onlyIf || {};
    if (condition.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
    if (condition.etagDoesNotMatch === '*' && current) return null;
    if (condition.etagDoesNotMatch !== undefined && condition.etagDoesNotMatch !== '*' && current?.etag === condition.etagDoesNotMatch) return null;
    const data = typeof value === 'string' ? encode.encode(value) : value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer());
    const entry = { data, etag: `etag-${++this.version}`, customMetadata: { ...options.customMetadata }, httpMetadata: { ...options.httpMetadata } };
    this.objects.set(key, entry);
    return { key, etag: entry.etag, httpEtag: `"${entry.etag}"`, size: data.byteLength };
  }
}

function request(path, { method = 'GET', owner = 'alice', json, bytes, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (owner !== null) finalHeaders['oai-authenticated-user-id'] = owner;
  let body;
  if (json !== undefined) { finalHeaders['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (bytes !== undefined) { finalHeaders['content-type'] = 'image/png'; body = bytes; }
  return new Request(ORIGIN + path, { method, headers: finalHeaders, body });
}
async function api(bucket, path, args = {}) {
  const response = await worker.fetch(request(path, args), { BUCKET: bucket });
  const value = await response.json(); return { status: response.status, value };
}
async function rpc(bucket, method, params = {}, owner = 'alice', headers = {}) {
  const response = await worker.fetch(request('/mcp', { method: 'POST', owner, json: { jsonrpc: '2.0', id: 1, method, params }, headers }), { BUCKET: bucket });
  return { status: response.status, value: await response.json() };
}
const call = (bucket, name, args = {}, owner = 'alice') => rpc(bucket, 'tools/call', { name, arguments: args }, owner);
const sceneOf = async (bucket, owner = 'alice') => (await api(bucket, '/api/scene', { owner })).value;
function editedScene(record, patch) { return { ...record.scene, config: { ...record.scene.config, ...patch } }; }

test('stateless discovery, tool inventory, and legacy initialization do not read private storage', async () => {
  const bucket = new MockR2();
  const modern = await rpc(bucket, 'server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }, null, { 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' });
  assert.equal(modern.status, 200); assert.ok(modern.value.result.supportedVersions.includes('2026-07-28'));
  assert.equal(modern.value.result.resultType, 'complete'); assert.ok(modern.value.result.capabilities.tools);
  const tools = await rpc(bucket, 'tools/list', {}, null);
  assert.deepEqual(tools.value.result.tools.map(tool => tool.name), ['list_templates', 'get_scene', 'generate_house', 'update_house', 'generate_map', 'update_map', 'generate_character', 'update_character', 'set_character_animation', 'generate_interior', 'update_interior', 'place_furniture', 'remove_furniture', 'request_export', 'request_animation_export', 'cancel_export']);
  assert.equal(modern.value.result._meta['io.modelcontextprotocol/serverInfo'].name, 'village-foundry-mcp');
  const initialized = await rpc(bucket, 'initialize', { protocolVersion: '2025-11-25' }, null);
  assert.equal(initialized.value.result.protocolVersion, '2025-11-25');
  const mismatch = await rpc(bucket, 'tools/list', {}, null, { 'Mcp-Method': 'tools/call' });
  assert.equal(mismatch.status, 400); assert.equal(mismatch.value.error.code, -32020);
  const unsupported = await rpc(bucket, 'tools/list', {}, null, { 'Mcp-Protocol-Version': '1900-01-01' });
  assert.equal(unsupported.value.error.code, -32022);
  assert.equal(bucket.getCount, 0); assert.equal(bucket.putCount, 0);
});

test('private scene calls require trusted owner identity and keep owners isolated', async () => {
  const bucket = new MockR2();
  const denied = await api(bucket, '/api/scene', { owner: null });
  assert.equal(denied.status, 401); assert.equal(bucket.getCount, 0);
  const deniedTool = await call(bucket, 'get_scene', {}, null);
  assert.equal(deniedTool.status, 401); assert.equal(deniedTool.value.result.isError, true);
  const initial = await sceneOf(bucket);
  assert.equal(initial.revision, 0); assert.equal(initial.scene.config.seed, 742);
  const saved = await api(bucket, '/api/scene', { method: 'POST', json: { scene: editedScene(initial, { tables: 6 }), expectedRevision: 0, owner: 'bob' } });
  assert.equal(saved.status, 200); assert.equal(saved.value.revision, 1);
  assert.equal((await sceneOf(bucket, 'bob')).scene.config.tables, 4);
  assert.equal((await sceneOf(bucket, 'alice')).scene.config.tables, 6);
  assert.deepEqual([...bucket.objects.keys()], ['scenes/alice.json']);
  const encodedOwner = 'a/b';
  const other = await sceneOf(bucket, encodedOwner);
  await api(bucket, '/api/scene', { method: 'POST', owner: encodedOwner, json: { scene: editedScene(other, { tables: 2 }) } });
  assert.ok(bucket.objects.has('scenes/a%2Fb.json'));
});

test('scene validation rejects malformed configuration, foreign origins, and oversized input', async () => {
  const bucket = new MockR2(), initial = await sceneOf(bucket);
  for (const patch of [{ width: 'large' }, { tables: 13 }, { fireplace: 'yes' }, { preset: 'missing' }, { items: [{ id: 'x', type: 'unknown', x: 0, z: 0 }] }]) {
    const result = await api(bucket, '/api/scene', { method: 'POST', json: { scene: editedScene(initial, patch) } });
    assert.equal(result.status, 400, JSON.stringify(patch));
  }
  const foreign = await api(bucket, '/api/scene', { method: 'POST', headers: { origin: 'https://elsewhere.example' }, json: { scene: editedScene(initial, { tables: 2 }) } });
  assert.equal(foreign.status, 403);
  const tooMuchLayout = await api(bucket, '/api/scene', { method: 'POST', json: { scene: initial.scene, layout: { note: 'x'.repeat(66000) } } });
  assert.equal(tooMuchLayout.status, 400);
  const tooMuchJson = await api(bucket, '/api/scene', { method: 'POST', json: { scene: initial.scene, junk: 'x'.repeat(256 * 1024) } });
  assert.equal(tooMuchJson.status, 413);
  assert.equal(bucket.objects.size, 0);
});

test('equivalent normalized writes are idempotent, while stale revisions cannot overwrite changes', async () => {
  const bucket = new MockR2(), initial = await sceneOf(bucket);
  const first = await api(bucket, '/api/scene', { method: 'POST', json: { scene: editedScene(initial, { width: 10 }), layout: { positions: [], note: 'ok' }, expectedRevision: 0 } });
  assert.equal(first.value.revision, 1);
  const firstEtag = bucket.objects.get('scenes/alice.json').etag;
  const equivalent = { ...first.value.scene, ignored: true, config: { ...first.value.scene.config, ignored: 'not saved' } };
  const repeat = await api(bucket, '/api/scene', { method: 'POST', json: { scene: equivalent, layout: { note: 'ok', positions: [] }, expectedRevision: 1 } });
  assert.equal(repeat.value.revision, 1); assert.equal(bucket.objects.get('scenes/alice.json').etag, firstEtag);
  const stale = await api(bucket, '/api/scene', { method: 'POST', json: { scene: editedScene(initial, { width: 8 }), expectedRevision: 0 } });
  assert.equal(stale.status, 409); assert.equal((await sceneOf(bucket)).scene.config.width, 10);
  // Another writer wins between read and put. The conditional write must fail.
  bucket.beforeNextPut = (key, options) => {
    assert.ok(options.onlyIf.etagMatches);
    const saved = bucket.objects.get(key), value = JSON.parse(decode.decode(saved.data));
    value.revision++; value.scene.config.width = 11;
    bucket.objects.set(key, { ...saved, etag: 'concurrent-etag', data: encode.encode(JSON.stringify(value)) });
  };
  const conflict = await api(bucket, '/api/scene', { method: 'POST', json: { scene: editedScene(first.value, { width: 12 }), expectedRevision: 1 } });
  assert.equal(conflict.status, 409); assert.equal((await sceneOf(bucket)).scene.config.width, 11);
});

test('conditional first-write protection permits only one initial revision writer', async () => {
  const bucket = new MockR2(), initial = await sceneOf(bucket);
  const results = await Promise.all([6, 7].map(tables => api(bucket, '/api/scene', { method: 'POST', json: { scene: editedScene(initial, { tables }), expectedRevision: 0 } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await sceneOf(bucket)).revision, 1);
});

test('MCP generation, exact furniture updates, removals, and error results operate on owned state', async () => {
  const bucket = new MockR2();
  const generated = await call(bucket, 'generate_interior', { config: { preset: 'tavern', seed: 19 }, brief: 'six tables, a bar on the left, fireplace and a clear central aisle', expectedRevision: 0 });
  const record = generated.value.result.structuredContent;
  assert.equal(record.scene.config.tables, 6); assert.equal(record.scene.config.barSide, 'left'); assert.ok(record.applied.length);
  const placed = await call(bucket, 'place_furniture', { item: { id: 'custom-table', type: 'table', x: 2, z: 1, rotation: -90, scale: 1.1 }, expectedRevision: record.revision });
  assert.equal(placed.value.result.structuredContent.scene.config.items[0].rotation, 270);
  const again = await call(bucket, 'place_furniture', { item: { id: 'custom-table', type: 'table', x: 2, z: 1, rotation: 270, scale: 1.1 } });
  assert.equal(again.value.result.structuredContent.revision, placed.value.result.structuredContent.revision);
  const removed = await call(bucket, 'remove_furniture', { id: 'custom-table' });
  assert.equal(removed.value.result.structuredContent.scene.config.items.length, 0);
  assert.ok(removed.value.result.structuredContent.scene.config.excludeIds.includes('custom-table'));
  const surfaceChoice = (await call(bucket, 'update_interior', { patch: { usePaintedSurfaces: false, useTextures: true } })).value.result.structuredContent;
  assert.equal(surfaceChoice.scene.config.usePaintedSurfaces, false); assert.equal(surfaceChoice.scene.config.useTextures, true);
  const invalid = await call(bucket, 'update_interior', { patch: { width: 'wide' } });
  assert.equal(invalid.value.result.isError, true); assert.equal(invalid.value.result.structuredContent.error.status, 400);
  assert.equal((await sceneOf(bucket, 'bob')).revision, 0);
});

test('export queue snapshots are immutable, PNG completion preserves later scene edits, and files remain private', async () => {
  const bucket = new MockR2();
  await call(bucket, 'generate_interior', { config: { tables: 6, seed: 51 } });
  const queued = await call(bucket, 'request_export', { options: { resolution: 256, scale: 1 } });
  const record = queued.value.result.structuredContent, job = record.exportJob;
  assert.equal(job.status, 'pending'); assert.equal(job.scene.config.tables, 6);
  assert.equal(job.scene.output.resolution, 256); assert.equal(record.scene.output.resolution, 512);
  const retry = await call(bucket, 'request_export', { options: { resolution: 256, scale: 1 } });
  assert.equal(retry.value.result.structuredContent.exportJob.id, job.id);
  assert.equal(retry.value.result.structuredContent.revision, record.revision);
  const changed = await call(bucket, 'update_interior', { patch: { tables: 2 } });
  assert.equal(changed.value.result.structuredContent.exportJob.scene.config.tables, 6);
  const conflicting = await call(bucket, 'request_export');
  assert.equal(conflicting.value.result.isError, true); assert.equal(conflicting.value.result.structuredContent.error.status, 409);
  const denied = await api(bucket, `/api/exports/${job.id}`, { method: 'POST', owner: 'bob', bytes: PNG });
  assert.equal(denied.status, 404);
  const malformed = await api(bucket, `/api/exports/${job.id}`, { method: 'POST', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(malformed.status, 415);
  const completed = await api(bucket, `/api/exports/${job.id}`, { method: 'POST', bytes: PNG });
  assert.equal(completed.status, 200); assert.equal(completed.value.exportJob.status, 'ready');
  assert.equal(completed.value.scene.config.tables, 2); assert.equal(completed.value.exportJob.scene.config.tables, 6);
  assert.equal(completed.value.exportJob.width, 1); assert.equal(completed.value.exportJob.height, 1);
  const again = await api(bucket, `/api/exports/${job.id}`, { method: 'POST', bytes: PNG });
  assert.equal(again.value.revision, completed.value.revision);
  const got = await worker.fetch(request(`/api/exports/${job.id}`), { BUCKET: bucket });
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PNG);
  assert.equal((await worker.fetch(request(`/api/exports/${job.id}`, { owner: 'bob' }), { BUCKET: bucket })).status, 404);
  assert.equal((await worker.fetch(request(`/api/exports/${job.id}`, { owner: null }), { BUCKET: bucket })).status, 401);
  const different = new Uint8Array(PNG.length + 1); different.set(PNG); different[different.length - 1] = 1;
  assert.equal((await api(bucket, `/api/exports/${job.id}`, { method: 'POST', bytes: different })).status, 409);
});

test('PNG completion retries a conditional conflict without losing a concurrent scene edit', async () => {
  const bucket = new MockR2();
  const queued = await call(bucket, 'request_export'), job = queued.value.result.structuredContent.exportJob;
  // The export object write triggers a concurrent scene edit just before the
  // next conditional scene write, exercising the merge/retry path.
  bucket.beforeNextPut = key => {
    assert.ok(key.startsWith('exports/'));
    bucket.beforeNextPut = sceneKey => {
      const saved = bucket.objects.get(sceneKey), record = JSON.parse(decode.decode(saved.data));
      record.revision++; record.scene.config.tables = 8;
      bucket.objects.set(sceneKey, { ...saved, etag: 'newer-scene', data: encode.encode(JSON.stringify(record)) });
    };
  };
  const result = await api(bucket, `/api/exports/${job.id}`, { method: 'POST', bytes: PNG });
  assert.equal(result.status, 200); assert.equal(result.value.scene.config.tables, 8);
  assert.equal(result.value.exportJob.status, 'ready'); assert.equal(result.value.exportJob.scene.config.tables, 4);
});

test('template discovery includes houses, rooms, and maps; house colors and edits survive recipe normalization', async () => {
  const bucket = new MockR2();
  const listed = (await call(bucket, 'list_templates', {}, null)).value.result.structuredContent;
  assert.equal(listed.templates.filter(value => value.kind === 'house').length, 5);
  assert.equal(listed.templates.filter(value => value.kind === 'interior').length, 4);
  assert.equal(listed.templates.filter(value => value.kind === 'map').length, 4);
  assert.equal(listed.templates.filter(value => value.kind === 'character').length, 8);
  assert.deepEqual(listed.animations, ['idle', 'walk', 'talk', 'drink', 'point', 'wave']);
  assert.equal(listed.animationDurations.walk, 1);
  const made = await call(bucket, 'generate_house', { params: { preset: 'cottage', seed: 99, paintSeed: 2048, width: 5.4, roofColor: '#AABBCC' } });
  const first = made.value.result.structuredContent;
  assert.equal(first.scene.format, 'house-foundry'); assert.equal(first.scene.params.preset, 'cottage');
  assert.equal(first.scene.params.roofColor, '#aabbcc'); assert.equal(first.scene.tints.roof, '#aabbcc');
  assert.equal(first.scene.params.paintSeed, 2048);
  assert.equal(first.scene.output.style, 'illustrated'); assert.equal(first.scene.output.pixelated, false);
  const changed = (await call(bucket, 'update_house', { patch: { width: 6, woodColor: '#998877' }, expectedRevision: first.revision })).value.result.structuredContent;
  assert.equal(changed.scene.params.width, 6); assert.equal(changed.scene.params.preset, 'cottage');
  assert.equal(changed.scene.tints.wood, '#998877'); assert.equal(changed.scene.paletteBase.wood, '#998877');
  assert.equal(changed.scene.params.paintSeed, 2048);
  for (const paintSeed of [-1, 0.5, 4294967296, '2048']) assert.equal((await call(bucket, 'update_house', { patch: { paintSeed } })).value.result.isError, true);
  for (const [name, args] of [['place_furniture', { item: { id: 'x', type: 'chair', x: 0, z: 0 } }], ['remove_furniture', { id: 'x' }], ['update_interior', { patch: { tables: 2 } }], ['update_map', { patch: { houseCount: 1 } }]]) {
    const result = (await call(bucket, name, args)).value.result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'wrong_scene_kind');
  }
  assert.equal((await sceneOf(bucket)).revision, changed.revision);
  const plaster = (await call(bucket, 'update_house', { patch: { wallColor: '#C8B89A', stoneColor: '#807766' } })).value.result.structuredContent;
  assert.equal(plaster.scene.tints.wall, '#c8b89a'); assert.equal(plaster.scene.paletteBase.wall, '#c8b89a');
  const stone = (await call(bucket, 'update_house', { patch: { wallKind: 'stone' } })).value.result.structuredContent;
  assert.equal(stone.scene.tints.wall, '#807766'); assert.equal(stone.scene.paletteBase.wall, '#807766');
  const unusedPlaster = (await call(bucket, 'update_house', { patch: { wallColor: '#D2C2AA' } })).value.result.structuredContent;
  assert.equal(unusedPlaster.scene.tints.wall, '#807766');
  const recoloredStone = (await call(bucket, 'update_house', { patch: { stoneColor: '#AB9988' } })).value.result.structuredContent;
  assert.equal(recoloredStone.scene.tints.wall, '#ab9988'); assert.equal(recoloredStone.scene.paletteBase.wall, '#ab9988');
  const brick = (await call(bucket, 'update_house', { patch: { wallKind: 'brick', stoneColor: '#A46843' } })).value.result.structuredContent;
  assert.equal(brick.scene.tints.wall, '#a46843');
  const plasterAgain = (await call(bucket, 'update_house', { patch: { wallKind: 'plaster' } })).value.result.structuredContent;
  assert.equal(plasterAgain.scene.tints.wall, '#d2c2aa');
  const freshStone = (await call(new MockR2(), 'generate_house', { params: { preset: 'village', stoneColor: '#998877', wallColor: '#FFEEDD' } })).value.result.structuredContent;
  assert.equal(freshStone.scene.tints.wall, '#998877'); assert.equal(freshStone.scene.paletteBase.wall, '#998877');
});

test('map validation retains palette and feature controls and rejects invalid types, bounds, and render styles', async () => {
  const bucket = new MockR2();
  const generated = (await call(bucket, 'generate_map', { config: { preset: 'riverside', seed: 45, width: 36, depth: 32, houseCount: 5, roofColor: '#ABCDEF', roadStyle: 'cobble' } })).value.result.structuredContent;
  assert.equal(generated.scene.format, 'village-foundry-map'); assert.equal(generated.scene.config.water, true);
  assert.equal(generated.scene.config.landform, 'island'); assert.equal(generated.scene.config.sea, true);
  assert.equal(generated.scene.config.roofColor, '#abcdef'); assert.equal(generated.scene.config.roadStyle, 'cobble');
  const changed = (await call(bucket, 'update_map', { patch: { includeHouses: false, houseCount: 0, landform: 'mainland', sea: true }, expectedRevision: generated.revision })).value.result.structuredContent;
  assert.equal(changed.scene.config.includeHouses, false); assert.equal(changed.scene.config.houseCount, 0); assert.equal(changed.scene.config.water, true);
  assert.equal(changed.scene.config.landform, 'mainland'); assert.equal(changed.scene.config.sea, true);
  for (const patch of [{ width: 257 }, { depth: 257 }, { width: 23 }, { width: 24.5 }, { houseCount: 33 }, { trees: 'yes' }, { sea: 'yes' }, { landform: 'archipelago' }, { roadStyle: 'script' }, { layoutStyle: 'grid' }, { housePreset: 'unknown' }, { stoneColor: 'url(https://example.org)' }]) {
    const result = (await call(bucket, 'update_map', { patch })).value.result;
    assert.equal(result.isError, true, JSON.stringify(patch)); assert.equal(result.structuredContent.error.status, 400);
  }
  const pixelScene = { ...changed.scene, output: { style: 'pixel', resolution: 1024, scale: 1 } };
  const pixel = await api(bucket, '/api/scene', { method: 'POST', json: { scene: pixelScene, expectedRevision: changed.revision } });
  assert.equal(pixel.status, 200); assert.equal(pixel.value.scene.output.pixelated, true); assert.equal(pixel.value.scene.output.style, 'pixel');
  const badStyle = await api(bucket, '/api/scene', { method: 'POST', json: { scene: { ...pixel.value.scene, output: { style: 'execute(code)' } } } });
  assert.equal(badStyle.status, 400);
  const wrongKind = (await call(bucket, 'update_house', { patch: { floors: 2 } })).value.result;
  assert.equal(wrongKind.structuredContent.error.code, 'wrong_scene_kind');
  const expanded = (await call(bucket, 'update_map', { patch: { width: 96, depth: 96, houseCount: 32, includeHouses: true, layoutStyle: 'organic' }, expectedRevision: pixel.value.revision })).value.result.structuredContent;
  assert.equal(expanded.scene.config.width, 96); assert.equal(expanded.scene.config.depth, 96); assert.equal(expanded.scene.config.houseCount, 32);
  assert.equal(expanded.scene.config.layoutStyle, 'organic'); assert.equal(expanded.scene.config.includeHouses, true);
  const limits = (await call(bucket, 'list_templates', {}, null)).value.result.structuredContent.limits.map;
  assert.deepEqual(limits, { width: [24, 256], depth: [24, 256], houseCount: [0, 32] });
});

test('large and rectangular map sizes roundtrip without changing palette, style, or export snapshots', async () => {
  const bucket = new MockR2();
  let record = (await call(bucket, 'generate_map', {config:{preset:'riverside',width:48,depth:48,houseCount:32,roofColor:'#123456'}})).value.result.structuredContent;
  record = (await api(bucket, '/api/scene', {method:'POST',json:{scene:{...record.scene,output:{resolution:2048,style:'illustrated',scale:1}},expectedRevision:record.revision}})).value;
  for (const [width,depth] of [[128,128],[192,192],[256,24],[24,256],[256,256]]) {
    record = (await call(bucket, 'update_map', {patch:{width,depth},expectedRevision:record.revision})).value.result.structuredContent;
    assert.equal(record.scene.config.width,width); assert.equal(record.scene.config.depth,depth);
    assert.equal(record.scene.config.roofColor,'#123456'); assert.equal(record.scene.config.houseCount,32);
    assert.equal(record.scene.output.resolution,2048); assert.equal(record.scene.output.style,'illustrated');
  }
  const queued = (await call(bucket, 'request_export', {})).value.result.structuredContent;
  const changed = (await call(bucket, 'update_map', {patch:{width:48,depth:48},expectedRevision:queued.revision})).value.result.structuredContent;
  assert.equal(changed.scene.config.width,48);
  assert.equal(changed.exportJob.scene.config.width,256); assert.equal(changed.exportJob.scene.config.depth,256);
});

test('house, map, and character snapshots use the same private still-export pipeline without changing scene kinds', async () => {
  for (const [name, args, format] of [['generate_house', { params: { preset: 'inn', seed: 11 } }, 'house-foundry'], ['generate_map', { config: { preset: 'farm', seed: 22 } }, 'village-foundry-map'], ['generate_character', { config: { preset: 'ranger', animation: 'point', time: 1.4, seed: 33 } }, 'village-foundry-character']]) {
    const bucket = new MockR2();
    const made = (await call(bucket, name, args)).value.result.structuredContent;
    const queued = (await call(bucket, 'request_export', { options: { resolution: 768, scale: 1, style: 'pixel' }, expectedRevision: made.revision })).value.result.structuredContent;
    assert.equal(queued.exportJob.scene.format, format); assert.equal(queued.exportJob.scene.output.resolution, 768);
    assert.equal(queued.exportJob.scene.output.pixelated, true); assert.equal(queued.scene.output.pixelated, false);
    assert.equal(queued.exportJob.options.format, 'png');
    const completion = await api(bucket, `/api/exports/${queued.exportJob.id}`, { method: 'POST', bytes: PNG });
    assert.equal(completion.status, 200); assert.equal(completion.value.scene.format, format); assert.equal(completion.value.exportJob.status, 'ready');
    const response = await worker.fetch(request(completion.value.exportJob.url), { BUCKET: bucket });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /asset-/);
  }
});

test('character appearance and pose edits retain identity, reject malformed values, and guard scene kind', async () => {
  const bucket = new MockR2();
  for (const [name, args] of [['update_character', { patch: { height: 1.8 } }], ['set_character_animation', { animation: 'walk' }], ['request_animation_export', {}]]) {
    const result = (await call(bucket, name, args)).value.result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'wrong_scene_kind');
  }
  const generated = (await call(bucket, 'generate_character', { config: { preset: 'innkeeper', seed: 158, build: 'sturdy', tunicColor: '#ABCDEF', animation: 'walk', time: 0.4 }, expectedRevision: 0 })).value.result.structuredContent;
  assert.equal(generated.scene.format, 'village-foundry-character'); assert.equal(generated.scene.config.seed, 158);
  assert.equal(generated.scene.config.tunicColor, '#abcdef'); assert.equal(generated.scene.config.build, 'sturdy');
  const pose = (await call(bucket, 'set_character_animation', { animation: 'talk', direction: 270, mouth: 'open', expectedRevision: generated.revision })).value.result.structuredContent;
  assert.equal(pose.scene.config.time, 0); assert.equal(pose.scene.config.animation, 'talk'); assert.equal(pose.scene.config.direction, 270);
  assert.equal(pose.scene.config.mouth, 'open'); assert.equal(pose.scene.config.seed, 158); assert.equal(pose.scene.config.tunicColor, '#abcdef');
  const repeated = (await call(bucket, 'set_character_animation', { animation: 'talk', direction: 270, mouth: 'open' })).value.result.structuredContent;
  assert.equal(repeated.revision, pose.revision);
  const changed = (await call(bucket, 'update_character', { patch: { height: 1.9, hair: 'braid', time: 1.25 } })).value.result.structuredContent;
  assert.equal(changed.scene.config.height, 1.9); assert.equal(changed.scene.config.hair, 'braid'); assert.equal(changed.scene.config.time, 1.25);
  for (const patch of [{ preset: 'dragon' }, { height: 2.1 }, { height: 'tall' }, { seed: -1 }, { seed: 4.5 }, { time: 3601 }, { direction: -1 }, { build: 'huge' }, { hair: 'none' }, { beard: 'long' }, { animation: 'jump' }, { mouth: 'smile' }, { skinColor: '#abc' }]) {
    const result = (await call(bucket, 'update_character', { patch })).value.result;
    assert.equal(result.isError, true, JSON.stringify(patch)); assert.equal(result.structuredContent.error.status, 400);
  }
  for (const args of [{}, { animation: 'walk', height: 1.6 }, { time: 'now' }]) {
    assert.equal((await call(bucket, 'set_character_animation', args)).value.result.isError, true);
  }
  assert.equal((await sceneOf(bucket)).revision, changed.revision);
  assert.equal((await call(bucket, 'place_furniture', { item: { id: 'barrel', type: 'barrel', x: 0, z: 0 } })).value.result.structuredContent.error.code, 'wrong_scene_kind');
});

test('adult and child character presets preserve gender, age, proportions, and appearance through MCP roundtrips', async () => {
  for (const [preset,gender,age] of [['blonde_woman','female','adult'],['blonde_man','male','adult'],['blonde_girl','female','child'],['blonde_boy','male','child']]) {
    const bucket = new MockR2();
    const made = (await call(bucket, 'generate_character', {config:{preset,seed:742,hairColor:'#DDCC88'}})).value.result.structuredContent;
    assert.equal(made.scene.config.preset,preset); assert.equal(made.scene.config.gender,gender); assert.equal(made.scene.config.age,age);
    assert.equal(made.scene.config.hairColor,'#ddcc88');
    if(age==='child')assert(made.scene.config.height<1.5);
    const changed = (await call(bucket, 'update_character', {patch:{gender,age,height:age==='child'?1.05:1.85,beard:'short'},expectedRevision:made.revision})).value.result.structuredContent;
    assert.equal(changed.scene.config.gender,gender); assert.equal(changed.scene.config.age,age);
    assert.equal(changed.scene.config.beard,age==='child'?'none':'short');
    const saved = await api(bucket, '/api/scene', {method:'POST',json:{scene:changed.scene,expectedRevision:changed.revision}});
    assert.equal(saved.status,200); assert.deepEqual(saved.value.scene.config,changed.scene.config);
    for(const patch of [{gender:'unknown'},{age:'teen'},{height:1.04},{height:2.01}])assert.equal((await call(bucket,'update_character',{patch})).value.result.isError,true);
  }
});

test('animation jobs validate render limits and preserve exact clip, directions, timing, and appearance snapshots', async () => {
  const bucket = new MockR2();
  const made = (await call(bucket, 'generate_character', { config: { preset: 'ranger', seed: 24, animation: 'walk', time: 0.5, direction: 45 } })).value.result.structuredContent;
  const large = await api(bucket, '/api/scene', { method: 'POST', json: { scene: { ...made.scene, output: { ...made.scene.output, resolution: 1024, scale: 4 } } } });
  assert.equal(large.status, 200);
  for (const args of [{ frames: 3 }, { frames: 25 }, { frames: 8.5 }, { frames: null }, { directions: 2 }, { directions: '4' }, { fps: 0 }, { fps: 25 }, { fps: 8.5 }, { animation: 'jump' }, { options: { resolution: 768 } }, { options: { scale: 3 } }]) {
    const result = (await call(bucket, 'request_animation_export', args)).value.result;
    assert.equal(result.isError, true, JSON.stringify(args)); assert.equal(result.structuredContent.error.status, 400);
  }
  assert.equal((await sceneOf(bucket)).exportJob, null);
  const queued = (await call(bucket, 'request_animation_export', { animation: 'talk', frames: 8, directions: 4, fps: 8 })).value.result.structuredContent;
  const job = queued.exportJob;
  assert.equal(job.options.format, 'spritesheet'); assert.equal(job.options.animation, 'talk');
  assert.equal(job.options.columns, 8); assert.equal(job.options.rows, 4); assert.equal(job.options.fps, 8);
  assert.deepEqual(job.options.directionAngles, [0, 90, 180, 270]);
  assert.equal(job.options.cycleDuration, 1.8); assert.equal(job.options.playbackDuration, 1);
  assert.deepEqual(job.options.sampleTimes, [0, 0.225, 0.45, 0.675, 0.9, 1.125, 1.35, 1.575]);
  assert.equal(job.scene.config.animation, 'talk'); assert.equal(job.scene.config.time, 0);
  assert.equal(job.scene.output.resolution, 512); assert.equal(job.scene.output.scale, 2);
  assert.equal(queued.scene.config.animation, 'walk'); assert.equal(queued.scene.config.time, 0.5);
  assert.equal(queued.scene.output.resolution, 1024); assert.equal(queued.scene.output.scale, 4);
  const retry = (await call(bucket, 'request_animation_export', { animation: 'talk', frames: 8, directions: 4, fps: 8 })).value.result.structuredContent;
  assert.equal(retry.exportJob.id, job.id); assert.equal(retry.revision, queued.revision);
  const different = (await call(bucket, 'request_animation_export', { animation: 'talk', frames: 12, directions: 4, fps: 8 })).value.result;
  assert.equal(different.structuredContent.error.code, 'export_pending');
  assert.equal((await call(bucket, 'request_export')).value.result.structuredContent.error.code, 'export_pending');
  const changed = (await call(bucket, 'update_character', { patch: { tunicColor: '#998877', animation: 'wave' } })).value.result.structuredContent;
  assert.deepEqual(changed.exportJob, job); assert.equal(changed.scene.config.animation, 'wave');
  assert.notEqual(changed.scene.config.tunicColor, changed.exportJob.scene.config.tunicColor);
});

test('sprite-sheet completion validates cell layout and persists immutable per-cell anchors and metadata', async () => {
  const bucket = new MockR2();
  await call(bucket, 'generate_character', { config: { preset: 'villager', direction: 135 } });
  const job = (await call(bucket, 'request_animation_export', { animation: 'wave' })).value.result.structuredContent.exportJob;
  const path = `/api/exports/${job.id}`;
  assert.equal((await api(bucket, path, { method: 'POST', owner: 'bob', bytes: SHEET_PNG })).status, 404);
  assert.equal((await api(bucket, path, { method: 'POST', bytes: PNG })).status, 400);
  for (const headers of [{ 'x-foundry-anchor-x': '1' }, { 'x-foundry-anchor-x': 'NaN', 'x-foundry-anchor-y': '1' }, { 'x-foundry-anchor-x': '3', 'x-foundry-anchor-y': '1' }]) {
    assert.equal((await api(bucket, path, { method: 'POST', bytes: SHEET_PNG, headers })).status, 400);
  }
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith('exports/')).length, 0);
  await call(bucket, 'update_character', { patch: { animation: 'drink', direction: 180 } });
  const headers = { 'x-foundry-anchor-x': '1', 'x-foundry-anchor-y': '2' };
  const complete = await api(bucket, path, { method: 'POST', bytes: SHEET_PNG, headers });
  assert.equal(complete.status, 200); assert.equal(complete.value.exportJob.status, 'ready');
  const metadata = complete.value.exportJob.metadata;
  assert.equal(metadata.width, 16); assert.equal(metadata.height, 8); assert.equal(metadata.cellWidth, 2); assert.equal(metadata.cellHeight, 2);
  assert.deepEqual(metadata.anchorPixels, [1, 2]); assert.equal(metadata.animation, 'wave'); assert.equal(metadata.rows, 4); assert.equal(metadata.columns, 8);
  assert.equal(complete.value.scene.config.animation, 'drink'); assert.equal(complete.value.exportJob.scene.config.animation, 'wave');
  const again = await api(bucket, path, { method: 'POST', bytes: SHEET_PNG, headers });
  assert.equal(again.value.revision, complete.value.revision);
  assert.equal((await api(bucket, path, { method: 'POST', bytes: SHEET_PNG, headers: { ...headers, 'x-foundry-anchor-x': '0.5' } })).status, 409);
  const oneDirection = (await call(bucket, 'request_animation_export', { frames: 12, directions: 1, fps: 12 })).value.result.structuredContent.exportJob;
  assert.deepEqual(oneDirection.options.directionAngles, [180]); assert.equal(oneDirection.options.animation, 'drink');
  const eightBucket = new MockR2();
  await call(eightBucket, 'generate_character');
  const eight = (await call(eightBucket, 'request_animation_export', { frames: 24, directions: 8, fps: 24 })).value.result.structuredContent.exportJob;
  assert.deepEqual(eight.options.directionAngles, [0, 45, 90, 135, 180, 225, 270, 315]); assert.equal(eight.options.sampleTimes.length, 24);
  const mixed = (await call(new MockR2(), 'generate_map', { config: { housePreset: 'mixed' } })).value.result.structuredContent;
  assert.equal(mixed.scene.config.housePreset, 'mixed');
});

test('wide sprite sheets share browser dimension limits while still PNGs and byte limits remain stricter', async () => {
  const bucket = new MockR2();
  await call(bucket, 'generate_character');
  const job = (await call(bucket, 'request_animation_export', { frames: 16, directions: 4 })).value.result.structuredContent.exportJob;
  const path = `/api/exports/${job.id}`;
  for (const [width, height] of [[16385, 4], [16, 16385], [10000, 4001], [0, 4]]) {
    const result = await api(bucket, path, { method: 'POST', bytes: rgbaPng(width, height, true) });
    assert.equal(result.status, 400, `${width} × ${height}`);
  }
  const wide = rgbaPng(16384, 4);
  assert.equal((await api(bucket, path, { method: 'POST', bytes: wide, headers: { 'content-length': String(16 * 1024 * 1024 + 1) } })).status, 413);
  const accepted = await api(bucket, path, { method: 'POST', bytes: wide });
  assert.equal(accepted.status, 200); assert.equal(accepted.value.exportJob.status, 'ready');
  assert.equal(accepted.value.exportJob.width, 16384); assert.equal(accepted.value.exportJob.metadata.cellWidth, 1024);
  const stillBucket = new MockR2();
  const still = (await call(stillBucket, 'request_export')).value.result.structuredContent.exportJob;
  for (const bytes of [wide, rgbaPng(8192, 4097, true)]) {
    assert.equal((await api(stillBucket, `/api/exports/${still.id}`, { method: 'POST', bytes })).status, 400);
  }
  assert.equal((await sceneOf(stillBucket)).exportJob.status, 'pending');
});

test('MCP and API cancellation preserve scenes, enforce ownership and revisions, and reject late completion', async () => {
  const bucket = new MockR2();
  const empty = (await call(bucket, 'cancel_export')).value.result.structuredContent;
  assert.equal(empty.cancelled, false); assert.equal(empty.exportJob, null); assert.equal(bucket.putCount, 0);
  assert.equal((await call(bucket, 'cancel_export', {}, null)).status, 401);
  const queued = (await call(bucket, 'request_export')).value.result.structuredContent, id = queued.exportJob.id;
  const path = `/api/exports/${id}`;
  assert.equal((await api(bucket, path + '/cancel', { method: 'POST', owner: 'bob', json: {} })).status, 404);
  assert.equal((await api(bucket, path + '/cancel', { method: 'POST', headers: { origin: 'https://elsewhere.example' }, json: {} })).status, 403);
  const stale = (await call(bucket, 'cancel_export', { id, expectedRevision: 0 })).value.result;
  assert.equal(stale.structuredContent.error.code, 'revision_conflict');
  assert.equal((await call(bucket, 'cancel_export', { id: '../bad' })).value.result.isError, true);
  const cancelled = (await call(bucket, 'cancel_export', { id, expectedRevision: queued.revision })).value.result.structuredContent;
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.exportJob.status, 'cancelled'); assert.ok(cancelled.exportJob.cancelledAt);
  assert.equal(cancelled.revision, queued.revision + 1); assert.deepEqual(cancelled.scene, queued.scene);
  const repeated = await api(bucket, path + '/cancel', { method: 'POST' });
  assert.equal(repeated.status, 200); assert.equal(repeated.value.cancelled, false); assert.match(repeated.value.note, /already cancelled/);
  assert.equal(repeated.value.revision, cancelled.revision);
  const late = await api(bucket, path, { method: 'POST', bytes: PNG });
  assert.equal(late.status, 409); assert.equal(late.value.error.code, 'export_cancelled');
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith('exports/')).length, 0);
  const replacement = (await call(bucket, 'request_export', { options: { resolution: 256 } })).value.result.structuredContent;
  assert.notEqual(replacement.exportJob.id, id);
  assert.equal((await api(bucket, path, { method: 'POST', bytes: PNG })).status, 404);
  assert.equal((await sceneOf(bucket)).exportJob.id, replacement.exportJob.id);
  const apiCancelled = await api(bucket, `/api/exports/${replacement.exportJob.id}/cancel`, { method: 'POST', json: { expectedRevision: replacement.revision } });
  assert.equal(apiCancelled.status, 200); assert.equal(apiCancelled.value.cancelled, true);
  const finalJob = (await call(bucket, 'request_export')).value.result.structuredContent.exportJob;
  const complete = await api(bucket, `/api/exports/${finalJob.id}`, { method: 'POST', bytes: PNG });
  const ready = (await call(bucket, 'cancel_export', { id: finalJob.id, expectedRevision: complete.value.revision })).value.result.structuredContent;
  assert.equal(ready.cancelled, false); assert.equal(ready.exportJob.status, 'ready'); assert.equal(ready.revision, complete.value.revision);
  assert.match(ready.note, /already ready/);
});

test('cancellation uses conditional writes and an in-flight PNG cannot revive a cancelled or replaced job', async () => {
  const conflictBucket = new MockR2();
  const first = (await call(conflictBucket, 'request_export')).value.result.structuredContent;
  conflictBucket.beforeNextPut = (key, options) => {
    assert.ok(options.onlyIf.etagMatches);
    const saved = conflictBucket.objects.get(key), record = JSON.parse(decode.decode(saved.data));
    record.revision++; record.scene.config.tables = 7;
    conflictBucket.objects.set(key, { ...saved, etag: 'concurrent-cancel-edit', data: encode.encode(JSON.stringify(record)) });
  };
  const conflict = (await call(conflictBucket, 'cancel_export', { id: first.exportJob.id, expectedRevision: first.revision })).value.result;
  assert.equal(conflict.structuredContent.error.code, 'revision_conflict');
  const unchangedJob = await sceneOf(conflictBucket);
  assert.equal(unchangedJob.exportJob.status, 'pending'); assert.equal(unchangedJob.scene.config.tables, 7);
  for (const replace of [false, true]) {
    const bucket = new MockR2();
    const old = (await call(bucket, 'request_export')).value.result.structuredContent.exportJob;
    let newer;
    bucket.beforeNextPut = async key => {
      assert.ok(key.startsWith('exports/'));
      const cancelled = (await call(bucket, 'cancel_export', { id: old.id })).value.result;
      assert.equal(cancelled.isError, false);
      await call(bucket, 'update_interior', { patch: { tables: 6 } });
      if (replace) newer = (await call(bucket, 'request_export')).value.result.structuredContent.exportJob;
    };
    const late = await api(bucket, `/api/exports/${old.id}`, { method: 'POST', bytes: PNG });
    assert.equal(late.status, 409); assert.equal(late.value.error.code, replace ? 'export_conflict' : 'export_cancelled');
    const current = await sceneOf(bucket);
    assert.equal(current.scene.config.tables, 6); assert.equal(current.exportJob.status, replace ? 'pending' : 'cancelled');
    assert.equal(current.exportJob.id, replace ? newer.id : old.id); assert.equal(current.exportJob.completedAt, undefined);
  }
});

test('deterministic render failures are private, bounded, visible to MCP, and terminal without blocking a new request', async () => {
  const bucket = new MockR2();
  const queued = (await call(bucket, 'request_export', { options: { resolution: 4096, scale: 1 } })).value.result.structuredContent;
  const job = queued.exportJob, path = `/api/exports/${job.id}`;
  const reason = { code: 'render_budget_exceeded', message: 'Native render exceeds the 16,777,216 pixel budget.' };
  const report = data => api(bucket, path + '/fail', { method: 'POST', json: data });
  assert.equal((await api(bucket, path + '/fail', { method: 'POST', owner: null, json: reason })).status, 401);
  assert.equal((await api(bucket, path + '/fail', { method: 'POST', owner: 'bob', json: reason })).status, 404);
  assert.equal((await api(bucket, path + '/fail', { method: 'POST', headers: { origin: 'https://elsewhere.example' }, json: reason })).status, 403);
  assert.equal((await api(bucket, path + '/fail')).status, 405);
  for (const invalid of [
    { ...reason, code: 'network_error' }, { ...reason, message: '' }, { ...reason, message: ' '.repeat(5) },
    { ...reason, message: 'x'.repeat(1001) }, { ...reason, message: 'bad\u0000message' }, { ...reason, stack: 'private trace' },
  ]) assert.equal((await report(invalid)).status, 400, JSON.stringify(invalid));
  const stale = await report({ ...reason, expectedRevision: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.value.error.code, 'revision_conflict');
  assert.equal((await sceneOf(bucket)).exportJob.status, 'pending');

  const failed = await report({ ...reason, message: `  ${reason.message}  `, expectedRevision: queued.revision });
  assert.equal(failed.status, 200); assert.equal(failed.value.failed, true);
  assert.equal(failed.value.revision, queued.revision + 1); assert.equal(failed.value.exportJob.status, 'failed');
  assert.ok(failed.value.exportJob.failedAt); assert.deepEqual(failed.value.exportJob.error, reason);
  assert.deepEqual(failed.value.scene, queued.scene); assert.deepEqual(failed.value.exportJob.scene, job.scene);
  assert.deepEqual(failed.value.exportJob.options, job.options);
  const observed = (await call(bucket, 'get_scene')).value.result.structuredContent;
  assert.deepEqual(observed.exportJob, failed.value.exportJob);
  const repeated = await report({ code: 'invalid_geometry', message: 'A later diagnosis must not overwrite the first failure.' });
  assert.equal(repeated.status, 200); assert.equal(repeated.value.failed, false);
  assert.equal(repeated.value.revision, failed.value.revision); assert.deepEqual(repeated.value.exportJob.error, reason);
  const cancelled = (await call(bucket, 'cancel_export', { id: job.id })).value.result.structuredContent;
  assert.equal(cancelled.cancelled, false); assert.equal(cancelled.exportJob.status, 'failed');
  const late = await api(bucket, path, { method: 'POST', bytes: PNG });
  assert.equal(late.status, 409); assert.equal(late.value.error.code, 'export_failed');
  assert.equal([...bucket.objects.keys()].filter(key => key.startsWith('exports/')).length, 0);

  const replacement = (await call(bucket, 'request_export', { options: { resolution: 2048, scale: 1 } })).value.result.structuredContent;
  assert.notEqual(replacement.exportJob.id, job.id); assert.equal(replacement.exportJob.status, 'pending');
  assert.equal((await report(reason)).status, 404);
  assert.equal((await sceneOf(bucket)).exportJob.id, replacement.exportJob.id);
  const replacementPath = `/api/exports/${replacement.exportJob.id}`;
  const completed = await api(bucket, replacementPath, { method: 'POST', bytes: PNG });
  const ready = await api(bucket, replacementPath + '/fail', { method: 'POST', json: reason });
  assert.equal(ready.status, 200); assert.equal(ready.value.failed, false);
  assert.equal(ready.value.exportJob.status, 'ready'); assert.equal(ready.value.revision, completed.value.revision);
  const third = (await call(bucket, 'request_export')).value.result.structuredContent.exportJob;
  await call(bucket, 'cancel_export', { id: third.id });
  const cancelledReport = await api(bucket, `/api/exports/${third.id}/fail`, { method: 'POST', json: reason });
  assert.equal(cancelledReport.value.failed, false); assert.equal(cancelledReport.value.exportJob.status, 'cancelled');
});

test('failure callbacks preserve concurrent edits with CAS and in-flight PNGs cannot revive failed or replaced jobs', async () => {
  const bucket = new MockR2();
  const queued = (await call(bucket, 'request_export')).value.result.structuredContent;
  const reason = { code: 'invalid_geometry', message: 'The scene has no finite renderable bounds.' };
  bucket.beforeNextPut = async (key, options) => {
    assert.ok(key.startsWith('scenes/')); assert.ok(options.onlyIf.etagMatches);
    const edit = (await call(bucket, 'update_interior', { patch: { tables: 7 } })).value.result;
    assert.equal(edit.isError, false);
  };
  const failed = await api(bucket, `/api/exports/${queued.exportJob.id}/fail`, { method: 'POST', json: reason });
  assert.equal(failed.status, 200); assert.equal(failed.value.failed, true);
  assert.equal(failed.value.scene.config.tables, 7); assert.equal(failed.value.revision, queued.revision + 2);
  assert.deepEqual(failed.value.exportJob.scene, queued.exportJob.scene);
  assert.deepEqual(failed.value.exportJob.error, reason);

  for (const replace of [false, true]) {
    const racing = new MockR2();
    const old = (await call(racing, 'request_export')).value.result.structuredContent.exportJob;
    let newer;
    racing.beforeNextPut = async key => {
      assert.ok(key.startsWith('exports/'));
      const response = await api(racing, `/api/exports/${old.id}/fail`, { method: 'POST', json: reason });
      assert.equal(response.status, 200); assert.equal(response.value.failed, true);
      await call(racing, 'update_interior', { patch: { tables: 6 } });
      if (replace) newer = (await call(racing, 'request_export')).value.result.structuredContent.exportJob;
    };
    const late = await api(racing, `/api/exports/${old.id}`, { method: 'POST', bytes: PNG });
    assert.equal(late.status, 409); assert.equal(late.value.error.code, replace ? 'export_conflict' : 'export_failed');
    const current = (await call(racing, 'get_scene')).value.result.structuredContent;
    assert.equal(current.scene.config.tables, 6); assert.equal(current.exportJob.status, replace ? 'pending' : 'failed');
    assert.equal(current.exportJob.id, replace ? newer.id : old.id); assert.equal(current.exportJob.completedAt, undefined);
    if (!replace) assert.deepEqual(current.exportJob.error, reason);
  }
});

test('fixed output settings are validated, remain immutable in export snapshots, and require exact PNG dimensions', async () => {
  const bucket = new MockR2(), initial = await sceneOf(bucket);
  assert.deepEqual(Object.fromEntries(['sizeMode', 'width', 'height', 'padding', 'fit'].map(key => [key, initial.scene.output[key]])),
    { sizeMode: 'auto', width: 512, height: 512, padding: 8, fit: 'contain' });
  for (const patch of [{ sizeMode: 'crop' }, { width: 15 }, { height: 8193 }, { width: 16.5 }, { width: '128' }, { padding: -1 }, { padding: 129 }, { fit: 'stretch' }, { width: 16, height: 16, padding: 8 }, { width: 8192, height: 8192, padding: 0 }]) {
    const scene = { ...initial.scene, output: { ...initial.scene.output, sizeMode: 'fixed', ...patch } };
    assert.equal((await api(bucket, '/api/scene', { method: 'POST', json: { scene } })).status, 400, JSON.stringify(patch));
  }
  const queued = (await call(bucket, 'request_export', { options: { sizeMode: 'fixed', width: 96, height: 160, padding: 8, fit: 'contain', style: 'pixel', scale: 4 } })).value.result.structuredContent;
  const job = queued.exportJob;
  assert.equal(job.scene.output.sizeMode, 'fixed'); assert.equal(job.scene.output.width, 96); assert.equal(job.scene.output.height, 160);
  assert.equal(job.scene.output.padding, 8); assert.equal(job.scene.output.fit, 'contain'); assert.equal(job.scene.output.scale, 4);
  assert.equal(queued.scene.output.sizeMode, 'auto'); assert.equal(queued.scene.output.width, 512);
  const edited = await api(bucket, '/api/scene', { method: 'POST', json: { scene: { ...queued.scene, output: { ...queued.scene.output, sizeMode: 'fixed', width: 64, height: 128, padding: 0, fit: 'pad' } }, expectedRevision: queued.revision } });
  assert.equal(edited.status, 200); assert.deepEqual(edited.value.exportJob, job);
  const path = `/api/exports/${job.id}`;
  assert.equal((await api(bucket, path, { method: 'POST', bytes: rgbaPng(64, 128) })).status, 400);
  const complete = await api(bucket, path, { method: 'POST', bytes: rgbaPng(96, 160) });
  assert.equal(complete.status, 200); assert.equal(complete.value.exportJob.metadata.width, 96); assert.equal(complete.value.exportJob.metadata.height, 160);
  assert.equal(complete.value.scene.output.width, 64); assert.equal(complete.value.scene.output.fit, 'pad');
  const legacy = await api(new MockR2(), '/api/scene', { method: 'POST', json: { scene: { ...initial.scene, output: { resolution: 256, scale: 1, pixelated: true } } } });
  assert.equal(legacy.status, 200); assert.equal(legacy.value.scene.output.sizeMode, 'auto'); assert.equal(legacy.value.scene.output.width, 512);
});

test('fixed animation cells are bounded before queuing and completed sheets must match exact cell size', async () => {
  const bucket = new MockR2();
  await call(bucket, 'generate_character');
  for (const args of [
    { options: { sizeMode: 'fixed', width: 1025, height: 64 } },
    { frames: 24, directions: 1, options: { sizeMode: 'fixed', width: 1024, height: 64 } },
    { frames: 8, directions: 8, options: { sizeMode: 'fixed', width: 1024, height: 1024 } },
    { options: { sizeMode: 'fixed', width: 16, height: 32, padding: 8 } },
  ]) {
    const result = (await call(bucket, 'request_animation_export', args)).value.result;
    assert.equal(result.isError, true, JSON.stringify(args)); assert.equal(result.structuredContent.error.status, 400);
  }
  assert.equal((await sceneOf(bucket)).exportJob, null);
  const queued = (await call(bucket, 'request_animation_export', { frames: 8, directions: 4, options: { sizeMode: 'fixed', width: 32, height: 48, padding: 4, fit: 'contain', scale: 2 } })).value.result.structuredContent;
  const job = queued.exportJob, path = `/api/exports/${job.id}`;
  assert.equal(job.scene.output.width, 32); assert.equal(job.scene.output.height, 48); assert.equal(job.scene.output.scale, 2);
  assert.equal((await api(bucket, path, { method: 'POST', bytes: rgbaPng(256, 128) })).status, 400);
  const complete = await api(bucket, path, { method: 'POST', bytes: rgbaPng(256, 192), headers: { 'x-foundry-anchor-x': '16', 'x-foundry-anchor-y': '44' } });
  assert.equal(complete.status, 200); assert.equal(complete.value.exportJob.metadata.cellWidth, 32); assert.equal(complete.value.exportJob.metadata.cellHeight, 48);
  assert.deepEqual(complete.value.exportJob.metadata.anchorPixels, [16, 44]);
});

test('connected-interior settings preserve floors, layout families, expanded capacity, and explicit furniture', async () => {
  const bucket = new MockR2();
  const newTypes = ['round_table', 'bench', 'stool', 'bar', 'counter', 'stove', 'sink', 'workbench', 'crate', 'sack', 'cupboard', 'wardrobe', 'washbasin', 'fireplace'];
  const items = newTypes.map((type, i) => ({ id: `new-${type}`, type, x: i % 5 - 2, z: Math.floor(i / 5) - 1 }));
  const generated = (await call(bucket, 'generate_interior', { config: { preset: 'inn', width: 20, depth: 18, floorCount: 3, floorIndex: 2, layoutVariant: 5, bedrooms: 6, beds: 12, tables: 12, kitchen: true, stairs: true, occupants: false, seed: 719, items } })).value.result.structuredContent;
  const config = generated.scene.config;
  assert.equal(config.width, 20); assert.equal(config.depth, 18); assert.equal(config.floorCount, 3); assert.equal(config.floorIndex, 2);
  assert.equal(config.layoutVariant, 5); assert.equal(config.bedrooms, 6); assert.equal(config.beds, 12); assert.equal(config.tables, 12);
  assert.equal(config.kitchen, true); assert.equal(config.stairs, true); assert.equal(config.occupants, false);
  assert.deepEqual(config.items.map(item => item.type), newTypes);
  const changed = (await call(bucket, 'update_interior', { patch: { layoutVariant: 'auto', kitchen: false, stairs: false, occupants: true }, expectedRevision: generated.revision })).value.result.structuredContent;
  assert.equal(changed.scene.config.layoutVariant, 'auto'); assert.equal(changed.scene.config.kitchen, false); assert.equal(changed.scene.config.stairs, false);
  assert.equal(changed.scene.config.occupants, true); assert.equal(changed.scene.config.seed, 719); assert.equal(changed.scene.config.floorIndex, 2);
  for (const patch of [{ width: 21 }, { depth: 5 }, { tables: 13 }, { beds: 13 }, { bedrooms: 7 }, { floorCount: 4 }, { floorCount: 2 }, { floorIndex: 3 }, { floorIndex: 1.5 }, { layoutVariant: 6 }, { layoutVariant: '2' }, { layoutVariant: null }, { kitchen: 'yes' }, { occupants: 1 }]) {
    const result = (await call(bucket, 'update_interior', { patch })).value.result;
    assert.equal(result.isError, true, JSON.stringify(patch)); assert.equal(result.structuredContent.error.status, 400);
  }
  const missingFloor = (await call(bucket, 'generate_interior', { config: { preset: 'cottage', floorIndex: 1 } })).value.result;
  assert.equal(missingFloor.isError, true); assert.match(missingFloor.content[0].text, /floorIndex/);
  assert.equal((await sceneOf(bucket)).revision, changed.revision);
  const lowerFloor = (await call(bucket, 'update_interior', { patch: { floorCount: 1, floorIndex: 0, stairs: true } })).value.result.structuredContent;
  assert.equal(lowerFloor.scene.config.floorCount, 1); assert.equal(lowerFloor.scene.config.floorIndex, 0); assert.equal(lowerFloor.scene.config.stairs, false);
  const listed = (await call(bucket, 'list_templates')).value.result.structuredContent;
  assert.equal(listed.furnitureTypes.length, 22); for (const type of newTypes) assert.ok(listed.furnitureTypes.includes(type));
  assert.deepEqual(listed.limits.interior.width, [6, 20]); assert.deepEqual(listed.limits.interior.beds, [0, 12]);
  assert.equal(listed.templates.find(value => value.kind === 'interior' && value.preset === 'tavern').config.floorCount, 2);
  assert.equal(listed.templates.find(value => value.kind === 'interior' && value.preset === 'inn').config.floorCount, 3);
});

test('all still scenes retain native HD detail and immutable geometry snapshots while animation caps stay unchanged', async () => {
  for (const name of ['generate_house','generate_interior','generate_map','generate_character']) {
    const bucket = new MockR2(), made = (await call(bucket,name)).value.result.structuredContent;
    assert.equal(made.scene.output.resolution,512,'Ordinary defaults remain unchanged');
    for (const resolution of [2048,4096]) {
      const queued = (await call(bucket,'request_export',{options:{resolution,scale:1,style:'illustrated',sizeMode:'auto'}})).value.result.structuredContent;
      assert.equal(queued.exportJob.scene.output.resolution,resolution,name);assert.equal(queued.exportJob.scene.output.scale,1);
      assert.equal(queued.exportJob.scene.output.pixelated,false);assert.equal(queued.exportJob.scene.output.sizeMode,'auto');
      assert.equal(queued.scene.output.resolution,512,'An export override must not change the editable scene');
      assert.deepEqual(queued.exportJob.scene.params||queued.exportJob.scene.config,made.scene.params||made.scene.config,'HD uses the identical geometry and seed');
      await call(bucket,'cancel_export');
    }
    for(const resolution of [4095,8192,'4096'])assert.equal((await call(bucket,'request_export',{options:{resolution}})).value.result.isError,true);
    const saved = await api(bucket,'/api/scene',{method:'POST',json:{scene:{...made.scene,output:{...made.scene.output,resolution:4096,scale:1}}}});
    assert.equal(saved.status,200);assert.equal(saved.value.scene.output.resolution,4096);
    if(name==='generate_character'){
      for(const resolution of [2048,4096])assert.equal((await call(bucket,'request_animation_export',{options:{resolution}})).value.result.isError,true);
      const animation=(await call(bucket,'request_animation_export',{})).value.result.structuredContent;
      assert.equal(animation.exportJob.scene.output.resolution,512);assert.equal(animation.scene.output.resolution,4096);
      await call(bucket,'cancel_export');
    }
    const transitioned=(await call(bucket,'generate_house')).value.result.structuredContent;
    assert.equal(transitioned.scene.output.resolution,4096,'Scene-kind changes preserve chosen still detail');
    const fixed=(await call(bucket,'request_export',{options:{resolution:4096,scale:1,sizeMode:'fixed',width:2048,height:3072,padding:16,fit:'contain'}})).value.result.structuredContent;
    assert.equal(fixed.exportJob.scene.output.width,2048);assert.equal(fixed.exportJob.scene.output.height,3072);assert.equal(fixed.exportJob.scene.output.resolution,4096);
  }
  const limits=(await call(new MockR2(),'list_templates')).value.result.structuredContent.limits;
  assert.equal(limits.stillExport.maxResolution,4096);assert.equal(limits.stillExport.maxNativeRenderPixels,16777216);
  assert.equal(limits.stillExport.maxPngPixels,33554432);assert.equal(limits.stillExport.maxPngBytes,16*1024*1024);
  assert.equal(limits.animationExport.maxResolution,512);
});
