import { normalizeInterior, INTERIOR_PRESETS, INTERIOR_ITEM_TYPES } from '../dist/interior-schema.mjs';
import { interpretBrief } from '../dist/director.mjs';
import { normalizeHouse, HOUSE_PRESETS } from '../dist/house-schema.mjs';
import { normalizeMap, MAP_PRESETS } from '../dist/map-schema.mjs';
import { normalizeCharacter, CHARACTER_PRESETS, CHARACTER_ANIMATIONS, CHARACTER_ANIMATION_DURATIONS } from '../dist/character-schema.mjs';

// Replaced by scripts/build-worker.mjs. No filesystem or external asset host is
// needed at runtime; only owner-scoped scene/export data goes into R2.
const STATIC_ASSETS = /*__STATIC_ASSETS__*/ {};
const JSON_LIMIT = 256 * 1024;
const LAYOUT_LIMIT = 64 * 1024;
const PNG_LIMIT = 16 * 1024 * 1024;
const STILL_RESOLUTIONS = [128, 192, 256, 384, 512, 768, 1024, 2048, 4096];
const PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SERVER_INFO = { name: 'village-foundry-mcp', title: 'Village Foundry MCP', version: '1.0.0' };
const encoder = new TextEncoder();
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const JOB_PATTERN = /^[a-f0-9-]{36}$/;
const has = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));

