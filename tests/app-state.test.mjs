import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PRESETS, DEFAULT_PARAMS, normalizeHouse} from '../dist/house-schema.mjs';
import {INTERIOR_PRESETS, normalizeInterior} from '../dist/interior-schema.mjs';
import {MAP_PRESETS, normalizeMap} from '../dist/map-schema.mjs';
import {CHARACTER_PRESETS, CHARACTER_DURATIONS, normalizeCharacter} from '../dist/character-schema.mjs';
import {MATERIAL_CATALOG, MATERIAL_FAMILIES} from '../dist/materials.mjs';

// Exercise the actual controller functions without starting its DOM/rendering
// bootstrap. Schema imports remain real; only browser I/O is substituted.
const source = (await readFile(new URL('../dist/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/\ninit\(\);\s*$/, '\n');
function controller(storage = new Map()) {
  const elements = new Map();
  const context = vm.createContext({
    PRESETS, DEFAULT_PARAMS, normalizeHouse, INTERIOR_PRESETS, normalizeInterior,
    MAP_PRESETS, normalizeMap, CHARACTER_PRESETS, CHARACTER_DURATIONS, normalizeCharacter,
    MATERIAL_CATALOG, MATERIAL_FAMILIES, Blob, URL, console,
    location: {origin: 'https://foundry.example'},
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id, {value: '1', min: '0', max: '500', tagName: 'INPUT'});
      return elements.get(id);
    }},
    localStorage: {setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key)},
  });
  vm.runInContext(source, context);
  return {run: code => vm.runInContext(code, context), storage};
}

test('workspace reload retains shared master detail and independent fixed canvases, including older saves', () => {
  const first = controller();
  first.run(`
    mode = 'map'; state.output.resolution = 4096; state.output.pixelated = true;
    Object.assign(state.output, {sizeMode:'fixed',width:256,height:384,padding:6,fit:'contain'});
    Object.assign(mapState.output, {sizeMode:'fixed',width:4096,height:3072,padding:12,fit:'contain'});
    Object.assign(interiorState.output, {sizeMode:'fixed',width:640,height:480,padding:8,fit:'pad'});
    saveWorkspace();
  `);
  for (const legacy of [false, true]) {
    const storage = new Map(first.storage);
    if (legacy) {
      const saved = JSON.parse(storage.get('village-foundry-workspace-v1'));
      delete saved.sharedOutput;
      storage.set('village-foundry-workspace-v1', JSON.stringify(saved));
    }
    const next = controller(storage); next.run('restoreWorkspace();');
    assert.equal(next.run('mode'), 'map');
    assert.equal(next.run('activeRecipe().output.resolution'), 4096);
    assert.equal(next.run('activeRecipe().output.pixelated'), true);
    assert.equal(next.run('activeRecipe().output.width'), 4096);
    assert.equal(next.run('activeRecipe().output.height'), 3072);
    assert.equal(next.run('state.output.width'), 256);
    assert.equal(next.run('state.output.height'), 384);
    assert.equal(next.run('interiorState.output.width'), 640);
    assert.equal(next.run('interiorState.output.fit'), 'pad');
  }
});

function pendingController(status) {
  const app = controller();
  app.run(`
    state = baseRecipe('village', 10); mode = 'exterior';
    mcpConnected = true; mcpRevision = 5; pendingMcpExport = 'job-a'; buildDirty = false;
    globalThis.remote = {revision:7,scene:baseRecipe('village',99),exportJob:{id:'job-a',status:${JSON.stringify(status)}}};
    globalThis.applied = [];
    applyLoadedRecipe = async recipe => {state = recipe; applied.push(recipe.params.seed);};
    api = async () => remote;
    setBusy = value => {busy = value;};
    makePack = async () => ({house:{userData:{}},textures:{}});
    disposePack = () => {};
    currentPack = {house:{userData:{}}};
    renderer = {setHouse(){},lastMeta:{anchor_px:[10,20]},render(){return {toBlob(done){done(new Blob(['png']));}}}};
  `);
  return app;
}

test('PNG completion leaves concurrent scene edits visible to the next follow poll', async () => {
  const app = pendingController('ready');
  await app.run(`completeMcpExport({id:'job-a',scene:baseRecipe('village',10),options:{format:'png'}});`);
  assert.equal(app.run('mcpRevision'), 5);
  assert.equal(app.run('state.params.seed'), 10);
  await app.run('pullMcp(true);');
  assert.equal(app.run('state.params.seed'), 99);
  assert.equal(app.run('mcpRevision'), 7);
  assert.equal(app.run('applied.length'), 1);
});

