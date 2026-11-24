import * as THREE from './vendor/three.module.js';
import { PRESETS, DEFAULT_PARAMS, normalizeHouse, buildHouse, disposeHouse, randomizeHouse } from './house-model.mjs';
import { MATERIAL_CATALOG, MATERIAL_FAMILIES, materialCanvas, loadMaterialTexture, inferPalette } from './materials.mjs';
import { HouseRenderer } from './renderer.mjs';
import { zipBlobs } from './zip.mjs';
import { INTERIOR_PRESETS, normalizeInterior, buildInterior } from './interior-model.mjs';
import { interpretBrief } from './director.mjs';
import { MAP_PRESETS, normalizeMap } from './map-schema.mjs';
import { CHARACTER_PRESETS, CHARACTER_DURATIONS, normalizeCharacter } from './character-schema.mjs';
import { compactLayoutReport } from './layout-report.mjs';
import { mcpConnection } from './mcp-connection.mjs';
let characterModel;
const applyCharacterPose = (group, pose) => characterModel.applyCharacterPose(group, pose);
const renderAnimationSheet = async (...args) => (await import('./animation-export.mjs')).renderAnimationSheet(...args);

const $ = id => document.getElementById(id);
const catalog = new Map(MATERIAL_CATALOG.map(item => [item.id, item]));
const familyByPreset = { village: 'village', cottage: 'cottage', source: 'townhouse', inn: 'townhouse', manor: 'manor' };
const toggles = ['chimney', 'dormer', 'porch', 'shutters', 'planters', 'sideWing', 'timber'];
const inputId = key => key.replace(/[A-Z]/g, s => `-${s.toLowerCase()}`);
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n)));
const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
const seedNumber = value => Math.round(clamp(Number(value) || 0, 0, 2147483647));
const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const asBlob = value => new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
const toBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create the PNG.')), 'image/png'));
function rng(seed) { let a = seed >>> 0; return () => { a += 0x6d2b79f5; let t = Math.imul(a ^ a >>> 15, a | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const defaultOutput = () => ({resolution: 512, scale: 2, pixelated: false, outline: true, shadow: true,
  sizeMode: 'auto', width: 512, height: 512, padding: 8, fit: 'contain'});
const sizeFields = output => Object.fromEntries(['sizeMode', 'width', 'height', 'padding', 'fit'].map(key => [key, output?.[key] ?? defaultOutput()[key]]));
const sharedOutputFields = output => Object.fromEntries(['resolution', 'scale', 'pixelated', 'outline', 'shadow'].map(key => [key, output?.[key] ?? defaultOutput()[key]]));
function outputBounds(raw, current) {
  const out = {...current};
  if (['auto', 'fixed'].includes(raw?.sizeMode)) out.sizeMode = raw.sizeMode;
  for (const key of ['width', 'height']) if (Number.isFinite(raw?.[key])) out[key] = Math.round(clamp(raw[key], 16, 8192));
  if (Number.isFinite(raw?.padding)) out.padding = Math.round(clamp(raw.padding, 0, Math.min(128, Math.floor((Math.min(out.width, out.height) - 1) / 2))));
  if (['contain', 'pad'].includes(raw?.fit)) out.fit = raw.fit;
  return out;
}

function baseRecipe(preset = 'village', seed = 742) {
  const family = MATERIAL_FAMILIES.find(f => f.id === familyByPreset[preset]);
  const materials = { roof: family.roof, wall: family.wall, wood: family.wood, ground: family.ground };
  const tints = Object.fromEntries(['roof', 'wall', 'wood'].map(key => [key, catalog.get(materials[key]).color]));
  return { format: 'house-foundry', version: 1,
    params: { ...DEFAULT_PARAMS, ...PRESETS[preset], preset, seed }, materials,
    tints, paletteBase: clone(tints),
    view: { elevation: 45, azimuth: 0 },
    output: defaultOutput(),
  };
}

function baseInterior(preset = 'tavern', seed = 742, config = {}) {
  const p = normalizeInterior({ preset, seed, ...config });
  const tints = { roof: '#8a806d', wall: p.wallColor, wood: p.woodColor };
  return { format: 'house-foundry-interior', version: 1, config: p,
    materials: { roof: 'roof_weathered', wall: 'wall_cream', wood: 'wood_oak', ground: 'ground_warm_cobble' },
    tints, paletteBase: clone(tints), view: { elevation: 45, azimuth: 0 },
    output: defaultOutput() };
}
function baseMap(preset = 'village', seed = 742, config = {}) {
  const p = normalizeMap({ preset, seed, ...config }), base = baseRecipe();
  return { format: 'village-foundry-map', version: 1, config: p, materials: base.materials,
    tints: { roof: p.roofColor || '#94918b', wood: p.woodColor || '#a17f50', wall: p.stoneColor || '#aaa697' },
    paletteBase: clone(base.paletteBase), view: base.view, output: base.output };
}
function baseCharacter(preset = 'innkeeper', seed = 742, config = {}) {
  const p = normalizeCharacter({preset, seed, ...config}), base = baseRecipe();
  return {format: 'village-foundry-character', version: 1, config: p, materials: base.materials,
    tints: base.tints, paletteBase: base.paletteBase, appearanceBase: Object.fromEntries(['skinColor', 'hairColor', 'tunicColor', 'trouserColor', 'leatherColor', 'accentColor'].map(key => [key, p[key]])), view: base.view, output: base.output};
}
let state = baseRecipe(), interiorState = baseInterior(), mapState = baseMap(), characterState = baseCharacter(), mode = 'exterior';
const activeRecipe = () => mode === 'exterior' ? state : { ...activeStyle(), view: state.view, output: {...state.output, ...sizeFields(activeStyle().output)} };
const activeStyle = () => mode === 'character' ? characterState : mode === 'map' ? mapState : mode === 'interior' ? interiorState : state;
const activeSeed = () => mode === 'exterior' ? state.params.seed : activeStyle().config.seed;
const activeLabel = () => mode === 'character' ? (CHARACTER_PRESETS[characterState.config.preset].label || characterState.config.preset) : mode === 'map' ? (MAP_PRESETS[mapState.config.preset].label || mapState.config.preset) : mode === 'interior' ? (INTERIOR_PRESETS[interiorState.config.preset].label || interiorState.config.preset) : PRESETS[state.params.preset].label;
let renderer, currentPack = null, groundTexture = null, materialTab = 'roof', referenceImage = null;
let rebuilding = 0, rebuildTimer, groundRevision = 0, gridRevision = 0, toastTimer;
let busy = false, buildDirty = true, cancelBatch = false, spinning = false, spinFrame = 0, disabledBefore = new Map();
let previewError = false;
let lastBatch = null;
let referenceRevision = 0, recipeLoadRevision = 0, mcpConnected = false, mcpRevision = null, mcpPolling = false, handledExport = null;
let exportRetryAt = 0;
let pendingMcpExport = null;
let mcpInitialScenePending = false;
let previewDetailTimer, previewDetailRevision = 0;
let characterPlaying = false, characterFrame = 0;
let saveTimer;
const savedControlIds = ['batch-count', 'batch-style', 'variation-strength', 'animation-detail', 'animation-frames', 'animation-directions', 'animation-style'];
function saveWorkspace() {
  try { localStorage.setItem('village-foundry-workspace-v1', JSON.stringify({mode, state, interiorState, mapState, characterState, sharedOutput: sharedOutputFields(state.output), controls: Object.fromEntries(savedControlIds.map(id => [id, $(id).value]))})); } catch { /* Storage can be disabled in a private browser. Recipes remain exportable. */ }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveWorkspace, 250); }
function restoreWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem('village-foundry-workspace-v1') || 'null');
    if (!saved) return;
    state = validateRecipe(saved.state); interiorState = validateRecipe(saved.interiorState);
    mapState = validateRecipe(saved.mapState); characterState = validateRecipe(saved.characterState);
    if (['exterior', 'interior', 'map', 'character'].includes(saved.mode)) mode = saved.mode;
    // Preserve shared detail and repair workspaces saved before sharedOutput.
    const shared = sharedOutputFields(saved.sharedOutput || saved.state?.output);
    const restored = validateRecipe({...activeStyle(), output: {...activeStyle().output, ...shared}});
    Object.assign(state.output, sharedOutputFields(restored.output));
    state.output.style = state.output.pixelated ? 'pixel' : 'illustrated';
    for (const id of savedControlIds) {
      const el = $(id), value = saved.controls?.[id];
      if (typeof value !== 'string') continue;
      if (el.tagName === 'SELECT') { if ([...el.options].some(o => o.value === value)) el.value = value; }
      else if (Number.isFinite(Number(value))) el.value = clamp(Number(value), Number(el.min), Number(el.max));
    }
  } catch { /* A recipe-format update safely falls back to the current defaults. */ }
}

function status(text) { $('status').textContent = text; }
function toast(text, error = false) {
  clearTimeout(toastTimer); $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}
function report(error) { console.error(error); status(error.message || String(error)); toast(error.message || String(error), true); }
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function filename(recipe = activeRecipe()) { const p = recipe.config || recipe.params; return `${recipe.format === 'village-foundry-character' ? 'character' : recipe.format === 'village-foundry-map' ? 'map' : recipe.config ? 'interior' : 'house'}-${p.preset}-${p.seed}${recipe.format === 'house-foundry-interior' ? `-floor-${(p.floorIndex || 0) + 1}` : ''}`; }
function disposePack(pack) {
  if (!pack) return;
  disposeHouse(pack.house);
  for (const texture of Object.values(pack.textures)) texture.dispose();
}

// Recolour sampled pixels while preserving their small-scale tonal detail.
function tintTexture(texture, base, tint) {
  if (!validColor(tint) || base.toLowerCase() === tint.toLowerCase()) return;
  const image = texture.image, context = image.getContext('2d'), data = context.getImageData(0, 0, image.width, image.height);
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const source = rgb(base), target = rgb(tint);
  for (let i = 0; i < data.data.length; i += 4) for (let c = 0; c < 3; c++) data.data[i + c] = clamp(data.data[i + c] * target[c] / Math.max(25, source[c]), 0, 255);
  context.putImageData(data, 0, 0); texture.needsUpdate = true;
}

async function makePack(recipe) {
  const textures = {};
  try {
    if (recipe.format === 'village-foundry-character') { characterModel ||= await import('./character-model.mjs'); return {house: characterModel.buildCharacter(recipe.config), textures}; }
    if (recipe.format === 'village-foundry-map') {
      const { buildMap } = await import('./map-model.mjs');
      return { house: buildMap(recipe.config), textures };
    }
    const loaded = await Promise.allSettled((recipe.params?.useTextures === true ? ['roof', 'wall', 'wood'] : []).map(async key => {
      const entry = catalog.get(recipe.materials[key]);
      const texture = await loadMaterialTexture(THREE, entry.id, { seed: (recipe.config || recipe.params).seed });
      textures[key] = texture;
      tintTexture(texture, entry.color, recipe.tints[key]);
    }));
    const failed = loaded.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (recipe.config) return { house: buildInterior(recipe.config, {}), textures };
    const params = { ...recipe.params };
    // Roof and exposed timber edge colours follow the selected finish too.
    params.roofColor = recipe.tints.roof; params.woodColor = recipe.tints.wood;
    if (params.wallKind === 'plaster') params.wallColor = recipe.tints.wall; else params.stoneColor = recipe.tints.wall;
    return { house: buildHouse(params, textures), textures };
  } catch (error) { Object.values(textures).forEach(t => t.dispose()); throw error; }
}

