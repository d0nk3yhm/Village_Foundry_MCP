/** Pure configuration shared by the browser map builder and MCP validation. */
export const MAP_PRESETS = Object.freeze({
  village: Object.freeze({ label: 'Island village', width: 80, depth: 80, houseCount: 10,
    housePreset: 'mixed', water: false, gardens: true }),
  crossroads: Object.freeze({ label: 'Island market town', width: 88, depth: 80, houseCount: 12,
    housePreset: 'mixed', water: false, gardens: false }),
  riverside: Object.freeze({ label: 'River island settlement', width: 80, depth: 80, houseCount: 8,
    housePreset: 'mixed', water: true, gardens: false }),
  farm: Object.freeze({ label: 'Island farmsteads', width: 64, depth: 56, houseCount: 4,
    housePreset: 'cottage', water: false, gardens: true }),
});

const bounded = (value, fallback, min, max) => {
  const number = Number(value);
  return Math.round(Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback)));
};
const boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const color = (value, fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;

/** Normalize a map configuration; no browser, rendering or Three.js dependencies. */
export function normalizeMap(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('A map configuration must be an object.');
  }
  const preset = Object.hasOwn(MAP_PRESETS, config.preset) ? config.preset : 'village';
  const base = MAP_PRESETS[preset];
  const housePreset = ['mixed', 'village', 'cottage', 'inn', 'manor', 'source'].includes(config.housePreset)
    ? config.housePreset : base.housePreset;
  return {
    preset,
    seed: bounded(config.seed ?? 742, 742, 0, 2147483647),
    width: bounded(config.width ?? base.width, base.width, 24, 256),
    depth: bounded(config.depth ?? base.depth, base.depth, 24, 256),
    houseCount: bounded(config.houseCount ?? base.houseCount, base.houseCount, 0, 32),
    layoutStyle: 'organic',
    landform: config.landform === 'mainland' ? 'mainland' : 'island',
    sea: boolean(config.sea, true),
    includeHouses: boolean(config.includeHouses, true),
    roads: boolean(config.roads, true),
    fences: boolean(config.fences, true),
    trees: boolean(config.trees, true),
    water: boolean(config.water, base.water),
    gardens: boolean(config.gardens, base.gardens),
    roadStyle: config.roadStyle === 'cobble' ? 'cobble' : 'dirt',
    housePreset,
    roofColor: color(config.roofColor, '#94918b'),
    woodColor: color(config.woodColor, '#a17f50'),
    stoneColor: color(config.stoneColor, '#aaa697'),
    plasterColor: color(config.plasterColor, '#dfcda8'),
  };
}