class HttpError extends Error {
  constructor(status, message, code = 'request_error', details = undefined) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
class RpcError extends HttpError {
  constructor(code, message, details, status = 400) { super(status, message, code, details); }
}
const invalid = message => { throw new HttpError(400, message, 'invalid_input'); };
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers,
  } });
}
function publicError(error) {
  if (error instanceof HttpError) return { message: error.message, code: error.code, status: error.status, ...(error.details === undefined ? {} : { details: error.details }) };
  console.error('Village Foundry MCP worker error', error);
  return { message: 'The scene service could not complete this request. Try again.', code: 'internal_error', status: 500 };
}
function requireOwner(request) {
  // This identity is supplied by the authenticated Sites gateway. Never accept
  // a user ID from request JSON, query strings, cookies, or an anonymous default.
  const id = request.headers.get('oai-authenticated-user-id')?.trim();
  if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) throw new HttpError(401, 'Sign in to use your private scene and exports.', 'authentication_required');
  return encodeURIComponent(id);
}
function requireBucket(env) {
  if (!env?.BUCKET?.get || !env.BUCKET.put) throw new HttpError(503, 'Private scene storage is not configured for this deployment.', 'storage_unavailable');
  return env.BUCKET;
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'This write must come from the same site origin.', 'origin_denied');
}
async function boundedBody(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, `Request body exceeds the ${limit} byte limit.`, 'body_too_large');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new HttpError(413, `Request body exceeds the ${limit} byte limit.`, 'body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Send JSON with Content-Type: application/json.', 'unsupported_media_type');
  const bytes = await boundedBody(request, JSON_LIMIT);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'The request body is not valid UTF-8 JSON.', 'invalid_json'); }
}
function requireObject(value, label) { if (!plain(value)) invalid(`${label} must be an object.`); return value; }
function finiteNumber(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(`${label} must be ${integer ? 'an integer' : 'a finite number'} from ${min} to ${max}.`);
  return value;
}
function expectedRevision(value) {
  if (value === undefined) return undefined;
  return finiteNumber(value, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER, true);
}
function safeItem(item, label = 'Furniture item') {
  requireObject(item, label);
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) invalid(`${label}.id must contain 1–80 letters, digits, underscores, or hyphens.`);
  if (!INTERIOR_ITEM_TYPES.includes(item.type)) invalid(`${label}.type must be one of: ${INTERIOR_ITEM_TYPES.join(', ')}.`);
  const output = { id: item.id, type: item.type,
    x: finiteNumber(item.x, `${label}.x`, -64, 64), z: finiteNumber(item.z, `${label}.z`, -64, 64) };
  if (has(item, 'rotation')) output.rotation = finiteNumber(item.rotation, `${label}.rotation`, -36000, 36000);
  if (has(item, 'scale')) output.scale = finiteNumber(item.scale, `${label}.scale`, 0.7, 1.5);
  return output;
}
function validatedConfig(raw) {
  requireObject(raw, 'Interior configuration');
  if (has(raw, 'preset') && (typeof raw.preset !== 'string' || !has(INTERIOR_PRESETS, raw.preset))) invalid('Unknown room preset. Choose tavern, cottage, inn, or workshop.');
  const input = {}, numeric = { width: [6, 20], depth: [6, 20], wallHeight: [1.8, 3.2], tables: [0, 12], beds: [0, 12], bedrooms: [0, 6], floorIndex: [0, 2], floorCount: [1, 3], seed: [0, 4294967295] };
  if (has(raw, 'preset')) input.preset = raw.preset;
  for (const [key, range] of Object.entries(numeric)) if (has(raw, key)) input[key] = finiteNumber(raw[key], key, ...range, ['tables', 'beds', 'bedrooms', 'floorIndex', 'floorCount', 'seed'].includes(key));
  for (const key of ['bar', 'fireplace', 'shelves', 'barrels', 'rug', 'clearCenter', 'kitchen', 'stairs', 'occupants', 'useTextures', 'usePaintedSurfaces']) if (has(raw, key)) {
    if (typeof raw[key] !== 'boolean') invalid(`${key} must be true or false.`); input[key] = raw[key];
  }
  if (has(raw, 'barSide')) {
    if (!['back', 'left', 'right'].includes(raw.barSide)) invalid('barSide must be back, left, or right.'); input.barSide = raw.barSide;
  }
  if (has(raw, 'layoutVariant')) {
    if (raw.layoutVariant !== 'auto') finiteNumber(raw.layoutVariant, 'layoutVariant', 0, 5, true);
    input.layoutVariant = raw.layoutVariant;
  }
  for (const key of ['woodColor', 'floorColor', 'wallColor', 'accentColor']) if (has(raw, key)) {
    if (typeof raw[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw[key])) invalid(`${key} must be a six-digit #RRGGBB color.`); input[key] = raw[key].toLowerCase();
  }
  if (has(raw, 'items')) {
    if (!Array.isArray(raw.items) || raw.items.length > 100) invalid('items must be an array of at most 100 furniture items.');
    input.items = raw.items.map((item, index) => safeItem(item, `items[${index}]`));
    if (new Set(input.items.map(item => item.id)).size !== input.items.length) invalid('Furniture item IDs must be unique.');
  }
  if (has(raw, 'excludeIds')) {
    if (!Array.isArray(raw.excludeIds) || raw.excludeIds.length > 300 || raw.excludeIds.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))) invalid('excludeIds must contain at most 300 valid furniture IDs.');
    input.excludeIds = [...new Set(raw.excludeIds)];
  }
  const normalized = normalizeInterior(input);
  if (has(input, 'floorIndex') && input.floorIndex >= normalized.floorCount) invalid('floorIndex must be smaller than floorCount. Floors are indexed from zero.');
  return normalized;
}
function validatedHouse(raw) {
  requireObject(raw, 'House parameters');
  if (has(raw, 'preset') && (typeof raw.preset !== 'string' || !has(HOUSE_PRESETS, raw.preset))) invalid('Unknown house preset. Choose village, cottage, inn, manor, or source.');
  const input = {}, numeric = { width: [3, 8], depth: [3, 10], floors: [1, 3], floorHeight: [1.45, 2.25], roofPitch: [25, 65], seed: [0, 4294967295], paintSeed: [0, 4294967295] };
  if (has(raw, 'preset')) input.preset = raw.preset;
  for (const [key, range] of Object.entries(numeric)) if (has(raw, key)) input[key] = finiteNumber(raw[key], key, ...range, ['floors', 'seed', 'paintSeed'].includes(key));
  for (const key of ['chimney', 'dormer', 'porch', 'shutters', 'planters', 'sideWing', 'timber', 'useTextures', 'usePaintedSurfaces', 'exposedRafters']) if (has(raw, key)) {
    if (typeof raw[key] !== 'boolean') invalid(`${key} must be true or false.`); input[key] = raw[key];
  }
  for (const key of ['roofColor', 'wallColor', 'stoneColor', 'woodColor']) if (has(raw, key)) {
    if (typeof raw[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw[key])) invalid(`${key} must be a six-digit #RRGGBB color.`); input[key] = raw[key].toLowerCase();
  }
  for (const [key, allowed] of [['roofKind', ['tiles', 'shingles', 'thatch', 'metal']], ['wallKind', ['stone', 'brick', 'plaster']]]) if (has(raw, key)) {
    if (!allowed.includes(raw[key])) invalid(`${key} must be one of: ${allowed.join(', ')}.`); input[key] = raw[key];
  }
  return normalizeHouse(input);
}
function validatedMap(raw) {
  requireObject(raw, 'Map configuration');
  if (has(raw, 'preset') && (typeof raw.preset !== 'string' || !has(MAP_PRESETS, raw.preset))) invalid('Unknown map preset. Choose village, crossroads, riverside, or farm.');
  const input = {}, numeric = { width: [24, 256], depth: [24, 256], houseCount: [0, 32], seed: [0, 2147483647] };
  if (has(raw, 'preset')) input.preset = raw.preset;
  for (const [key, range] of Object.entries(numeric)) if (has(raw, key)) input[key] = finiteNumber(raw[key], key, ...range, true);
  for (const key of ['includeHouses', 'roads', 'fences', 'trees', 'water', 'gardens', 'sea']) if (has(raw, key)) {
    if (typeof raw[key] !== 'boolean') invalid(`${key} must be true or false.`); input[key] = raw[key];
  }
  if (has(raw, 'roadStyle')) { if (!['dirt', 'cobble'].includes(raw.roadStyle)) invalid('roadStyle must be dirt or cobble.'); input.roadStyle = raw.roadStyle; }
  if (has(raw, 'layoutStyle')) { if (raw.layoutStyle !== 'organic') invalid('layoutStyle must be organic.'); input.layoutStyle = raw.layoutStyle; }
  if (has(raw, 'landform')) { if (!['island', 'mainland'].includes(raw.landform)) invalid('landform must be island or mainland.'); input.landform = raw.landform; }
  if (has(raw, 'housePreset')) { if (typeof raw.housePreset !== 'string' || !(raw.housePreset === 'mixed' || has(HOUSE_PRESETS, raw.housePreset))) invalid('housePreset must be mixed, village, cottage, inn, manor, or source.'); input.housePreset = raw.housePreset; }
  for (const key of ['roofColor', 'woodColor', 'stoneColor', 'plasterColor']) if (has(raw, key)) {
    if (typeof raw[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw[key])) invalid(`${key} must be a six-digit #RRGGBB color.`); input[key] = raw[key].toLowerCase();
  }
  return normalizeMap(input);
}
function validatedCharacter(raw) {
  requireObject(raw, 'Character configuration');
  const input = {}, numeric = { seed: [0, 4294967295], height: [1.05, 2], time: [0, 3600], direction: [0, 360] };
  for (const [key, range] of Object.entries(numeric)) if (has(raw, key)) input[key] = finiteNumber(raw[key], key, ...range, key === 'seed');
  for (const [key, allowed] of [
    ['preset', Object.keys(CHARACTER_PRESETS)], ['build', ['slim', 'average', 'sturdy']],
    ['gender', ['female', 'male']], ['age', ['adult', 'child']],
    ['hair', ['short', 'swept', 'bob', 'braid']], ['beard', ['none', 'stubble', 'short']],
    ['animation', CHARACTER_ANIMATIONS], ['mouth', ['auto', 'closed', 'open', 'wide']],
  ]) if (has(raw, key)) {
    if (!allowed.includes(raw[key])) invalid(`${key} must be one of: ${allowed.join(', ')}.`); input[key] = raw[key];
  }
  for (const key of ['skinColor', 'hairColor', 'tunicColor', 'trouserColor', 'leatherColor', 'accentColor']) if (has(raw, key)) {
    if (typeof raw[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw[key])) invalid(`${key} must be a six-digit #RRGGBB color.`); input[key] = raw[key].toLowerCase();
  }
  return normalizeCharacter(input);
}
function recipeFinishes(raw, scene) {
  for (const name of ['materials', 'tints', 'paletteBase']) if (raw[name] !== undefined) {
    requireObject(raw[name], name); scene[name] = {};
    for (const key of ['roof', 'wall', 'wood', 'ground']) if (has(raw[name], key)) {
      const value = raw[name][key], valid = name === 'materials' ? typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value) : typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
      if (!valid) invalid(`${name}.${key} must be ${name === 'materials' ? 'a material identifier' : 'a six-digit #RRGGBB color'}.`);
      scene[name][key] = name === 'materials' ? value : value.toLowerCase();
    }
  }
  // Explicit house colors must survive the browser recipe wrapper: its model
  // uses these tints for edge colors as well as texture/material controls.
  if (scene.format === 'house-foundry') scene.tints = { roof: scene.params.roofColor, wall: scene.params.wallKind === 'plaster' ? scene.params.wallColor : scene.params.stoneColor, wood: scene.params.woodColor, ...(scene.tints || {}) };
  if (scene.tints) scene.paletteBase = { ...copy(scene.tints), ...(scene.paletteBase || {}) };
}
function normalizeScene(raw) {
  requireObject(raw, 'Scene');
  if (!['house-foundry', 'house-foundry-interior', 'village-foundry-map', 'village-foundry-character'].includes(raw.format) || raw.version !== 1) invalid('Choose a version 1 house, interior, map, or character scene recipe.');
  const scene = { format: raw.format, version: 1,
    view: { elevation: 45, azimuth: 0 }, output: { style: 'illustrated', resolution: 512, scale: 2, pixelated: false, outline: true, shadow: true,
      sizeMode: 'auto', width: 512, height: 512, padding: 8, fit: 'contain' } };
  if (raw.format === 'house-foundry') scene.params = validatedHouse(raw.params);
  else if (raw.format === 'house-foundry-interior') scene.config = validatedConfig(raw.config);
  else if (raw.format === 'village-foundry-map') scene.config = validatedMap(raw.config);
  else scene.config = validatedCharacter(raw.config);
  recipeFinishes(raw, scene);
  if (raw.view !== undefined) {
    requireObject(raw.view, 'view');
    if (has(raw.view, 'elevation')) scene.view.elevation = finiteNumber(raw.view.elevation, 'view.elevation', 0, 90);
    if (has(raw.view, 'azimuth')) scene.view.azimuth = finiteNumber(raw.view.azimuth, 'view.azimuth', -180, 180);
  }
  if (raw.output !== undefined) {
    requireObject(raw.output, 'output');
    if (has(raw.output, 'resolution')) {
      if (!STILL_RESOLUTIONS.includes(raw.output.resolution)) invalid(`output.resolution must be one of: ${STILL_RESOLUTIONS.join(', ')}.`); scene.output.resolution = raw.output.resolution;
    }
    if (has(raw.output, 'scale')) scene.output.scale = finiteNumber(raw.output.scale, 'output.scale', 1, 4, true);
    for (const key of ['pixelated', 'outline', 'shadow']) if (has(raw.output, key)) {
      if (typeof raw.output[key] !== 'boolean') invalid(`output.${key} must be true or false.`); scene.output[key] = raw.output[key];
    }
    if (has(raw.output, 'style')) {
      if (!['illustrated', 'pixel'].includes(raw.output.style)) invalid('output.style must be illustrated or pixel.');
      scene.output.style = raw.output.style;
      if (!has(raw.output, 'pixelated')) scene.output.pixelated = raw.output.style === 'pixel';
    } else if (has(raw.output, 'pixelated')) scene.output.style = raw.output.pixelated ? 'pixel' : 'illustrated';
    if ((scene.output.style === 'pixel') !== scene.output.pixelated) invalid('output.style and output.pixelated must describe the same rendering style.');
    if (has(raw.output, 'sizeMode')) {
      if (!['auto', 'fixed'].includes(raw.output.sizeMode)) invalid('output.sizeMode must be auto or fixed.'); scene.output.sizeMode = raw.output.sizeMode;
    }
    for (const key of ['width', 'height']) if (has(raw.output, key)) scene.output[key] = finiteNumber(raw.output[key], `output.${key}`, 16, 8192, true);
    if (has(raw.output, 'padding')) scene.output.padding = finiteNumber(raw.output.padding, 'output.padding', 0, 128, true);
    if (has(raw.output, 'fit')) {
      if (!['contain', 'pad'].includes(raw.output.fit)) invalid('output.fit must be contain or pad.'); scene.output.fit = raw.output.fit;
    }
    if (scene.output.padding * 2 >= Math.min(scene.output.width, scene.output.height)) invalid('output.padding must be smaller than half the canvas width and height.');
    if (scene.output.width * scene.output.height > 33554432) invalid('The fixed output canvas must contain at most 33554432 pixels.');
  }
  return scene;
}
function defaultScene() { return normalizeScene({ format: 'house-foundry-interior', version: 1, config: { preset: 'tavern', seed: 742 } }); }
function normalizeLayout(value) {
  if (value === null || value === undefined) return null;
  if (!plain(value) && !Array.isArray(value)) invalid('layout must be a JSON object, array, or null.');
  if (encoder.encode(JSON.stringify(value)).byteLength > LAYOUT_LIMIT) invalid('layout exceeds the 64 KiB limit.');
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 8000 || depth > 16) invalid('layout is too deeply nested or complex.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid('layout numbers must be finite.'); return item; }
    if (typeof item === 'string') { if (item.length > 8192) invalid('layout strings must be at most 8192 characters.'); return item; }
    if (Array.isArray(item)) { if (item.length > 2000) invalid('layout arrays must have at most 2000 entries.'); return item.map(child => visit(child, depth + 1)); }
    if (!plain(item)) invalid('layout must contain only JSON data.');
    const out = {};
    for (const [key, child] of Object.entries(item)) {
      if (key.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid('layout contains an unsupported property name.');
      out[key] = visit(child, depth + 1);
    }
    return out;
  }
  return visit(value, 0);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function emptyRecord() { return { scene: defaultScene(), revision: 0, layout: null, exportJob: null }; }
async function readRecord(bucket, owner) {
  const object = await bucket.get(`scenes/${owner}.json`);
  if (!object) return { record: emptyRecord(), etag: null };
  const record = await object.json();
  if (!plain(record) || !Number.isInteger(record.revision) || !record.scene) throw new HttpError(500, 'The saved scene could not be read.', 'invalid_saved_scene');
  return { record, etag: object.etag };
}
function checkRevision(record, expected) {
  if (expected !== undefined && record.revision !== expected) throw new HttpError(409, 'The scene changed since you loaded it. Fetch the latest scene and retry.', 'revision_conflict', { revision: record.revision });
}
async function writeRecord(bucket, owner, previous, record) {
  const saved = await bucket.put(`scenes/${owner}.json`, JSON.stringify(record), {
    onlyIf: previous.etag ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  if (!saved) throw new HttpError(409, 'Another request changed this scene. Fetch the latest scene and retry.', 'revision_conflict');
  return record;
}
async function saveScene(bucket, owner, previous, scene, layout, expected) {
  checkRevision(previous.record, expected);
  const sameScene = canonical(scene) === canonical(previous.record.scene);
  const nextLayout = layout === undefined ? (sameScene ? previous.record.layout : null) : normalizeLayout(layout);
  if (sameScene && canonical(nextLayout) === canonical(previous.record.layout)) return previous.record;
  const next = { ...previous.record, scene, layout: nextLayout, revision: previous.record.revision + 1 };
  // A queued render keeps its own immutable scene snapshot through later edits.
  return writeRecord(bucket, owner, previous, next);
}

const integerRevision = { type: 'integer', minimum: 0, description: 'Optional optimistic concurrency guard. Use revision from get_scene.' };
const configSchema = { type: 'object', description: 'Room configuration. Fields are validated and whitelisted; existing generated-object IDs can be excluded.', properties: {
  preset: { type: 'string', enum: Object.keys(INTERIOR_PRESETS) }, width: { type: 'number', minimum: 6, maximum: 20 }, depth: { type: 'number', minimum: 6, maximum: 20 },
  wallHeight: { type: 'number', minimum: 1.8, maximum: 3.2 }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
  tables: { type: 'integer', minimum: 0, maximum: 12 }, beds: { type: 'integer', minimum: 0, maximum: 12 },
  bedrooms: { type: 'integer', minimum: 0, maximum: 6 }, floorIndex: { type: 'integer', minimum: 0, maximum: 2, description: 'Zero-based floor index, smaller than floorCount.' }, floorCount: { type: 'integer', minimum: 1, maximum: 3 },
  layoutVariant: { oneOf: [{ type: 'string', enum: ['auto'] }, { type: 'integer', minimum: 0, maximum: 5 }], description: 'Auto chooses a seeded plan; a number selects one of six layout families.' },
  bar: { type: 'boolean' }, barSide: { type: 'string', enum: ['back', 'left', 'right'] },
  fireplace: { type: 'boolean' }, shelves: { type: 'boolean' }, barrels: { type: 'boolean' }, rug: { type: 'boolean' }, clearCenter: { type: 'boolean' }, kitchen: { type: 'boolean' }, stairs: { type: 'boolean' }, occupants: { type: 'boolean' }, useTextures: { type: 'boolean' }, usePaintedSurfaces: { type: 'boolean' },
  woodColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, floorColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, wallColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, accentColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  excludeIds: { type: 'array', maxItems: 300, items: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' } },
}, additionalProperties: false };
const itemSchema = { type: 'object', properties: {
  id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, type: { type: 'string', enum: INTERIOR_ITEM_TYPES },
  x: { type: 'number', minimum: -64, maximum: 64, description: 'Room-centered horizontal world coordinate.' },
  z: { type: 'number', minimum: -64, maximum: 64, description: 'Room-centered depth coordinate. The browser checks room fit and collisions.' },
  rotation: { type: 'number', minimum: -36000, maximum: 36000, description: 'Rotation in degrees.' }, scale: { type: 'number', minimum: 0.7, maximum: 1.5 },
}, required: ['id', 'type', 'x', 'z'], additionalProperties: false };
configSchema.properties.items = { type: 'array', maxItems: 100, items: itemSchema };
const colorRule = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const houseSchema = { type: 'object', properties: {
  preset: { type: 'string', enum: Object.keys(HOUSE_PRESETS) }, width: { type: 'number', minimum: 3, maximum: 8 }, depth: { type: 'number', minimum: 3, maximum: 10 },
  floors: { type: 'integer', minimum: 1, maximum: 3 }, floorHeight: { type: 'number', minimum: 1.45, maximum: 2.25 }, roofPitch: { type: 'number', minimum: 25, maximum: 65 }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
  paintSeed: { type: 'integer', minimum: 0, maximum: 4294967295, description: 'Optional surface-paint seed; defaults to the house seed. Shared map finishes can retain this independently of geometry variation.' },
  roofColor: colorRule, wallColor: colorRule, stoneColor: colorRule, woodColor: colorRule,
  roofKind: { type: 'string', enum: ['tiles', 'shingles', 'thatch', 'metal'] }, wallKind: { type: 'string', enum: ['stone', 'brick', 'plaster'] },
  ...Object.fromEntries(['chimney', 'dormer', 'porch', 'shutters', 'planters', 'sideWing', 'timber', 'useTextures', 'usePaintedSurfaces', 'exposedRafters'].map(key => [key, { type: 'boolean' }])),
}, additionalProperties: false };
const mapSchema = { type: 'object', properties: {
  preset: { type: 'string', enum: Object.keys(MAP_PRESETS) }, seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
  width: { type: 'integer', minimum: 24, maximum: 256 }, depth: { type: 'integer', minimum: 24, maximum: 256 }, houseCount: { type: 'integer', minimum: 0, maximum: 32 },
  ...Object.fromEntries(['includeHouses', 'roads', 'fences', 'trees', 'water', 'gardens', 'sea'].map(key => [key, { type: 'boolean' }])),
  roadStyle: { type: 'string', enum: ['dirt', 'cobble'] }, housePreset: { type: 'string', enum: ['mixed', ...Object.keys(HOUSE_PRESETS)] },
  layoutStyle: { type: 'string', enum: ['organic'], description: 'Seeded organic placement with connected paths and plot spacing.' },
  landform: { type: 'string', enum: ['island', 'mainland'], description: 'Island uses its visible coastline for terrain and placement; mainland keeps a rectangular terrain patch.' },
  roofColor: colorRule, woodColor: colorRule, stoneColor: colorRule, plasterColor: colorRule,
}, additionalProperties: false };
const characterPoseProperties = {
  animation: { type: 'string', enum: CHARACTER_ANIMATIONS },
  time: { type: 'number', minimum: 0, maximum: 3600, description: 'Animation time in seconds; clips loop at their listed duration.' },
  direction: { type: 'number', minimum: 0, maximum: 360, description: 'Facing angle in degrees. Zero faces positive Z.' },
  mouth: { type: 'string', enum: ['auto', 'closed', 'open', 'wide'] },
};
const characterSchema = { type: 'object', properties: {
  preset: { type: 'string', enum: Object.keys(CHARACTER_PRESETS) }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
  height: { type: 'number', minimum: 1.05, maximum: 2 }, build: { type: 'string', enum: ['slim', 'average', 'sturdy'] },
  gender: { type: 'string', enum: ['female', 'male'] }, age: { type: 'string', enum: ['adult', 'child'] },
  hair: { type: 'string', enum: ['short', 'swept', 'bob', 'braid'] }, beard: { type: 'string', enum: ['none', 'stubble', 'short'] },
  ...Object.fromEntries(['skinColor', 'hairColor', 'tunicColor', 'trouserColor', 'leatherColor', 'accentColor'].map(key => [key, colorRule])),
  ...characterPoseProperties,
}, additionalProperties: false };
const exportProperties = { resolution: { type: 'integer', enum: STILL_RESOLUTIONS, description: 'Native geometry detail density for any still scene. For a master PNG, use 4096 with scale 1, illustrated style, and auto size. Resolution is a world-density reference, not an exact PNG side length; the browser reports render-budget errors rather than silently reducing detail.' }, scale: { type: 'integer', minimum: 1, maximum: 4, description: 'Illustrated auto or pad output increases native geometry sampling with scale; pixel output enlarges the native pixel grid by an integer factor. Fixed contain output uses the requested final canvas dimensions. Use scale 1 with resolution 4096 for a native master.' }, style: { type: 'string', enum: ['illustrated', 'pixel'] }, pixelated: { type: 'boolean' },
  sizeMode: { type: 'string', enum: ['auto', 'fixed'], description: 'Auto keeps the rendered sprite size; fixed uses the exact requested transparent canvas.' },
  width: { type: 'integer', minimum: 16, maximum: 8192 }, height: { type: 'integer', minimum: 16, maximum: 8192 },
  padding: { type: 'integer', minimum: 0, maximum: 128, description: 'Transparent padding in final output pixels, smaller than half either canvas dimension.' },
  fit: { type: 'string', enum: ['contain', 'pad'], description: 'Contain preserves aspect ratio while fitting; pad preserves sprite scale and fails if it cannot fit.' },
};
const animationExportProperties = { ...exportProperties, resolution: { type: 'integer', enum: [128, 192, 256, 384, 512] }, scale: { type: 'integer', minimum: 1, maximum: 2 },
  width: { type: 'integer', minimum: 16, maximum: 1024, description: 'Fixed final width of each animation cell.' }, height: { type: 'integer', minimum: 16, maximum: 1024, description: 'Fixed final height of each animation cell.' },
};
const tool = (name, description, properties = {}, required = [], readOnly = false) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: /^(generate_|update_|set_|place_|remove_|cancel_)/.test(name), idempotentHint: readOnly || name.startsWith('update_') || ['set_character_animation', 'place_furniture', 'remove_furniture', 'cancel_export'].includes(name), openWorldHint: false },
});
const TOOLS = [
  tool('list_templates', 'List procedural house, interior, map, and character templates, furniture types, animation durations, and configuration limits. No image generation is used.', {}, [], true),
  tool('get_scene', 'Read your current house, interior, map, or character scene, revision, last browser-computed layout, and export-job status.', {}, [], true),
  tool('generate_house', 'Create a house from explicit template parameters. This replaces your current scene; rendering occurs in the open browser app.', { params: houseSchema, expectedRevision: integerRevision }),
  tool('update_house', 'Patch parameters of the current house scene. Unspecified fields are retained.', { patch: houseSchema, expectedRevision: integerRevision }, ['patch']),
  tool('generate_map', 'Create a village map with optional generated houses, roads, fences, trees, water, and gardens. This replaces your current scene.', { config: mapSchema, expectedRevision: integerRevision }),
  tool('update_map', 'Patch parameters of the current village map. Unspecified fields are retained.', { patch: mapSchema, expectedRevision: integerRevision }, ['patch']),
  tool('generate_character', 'Create a procedural innkeeper, ranger, villager, or blacksmith with editable appearance and animation. This replaces your current scene.', { config: characterSchema, expectedRevision: integerRevision }),
  tool('update_character', 'Patch the current character appearance or pose. Unspecified fields are retained.', { patch: characterSchema, expectedRevision: integerRevision }, ['patch']),
  tool('set_character_animation', 'Set the current character animation, time, facing direction, or mouth pose without changing its identity or clothing. Changing animation resets time to zero unless supplied.', { ...characterPoseProperties, expectedRevision: integerRevision }),
  tool('generate_interior', 'Create a room from explicit configuration and optional simple layout instructions. This replaces your current interior scene; rendering occurs in the open browser app.', { config: configSchema, brief: { type: 'string', maxLength: 4000 }, expectedRevision: integerRevision }),
  tool('update_interior', 'Patch your current room configuration. Unspecified fields are retained; use expectedRevision to avoid overwriting another edit.', { patch: configSchema, expectedRevision: integerRevision }, ['patch']),
  tool('place_furniture', 'Add or replace a furniture item by stable ID at exact room-centered x/z coordinates. Browser layout reports collisions or items that do not fit.', { item: itemSchema, expectedRevision: integerRevision }, ['item']),
  tool('remove_furniture', 'Remove a custom item or exclude an automatically placed item by ID from the latest layout.', { id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, expectedRevision: integerRevision }, ['id']),
  tool('request_export', 'Queue a still PNG of an immutable snapshot of any scene, including a character pose. A native HD master uses resolution 4096, scale 1, illustrated style, and auto size; the open browser rerenders the same geometry. Exact transparent canvases support contain or pad fitting. Keep the app open with Follow MCP changes enabled; get_scene reports when its private PNG is ready.', { options: { type: 'object', properties: exportProperties, additionalProperties: false }, expectedRevision: integerRevision }),
  tool('request_animation_export', 'Queue one seamless character animation cycle as a PNG sprite sheet. Columns are frames, rows are facing directions. Requires the open app with Follow MCP changes enabled. Default 8 frames, 4 directions, 8 fps; inherited output is capped at resolution 512 and scale 2.', {
    animation: characterPoseProperties.animation, frames: { type: 'integer', minimum: 4, maximum: 24 }, directions: { type: 'integer', enum: [1, 4, 8] }, fps: { type: 'integer', minimum: 1, maximum: 24 },
    options: { type: 'object', properties: animationExportProperties, additionalProperties: false }, expectedRevision: integerRevision,
  }),
  tool('cancel_export', 'Cancel your latest pending export so another request can be queued. Optionally specify the job ID and expectedRevision to avoid cancelling a newer request. Ready or already-cancelled jobs are reported without changing them; late PNG completion is rejected.', {
    id: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, expectedRevision: integerRevision,
  }),
];

function applyExportOutput(scene, raw, animated = false) {
  const requested = raw === undefined ? {} : requireObject(raw, 'options');
  if (Object.keys(requested).some(key => !['resolution', 'scale', 'style', 'pixelated', 'sizeMode', 'width', 'height', 'padding', 'fit'].includes(key))) invalid('Export options support resolution, scale, style, pixelated, sizeMode, width, height, padding, and fit only.');
  if (animated) {
    if (has(requested, 'resolution') && ![128, 192, 256, 384, 512].includes(requested.resolution)) invalid('Animation resolution must be 128, 192, 256, 384, or 512.');
    if (has(requested, 'scale')) finiteNumber(requested.scale, 'Animation scale', 1, 2, true);
    for (const key of ['width', 'height']) if (has(requested, key)) finiteNumber(requested[key], `Animation cell ${key}`, 16, 1024, true);
  }
  const output = { ...scene.output,
    ...(animated ? { resolution: Math.min(scene.output.resolution, 512), scale: Math.min(scene.output.scale, 2) } : {}), ...requested };
  if (has(requested, 'style') && !has(requested, 'pixelated')) output.pixelated = requested.style === 'pixel';
  if (has(requested, 'pixelated') && !has(requested, 'style')) output.style = requested.pixelated ? 'pixel' : 'illustrated';
  scene.output = normalizeScene({ ...scene, output }).output;
  if (animated && scene.output.sizeMode === 'fixed' && (scene.output.width > 1024 || scene.output.height > 1024)) invalid('Fixed animation cells must be at most 1024 pixels wide and high.');
}
function animationExportOptions(args, scene) {
  const animation = args.animation === undefined ? scene.config.animation : args.animation;
  if (!CHARACTER_ANIMATIONS.includes(animation)) invalid(`animation must be one of: ${CHARACTER_ANIMATIONS.join(', ')}.`);
  const frames = finiteNumber(args.frames === undefined ? 8 : args.frames, 'frames', 4, 24, true);
  const directions = args.directions === undefined ? 4 : args.directions;
  if (![1, 4, 8].includes(directions)) invalid('directions must be 1, 4, or 8.');
  const fps = finiteNumber(args.fps === undefined ? 8 : args.fps, 'fps', 1, 24, true);
  if (scene.output.sizeMode === 'fixed') {
    const width = scene.output.width * frames, height = scene.output.height * directions;
    if (width > 16384 || height > 16384 || width * height > 40000000) invalid('The requested fixed animation cells would exceed the sprite-sheet limit of 16384 pixels per side or 40000000 pixels total. Reduce cell size, frames, or directions.');
  }
  const cycleDuration = CHARACTER_ANIMATION_DURATIONS[animation];
  const directionAngles = directions === 1 ? [scene.config.direction] : Array.from({ length: directions }, (_, i) => i * 360 / directions);
  const sampleTimes = Array.from({ length: frames }, (_, i) => Number((cycleDuration * i / frames).toFixed(12)));
  scene.config = validatedCharacter({ ...scene.config, animation, time: 0 });
  return { format: 'spritesheet', animation, frames, directions, fps, columns: frames, rows: directions, directionAngles, sampleTimes, cycleDuration, playbackDuration: frames / fps };
}
async function queueExport(bucket, owner, previous, scene, options) {
  const pending = previous.record.exportJob;
  if (pending?.status === 'pending') {
    // Include the layout and clip selection: an 8-frame request must not be
    // mistaken for a pending 24-frame request of the same character snapshot.
    if (canonical(pending.scene) === canonical(scene) && canonical(pending.options || { format: 'png' }) === canonical(options)) return { ...previous.record, note: 'This snapshot and export layout are already queued. Keep the app open with Follow MCP changes enabled.' };
    throw new HttpError(409, 'A different export is still pending. Render that request in the open app before queuing another.', 'export_pending', { jobId: pending.id });
  }
  const job = { id: crypto.randomUUID(), status: 'pending', requestedAt: new Date().toISOString(), scene: copy(scene), options: copy(options) };
  const record = await writeRecord(bucket, owner, previous, { ...previous.record, revision: previous.record.revision + 1, exportJob: job });
  return { ...record, note: 'Keep the app open with Follow MCP changes enabled. Its renderer will complete this PNG request; get_scene reports readiness and output metadata.' };
}
async function cancelExport(bucket, owner, previous, id, expected) {
  if (id !== undefined && (typeof id !== 'string' || !JOB_PATTERN.test(id))) invalid('id must be a valid export job ID.');
  checkRevision(previous.record, expected);
  const job = previous.record.exportJob;
  if (id !== undefined && job?.id !== id) throw new HttpError(404, 'This export request is not in your current scene queue.', 'export_not_found');
  if (!job) return { ...previous.record, cancelled: false, note: 'There is no pending export to cancel.' };
  if (job.status === 'ready') return { ...previous.record, cancelled: false, note: 'This export is already ready. Its completed PNG has been retained.' };
  if (job.status === 'cancelled') return { ...previous.record, cancelled: false, note: 'This export was already cancelled.' };
  if (job.status === 'failed') return { ...previous.record, cancelled: false, note: 'This export already failed. Its reported error has been retained; a new export can be queued.' };
  if (job.status !== 'pending') throw new HttpError(409, 'Only a pending export can be cancelled.', 'export_not_pending');
  const next = { ...previous.record, revision: previous.record.revision + 1, exportJob: { ...job, status: 'cancelled', cancelledAt: new Date().toISOString() } };
  const record = await writeRecord(bucket, owner, previous, next);
  return { ...record, cancelled: true, note: 'The pending export was cancelled. A new export can now be queued.' };
}

async function failExport(bucket, owner, previous, id, data) {
  if (Object.keys(data).some(key => !['code','message','expectedRevision'].includes(key))) invalid('Failure reports support code, message, and expectedRevision only.');
  if (!['render_budget_exceeded','invalid_geometry'].includes(data.code)) invalid('Failure code must be render_budget_exceeded or invalid_geometry. Transient connection errors must remain retryable.');
  if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.message)) invalid('Failure message must contain 1–1000 characters without unsupported control characters.');
  const expected = expectedRevision(data.expectedRevision), reason = {code:data.code,message:data.message.trim()};
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) previous = await readRecord(bucket, owner);
    checkRevision(previous.record, expected);
    const job = previous.record.exportJob;
    if (job?.id !== id) throw new HttpError(404, 'This export request is not in your current scene queue.', 'export_not_found');
    if (job.status !== 'pending') return {...previous.record,failed:false,note:`This export is already ${job.status}. Its existing result has been retained.`};
    const next = {...previous.record,revision:previous.record.revision+1,exportJob:{...job,status:'failed',failedAt:new Date().toISOString(),error:reason}};
    try {
      const saved = await writeRecord(bucket, owner, previous, next);
      return {...saved,failed:true,note:'The browser reported a deterministic render failure. Adjust the detail, canvas, or scene and request a new export.'};
    } catch (error) { if (!(error instanceof HttpError) || error.status !== 409 || attempt === 3) throw error; }
  }
}

