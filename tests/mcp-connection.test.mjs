import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { mcpConnection } from '../dist/mcp-connection.mjs';
import { PRESETS, HOUSE_MATERIAL_FAMILIES, normalizeHouse } from '../dist/house-schema.mjs';
import { INTERIOR_PRESETS, normalizeInterior } from '../dist/interior-schema.mjs';
import { MAP_PRESETS, normalizeMap } from '../dist/map-schema.mjs';
import { CHARACTER_PRESETS, CHARACTER_DURATIONS, normalizeCharacter } from '../dist/character-schema.mjs';
import { MATERIAL_CATALOG, MATERIAL_FAMILIES } from '../dist/materials.mjs';

test('MCP endpoint follows the current origin and custom port for hosted and local workbenches', () => {
  for (const [address, endpoint, local] of [
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787/mcp', true],
    ['http://localhost:9412/index.html?scene=map', 'http://localhost:9412/mcp', true],
    ['http://[::1]:9412/', 'http://[::1]:9412/mcp', true],
    ['https://foundry.example/workbench/', 'https://foundry.example/mcp', false],
    ['https://localhost.example/', 'https://localhost.example/mcp', false],
  ]) {
    assert.deepEqual(mcpConnection(address), {
      available: true, local, endpoint, origin: new URL(address).origin,
    });
  }
  assert.equal(mcpConnection({ origin: 'https://foundry.example' }).endpoint, 'https://foundry.example/mcp');
});

test('file and invalid origins never advertise a fabricated MCP endpoint', () => {
  for (const address of ['file:///C:/VillageFoundry/index.html', 'data:text/html,test', '', null]) {
    assert.deepEqual(mcpConnection(address), { available: false, local: false, origin: null, endpoint: null });
  }
});