function options(recipe = activeRecipe()) { return { ...recipe.view, ...recipe.output, ...(recipe.format === 'village-foundry-character' ? {fixedBounds: true, trim: false} : {}) }; }
function syncPreviewZoom() {
  const zoom = renderer?.previewZoom || 1;
  $('preview-zoom-value').value = `${Math.round(zoom * 100)}%`;
  $('zoom-out-btn').disabled = busy || zoom <= .25;
  $('zoom-in-btn').disabled = busy || zoom >= 8;
}
function cancelPreviewDetail() {
  clearTimeout(previewDetailTimer); ++previewDetailRevision;
}
function schedulePreviewDetail(delay = 160) {
  cancelPreviewDetail();
  if (!renderer?.previewSnapshot || busy || buildDirty || previewError) return;
  const revision=previewDetailRevision;
  previewDetailTimer=setTimeout(async () => {
    if(revision!==previewDetailRevision||busy||buildDirty||previewError)return;
    const label=$('preview-detail-status');label.textContent='Rendering detail…';label.title='';
    // Let the status paint before a CPU render can occupy the main thread.
    await tick();await tick();
    if(revision!==previewDetailRevision||busy||buildDirty||previewError)return;
    try{
      const result=renderer.renderPreviewDetail();
      if(!result)return;
      label.textContent=result.status==='limited'?result.message:
        `${result.style==='pixel'?'Native pixel grid':'Geometry detail'} · ${result.renderWidth} × ${result.renderHeight}${result.densityLimited?' · viewport limit':''}`;
      label.title=result.status==='ready'?`Same scene, ${result.nativePixelsPerUnit.toFixed(1)} rendered pixels per world unit. PNG exports use the full scene and output settings.`:result.message;
    }catch(error){label.textContent='Preview detail unavailable';label.title=error.message;}
  },delay);
}
function renderPreview() {
  if (!renderer || !currentPack || busy) return;
  try {
    renderer.show(options()); previewError = false; syncPreviewZoom();
    const m = renderer.lastMeta;
    $('stage-meta').textContent = `${activeLabel()} · seed ${activeSeed()}${m ? ` · ${m.width} × ${m.height} ${m.groundIncluded ? 'preview' : 'PNG'}` : ''}`;
    schedulePreviewDetail();
  } catch (error) { previewError = true; status(error.message); toast(error.message, true); }
  for (const id of ['download-btn', 'export-views-btn', 'batch-btn', 'export-both-btn', 'map-bundle-btn', 'character-reference-btn', 'animation-export-btn', 'animation-all-btn']) $(id).disabled = buildDirty || previewError;
}
async function rebuild() {
  const revision = ++rebuilding, recipe = clone(activeRecipe()); buildDirty = true;
  $('viewport').classList.add('is-loading');
  try {
    await tick();
    const pack = await makePack(recipe);
    if (revision !== rebuilding || busy) { disposePack(pack); return; }
    renderer.setHouse(pack.house); const previous = currentPack; currentPack = pack; disposePack(previous); buildDirty = false;
    renderPreview();
    if (!previewError) status(`${activeLabel()} ready. Scroll to zoom, drag to rotate, or Shift + drag to pan.`);
    if (mode === 'interior') {
      const layout = pack.house.userData.layout;
      const warnings = layout?.warnings || [];
      $('director-status').textContent = `${layout?.rooms?.length || 1} connected rooms · ${layout?.items?.length || 0} furniture pieces.${warnings.length ? ` ${warnings.length} placement adjustment${warnings.length === 1 ? '' : 's'}: ${warnings.slice(0, 2).join(' ')}` : ' Doors, stairs and walking routes stay clear.'}`;
    }
    if (mode === 'map') {
      const layout = pack.house.userData.layout;
      const count = layout?.buildings?.length || 0;
      $('map-layout-status').textContent = `${mapState.config.includeHouses ? `${count} buildings placed.` : `${count} plots prepared; houses hidden.`} ${(layout?.placementWarnings || []).join(' ') || 'Gate openings and entrance paths connect the plots.'}`;
    }
  } catch (error) { if (revision === rebuilding) report(error); }
  finally { if (revision === rebuilding) $('viewport').classList.remove('is-loading'); }
}
function scheduleRebuild() {
  if (busy) return;
  cancelPreviewDetail();
  scheduleSave();
  buildDirty = true; ++rebuilding; clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 100);
  for (const id of ['download-btn', 'export-views-btn', 'batch-btn', 'export-both-btn', 'map-bundle-btn', 'character-reference-btn', 'animation-export-btn', 'animation-all-btn']) $(id).disabled = true;
}

function syncUI() {
  $('preset').value = state.params.preset;
  for (const key of ['width', 'depth', 'floors', 'floorHeight', 'roofPitch', 'seed']) $(inputId(key)).value = state.params[key];
  for (const key of toggles) $(inputId(key)).checked = !!state.params[key];
  for (const key of ['roof', 'wall', 'wood']) $(`${key}-color`).value = activeStyle().tints[key];
  $('seed').value = activeSeed();
  $('elevation').value = state.view.elevation; $('azimuth').value = state.view.azimuth;
  $('resolution').value = state.output.resolution; $('pixel-scale').value = state.output.scale;
  const sizes = sizeFields(activeStyle().output);
  $('output-size-mode').value = sizes.sizeMode;
  for (const key of ['width', 'height', 'padding', 'fit']) $(`output-${key}`).value = sizes[key];
  $('fixed-size-fields').hidden = sizes.sizeMode !== 'fixed'; $('output-size-note').hidden = sizes.sizeMode !== 'fixed';
  document.querySelector('.export-note').textContent = sizes.sizeMode === 'fixed' ? `Exact ${sizes.width} × ${sizes.height} canvas, with transparent padding.` : mode === 'character' ? 'Fixed animation frames with a shared ground anchor.' : 'Trimmed PNGs; consistent scale across the batch.';
  document.querySelector('.export-hint').textContent = mode === 'map' && mapState.config.landform === 'island' && mapState.config.sea ? 'Surrounding sea included' : 'Transparent background';
  for (const key of ['pixelated', 'outline', 'shadow']) $(key).checked = state.output[key];
  $('width-value').value = state.params.width.toFixed(1); $('depth-value').value = state.params.depth.toFixed(1);
  $('roof-pitch-value').value = `${state.params.roofPitch}°`;
  $('floor-height-value').value = Number(state.params.floorHeight).toFixed(2);
  $('elevation-value').value = `${Math.round(state.view.elevation)}°`; $('azimuth-value').value = `${Math.round(state.view.azimuth)}°`;
  for (const card of document.querySelectorAll('[data-preset]')) { const active = card.dataset.preset === state.params.preset; card.classList.toggle('active', active); card.setAttribute('aria-pressed', active); }
  const viewName = state.view.elevation === 90 ? 'top' : state.view.elevation === 0 ? 'front' : 'rpg';
  for (const name of ['rpg', 'top', 'front']) { $(`view-${name}`).classList.toggle('active', name === viewName); $(`view-${name}`).setAttribute('aria-pressed', name === viewName); }
  const interior = mode === 'interior', map = mode === 'map', character = mode === 'character';
  $('exterior-controls').hidden = mode !== 'exterior'; $('interior-controls').hidden = !interior; $('interior-director').hidden = !interior; $('map-controls').hidden = !map;
  $('character-controls').hidden = !character; $('character-animation-panel').hidden = !character;
  document.querySelector('.materials-panel').hidden = character;
  $('viewport').dataset.mode = mode;
  $('batch-panel').hidden = map; $('map-bundle-btn').hidden = !map;
  for (const key of ['exterior', 'interior', 'map', 'character']) { $(`mode-${key}`).classList.toggle('active', mode === key); $(`mode-${key}`).setAttribute('aria-pressed', mode === key); }
  $('preview-heading').textContent = character ? 'The people of your world' : map ? 'A village that belongs together' : interior ? 'Rooms that belong together' : 'Your next village house';
  $('download-btn').textContent = character ? 'Export this pose' : map ? 'Export this map' : interior ? 'Export this interior' : 'Export this house';
  document.querySelector('.settings-heading h1').textContent = character ? 'Create a village character' : map ? 'Build your village map' : interior ? 'Plan your building interior' : 'Build a village house';
  document.querySelector('label[for="batch-count"]').textContent = character ? 'Number of characters' : interior ? 'Number of interiors' : 'Number of houses';
  $('batch-heading').textContent = character ? 'Populate your world' : interior ? 'Generate a collection of rooms' : 'Generate a whole village';
  $('room-preset').value = interiorState.config.preset;
  for (const key of ['width', 'depth', 'tables', 'bedrooms']) { $(`room-${key}`).value = interiorState.config[key] ?? (key === 'bedrooms' ? 2 : 0); $(`room-${key}-value`).value = interiorState.config[key] ?? (key === 'bedrooms' ? 2 : 0); }
  $('bar-side').value = interiorState.config.barSide;
  for (const key of ['fireplace', 'shelves', 'barrels', 'rug', 'clearCenter', 'kitchen', 'bar', 'stairs', 'occupants']) $(`room-${inputId(key)}`).checked = !!interiorState.config[key];
  for (const id of ['room-kitchen', 'room-bar', 'room-fireplace', 'bar-side']) $(id).disabled = (interiorState.config.floorIndex || 0) > 0;
  $('room-service-note').hidden = !(interiorState.config.floorIndex > 0);
  for (const key of ['floorCount', 'floorIndex', 'layoutVariant']) $(`room-${inputId(key)}`).value = interiorState.config[key] ?? (key === 'floorCount' ? 1 : key === 'floorIndex' ? 0 : 'auto');
  for (const option of $('room-floor-index').options) option.disabled = Number(option.value) >= (interiorState.config.floorCount || 1);
  document.querySelector('[data-material-tab="roof"]').hidden = interior;
  document.querySelector('[data-material-tab="ground"]').hidden = mode !== 'exterior';
  $('roof-color').closest('label').hidden = interior;
  $('map-preset').value = mapState.config.preset;
  for (const [id, key] of [['width', 'width'], ['depth', 'depth'], ['house-count', 'houseCount']]) $(`map-${id}`).value = mapState.config[key];
  $('map-house-count-value').value = mapState.config.houseCount;
  $('map-size-preset').value = mapState.config.width === mapState.config.depth && [48, 80, 128, 192].includes(mapState.config.width) ? String(mapState.config.width) : 'custom';
  $('map-size-summary').textContent = `${mapState.config.width} × ${mapState.config.depth} world units. Set exported pixels in PNG canvas below.`;
  for (const [id, key] of [['houses', 'includeHouses'], ['roads', 'roads'], ['fences', 'fences'], ['trees', 'trees'], ['water', 'water'], ['gardens', 'gardens'], ['sea', 'sea']]) $(`map-${id}`).checked = mapState.config[key];
  $('map-landform').value = mapState.config.landform;
  $('map-sea').disabled = mapState.config.landform !== 'island';
  $('map-house-preset').value = mapState.config.housePreset; $('map-road-style').value = mapState.config.roadStyle;
  for (const style of ['illustrated', 'pixel']) { const on = (style === 'pixel') === state.output.pixelated; $(`style-${style}`).classList.toggle('active', on); $(`style-${style}`).setAttribute('aria-pressed', on); }
  for (const key of ['preset', 'build', 'hair', 'beard', 'animation', 'mouth', 'height', 'direction']) $(`character-${key}`).value = characterState.config[key];
  $('character-beard').disabled = characterState.config.age === 'child';
  for (const key of ['skinColor', 'hairColor', 'tunicColor', 'trouserColor', 'leatherColor', 'accentColor']) $(`character-${inputId(key)}`).value = characterState.config[key];
  $('character-height-value').value = Number(characterState.config.height).toFixed(2);
  $('character-direction-value').value = `${characterState.config.direction}°`;
  const duration = CHARACTER_DURATIONS[characterState.config.animation];
  const phase = (characterState.config.time % duration) / duration;
  $('character-phase').value = phase; $('character-phase-value').value = `${Math.round(phase * 100)}%`;
  updateBatchLabel();
  scheduleSave();
}