async function callTool(name, args, request, env) {
  requireObject(args, 'Tool arguments');
  if (!TOOLS.some(entry => entry.name === name)) throw new HttpError(404, `Unknown tool: ${String(name).slice(0, 80)}`, 'unknown_tool');
  if (name === 'list_templates') return { templates: [
    ...Object.keys(HOUSE_PRESETS).map(preset => ({ kind: 'house', format: 'house-foundry', preset, params: normalizeHouse({ preset, seed: 742 }) })),
    ...Object.keys(INTERIOR_PRESETS).map(preset => ({ kind: 'interior', format: 'house-foundry-interior', preset, config: normalizeInterior({ preset, seed: 742 }) })),
    ...Object.keys(MAP_PRESETS).map(preset => ({ kind: 'map', format: 'village-foundry-map', preset, config: normalizeMap({ preset, seed: 742 }) })),
    ...Object.keys(CHARACTER_PRESETS).map(preset => ({ kind: 'character', format: 'village-foundry-character', preset, config: normalizeCharacter({ preset, seed: 742 }) })),
  ], furnitureTypes: INTERIOR_ITEM_TYPES, animations: CHARACTER_ANIMATIONS, animationDurations: CHARACTER_ANIMATION_DURATIONS,
    limits: { house: { width: [3, 8], depth: [3, 10], floors: [1, 3] }, interior: { width: [6, 20], depth: [6, 20], tables: [0, 12], beds: [0, 12], bedrooms: [0, 6], floorIndex: [0, 2], floorCount: [1, 3], layoutVariant: ['auto', 0, 1, 2, 3, 4, 5], customItems: 100 }, map: { width: [24, 256], depth: [24, 256], houseCount: [0, 32] }, character: { height: [1.05, 2], gender: ['female', 'male'], age: ['adult', 'child'], time: [0, 3600], direction: [0, 360] },
      stillExport: { resolutions: STILL_RESOLUTIONS, maxResolution: 4096, maxNativeRenderSide: 8192, maxNativeRenderPixels: 16777216, maxPngSide: 8192, maxPngPixels: 33554432, maxPngBytes: PNG_LIMIT },
      animationExport: { frames: [4, 24], directions: [1, 4, 8], fps: [1, 24], maxResolution: 512, maxScale: 2 } },
    note: 'Geometry is built from explicit parameters. Images can guide materials; no image model reconstructs a scene.' };
  const owner = requireOwner(request), bucket = requireBucket(env), previous = await readRecord(bucket, owner);
  if (name === 'get_scene') return previous.record;
  const expected = expectedRevision(args.expectedRevision); checkRevision(previous.record, expected);
  if (name === 'cancel_export') return cancelExport(bucket, owner, previous, args.id, expected);
  let scene = copy(previous.record.scene); let applied;
  const requiredFormat = { update_house: 'house-foundry', update_map: 'village-foundry-map', update_character: 'village-foundry-character', set_character_animation: 'village-foundry-character', request_animation_export: 'village-foundry-character', update_interior: 'house-foundry-interior', place_furniture: 'house-foundry-interior', remove_furniture: 'house-foundry-interior' }[name];
  if (requiredFormat && scene.format !== requiredFormat) throw new HttpError(400, `${name} needs a ${requiredFormat} scene. Generate or load that scene type first.`, 'wrong_scene_kind', { currentFormat: scene.format });
  if (name === 'generate_house') {
    scene = { format: 'house-foundry', version: 1, params: validatedHouse({ seed: 742, ...(args.params === undefined ? {} : requireObject(args.params, 'params')) }), view: scene.view, output: scene.output };
  } else if (name === 'update_house') {
    const patch = requireObject(args.patch, 'patch'); scene.params = validatedHouse({ ...scene.params, ...patch });
    for (const [field, slot] of [['roofColor', 'roof'], ['woodColor', 'wood']]) if (has(patch, field)) {
      scene.tints = { ...(scene.tints || {}), [slot]: scene.params[field] }; scene.paletteBase = { ...(scene.paletteBase || {}), [slot]: scene.params[field] };
    }
    const wallField = scene.params.wallKind === 'plaster' ? 'wallColor' : 'stoneColor';
    if (has(patch, 'wallKind') || has(patch, wallField)) {
      scene.tints = { ...(scene.tints || {}), wall: scene.params[wallField] }; scene.paletteBase = { ...(scene.paletteBase || {}), wall: scene.params[wallField] };
    }
  } else if (name === 'generate_map') {
    scene = { format: 'village-foundry-map', version: 1, config: validatedMap({ seed: 742, ...(args.config === undefined ? {} : requireObject(args.config, 'config')) }), view: scene.view, output: scene.output };
  } else if (name === 'update_map') {
    scene.config = validatedMap({ ...scene.config, ...requireObject(args.patch, 'patch') });
  } else if (name === 'generate_character') {
    scene = { format: 'village-foundry-character', version: 1, config: validatedCharacter({ seed: 742, ...(args.config === undefined ? {} : requireObject(args.config, 'config')) }), view: scene.view, output: scene.output };
  } else if (name === 'update_character') {
    scene.config = validatedCharacter({ ...scene.config, ...requireObject(args.patch, 'patch') });
  } else if (name === 'set_character_animation') {
    if (Object.keys(args).some(key => !['animation', 'time', 'direction', 'mouth', 'expectedRevision'].includes(key))) invalid('Character pose supports animation, time, direction, mouth, and expectedRevision only.');
    const patch = Object.fromEntries(['animation', 'time', 'direction', 'mouth'].filter(key => has(args, key)).map(key => [key, args[key]]));
    if (!Object.keys(patch).length) invalid('Supply an animation, time, direction, or mouth pose.');
    if (has(patch, 'animation') && !has(patch, 'time') && patch.animation !== scene.config.animation) patch.time = 0;
    scene.config = validatedCharacter({ ...scene.config, ...patch });
  } else if (name === 'generate_interior') {
    const config = args.config === undefined ? {} : requireObject(args.config, 'config');
    scene = { format: 'house-foundry-interior', version: 1, config: validatedConfig({ seed: 742, ...config }), view: scene.view, output: scene.output };
    if (args.brief !== undefined) {
      if (typeof args.brief !== 'string' || args.brief.length > 4000) invalid('brief must be at most 4000 characters.');
      const result = interpretBrief(args.brief, scene.config); scene.config = validatedConfig(result.config); applied = result.applied;
    }
  } else if (name === 'update_interior') {
    scene.config = validatedConfig({ ...scene.config, ...requireObject(args.patch, 'patch') });
  } else if (name === 'place_furniture') {
    const item = safeItem(args.item);
    const items = scene.config.items.filter(existing => existing.id !== item.id); items.push(item);
    scene.config = validatedConfig({ ...scene.config, items, excludeIds: scene.config.excludeIds.filter(id => id !== item.id) });
  } else if (name === 'remove_furniture') {
    if (typeof args.id !== 'string' || !ID_PATTERN.test(args.id)) invalid('id must contain 1–80 letters, digits, underscores, or hyphens.');
    scene.config = validatedConfig({ ...scene.config, items: scene.config.items.filter(item => item.id !== args.id), excludeIds: [...new Set([...scene.config.excludeIds, args.id])] });
  } else if (name === 'request_export' || name === 'request_animation_export') {
    const animated = name === 'request_animation_export';
    applyExportOutput(scene, args.options, animated);
    const options = animated ? animationExportOptions(args, scene) : { format: 'png' };
    return queueExport(bucket, owner, previous, scene, options);
  }
  // All still scene kinds share the same detail range. Animation requests
  // apply their smaller snapshot-only limits in applyExportOutput instead.
  const record = await saveScene(bucket, owner, previous, normalizeScene(scene), undefined, expected);
  return applied === undefined ? record : { ...record, applied };
}