test('export cancellation leaves concurrent scene edits visible to the next follow poll', async () => {
  const app = pendingController('cancelled');
  await app.run('cancelMcpExport();');
  assert.equal(app.run('mcpRevision'), 5);
  assert.equal(app.run('pendingMcpExport'), null);
  await app.run('pullMcp(true);');
  assert.equal(app.run('state.params.seed'), 99);
  assert.equal(app.run('mcpRevision'), 7);
});

function mapDimensionController(key = 'depth') {
  const app = controller();
  app.run(`
    mapState.config = normalizeMap({...mapState.config, width:128, depth:128});
    globalThis.commits = {reset:0, sync:0, rebuild:0, prevented:0, blur:0};
    renderer = {resetPreview(){commits.reset++;}};
    syncPreviewZoom = () => {};
    syncUI = () => {commits.sync++;};
    scheduleRebuild = () => {commits.rebuild++;};
    globalThis.handlers = new Map();
    globalThis.input = {
      value:'128',
      addEventListener(name, callback){handlers.set(name, callback);},
      blur(){commits.blur++; handlers.get('blur')({target:input});}
    };
    globalThis.fire = (name, key) => handlers.get(name)({target:input,key,preventDefault(){commits.prevented++;}});
    bindMapDimensionInput(input, ${JSON.stringify(key)});
  `);
  return app;
}

test('programmatic map height fills commit on Enter and blur without a change event', () => {
  const app = mapDimensionController();
  app.run(`input.value='96'; fire('keydown','Enter');`);
  assert.equal(app.run('mapState.config.depth'), 96);
  assert.equal(app.run('mapState.config.width'), 128);
  assert.equal(app.run('commits.prevented'), 1);
  assert.equal(app.run('commits.blur'), 1);
  assert.equal(app.run('commits.sync'), 1);
  assert.equal(app.run('commits.rebuild'), 1);
  // Locator fill + Tab can cause blur without the native input dirty flag.
  app.run(`input.value='104'; fire('keydown','Tab'); input.blur();`);
  assert.equal(app.run('mapState.config.depth'), 104);
  assert.equal(app.run('commits.sync'), 2);
  assert.equal(app.run('commits.rebuild'), 2);
});

test('map dimensions normalize once and repeated change/Enter/blur events do not rebuild again', () => {
  const app = mapDimensionController('width');
  app.run(`input.value='999'; fire('change'); fire('keydown','Enter'); fire('change'); input.blur();`);
  assert.equal(app.run('mapState.config.width'), 256);
  assert.equal(app.run('input.value'), '256');
  assert.equal(app.run('commits.reset'), 1);
  assert.equal(app.run('commits.sync'), 1);
  assert.equal(app.run('commits.rebuild'), 1);
  app.run(`input.value=''; input.blur(); input.value='not a number'; fire('keydown','Enter');`);
  assert.equal(app.run('input.value'), '256');
  assert.equal(app.run('mapState.config.width'), 256);
  assert.equal(app.run('commits.sync'), 1);
  assert.equal(app.run('commits.rebuild'), 1);
});

test('all still-scene recipes preserve 4096 master detail', () => {
  const app=controller();
  for(const factory of ['baseRecipe()','baseInterior()','baseMap()','baseCharacter()']) {
    assert.equal(app.run(`validateRecipe({...${factory},output:{...defaultOutput(),resolution:4096,scale:1}}).output.resolution`),4096);
  }
});

test('deterministic MCP render limits report a terminal failure without consuming a newer scene revision', async () => {
  const app=pendingController('pending');
  app.run(`
    globalThis.reported=[];
    renderer.render=()=>{const error=new RangeError('Reduce the fixed canvas dimensions.');error.code='render_budget_exceeded';throw error;};
    api=async(path,options)=>{reported.push({path,body:JSON.parse(options.body)});return{revision:8,exportJob:{id:'job-a',status:'failed'}};};
  `);
  await app.run(`completeMcpExport({id:'job-a',scene:baseRecipe('village',10),options:{format:'png'}});`);
  assert.equal(app.run('reported[0].path'),'/api/exports/job-a/fail');
  assert.equal(app.run('reported[0].body.code'),'render_budget_exceeded');
  assert.equal(app.run('pendingMcpExport'),null);
  assert.equal(app.run('handledExport'),'job-a');
  assert.equal(app.run('mcpRevision'),5);
});