function setMode(next) {
  if (busy || !['exterior', 'interior', 'map', 'character'].includes(next)) return;
  if (next !== mode) { renderer.resetPreview(); syncPreviewZoom(); }
  mode = next; stopSpin(); stopCharacter();
  renderer.setGroundTexture(mode === 'exterior' ? groundTexture : null);
  materialTab = mode === 'interior' ? 'wood' : 'roof';
  for (const tab of document.querySelectorAll('[data-material-tab]')) { const selected = tab.dataset.materialTab === materialTab; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', selected); }
  const select = $('batch-template'); select.replaceChildren(new Option(mode === 'character' ? 'Village inhabitants' : mode === 'interior' ? 'Mixed interiors' : 'Mixed village', 'mixed'));
  for (const [key, preset] of Object.entries(mode === 'character' ? CHARACTER_PRESETS : mode === 'interior' ? INTERIOR_PRESETS : PRESETS)) select.add(new Option(preset.label || key, key));
  syncUI(); renderMaterials(); scheduleRebuild();
}

function outputForStyle(style, source = state.output) {
  if (style === 'current') return clone(source);
  const same = (style === 'pixel') === source.pixelated;
  return { ...source, style, resolution: same || source.resolution >= 2048 ? source.resolution : mode === 'map' ? Math.max(768, source.resolution) : style === 'pixel' ? 384 : 512, scale: same || source.resolution >= 2048 ? source.scale : 2, pixelated: style === 'pixel', outline: true };
}
function applyArtStyle(style) {
  if (busy) return;
  state.output = outputForStyle(style); syncUI(); renderPreview();
}

function applyPreset(preset) {
  if (busy || !PRESETS[preset]) return;
  const next = baseRecipe(preset, state.params.seed); next.view = clone(state.view); next.output = clone(state.output);
  state = next; syncUI(); renderMaterials(); scheduleRebuild();
}

async function renderMaterials() {
  const revision = ++gridRevision, category = materialTab, grid = $('material-grid'); grid.replaceChildren();
  const entries = MATERIAL_CATALOG.filter(item => item.category === category);
  for (const entry of entries) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'material-card';
    button.dataset.materialId = entry.id; button.setAttribute('aria-pressed', activeStyle().materials[category] === entry.id);
    button.classList.toggle('active', activeStyle().materials[category] === entry.id); button.title = `${entry.label} · ${entry.source === 'sample' ? 'From your samples' : 'Procedural texture'}`;
    const label = document.createElement('span'); label.textContent = entry.label;
    const thumb = document.createElement('canvas'); thumb.width = 96; thumb.height = 64; thumb.setAttribute('aria-hidden', 'true');
    button.append(thumb, label); grid.append(button);
    button.addEventListener('click', () => chooseMaterial(entry));
    materialCanvas(entry.id, { seed: 742 }).then(source => {
      if (revision !== gridRevision) return;
      const ctx = thumb.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(source, 0, 0, 96, 64);
    }).catch(report);
    button.disabled = busy;
  }
  const selected = catalog.get(activeStyle().materials[category]);
  $('material-info').textContent = `${selected.label} · ${selected.source === 'sample' ? 'Sampled from your references' : 'Made with code'}${category === 'ground' ? ' · Preview only; excluded from house exports.' : ''}`;
}
function chooseMaterial(entry) {
  if (busy) return;
  const style = activeStyle(); style.materials[entry.category] = entry.id;
  if (entry.category === 'ground') {
    // A selected ground material is shown even if it is not in the compact menu.
    let option = [...$('ground').options].find(o => o.value === entry.id.replace('ground_', ''));
    if (!option) { option = new Option(entry.label, entry.id.replace('ground_', '')); $('ground').add(option); }
    $('ground').value = option.value; updateGround();
  } else {
    style.tints[entry.category] = entry.color; style.paletteBase[entry.category] = entry.color;
    if (mode === 'map') style.config[entry.category === 'wall' ? 'stoneColor' : `${entry.category}Color`] = entry.color;
    else if (mode === 'interior') style.config[`${entry.category}Color`] = entry.color;
    else { if (entry.category === 'roof') state.params.roofKind = entry.kind; if (entry.category === 'wall') state.params.wallKind = entry.kind; }
    syncUI(); scheduleRebuild();
  }
  renderMaterials();
}
async function updateGround() {
  const revision = ++groundRevision, value = $('ground').value;
  try {
    const texture = value === 'none' ? null : await loadMaterialTexture(THREE, `ground_${value}`, { seed: state.params.seed });
    if (revision !== groundRevision) { texture?.dispose(); return; }
    renderer.setGroundTexture(mode === 'exterior' ? texture : null); groundTexture?.dispose(); groundTexture = texture;
    if (value !== 'none') state.materials.ground = `ground_${value}`;
    renderPreview();
  } catch (error) { report(error); }
}

function variedRecipe(template, seed, strength, current = null) {
  const recipe = baseRecipe(template, seed), r = rng(seed ^ 0x578713);
  recipe.params = randomizeHouse(template, seed, strength);
  if (current && current.params.preset === template) {
    // Keep the user's chosen finishes; variation adjusts proportions and details.
    recipe.materials = clone(current.materials); recipe.paletteBase = clone(current.paletteBase || current.tints);
    recipe.tints = clone(recipe.paletteBase);
  }
  for (const key of ['roof', 'wall', 'wood']) {
    const c = new THREE.Color(recipe.tints[key]); c.offsetHSL((r() - .5) * .025 * strength, (r() - .5) * .07 * strength, (r() - .5) * .07 * strength);
    recipe.tints[key] = `#${c.getHexString()}`;
  }
  recipe.params.roofKind = catalog.get(recipe.materials.roof).kind;
  recipe.params.wallKind = catalog.get(recipe.materials.wall).kind;
  recipe.view = clone(state.view); recipe.output = clone(state.output);
  return recipe;
}

function variedInterior(template, seed, strength, current = null) {
  const r = rng(seed ^ 0x16853), original = current?.config || INTERIOR_PRESETS[template];
  const p = { ...original, preset: template, seed,
    width: Math.round(clamp(original.width + (r() - .5) * 2.8 * strength, 6, 20) * 2) / 2,
    depth: Math.round(clamp(original.depth + (r() - .5) * 2.8 * strength, 6, 20) * 2) / 2,
    tables: Math.round(clamp(original.tables + (r() - .5) * 3 * strength, 0, 12)),
  };
  if (r() < strength * .35) p.barSide = ['back', 'left', 'right'][Math.floor(r() * 3)];
  const recipe = baseInterior(template, seed, p);
  if (current) { recipe.materials = clone(current.materials); recipe.tints = clone(current.tints); recipe.paletteBase = clone(current.paletteBase); recipe.output = clone(current.output); }
  return recipe;
}

function variedCharacter(template, seed, strength, current = null) {
  const original = current?.config || CHARACTER_PRESETS[template], r = rng(seed ^ 0x346b31);
  const recipe = baseCharacter(template, seed, {...original, seed, time: 0});
  const p = recipe.config;
  if (strength > 0) {
    p.height = Math.round(clamp((original.height || 1.75) + (r() - .5) * .28 * strength, p.age === 'child' ? 1.05 : 1.5, p.age === 'child' ? 1.45 : 2) * 100) / 100;
    if (r() < strength) p.hair = ['short', 'swept', 'bob', 'braid'][Math.floor(r() * 4)];
    if (r() < strength) p.build = ['slim', 'average', 'sturdy'][Math.floor(r() * 3)];
    if (p.age !== 'child' && p.gender !== 'female' && r() < strength) p.beard = ['none', 'none', 'stubble', 'short'][Math.floor(r() * 4)];
  }
  recipe.appearanceBase = clone(current?.appearanceBase || recipe.appearanceBase);
  if (current?.output) recipe.output = clone(current.output);
  for (const key of Object.keys(recipe.appearanceBase)) {
    if (key === 'hairColor') { p[key] = recipe.appearanceBase[key]; continue; }
    const color = new THREE.Color(recipe.appearanceBase[key]);
    color.offsetHSL((r() - .5) * (key === 'tunicColor' ? .4 : .035) * strength, (r() - .5) * .12 * strength, (r() - .5) * .10 * strength);
    p[key] = `#${color.getHexString()}`;
  }
  return recipe;
}

function generateVariation() {
  if (busy) return;
  const seed = (activeSeed() + 1) % 2147483648;
  if (mode === 'character') { stopCharacter(); characterState = variedCharacter(characterState.config.preset, seed, Number($('variation-strength').value) / 100, characterState); }
  else if (mode === 'map') mapState.config = normalizeMap({ ...mapState.config, seed });
  else if (mode === 'interior') interiorState.config = normalizeInterior({ ...interiorState.config, seed });
  else state = variedRecipe(state.params.preset, seed, Number($('variation-strength').value) / 100, state);
  syncUI(); renderMaterials(); scheduleRebuild();
}