function resultMeta(result) { return { ...result, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } }; }
function rpcReply(id, result, status = 200) { return json({ jsonrpc: '2.0', id, result: resultMeta(result) }, status, { 'MCP-Protocol-Version': '2026-07-28' }); }
function rpcFailure(id, error) {
  const info = publicError(error);
  const code = error instanceof RpcError ? error.code : info.status === 401 ? -32001 : info.status === 403 ? -32003 : info.status === 413 ? -32010 : info.status >= 500 ? -32603 : -32602;
  return json({ jsonrpc: '2.0', id: id ?? null, error: { code, message: info.message, ...(info.details === undefined ? {} : { data: info.details }) } }, info.status);
}
function checkRpcHeaders(request, message) {
  const method = request.headers.get('mcp-method'), name = request.headers.get('mcp-name');
  if ((method && method !== message.method) || (name && name !== message.params?.name)) throw new RpcError(-32020, 'MCP header does not match its JSON-RPC body.');
  const headerVersion = request.headers.get('mcp-protocol-version');
  const metaVersion = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (headerVersion && metaVersion && headerVersion !== metaVersion) throw new RpcError(-32020, 'MCP protocol header does not match request metadata.');
  const version = metaVersion || headerVersion;
  if (version && !PROTOCOLS.includes(version)) throw new RpcError(-32022, 'Unsupported protocol version', { supported: PROTOCOLS, requested: version });
  if (metaVersion === '2026-07-28' && !plain(message.params?._meta?.['io.modelcontextprotocol/clientCapabilities'])) throw new RpcError(-32602, 'Modern MCP requests must include clientCapabilities metadata.');
}
async function handleMcp(request, env) {
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'Use POST for the stateless MCP endpoint.' } }, 405, { allow: 'POST' });
  let message;
  try {
    sameOrigin(request); message = await readJson(request);
    if (!plain(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new RpcError(-32600, 'Invalid JSON-RPC request.');
    if (!has(message, 'id')) {
      if (['notifications/initialized', 'notifications/cancelled'].includes(message.method)) return new Response(null, { status: 202 });
      throw new RpcError(-32600, 'Requests must include an ID.');
    }
    if (!(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)))) throw new RpcError(-32600, 'Request ID must be a string or number.');
    if (message.params !== undefined && !plain(message.params)) throw new RpcError(-32602, 'params must be an object.');
    checkRpcHeaders(request, message);
    if (message.method === 'server/discover') return rpcReply(message.id, { supportedVersions: PROTOCOLS, capabilities: { tools: { listChanged: false } },
      instructions: 'Create and edit private procedural houses, interiors, village maps, and animated characters. PNG and character sprite-sheet exports are completed by the open browser workbench with Follow MCP changes enabled.' });
    if (message.method === 'initialize') return rpcReply(message.id, { protocolVersion: ['2025-11-25', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-11-25',
      capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: 'This endpoint also supports stateless discovery with protocol 2026-07-28.' });
    if (message.method === 'ping') return rpcReply(message.id, {});
    if (message.method === 'tools/list') return rpcReply(message.id, { tools: TOOLS });
    if (message.method !== 'tools/call') throw new RpcError(-32601, `Method not found: ${message.method}`, undefined, 404);
    try {
      const value = await callTool(message.params?.name, message.params?.arguments ?? {}, request, env);
      return rpcReply(message.id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
    } catch (error) {
      const info = publicError(error);
      return rpcReply(message.id, { content: [{ type: 'text', text: info.message }], structuredContent: { error: info }, isError: true }, [401, 403, 503].includes(info.status) ? info.status : 200);
    }
  } catch (error) { return rpcFailure(message?.id, error); }
}

function pngInfo(bytes, spritesheet = false) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((byte, i) => bytes[i] !== byte) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw new HttpError(415, 'Upload a PNG image with a valid PNG signature and IHDR header.', 'invalid_png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20);
  const maxSide = spritesheet ? 16384 : 8192, maxPixels = spritesheet ? 40000000 : 33554432;
  if (!width || !height || width > maxSide || height > maxSide || width * height > maxPixels) invalid(`PNG dimensions exceed this ${spritesheet ? 'sprite-sheet' : 'still-image'} export's ${maxSide}-pixel side or ${maxPixels}-pixel area limit.`);
  return { width, height };
}
function exportMetadata(request, job, dimensions) {
  const options = job.options || { format: 'png' };
  const columns = options.format === 'spritesheet' ? options.frames : 1;
  const rows = options.format === 'spritesheet' ? options.directions : 1;
  if (dimensions.width % columns || dimensions.height % rows) invalid('Sprite-sheet dimensions must divide evenly into the requested frame columns and direction rows.');
  const cellWidth = dimensions.width / columns, cellHeight = dimensions.height / rows;
  if (job.scene.output?.sizeMode === 'fixed' && (cellWidth !== job.scene.output.width || cellHeight !== job.scene.output.height)) invalid(`The completed PNG must match the requested fixed ${job.scene.output.width} × ${job.scene.output.height} pixel ${options.format === 'spritesheet' ? 'cells' : 'canvas'}.`);
  const x = request.headers.get('x-foundry-anchor-x'), y = request.headers.get('x-foundry-anchor-y');
  if ((x === null) !== (y === null)) invalid('Supply both X-Foundry-Anchor-X and X-Foundry-Anchor-Y, or neither.');
  let anchorPixels = null;
  if (x !== null) {
    if (!x.trim() || !y.trim() || x.length > 40 || y.length > 40) invalid('Export anchor headers must be finite pixel coordinates.');
    anchorPixels = [finiteNumber(Number(x), 'Anchor X', 0, cellWidth), finiteNumber(Number(y), 'Anchor Y', 0, cellHeight)];
  }
  return { ...copy(options), ...dimensions, columns, rows, cellWidth, cellHeight, anchorPixels };
}
async function completeExport(request, bucket, owner, id) {
  sameOrigin(request);
  if (!/^image\/png(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Send the PNG with Content-Type: image/png.', 'unsupported_media_type');
  let previous = await readRecord(bucket, owner);
  if (previous.record.exportJob?.id !== id) throw new HttpError(404, 'This export request does not belong to your current scene queue.', 'export_not_found');
  if (previous.record.exportJob.status === 'cancelled') throw new HttpError(409, 'This export was cancelled. Its PNG can no longer be completed.', 'export_cancelled');
  if (previous.record.exportJob.status === 'failed') throw new HttpError(409, 'This export failed. Request a new export after correcting the reported error.', 'export_failed', previous.record.exportJob.error);
  const bytes = await boundedBody(request, PNG_LIMIT), dimensions = pngInfo(bytes, previous.record.exportJob.options?.format === 'spritesheet');
  const metadata = exportMetadata(request, previous.record.exportJob, dimensions);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const key = `exports/${owner}/${id}.png`;
  const saved = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/png', cacheControl: 'private, no-store' }, customMetadata: { sha256: digest, metadata: canonical(metadata) } });
  if (!saved) {
    const existing = await bucket.get(key);
    if (existing?.customMetadata?.sha256 !== digest) throw new HttpError(409, 'This export already contains a different PNG. Export results are immutable.', 'export_conflict');
    if (existing.customMetadata.metadata && existing.customMetadata.metadata !== canonical(metadata)) throw new HttpError(409, 'This export already has different frame or anchor metadata. Export results are immutable.', 'export_conflict');
  }
  // A scene edit can race the render upload. Retain that newer scene and only
  // complete the matching job; never replace it with the job's older snapshot.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) previous = await readRecord(bucket, owner);
    const job = previous.record.exportJob;
    if (job?.id !== id) throw new HttpError(409, 'The export queue changed before this PNG could be attached.', 'export_conflict');
    if (job.status === 'cancelled') throw new HttpError(409, 'This export was cancelled while its PNG was uploading.', 'export_cancelled');
    if (job.status === 'failed') throw new HttpError(409, 'This export failed while its PNG was uploading. Its failure has been retained.', 'export_failed', job.error);
    if (job.status === 'ready') return previous.record;
    if (job.status !== 'pending') throw new HttpError(409, 'Only a pending export can be completed.', 'export_not_pending');
    const next = { ...previous.record, revision: previous.record.revision + 1, exportJob: {
      ...job, status: 'ready', url: `/api/exports/${id}`, completedAt: new Date().toISOString(), bytes: bytes.byteLength, ...dimensions, metadata,
    } };
    try { return await writeRecord(bucket, owner, previous, next); }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 409 || attempt === 3) throw error; }
  }
}
async function handleApi(request, env, pathname) {
  const owner = requireOwner(request), bucket = requireBucket(env);
  if (pathname === '/api/scene') {
    if (request.method === 'GET') return json((await readRecord(bucket, owner)).record);
    if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'Use GET or POST for scene data.' } }, 405, { allow: 'GET, POST' });
    sameOrigin(request); const data = requireObject(await readJson(request), 'Request body');
    const previous = await readRecord(bucket, owner);
    return json(await saveScene(bucket, owner, previous, normalizeScene(data.scene), has(data, 'layout') ? data.layout : undefined, expectedRevision(data.expectedRevision)));
  }
  const match = /^\/api\/exports\/([a-f0-9-]+)(\/(?:cancel|fail))?$/.exec(pathname);
  if (match && JOB_PATTERN.test(match[1])) {
    const id = match[1];
    if (match[2]) {
      if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'Use POST to report or cancel a pending export.' } }, 405, { allow: 'POST' });
      sameOrigin(request);
      const data = request.body ? requireObject(await readJson(request), 'Request body') : {};
      if (match[2] === '/fail') return json(await failExport(bucket, owner, await readRecord(bucket, owner), id, data));
      return json(await cancelExport(bucket, owner, await readRecord(bucket, owner), id, expectedRevision(data.expectedRevision)));
    }
    if (request.method === 'POST') return json(await completeExport(request, bucket, owner, id));
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: { code: 'method_not_allowed', message: 'Use GET or POST for PNG exports.' } }, 405, { allow: 'GET, HEAD, POST' });
    const object = await bucket.get(`exports/${owner}/${id}.png`);
    if (!object) throw new HttpError(404, 'No completed PNG was found for this export.', 'export_not_found');
    return new Response(request.method === 'HEAD' ? null : object.body, { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="asset-${id}.png"`, etag: object.httpEtag || `"${object.etag}"` } });
  }
  throw new HttpError(404, 'API route not found.', 'not_found');
}
function serveAsset(request, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  let path;
  try { path = decodeURIComponent(pathname); } catch { return new Response('Not found', { status: 404 }); }
  if (path === '/') path = '/index.html';
  if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) return new Response('Not found', { status: 404 });
  const asset = STATIC_ASSETS[path];
  if (!asset) return new Response('Not found', { status: 404 });
  const headers = { 'content-type': asset.mime, 'cache-control': path.endsWith('.html') ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', etag: asset.etag };
  if (request.headers.get('if-none-match') === asset.etag) return new Response(null, { status: 304, headers });
  if (request.method === 'HEAD') return new Response(null, { headers });
  const binary = atob(asset.data), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new Response(bytes, { headers });
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/mcp' || pathname === '/mcp/') return handleMcp(request, env);
    try { return pathname.startsWith('/api/') ? await handleApi(request, env, pathname) : serveAsset(request, pathname); }
    catch (error) { const info = publicError(error); return json({ error: info }, info.status); }
  },
};