// Exercise the controller's real API, connection and copy functions without
// bootstrapping the renderer or DOM. Schemas and endpoint discovery remain real.
const source = (await readFile(new URL('../dist/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/\ninit\(\);\s*$/, '\n');
function controller(address, { fetcher, copyError = false } = {}) {
  const elements = new Map(), requests = [], intervals = [], copied = [], selections = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', checked: false, disabled: true, hidden: false, textContent: '' });
    return elements.get(id);
  };
  const context = vm.createContext({
    mcpConnection, PRESETS, HOUSE_MATERIAL_FAMILIES, normalizeHouse, INTERIOR_PRESETS, normalizeInterior,
    MAP_PRESETS, normalizeMap, CHARACTER_PRESETS, CHARACTER_DURATIONS, normalizeCharacter,
    MATERIAL_CATALOG, MATERIAL_FAMILIES, Blob, URL, console,
    location: new URL(address),
    document: {
      getElementById: element,
      getSelection: () => ({ removeAllRanges() {}, addRange(range) { selections.push(range.node); } }),
      createRange: () => ({ selectNodeContents(node) { this.node = node; } }),
    },
    navigator: { clipboard: { async writeText(text) {
      if (copyError) throw new Error('Clipboard unavailable');
      copied.push(text);
    } } },
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
    fetch: async (path, init) => {
      requests.push({ path, init });
      if (fetcher) return fetcher(path, init);
      return Response.json(path === '/api/local-info'
        ? { mode: 'local', persistentStorage: true, renderer: 'browser', requiresOpenBrowser: true,
          mcpUrl: 'https://unrelated.example/mcp' }
        : { revision: 7, scene: null, exportJob: null });
    },
  });
  vm.runInContext(source, context);
  vm.runInContext('toast = message => { globalThis.notice = message; };', context);
  return { run: code => vm.runInContext(code, context), element, requests, intervals, copied, selections };
}

test('local connection contacts the local API and automatically follows browser render jobs', async () => {
  const app = controller('http://127.0.0.1:9412/');
  await app.run('connectMcp();');
  assert.equal(app.run('mcpConnected'), true);
  assert.equal(app.run('mcpRevision'), 7);
  assert.deepEqual(app.requests.map(r => r.path).sort(), ['/api/local-info', '/api/scene']);
  assert.ok(app.requests.every(r => r.init.credentials === 'same-origin'));
  assert.equal(app.element('mcp-endpoint').textContent, 'http://127.0.0.1:9412/mcp');
  assert.equal(app.element('mcp-live-sync').checked, true);
  assert.equal(app.element('mcp-live-sync').disabled, false);
  assert.equal(app.element('mcp-pull').disabled, false);
  assert.equal(app.element('mcp-push').disabled, false);
  assert.match(app.element('mcp-status').textContent, /Local MCP connected/);
  assert.match(app.element('mcp-status').textContent, /saves scene data and PNGs on this computer/);
  assert.match(app.element('mcp-connection-note').textContent, /keep this tab open/i);
  assert.equal(app.intervals.length, 1);
});

test('hosted connection keeps its existing Follow opt-in and does not probe local-only routes', async () => {
  const app = controller('https://foundry.example/');
  await app.run('connectMcp();');
  assert.deepEqual(app.requests.map(r => r.path), ['/api/scene']);
  assert.equal(app.element('mcp-endpoint').textContent, 'https://foundry.example/mcp');
  assert.equal(app.element('mcp-live-sync').checked, false);
  assert.equal(app.element('mcp-live-sync').disabled, false);
  assert.match(app.element('mcp-status').textContent, /^Connected\./);
  assert.doesNotMatch(app.element('mcp-status').textContent, /Local MCP/);
});

test('a static local preview gives local server guidance without suggesting a hosted-only service', async () => {
  const app = controller('http://localhost:5500/', {
    fetcher: () => new Response('<!doctype html>Static preview', { status: 404 }),
  });
  await app.run('connectMcp();');
  assert.equal(app.run('mcpConnected'), false);
  assert.equal(app.element('mcp-live-sync').disabled, true);
  assert.equal(app.element('mcp-live-sync').checked, false);
  assert.equal(app.element('mcp-pull').disabled, true);
  assert.equal(app.element('mcp-push').disabled, true);
  assert.equal(app.intervals.length, 0);
  assert.match(app.element('mcp-status').textContent, /Start the local server/);
  assert.doesNotMatch(app.element('mcp-status').textContent, /published|cloud/i);
  assert.equal(app.element('mcp-copy-endpoint').disabled, false);
});

test('local discovery metadata is optional and cannot redirect the copied endpoint', async () => {
  const app = controller('http://localhost:9412/', {
    fetcher: path => path === '/api/local-info'
      ? Response.json({ error: { message: 'Not found' } }, { status: 404 })
      : Response.json({ revision: 2, scene: null, exportJob: null }),
  });
  await app.run('connectMcp();');
  await app.run('copyMcpEndpoint();');
  assert.equal(app.run('mcpConnected'), true);
  assert.deepEqual(app.copied, ['http://localhost:9412/mcp']);
  assert.equal(app.run('notice'), 'MCP endpoint copied.');
});

test('clipboard denial selects the actual same-origin endpoint for manual copying', async () => {
  const app = controller('http://[::1]:9412/', { copyError: true });
  await app.run('connectMcp();');
  await app.run('copyMcpEndpoint();');
  assert.deepEqual(app.copied, []);
  assert.equal(app.selections[0], app.element('mcp-endpoint'));
  assert.equal(app.selections[0].textContent, 'http://[::1]:9412/mcp');
  assert.match(app.element('mcp-status').textContent, /Copy the endpoint shown above/);
});

test('a saved local MCP scene and pending export are followed even when created before browser startup', async () => {
  let remote;
  const app=controller('http://localhost:8787/',{fetcher:path=>Response.json(path==='/api/local-info'?{mode:'local'}:remote)});
  remote=JSON.parse(app.run(`JSON.stringify({revision:8,scene:baseRecipe('village',99),exportJob:{id:'pending-job',status:'pending'}})`));
  app.run(`
    state=baseRecipe('village',10);mode='exterior';
    globalThis.applied=[];globalThis.completed=[];
    applyLoadedRecipe=async recipe=>{state=recipe;applied.push(recipe.params.seed);};
    completeMcpExport=async job=>{completed.push(job.id);};
  `);
  await app.run('connectMcp();');
  assert.equal(app.run('mcpRevision'),8,'Keep the revision for optimistic writes before the first poll.');
  await app.run('pullMcp(true);');
  assert.equal(app.run('applied[0]'),99);
  assert.equal(app.run('completed[0]'),'pending-job');
  assert.equal(app.run('mcpInitialScenePending'),false);
});

test('a new local server at revision zero leaves the restored browser workspace intact', async () => {
  let remote;
  const app=controller('http://localhost:8787/',{fetcher:path=>Response.json(path==='/api/local-info'?{mode:'local'}:remote)});
  remote=JSON.parse(app.run(`JSON.stringify({revision:0,scene:baseRecipe('village',742),exportJob:null})`));
  app.run(`state=baseRecipe('village',123);globalThis.applied=[];applyLoadedRecipe=async recipe=>{state=recipe;applied.push(recipe);};`);
  await app.run('connectMcp();');await app.run('pullMcp(true);');
  assert.equal(app.run('state.params.seed'),123);
  assert.equal(app.run('applied.length'),0);
  assert.equal(app.run('mcpRevision'),0);
});