function setBusy(value) {
  busy = value;
  if (value) {
    cancelPreviewDetail();
    stopSpin(); stopCharacter(); ++rebuilding; clearTimeout(rebuildTimer); disabledBefore = new Map();
    for (const element of document.querySelectorAll('button,input,select,textarea')) { disabledBefore.set(element, element.disabled); element.disabled = true; }
    $('batch-cancel-btn').disabled = false;
    if (pendingMcpExport) $('mcp-cancel-export').disabled = false;
  } else {
    for (const [element, disabled] of disabledBefore) element.disabled = disabled;
    disabledBefore.clear(); renderPreview();
  }
}
function updateBatchLabel() {
  const count = Math.round(clamp(Number($('batch-count').value) || 1, 1, 500));
  const noun = mode === 'character' ? 'character' : mode === 'interior' ? 'interior' : 'house';
  $('batch-btn').textContent = `Export ${count} ${noun}${count === 1 ? '' : 's'}`;
  $('variation-strength-value').value = `${$('variation-strength').value}%`;
}

async function exportCurrent() {
  if (!currentPack || busy || buildDirty) return;
  const recipe = clone(activeRecipe()); setBusy(true);
  try { const canvas = renderer.render(options(recipe), { previewGround: false }); download(await toBlob(canvas), `${filename(recipe)}.png`); toast(`Exported ${canvas.width} × ${canvas.height} PNG.`); }
  catch (error) { report(error); }
  finally { setBusy(false); }
}

async function exportViews() {
  if (!currentPack || busy || buildDirty) return;
  setBusy(true);
  try {
    const entries = [], views = [];
    for (const [azimuth, name] of [[0, 'front'], [90, 'right'], [180, 'back'], [-90, 'left']]) {
      const recipe = clone(activeRecipe()); recipe.view.azimuth = azimuth;
      const canvas = renderer.render(options(recipe), { previewGround: false });
      entries.push({ name: `${filename()}-${name}.png`, blob: await toBlob(canvas) });
      views.push({ direction: name, width: canvas.width, height: canvas.height, anchor_px: renderer.lastMeta.anchor_px, recipe }); await tick();
    }
    entries.push({ name: 'views.json', blob: asBlob({ format: 'house-foundry-views', version: 1, views }) });
    download(await zipBlobs(entries), `${filename()}-four-views.zip`); toast('Exported four transparent views in one ZIP.');
  } catch (error) { report(error); }
  finally { setBusy(false); }
}

async function exportBothStyles() {
  if (!currentPack || busy || buildDirty) return;
  const source = clone(activeRecipe()); setBusy(true);
  try {
    const entries = [], variants = [];
    for (const style of ['illustrated', 'pixel']) {
      const recipe = clone(source); recipe.output = outputForStyle(style, source.output);
      const canvas = renderer.render(options(recipe), { previewGround: false });
      const file = `${style}/${filename(recipe)}.png`;
      entries.push({ name: file, blob: await toBlob(canvas) });
      entries.push({ name: `${style}/${filename(recipe)}.json`, blob: asBlob(recipe) });
      variants.push({ style, file, ...clone(renderer.lastMeta) }); await tick();
    }
    entries.push({ name: 'styles.json', blob: asBlob({ format: 'village-foundry-styles', version: 1, variants }) });
    download(await zipBlobs(entries), `${filename(source)}-both-styles.zip`); toast('Exported illustrated and pixel-art versions, with matching recipes.');
  } catch (error) { report(error); }
  finally { setBusy(false); }
}

async function exportVillageBundle() {
  if (mode !== 'map' || !currentPack || busy || buildDirty) return;
  const source = clone(activeRecipe()), layout = clone(currentPack.house.userData.layout), includeInteriors = $('map-interiors').checked;
  const entries = [], assets = [], linkedBuildings = []; let pack = null;
  cancelBatch = false; setBusy(true); $('bundle-cancel-btn').hidden = false; $('bundle-cancel-btn').disabled = false;
  const capture = async (recipe, name, parentId = null, floor = null) => {
    await tick(); if (cancelBatch) return false;
    pack = await makePack(recipe); renderer.setHouse(pack.house);
    const canvas = renderer.render(options(recipe), { previewGround: false });
    entries.push({ name: `${name}.png`, blob: await toBlob(canvas) });
    entries.push({ name: `${name}.json`, blob: asBlob({ ...recipe, layout: pack.house.userData.layout }) });
    assets.push({ id: name, file: `${name}.png`, recipe: `${name}.json`, buildingId: parentId, floor, ...clone(renderer.lastMeta) });
    renderer.setHouse(currentPack.house); disposePack(pack); pack = null;
    status(`Packing the village: ${assets.length} assets rendered…`); return true;
  };
  try {
    const mapCanvas = renderer.render(options(source), { previewGround: false });
    entries.push({ name: 'map/complete.png', blob: await toBlob(mapCanvas) });
    entries.push({ name: 'map/recipe.json', blob: asBlob(source) });
    assets.push({ id: 'complete-map', file: 'map/complete.png', ...clone(renderer.lastMeta) });
    const terrain = clone(source); terrain.config.includeHouses = false;
    await capture(terrain, 'map/landscape');
    for (const building of source.config.includeHouses ? (layout.buildings || []) : []) {
      if (cancelBatch) break;
      const p = building.params, recipe = baseRecipe(p.preset || 'village', building.seed ?? p.seed);
      recipe.params = { ...recipe.params, ...p };
      recipe.tints = { roof: p.roofColor || source.tints.roof, wall: p.wallKind === 'plaster' ? (p.wallColor || source.config.plasterColor || '#d1bea0') : (p.stoneColor || source.tints.wall), wood: p.woodColor || source.tints.wood };
      recipe.paletteBase = clone(recipe.tints); recipe.view = clone(source.view); recipe.output = {...clone(source.output), ...sizeFields(state.output)};
      const rotation = building.rotationDegrees ?? building.rotation ?? 0;
      recipe.view.azimuth = ((recipe.view.azimuth - rotation + 540) % 360) - 180;
      const id = String(building.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      await capture(recipe, `houses/${id}`, id);
      const linked = { ...building, exterior: `houses/${id}.png`, interiors: [] };
      if (includeInteriors) {
        for (let floor = 0; floor < (p.floors || 1); floor++) {
          if (cancelBatch) break;
          const config = { ...building.interior, preset: building.interior?.preset || 'cottage', floorIndex: floor, floorCount: p.floors || 1,
            width: p.width, depth: p.depth, seed: (building.interior?.seed ?? building.seed) >>> 0,
            woodColor: p.woodColor || source.tints.wood, wallColor: p.wallColor || '#d1bea0' };
          const room = baseInterior(config.preset, config.seed, config); room.view = clone(source.view); room.view.azimuth = 0; room.output = {...clone(source.output), ...sizeFields(interiorState.output)};
          const roomName = `interiors/${id}-floor-${floor + 1}`;
          await capture(room, roomName, id, floor + 1); linked.interiors.push({ floor: floor + 1, file: `${roomName}.png`, recipe: `${roomName}.json` });
        }
      }
      linkedBuildings.push(linked);
    }
    if (cancelBatch) { toast('Village bundle cancelled.'); return; }
    entries.push({ name: 'village.json', blob: asBlob({ format: 'village-foundry-bundle', version: 1, seed: source.config.seed,
      style: source.output.pixelated ? 'pixel' : 'illustrated', view: source.view, output: source.output,
      units: 'Shared world units. Metadata pixelsPerUnit gives each image scale; rescale standalone assets to the map pixelsPerUnit before compositing. Place each sprite using anchor_px. Map buildings include x/z and rotation.',
      layout: { ...layout, buildings: linkedBuildings }, assets }) });
    download(await zipBlobs(entries), `village-foundry-${source.config.seed}-${source.output.pixelated ? 'pixel' : 'illustrated'}.zip`);
    status(`Village bundle ready: ${assets.length} matching assets, map layout and linked interiors.`);
    toast(`Exported ${assets.length} matching assets with the map layout and linked interiors.`);
  } catch (error) { report(error); }
  finally { renderer.setHouse(currentPack.house); disposePack(pack); $('bundle-cancel-btn').hidden = true; setBusy(false); }
}

async function exportBatch() {
  if (!currentPack || busy || buildDirty) return;
  const count = Math.round(clamp(Number($('batch-count').value) || 1, 1, 500));
  const template = $('batch-template').value, strength = Number($('variation-strength').value) / 100;
  const selectedStyle = $('batch-style').value, styles = selectedStyle === 'both' ? ['illustrated', 'pixel'] : [selectedStyle];
  const source = clone(activeRecipe()), baseSeed = (source.config || source.params).seed, choose = rng(baseSeed ^ 0x732943);
  const characterBatch = source.format === 'village-foundry-character', interiorBatch = source.format === 'house-foundry-interior', noun = characterBatch ? 'characters' : interiorBatch ? 'interiors' : 'houses';
  const entries = [], houses = []; let pack = null;
  cancelBatch = false; setBusy(true); $('batch-cancel-btn').hidden = false;
  $('batch-progress').hidden = false; $('batch-progress').max = count; $('batch-progress').value = 0;
  $('batch-status').textContent = `Preparing ${count} ${noun}…`; status('Generating your collection. You can cancel the export.');
  try {
    for (let i = 0; i < count; i++) {
      await tick(); if (cancelBatch) break;
      const seed = (baseSeed + i) % 2147483648;
      const pick = choose();
      const characterTemplates = Object.keys(CHARACTER_PRESETS);
      const type = template === 'mixed' ? (characterBatch ? characterTemplates[Math.min(characterTemplates.length - 1, Math.floor(pick * characterTemplates.length))] : interiorBatch ? ['tavern', 'cottage', 'inn', 'workshop'][Math.min(3, Math.floor(pick * 4))] : (pick < .52 ? 'village' : pick < .75 ? 'cottage' : pick < .90 ? 'inn' : pick < .97 ? 'manor' : 'source')) : template;
      const recipe = characterBatch ? variedCharacter(type, seed, strength, template === 'mixed' ? null : source) : interiorBatch ? variedInterior(type, seed, strength, template === 'mixed' ? null : source) : variedRecipe(type, seed, strength, template === 'mixed' ? null : source);
      recipe.view = clone(source.view); recipe.output = clone(source.output);
      pack = await makePack(recipe); renderer.setHouse(pack.house);
      const name = `${String(i + 1).padStart(3, '0')}-${filename(recipe)}`;
      const variants = [];
      for (const style of styles) {
        const styled = clone(recipe); styled.output = outputForStyle(style, source.output);
        const canvas = renderer.render(options(styled), { previewGround: false });
        const label = styled.output.pixelated ? 'pixel' : 'illustrated';
        const file = `${label}/sprites/${name}.png`, recipeFile = `${label}/recipes/${name}.json`;
        entries.push({ name: file, blob: await toBlob(canvas) }); entries.push({ name: recipeFile, blob: asBlob(styled) });
        variants.push({ style: label, file, recipe: recipeFile, ...clone(renderer.lastMeta) });
      }
      houses.push({ template: type, seed, variants, layout: pack.house.userData.layout || undefined });
      renderer.setHouse(currentPack.house); disposePack(pack); pack = null;
      $('batch-progress').value = i + 1; $('batch-status').textContent = `Rendered ${i + 1} of ${count} ${noun}…`;
    }
    if (cancelBatch) { $('batch-status').textContent = `Cancelled after ${houses.length} of ${count} ${noun}. Your current scene is unchanged.`; toast('Batch cancelled.'); return; }
    $('batch-status').textContent = 'Packing your PNGs and recipes…'; await tick();
    const manifest = { format: 'house-foundry-batch', version: 1, baseSeed, template, variation: strength,
      count: houses.length, output: source.output, view: source.view,
      notes: 'RGBA PNGs with transparent background and world-unit scale metadata. Character bounds are fixed for animation. Load any recipes/*.json file to edit that asset.', assets: houses };
    entries.push({ name: 'manifest.json', blob: asBlob(manifest) });
    const zip = await zipBlobs(entries);
    if (cancelBatch) { $('batch-status').textContent = 'Batch cancelled.'; return; }
    download(zip, `village-foundry-${noun}-${template}-${baseSeed}-${count}.zip`);
    lastBatch = { count: houses.length, baseSeed, bytes: zip.size };
    $('batch-status').textContent = `Exported ${count * styles.length} transparent PNGs + matching recipes (${(zip.size / 1048576).toFixed(1)} MB).`;
    toast(`${count} ${noun} are ready in your ZIP.`);
  } catch (error) { $('batch-status').textContent = `Export stopped: ${error.message}`; report(error); }
  finally {
    renderer.setHouse(currentPack.house); disposePack(pack); $('batch-cancel-btn').hidden = true;
    setBusy(false); status('Ready. Your seed and settings are saved in each exported recipe.');
  }
}

function validateRecipe(raw) {
  if (raw?.format === 'village-foundry-character' && raw.version === 1 && raw.config && typeof raw.config === 'object') {
    const config = normalizeCharacter(raw.config), recipe = baseCharacter(config.preset, config.seed, config);
    if (Number.isFinite(raw.view?.elevation)) recipe.view.elevation = clamp(raw.view.elevation, 0, 90);
    if (Number.isFinite(raw.view?.azimuth)) recipe.view.azimuth = clamp(raw.view.azimuth, -180, 180);
    if ([128, 192, 256, 384, 512, 768, 1024, 2048, 4096].includes(raw.output?.resolution)) recipe.output.resolution = raw.output.resolution;
    if ([1, 2, 3, 4].includes(raw.output?.scale)) recipe.output.scale = raw.output.scale;
    for (const key of ['pixelated', 'outline', 'shadow']) if (typeof raw.output?.[key] === 'boolean') recipe.output[key] = raw.output[key];
    for (const key of Object.keys(recipe.appearanceBase)) if (validColor(raw.appearanceBase?.[key])) recipe.appearanceBase[key] = raw.appearanceBase[key];
    recipe.output = outputBounds(raw.output, recipe.output); return recipe;
  }
  if (raw?.format === 'village-foundry-map' && raw.version === 1 && raw.config && typeof raw.config === 'object') {
    const config = normalizeMap(raw.config), map = baseMap(config.preset, config.seed, config);
    if (Number.isFinite(raw.view?.elevation)) map.view.elevation = clamp(raw.view.elevation, 0, 90);
    if (Number.isFinite(raw.view?.azimuth)) map.view.azimuth = clamp(raw.view.azimuth, -180, 180);
    if ([128, 192, 256, 384, 512, 768, 1024, 2048, 4096].includes(raw.output?.resolution)) map.output.resolution = raw.output.resolution;
    if ([1, 2, 3, 4].includes(raw.output?.scale)) map.output.scale = raw.output.scale;
    for (const key of ['pixelated', 'outline', 'shadow']) if (typeof raw.output?.[key] === 'boolean') map.output[key] = raw.output[key];
    map.output = outputBounds(raw.output, map.output); return map;
  }
  if (raw?.format === 'house-foundry-interior' && raw.version === 1 && raw.config && typeof raw.config === 'object') {
    const config = normalizeInterior(raw.config), room = baseInterior(config.preset, config.seed, config);
    for (const category of ['roof', 'wall', 'wood', 'ground']) {
      if (catalog.get(raw.materials?.[category])?.category === category) room.materials[category] = raw.materials[category];
      if (category !== 'ground' && validColor(raw.tints?.[category])) room.tints[category] = raw.tints[category];
    }
    room.paletteBase = clone(room.tints);
    if (Number.isFinite(raw.view?.elevation)) room.view.elevation = clamp(raw.view.elevation, 0, 90);
    if (Number.isFinite(raw.view?.azimuth)) room.view.azimuth = clamp(raw.view.azimuth, -180, 180);
    if ([128, 192, 256, 384, 512, 768, 1024, 2048, 4096].includes(raw.output?.resolution)) room.output.resolution = raw.output.resolution;
    if ([1, 2, 3, 4].includes(raw.output?.scale)) room.output.scale = raw.output.scale;
    for (const key of ['pixelated', 'outline', 'shadow']) if (typeof raw.output?.[key] === 'boolean') room.output[key] = raw.output[key];
    room.output = outputBounds(raw.output, room.output); return room;
  }
  if (!raw || raw.format !== 'house-foundry' || raw.version !== 1 || !raw.params || !Object.hasOwn(PRESETS, raw.params.preset)) throw new Error('Choose a Village Foundry recipe JSON file from an export.');
  const recipe = baseRecipe(raw.params.preset, seedNumber(raw.params.seed));
  recipe.params = normalizeHouse(raw.params);
  recipe.tints = {roof: recipe.params.roofColor, wall: recipe.params.wallKind === 'plaster' ? recipe.params.wallColor : recipe.params.stoneColor, wood: recipe.params.woodColor};
  recipe.paletteBase = clone(recipe.tints);
  const ranges = { width: [3, 8], depth: [3, 10], floors: [1, 3], floorHeight: [1.45, 2.25], roofPitch: [25, 65] };
  for (const [key, range] of Object.entries(ranges)) {
    if (!Number.isFinite(Number(raw.params[key]))) throw new Error(`The recipe has an invalid ${key}.`);
    recipe.params[key] = clamp(raw.params[key], ...range);
  }
  recipe.params.floors = Math.round(recipe.params.floors);
  for (const key of toggles) if (typeof raw.params[key] === 'boolean') recipe.params[key] = raw.params[key];
  for (const key of ['roofColor', 'wallColor', 'woodColor']) if (validColor(raw.params[key])) recipe.params[key] = raw.params[key];
  for (const category of ['roof', 'wall', 'wood', 'ground']) {
    if (catalog.get(raw.materials?.[category])?.category === category) recipe.materials[category] = raw.materials[category];
    if (category !== 'ground') {
      if (validColor(raw.tints?.[category])) recipe.tints[category] = raw.tints[category];
      recipe.paletteBase[category] = validColor(raw.paletteBase?.[category]) ? raw.paletteBase[category] : recipe.tints[category];
    }
  }
  if (Number.isFinite(raw.view?.elevation)) recipe.view.elevation = clamp(raw.view.elevation, 0, 90);
  if (Number.isFinite(raw.view?.azimuth)) recipe.view.azimuth = clamp(raw.view.azimuth, -180, 180);
  if ([128, 192, 256, 384, 512, 768, 1024, 2048, 4096].includes(raw.output?.resolution)) recipe.output.resolution = raw.output.resolution;
  if ([1, 2, 3, 4].includes(raw.output?.scale)) recipe.output.scale = raw.output.scale;
  for (const key of ['pixelated', 'outline', 'shadow']) if (typeof raw.output?.[key] === 'boolean') recipe.output[key] = raw.output[key];
  recipe.output = outputBounds(raw.output, recipe.output); return recipe;
}

async function loadReference(source, name) {
  const revision = ++referenceRevision;
  const image = new Image(); image.decoding = 'async'; image.src = source; await image.decode();
  if (revision !== referenceRevision) return;
  if (image.naturalWidth * image.naturalHeight > 40000000) throw new Error('Choose an image smaller than 40 megapixels.');
  referenceImage = image;
  const canvas = $('reference-canvas'), ctx = canvas.getContext('2d');
  const scale = Math.min(1, 384 / image.naturalWidth, 240 / image.naturalHeight);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  ctx.imageSmoothingEnabled = false; ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  canvas.hidden = false;
  $('reference-note').textContent = `${name} · ${image.naturalWidth} × ${image.naturalHeight}. Use its colours as a starting palette.`;
  $('sample-palette-btn').disabled = false;
}
async function uploadReference(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Choose a PNG, JPEG, WebP or another image file.', true); return; }
  if (file.size > 25 * 1048576) { toast('Choose an image smaller than 25 MB.', true); return; }
  const url = URL.createObjectURL(file);
  try { await loadReference(url, file.name); } catch (error) { report(error); } finally { URL.revokeObjectURL(url); }
}
function samplePalette() {
  if (!referenceImage || busy) return;
  const canvas = document.createElement('canvas'), scale = Math.min(1, 512 / Math.max(referenceImage.width, referenceImage.height));
  canvas.width = Math.round(referenceImage.width * scale); canvas.height = Math.round(referenceImage.height * scale);
  const ctx = canvas.getContext('2d'); ctx.drawImage(referenceImage, 0, 0, canvas.width, canvas.height);
  const palette = inferPalette(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const style = activeStyle(); style.tints = { roof: palette.roof, wall: palette.wall, wood: palette.wood }; style.paletteBase = clone(style.tints);
  if (mode === 'character') {
    Object.assign(style.config, {tunicColor: palette.roof, leatherColor: palette.wood, accentColor: palette.wall});
    Object.assign(style.appearanceBase, {tunicColor: palette.roof, leatherColor: palette.wood, accentColor: palette.wall});
  }
  else if (mode === 'map') { style.config.stoneColor = palette.wall; style.config.woodColor = palette.wood; style.config.roofColor = palette.roof; }
  else if (mode === 'interior') { style.config.wallColor = palette.wall; style.config.woodColor = palette.wood; }
  else state.params.wallColor = palette.wall;
  syncUI(); scheduleRebuild();
  toast('Applied estimated colours. You can adjust each tint below.');
}

async function applyLoadedRecipe(recipe) {
  stopSpin(); stopCharacter();
  if (recipe.format === 'village-foundry-character') { characterState = recipe; state.view = clone(recipe.view); Object.assign(state.output, sharedOutputFields(recipe.output)); state.output.style = state.output.pixelated ? 'pixel' : 'illustrated'; setMode('character'); }
  else if (recipe.format === 'village-foundry-map') { mapState = recipe; state.view = clone(recipe.view); Object.assign(state.output, sharedOutputFields(recipe.output)); state.output.style = state.output.pixelated ? 'pixel' : 'illustrated'; setMode('map'); }
  else if (recipe.config) { interiorState = recipe; state.view = clone(recipe.view); Object.assign(state.output, sharedOutputFields(recipe.output)); state.output.style = state.output.pixelated ? 'pixel' : 'illustrated'; setMode('interior'); }
  else { state = recipe; setMode('exterior'); }
  clearTimeout(rebuildTimer); syncUI(); renderMaterials(); await rebuild();
}

async function api(path, init = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  let result;
  try { result = await response.json(); } catch {
    throw new Error(mcpConnection(location).local
      ? 'The local MCP service did not respond with scene data. Start the local server and open its workbench address.'
      : 'The MCP scene service did not respond with scene data. Open the workbench from its server address.');
  }
  if (!response.ok) throw new Error(result.error?.message || (typeof result.error === 'string' ? result.error : null) || `Scene request failed (${response.status}).`);
  return result;
}
async function copyMcpEndpoint() {
  const { endpoint } = mcpConnection(location);
  if (!endpoint) return;
  try {
    await navigator.clipboard.writeText(endpoint);
    toast('MCP endpoint copied.');
  } catch {
    const selection = document.getSelection?.();
    if (selection && document.createRange) {
      const range = document.createRange(); range.selectNodeContents($('mcp-endpoint'));
      selection.removeAllRanges(); selection.addRange(range);
    }
    $('mcp-status').textContent = 'Clipboard access is unavailable. Copy the endpoint shown above.';
  }
}
async function connectMcp() {
  const connection = mcpConnection(location);
  $('mcp-endpoint').textContent = connection.endpoint || 'Open the workbench through its server';
  $('mcp-copy-endpoint').disabled = !connection.available;
  $('mcp-connection-note').textContent = connection.local
    ? 'Local MCP runs on this computer. Connect your MCP client to the endpoint below; keep this tab open with Follow MCP changes enabled to render exports.'
    : 'Load a scene recipe from MCP, or send your current scene for precise edits.';
  if (!connection.available) {
    $('mcp-status').textContent = 'Start the local server, then open the workbench address it prints to connect MCP.';
    $('mcp-live-sync').disabled = true; return;
  }
  try {
    const [remote, localInfo] = await Promise.all([
      api('/api/scene'),
      connection.local ? api('/api/local-info').catch(() => null) : Promise.resolve(null),
    ]);
    mcpConnected = true; mcpRevision = remote.revision;
    mcpInitialScenePending = connection.local && remote.revision > 0 && Boolean(remote.scene);
    syncMcpJob(remote.exportJob);
    $('mcp-live-sync').disabled = false;
    if (connection.local) $('mcp-live-sync').checked = true;
    $('mcp-status').textContent = connection.local
      ? `Local MCP connected. Following scene changes and export requests.${localInfo?.persistentStorage ? ' The local server saves scene data and PNGs on this computer.' : ''}`
      : 'Connected. Load the saved MCP scene, or send your current scene to start directing it.';
    $('mcp-pull').disabled = false; $('mcp-push').disabled = false;
    setInterval(() => {
      if ($('mcp-live-sync').checked && !busy && !buildDirty && !mcpPolling) pullMcp(true).catch(error => { $('mcp-status').textContent = error.message; });
    }, 4500);
  } catch (error) {
    mcpConnected = false;
    $('mcp-status').textContent = connection.local ? `Local MCP is unavailable. ${error.message}` : error.message;
    $('mcp-live-sync').disabled = true; $('mcp-pull').disabled = true; $('mcp-push').disabled = true;
  }
}
function syncMcpJob(job) {
  pendingMcpExport = job?.status === 'pending' ? job.id : null;
  $('mcp-cancel-export').hidden = !pendingMcpExport;
  $('mcp-cancel-export').disabled = !pendingMcpExport;
}
async function cancelMcpExport() {
  if (!pendingMcpExport) return;
  const result = await api(`/api/exports/${encodeURIComponent(pendingMcpExport)}/cancel`, {method: 'POST'});
  // An export response may also contain a concurrent scene edit. Only a scene
  // load/write advances mcpRevision; the next follow poll must still see it.
  syncMcpJob(result.exportJob);
  $('mcp-status').textContent = result.note || (result.cancelled ? 'MCP export cancelled.' : 'The export was already completed.');
}
async function pullMcp(follow = false) {
  if (!mcpConnected || busy || mcpPolling) return;
  mcpPolling = true;
  try {
    const remote = await api('/api/scene');
    syncMcpJob(remote.exportJob);
    if (remote.scene && (!follow || remote.revision !== mcpRevision || mcpInitialScenePending)) {
      if (busy) return;
      await applyLoadedRecipe(validateRecipe(remote.scene));
      mcpInitialScenePending = false;
      mcpRevision = remote.revision;
      $('mcp-status').textContent = 'MCP scene loaded. The preview shows the generated result.';
      // Send the renderer's actual placement report, including skipped requests.
      // This lets an MCP caller inspect the result instead of assuming placement.
      if (['interior', 'map'].includes(mode) && !buildDirty && currentPack.house.userData.kind === mode) {
        const actual = currentPack.house.userData.config;
        const normalizer = mode === 'map' ? normalizeMap : normalizeInterior;
        if (JSON.stringify(actual) === JSON.stringify(normalizer(remote.scene.config))) {
          try {
            const saved = await api('/api/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scene: remote.scene, layout: compactLayoutReport(currentPack.house.userData.layout, mode), expectedRevision: mcpRevision }) });
            mcpRevision = saved.revision;
          } catch (error) { $('mcp-status').textContent = `Scene loaded; placement report is waiting to sync: ${error.message}`; }
        }
      }
    }
    if (remote.exportJob?.status === 'ready' && remote.exportJob.url) {
      const url = new URL(remote.exportJob.url, location.origin);
      if (url.origin === location.origin && url.pathname.startsWith('/api/exports/')) {
        $('mcp-export-link').href = url.href; $('mcp-export-link').hidden = false; $('mcp-export-link').textContent = 'Download latest MCP PNG';
      }
    }
    if(remote.exportJob?.status==='failed') $('mcp-status').textContent=`PNG request could not render: ${remote.exportJob.error?.message||'Change its settings and request another export.'}`;
    if (follow && remote.exportJob?.status === 'pending' && remote.exportJob.id !== handledExport && Date.now() >= exportRetryAt && !busy) await completeMcpExport(remote.exportJob);
  } finally { mcpPolling = false; }
}
async function pushMcp() {
  if (!mcpConnected || busy || buildDirty) return;
  const result = await api('/api/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: activeRecipe(), layout: compactLayoutReport(currentPack.house.userData.layout, mode), expectedRevision: mcpRevision }) });
  mcpRevision = result.revision;
  mcpInitialScenePending = false;
  $('mcp-status').textContent = 'Scene sent. Your connected assistant can now edit it through MCP.';
  toast('Current scene saved for MCP.');
}
async function completeMcpExport(job) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(job.id)) throw new Error('The export request has an invalid identifier.');
  let pack, snapshotValidated = false;
  setBusy(true); $('mcp-status').textContent = 'Rendering the PNG requested through MCP…';
  try {
    const recipe = validateRecipe(job.scene); snapshotValidated = true; pack = await makePack(recipe); renderer.setHouse(pack.house);
    let canvas, anchor;
    if (job.options?.format === 'spritesheet') {
      if (recipe.format !== 'village-foundry-character') throw new Error('Sprite sheets require a character scene.');
      const sheet = await renderAnimationSheet(renderer, pack.house, recipe.config, options(recipe), {...job.options,
        shouldCancel: () => pendingMcpExport !== job.id,
        onProgress: async (done, total) => { $('mcp-status').textContent = `Rendering animation: ${done} of ${total} frames…`; await tick(); }});
      canvas = sheet.canvas; anchor = sheet.metadata.anchor_px;
    } else { canvas = renderer.render(options(recipe), { previewGround: false }); anchor = renderer.lastMeta.anchor_px; }
    const blob = await toBlob(canvas);
    if(blob.size>16*1024*1024){const error=new RangeError('This PNG exceeds the MCP service’s 16 MiB file limit. Reduce its detail resolution, export scale, or fixed canvas dimensions.');error.code='render_budget_exceeded';throw error;}
    const response = await api(`/api/exports/${encodeURIComponent(job.id)}`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Foundry-Anchor-X': String(anchor[0]), 'X-Foundry-Anchor-Y': String(anchor[1]) }, body: blob });
    handledExport = job.id;
    // Keep the last-applied scene revision until the next follow poll loads
    // any scene changes that arrived while this snapshot was rendering.
    syncMcpJob(response.exportJob);
    $('mcp-export-link').href = `/api/exports/${encodeURIComponent(job.id)}`; $('mcp-export-link').hidden = false;
    $('mcp-export-link').textContent = 'Download latest MCP PNG'; $('mcp-status').textContent = 'PNG rendered and saved. Your assistant can retrieve it through MCP.';
  } catch (error) {
    if (pendingMcpExport !== job.id) { $('mcp-status').textContent = 'MCP export cancelled.'; return; }
    if(snapshotValidated&&['render_budget_exceeded','invalid_geometry'].includes(error.code)){
      try{
        const response=await api(`/api/exports/${encodeURIComponent(job.id)}/fail`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:error.code,message:error.message.slice(0,1000)})});
        syncMcpJob(response.exportJob);handledExport=job.id;
        $('mcp-status').textContent=`PNG request could not render: ${error.message} Change its settings and request another export.`;
        return;
      }catch(failure){$('mcp-status').textContent=`Could not report the render failure: ${failure.message}`;}
    }
    exportRetryAt = Date.now() + 60000; $('mcp-status').textContent = `PNG request failed: ${error.message} Retrying in one minute while Follow MCP changes is enabled.`; throw error;
  }
  finally { renderer.setHouse(currentPack.house); disposePack(pack); setBusy(false); }
}

function stopCharacter() {
  characterPlaying = false; cancelAnimationFrame(characterFrame);
  $('character-play').textContent = 'Play animation'; $('character-play').setAttribute('aria-pressed', 'false');
}
function poseCharacter() {
  if (mode !== 'character' || busy || buildDirty || !currentPack) return;
  applyCharacterPose(currentPack.house, characterState.config); renderPreview();
}
function toggleCharacter() {
  if (characterPlaying) { stopCharacter(); return; }
  if (mode !== 'character' || busy || buildDirty) return;
  stopSpin(); characterPlaying = true; $('character-play').textContent = 'Pause animation'; $('character-play').setAttribute('aria-pressed', 'true');
  let last = performance.now();
  const animate = now => {
    if (!characterPlaying) return;
    if (now - last >= 90) {
      const duration = CHARACTER_DURATIONS[characterState.config.animation];
      characterState.config.time = (characterState.config.time + (now - last) / 1000) % duration; last = now;
      $('character-phase').value = characterState.config.time / duration;
      $('character-phase-value').value = `${Math.round(characterState.config.time / duration * 100)}%`;
      poseCharacter();
    }
    characterFrame = requestAnimationFrame(animate);
  };
  characterFrame = requestAnimationFrame(animate);
}

async function exportCharacterAnimations(all = false) {
  if (mode !== 'character' || !currentPack || busy || buildDirty) return;
  const source = clone(activeRecipe()), entries = [], animations = [];
  const selected = $('animation-style').value, styles = selected === 'both' ? ['illustrated', 'pixel'] : [selected];
  const actions = all ? Object.keys(CHARACTER_DURATIONS) : [source.config.animation];
  const frames = Number($('animation-frames').value), directions = Number($('animation-directions').value);
  const frameDetail = Number($('animation-detail').value);
  cancelBatch = false; setBusy(true); $('animation-cancel-btn').hidden = false; $('animation-cancel-btn').disabled = false;
  try {
    for (const style of styles) for (const animation of actions) {
      const recipe = clone(source); recipe.output = outputForStyle(style, source.output);
      recipe.output.resolution = frameDetail; recipe.output.scale = Math.min(2, recipe.output.scale);
      recipe.config.animation = animation; recipe.config.time = 0;
      const styleName = recipe.output.pixelated ? 'pixel' : 'illustrated', prefix = `${styleName}/${animation}`;
      const result = await renderAnimationSheet(renderer, currentPack.house, recipe.config, options(recipe), {
        animation, frames, directions, shouldCancel: () => cancelBatch,
        onFrame: async (canvas, cell) => { entries.push({name: `${prefix}/frames/d${cell.row}-${String(cell.column).padStart(2, '0')}.png`, blob: await toBlob(canvas)}); },
        onProgress: async (done, total) => { $('animation-status').textContent = `${styleName} · ${animation}: ${done} of ${total} frames…`; await tick(); },
      });
      entries.push({name: `${prefix}/sheet.png`, blob: await toBlob(result.canvas)});
      entries.push({name: `${prefix}/animation.json`, blob: asBlob(result.metadata)});
      entries.push({name: `${prefix}/recipe.json`, blob: asBlob(recipe)});
      animations.push({animation, style: styleName, sheet: `${prefix}/sheet.png`, metadata: `${prefix}/animation.json`, frames, directions, fps: result.metadata.fps});
    }
    entries.push({name: 'character.json', blob: asBlob({format: 'village-foundry-character-pack', version: 1, character: source, animations})});
    download(await zipBlobs(entries), `${filename(source)}-${all ? 'all-actions' : source.config.animation}.zip`);
    $('animation-status').textContent = `Exported ${animations.length} sprite sheet${animations.length === 1 ? '' : 's'}, individual frames, and exact frame timing and anchors.`;
    toast('Character animation pack exported.');
  } catch (error) { if (cancelBatch) $('animation-status').textContent = 'Animation export cancelled.'; else report(error); }
  finally { applyCharacterPose(currentPack.house, source.config); $('animation-cancel-btn').hidden = true; setBusy(false); }
}

async function exportCharacterReference() {
  if (mode !== 'character' || !currentPack || busy || buildDirty) return;
  const source = clone(activeRecipe()), entries = [], views = []; setBusy(true);
  try {
    const sheet = document.createElement('canvas'); let context;
    for (let i = 0; i < 4; i++) {
      const pose = {...source.config, animation: 'idle', time: 0, direction: i * 90, mouth: 'closed'};
      applyCharacterPose(currentPack.house, pose);
      const canvas = renderer.render({...options(source), resolution: 768, scale: 1, pixelated: false, style: 'illustrated', sizeMode: 'auto'}, {previewGround: false});
      if (!context) { sheet.width = canvas.width * 4; sheet.height = canvas.height; context = sheet.getContext('2d'); }
      context.drawImage(canvas, canvas.width * i, 0);
      const name = `turnaround-${i * 90}.png`; entries.push({name, blob: await toBlob(canvas)});
      views.push({file: name, direction: i * 90, ...clone(renderer.lastMeta)}); await tick();
    }
    entries.push({name: 'turnaround.png', blob: await toBlob(sheet)});
    for (const mouth of ['closed', 'open', 'wide']) {
      applyCharacterPose(currentPack.house, {...source.config, animation: 'talk', time: .25, direction: 0, mouth});
      const canvas = renderer.render({...options(source), resolution: 768, scale: 1, pixelated: false, style: 'illustrated', sizeMode: 'auto'}, {previewGround: false});
      entries.push({name: `expression-${mouth}.png`, blob: await toBlob(canvas)}); await tick();
    }
    entries.push({name: 'reference.json', blob: asBlob({format: 'village-foundry-character-reference', version: 1, recipe: source, views,
      notes: 'All views and expressions come from one articulated model. World-up is +Y; front is +Z. Recipe recreates the same character.'})});
    download(await zipBlobs(entries), `${filename(source)}-references.zip`); toast('Exported a turnaround and three mouth-expression references.');
  } catch (error) { report(error); }
  finally { applyCharacterPose(currentPack.house, source.config); setBusy(false); }
}

function stopSpin() { spinning = false; cancelAnimationFrame(spinFrame); $('spin-btn').setAttribute('aria-pressed', 'false'); }
function toggleSpin() {
  if (busy) return;
  if (spinning) { stopSpin(); return; }
  spinning = true; $('spin-btn').setAttribute('aria-pressed', 'true'); let previous = performance.now();
  const animate = time => {
    if (!spinning) return;
    if (time - previous >= 65) { state.view.azimuth = ((state.view.azimuth + (time - previous) * .012 + 180) % 360) - 180; previous = time; syncUI(); renderPreview(); }
    spinFrame = requestAnimationFrame(animate);
  };
  spinFrame = requestAnimationFrame(animate);
}

function bindMapDimensionInput(input, key) {
  const commit = () => {
    const current = mapState.config;
    const raw = String(input.value).trim(), value = raw === '' ? current[key] : Number(raw);
    const next = normalizeMap({...current, [key]: Number.isFinite(value) ? value : current[key]});
    input.value = String(next[key]);
    if (next.width === current.width && next.depth === current.depth) return;
    mapState.config = next;
    renderer.resetPreview(); syncPreviewZoom(); syncUI(); scheduleRebuild();
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); commit(); input.blur();
  });
}

function bindEvents() {
  $('character-preset').replaceChildren(...Object.entries(CHARACTER_PRESETS).map(([key, preset]) => new Option(preset.label || key, key)));
  for (const id of savedControlIds) $(id).addEventListener('change', scheduleSave);
  $('mode-exterior').addEventListener('click', () => setMode('exterior'));
  $('mode-interior').addEventListener('click', () => setMode('interior'));
  $('mode-map').addEventListener('click', () => { if (state.output.resolution < 768) state.output.resolution = 1024; setMode('map'); });
  $('mode-character').addEventListener('click', () => setMode('character'));
  $('character-preset').addEventListener('change', e => { stopCharacter(); const output = characterState.output; characterState = baseCharacter(e.target.value, activeSeed()); characterState.output = output; syncUI(); scheduleRebuild(); });
  for (const key of ['build', 'hair', 'beard']) $(`character-${key}`).addEventListener('change', e => { stopCharacter(); characterState.config[key] = e.target.value; scheduleRebuild(); });
  $('character-height').addEventListener('input', e => { stopCharacter(); characterState.config.height = Number(e.target.value); syncUI(); scheduleRebuild(); });
  for (const key of ['skinColor', 'hairColor', 'tunicColor', 'trouserColor', 'leatherColor', 'accentColor']) $(`character-${inputId(key)}`).addEventListener('input', e => {
    stopCharacter(); characterState.config[key] = e.target.value; characterState.appearanceBase[key] = e.target.value; scheduleRebuild();
  });
  $('character-animation').addEventListener('change', e => { stopCharacter(); characterState.config.animation = e.target.value; characterState.config.time = 0; syncUI(); poseCharacter(); });
  $('character-mouth').addEventListener('change', e => { characterState.config.mouth = e.target.value; poseCharacter(); });
  $('character-direction').addEventListener('input', e => { characterState.config.direction = Number(e.target.value); syncUI(); poseCharacter(); });
  $('character-phase').addEventListener('input', e => { stopCharacter(); characterState.config.time = Number(e.target.value) * CHARACTER_DURATIONS[characterState.config.animation]; syncUI(); poseCharacter(); });
  $('character-play').addEventListener('click', toggleCharacter);
  $('character-reference-btn').addEventListener('click', exportCharacterReference);
  $('animation-export-btn').addEventListener('click', () => exportCharacterAnimations(false));
  $('animation-all-btn').addEventListener('click', () => exportCharacterAnimations(true));
  $('animation-cancel-btn').addEventListener('click', () => { cancelBatch = true; $('animation-status').textContent = 'Cancelling after this frame…'; });
  $('style-illustrated').addEventListener('click', () => applyArtStyle('illustrated'));
  $('style-pixel').addEventListener('click', () => applyArtStyle('pixel'));
  $('map-preset').addEventListener('change', e => { const output = mapState.output; mapState = baseMap(e.target.value, activeSeed()); mapState.output = output; syncUI(); scheduleRebuild(); });
  $('map-size-preset').addEventListener('change', e => {
    if (e.target.value === 'custom') { $('map-width').focus(); return; }
    const size = Number(e.target.value);
    mapState.config = normalizeMap({...mapState.config, width: size, depth: size});
    renderer.resetPreview(); syncPreviewZoom(); syncUI(); scheduleRebuild();
  });
  for (const [id, key] of [['width', 'width'], ['depth', 'depth']]) {
    bindMapDimensionInput($(`map-${id}`), key);
  }
  $('map-house-count').addEventListener('input', e => { mapState.config.houseCount = Number(e.target.value); syncUI(); scheduleRebuild(); });
  for (const [id, key] of [['houses', 'includeHouses'], ['roads', 'roads'], ['fences', 'fences'], ['trees', 'trees'], ['water', 'water'], ['gardens', 'gardens'], ['sea', 'sea']]) $(`map-${id}`).addEventListener('change', e => { mapState.config[key] = e.target.checked; syncUI(); scheduleRebuild(); });
  $('map-landform').addEventListener('change', e => { mapState.config.landform = e.target.value; syncUI(); scheduleRebuild(); });
  for (const [id, key] of [['house-preset', 'housePreset'], ['road-style', 'roadStyle']]) $(`map-${id}`).addEventListener('change', e => { mapState.config[key] = e.target.value; scheduleRebuild(); });
  $('room-preset').addEventListener('change', e => { const output = interiorState.output; interiorState = baseInterior(e.target.value, activeSeed()); interiorState.output = output; syncUI(); renderMaterials(); scheduleRebuild(); });
  for (const key of ['width', 'depth', 'tables', 'bedrooms']) $(`room-${key}`).addEventListener('input', e => { interiorState.config[key] = Number(e.target.value); syncUI(); scheduleRebuild(); });
  for (const key of ['floorCount', 'floorIndex', 'layoutVariant']) $(`room-${inputId(key)}`).addEventListener('change', e => { interiorState.config[key] = e.target.value === 'auto' ? 'auto' : Number(e.target.value); interiorState.config = normalizeInterior(interiorState.config); syncUI(); scheduleRebuild(); });
  $('bar-side').addEventListener('change', e => { interiorState.config.barSide = e.target.value; interiorState.config.bar = true; scheduleRebuild(); });
  for (const key of ['fireplace', 'shelves', 'barrels', 'rug', 'clearCenter', 'kitchen', 'bar', 'stairs', 'occupants']) $(`room-${inputId(key)}`).addEventListener('change', e => { interiorState.config[key] = e.target.checked; scheduleRebuild(); });
  $('apply-brief').addEventListener('click', () => {
    const result = interpretBrief($('room-brief').value, interiorState.config);
    const output = interiorState.output;
    interiorState = baseInterior(result.config.preset, result.config.seed, result.config);
    interiorState.output = output;
    $('director-status').textContent = result.applied.length ? `Applied: ${result.applied.join(', ')}.` : result.note;
    syncUI(); scheduleRebuild(); toast(result.applied.length ? `Applied: ${result.applied.join(', ')}.` : result.note);
  });
  $('mcp-copy-endpoint').addEventListener('click', copyMcpEndpoint);
  $('mcp-pull').addEventListener('click', () => pullMcp(false).catch(report));
  $('mcp-push').addEventListener('click', () => pushMcp().catch(report));
  $('mcp-cancel-export').addEventListener('click', () => cancelMcpExport().catch(report));
  $('mcp-live-sync').addEventListener('change', () => {
    if ($('mcp-live-sync').checked) { exportRetryAt = 0; pullMcp(true).catch(report); }
    else $('mcp-status').textContent = 'Connected. Automatic updates paused; use Load MCP scene when you are ready.';
  });
  $('preset').addEventListener('change', e => applyPreset(e.target.value));
  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
  for (const key of ['width', 'depth', 'floors', 'floorHeight', 'roofPitch']) $(inputId(key)).addEventListener('input', e => { state.params[key] = Number(e.target.value); syncUI(); scheduleRebuild(); });
  $('seed').addEventListener('change', e => {
    if (mode === 'character') { stopCharacter(); characterState = variedCharacter(characterState.config.preset, seedNumber(e.target.value), Number($('variation-strength').value) / 100, characterState); }
    else if (mode === 'map') mapState.config.seed = seedNumber(e.target.value);
    else if (mode === 'interior') interiorState.config.seed = seedNumber(e.target.value);
    else state = variedRecipe(state.params.preset, seedNumber(e.target.value), Number($('variation-strength').value) / 100, state);
    syncUI(); scheduleRebuild();
  });
  for (const key of toggles) $(inputId(key)).addEventListener('change', e => { state.params[key] = e.target.checked; scheduleRebuild(); });
  for (const key of ['roof', 'wall', 'wood']) $(`${key}-color`).addEventListener('input', e => {
    const style = activeStyle(); style.tints[key] = e.target.value; style.paletteBase[key] = e.target.value;
    if (mode === 'map') style.config[key === 'wall' ? 'stoneColor' : `${key}Color`] = e.target.value;
    else if (mode === 'interior' && key !== 'roof') style.config[`${key}Color`] = e.target.value;
    else if (key === 'wall') state.params.wallColor = e.target.value; scheduleRebuild();
  });
  $('variation-btn').addEventListener('click', generateVariation);
  $('reset-btn').addEventListener('click', () => { stopSpin(); stopCharacter(); if (mode === 'character') characterState = baseCharacter(); else if (mode === 'map') mapState = baseMap(); else if (mode === 'interior') interiorState = baseInterior(); else state = baseRecipe(); $('ground').value = 'none'; updateGround(); syncUI(); renderMaterials(); scheduleRebuild(); });
  for (const key of ['elevation', 'azimuth']) $(key).addEventListener('input', e => { stopSpin(); state.view[key] = Number(e.target.value); syncUI(); renderPreview(); });
  for (const [name, elevation] of [['rpg', 45], ['top', 90], ['front', 0]]) $(`view-${name}`).addEventListener('click', () => { stopSpin(); state.view = { elevation, azimuth: 0 }; syncUI(); renderPreview(); });
  $('elevation').min = '0';
  $('spin-btn').addEventListener('click', toggleSpin);
  $('checker').addEventListener('change', e => { $('viewport').dataset.checker = e.target.value; });
  $('resolution').addEventListener('change', e => { state.output.resolution = Number(e.target.value); if(state.output.resolution>=2048)state.output.scale=1; syncUI(); renderPreview(); });
  $('pixel-scale').addEventListener('change', e => { state.output.scale = Number(e.target.value); renderPreview(); });
  $('output-size-mode').addEventListener('change', e => { activeStyle().output = {...defaultOutput(), ...activeStyle().output, sizeMode: e.target.value}; syncUI(); renderPreview(); });
  for (const key of ['width', 'height', 'padding']) $(`output-${key}`).addEventListener('change', e => {
    const target = activeStyle(); target.output = outputBounds({[key]: Number(e.target.value)}, {...defaultOutput(), ...target.output});
    target.output.padding = Math.min(target.output.padding, Math.floor((Math.min(target.output.width, target.output.height) - 1) / 2));
    syncUI(); renderPreview();
  });
  $('output-fit').addEventListener('change', e => { activeStyle().output.fit = e.target.value; syncUI(); renderPreview(); });
  for (const key of ['pixelated', 'outline', 'shadow']) $(key).addEventListener('change', e => { state.output[key] = e.target.checked; state.output.style = state.output.pixelated ? 'pixel' : 'illustrated'; renderPreview(); });
  $('ground').addEventListener('change', updateGround);
  $('download-btn').addEventListener('click', exportCurrent); $('export-views-btn').addEventListener('click', exportViews);
  $('export-both-btn').addEventListener('click', exportBothStyles); $('map-bundle-btn').addEventListener('click', exportVillageBundle);
  $('bundle-cancel-btn').addEventListener('click', () => { cancelBatch = true; status('Cancelling after this asset…'); });
  $('batch-count').addEventListener('input', updateBatchLabel); $('variation-strength').addEventListener('input', updateBatchLabel);
  $('batch-btn').addEventListener('click', exportBatch); $('batch-cancel-btn').addEventListener('click', () => { cancelBatch = true; $('batch-status').textContent = 'Cancelling after this house…'; });
  $('save-recipe-btn').addEventListener('click', () => { download(asBlob({ ...activeRecipe(), layout: currentPack?.house.userData.layout, placement: renderer.lastMeta }), `${filename()}.json`); toast('Saved this scene’s editable recipe.'); });
  $('load-recipe-btn').addEventListener('click', () => $('load-recipe-input').click());
  $('load-recipe-input').addEventListener('change', async e => {
    const file = e.target.files[0], revision = ++recipeLoadRevision; if (!file) return;
    try {
      if (file.size > 1048576) throw new Error('This file is too large to be a scene recipe.');
      const recipe = validateRecipe(JSON.parse(await file.text()));
      if (revision !== recipeLoadRevision) return;
      if (busy) throw new Error('Finish or cancel the export before loading a recipe.');
      await applyLoadedRecipe(recipe); toast('Recipe loaded.');
    }
    catch (error) { report(error); } finally { e.target.value = ''; }
  });
  document.querySelectorAll('[data-material-tab]').forEach(button => button.addEventListener('click', () => {
    materialTab = button.dataset.materialTab;
    for (const tab of document.querySelectorAll('[data-material-tab]')) { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', active); }
    renderMaterials();
  }));
  $('export-material-btn').addEventListener('click', async () => {
    try { const id = activeStyle().materials[materialTab], tile = await materialCanvas(id, { seed: activeSeed() }); download(await toBlob(tile), `${id}-${activeSeed()}.png`); toast('Exported the material tile.'); } catch (error) { report(error); }
  });
  $('upload-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => { uploadReference(e.target.files[0]); e.target.value = ''; });
  const drop = $('reference-drop');
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('dragover'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, e => { e.preventDefault(); drop.classList.remove('dragover'); });
  drop.addEventListener('drop', e => { if (!busy) uploadReference(e.dataTransfer.files[0]); });
  $('sample-palette-btn').addEventListener('click', samplePalette);
  let drag = null;
  const canvas = $('render-canvas');
  const zoomBy = factor => { if (busy || previewError) return; renderer.setPreviewZoom(renderer.previewZoom * factor); syncPreviewZoom(); schedulePreviewDetail(); };
  $('zoom-in-btn').addEventListener('click', () => zoomBy(1.25));
  $('zoom-out-btn').addEventListener('click', () => zoomBy(.8));
  $('zoom-fit-btn').addEventListener('click', () => { if (!busy) { renderer.resetPreview(); syncPreviewZoom(); schedulePreviewDetail(); } });
  canvas.addEventListener('wheel', e => {
    if (busy || previewError || !renderer.previewSnapshot || !e.deltaY) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1);
    renderer.setPreviewZoom(renderer.previewZoom * Math.exp(-clamp(delta, -240, 240) * .002),
      (e.clientX - rect.left) * renderer.previewFrame.width / rect.width, (e.clientY - rect.top) * renderer.previewFrame.height / rect.height);
    syncPreviewZoom(); schedulePreviewDetail();
  }, { passive: false });
  canvas.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || busy) return;
    if (['+', '=', '-'].includes(e.key)) { e.preventDefault(); zoomBy(e.key === '-' ? .8 : 1.25); }
    else if (e.key === '0' || e.key === 'Home') { e.preventDefault(); renderer.resetPreview(); syncPreviewZoom(); schedulePreviewDetail(); }
  });
  canvas.addEventListener('pointerdown', e => {
    if (busy || ![0, 1].includes(e.button)) return;
    e.preventDefault(); stopSpin();
    drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1, ...state.view };
    canvas.focus({preventScroll: true}); canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
  canvas.addEventListener('pointermove', e => {
    if (!drag || busy) return;
    if (drag.pan) {
      renderer.panPreview(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY; schedulePreviewDetail(); return;
    }
    state.view.azimuth = Math.round(((drag.azimuth + (e.clientX - drag.x) * .35 + 540) % 360) - 180);
    state.view.elevation = Math.round(clamp(drag.elevation + (e.clientY - drag.y) * .2, 0, 90)); syncUI(); renderPreview();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, () => { drag = null; canvas.style.cursor = 'grab'; });
  new ResizeObserver(() => {renderer.repaintPreview();schedulePreviewDetail();}).observe($('viewport'));
  window.addEventListener('pagehide', event => { saveWorkspace(); stopSpin(); stopCharacter(); cancelPreviewDetail(); if (!event.persisted) { disposePack(currentPack); groundTexture?.dispose(); renderer?.dispose(); } });
}

async function init() {
  try {
    restoreWorkspace(); renderer = new HouseRenderer($('render-canvas')); bindEvents(); setMode(mode); clearTimeout(rebuildTimer);
    for (const id of ['download-btn', 'export-views-btn', 'batch-btn', 'export-both-btn', 'map-bundle-btn']) $(id).disabled = true;
    await rebuild();
    connectMcp();
  } catch (error) {
    report(error); $('stage-meta').textContent = `The scene could not load: ${error.message}`;
    for (const id of ['download-btn', 'batch-btn', 'export-views-btn', 'export-both-btn', 'map-bundle-btn', 'variation-btn', 'animation-export-btn', 'animation-all-btn', 'character-reference-btn']) $(id).disabled = true;
  }
}

init();
