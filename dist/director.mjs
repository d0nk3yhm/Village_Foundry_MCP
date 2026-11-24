import { normalizeInterior, INTERIOR_PRESETS } from './interior-schema.mjs';

/** A small, explicit rule parser. Free-form interpretation belongs to the MCP caller. */
export function interpretBrief(brief, current = {}) {
  const text = String(brief || '').slice(0, 4000).toLowerCase();
  const patch = {}, applied = [];
  const templates = [['tavern', /\b(tavern|bar|pub)\b/], ['cottage', /\b(cottage|home|house interior)\b/], ['inn', /\b(inn|guest room|bedroom)\b/], ['workshop', /\b(workshop|smithy|workroom)\b/]];
  for (const [preset, expression] of templates) if (expression.test(text)) { patch.preset = preset; break; }
  let base = current;
  if (patch.preset && patch.preset !== current.preset) { base = { ...INTERIOR_PRESETS[patch.preset], seed: current.seed ?? 742 }; applied.push(`${patch.preset} template`); }
  const words = { zero: 0, no: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const number = value => /^\d+$/.test(value) ? Number(value) : words[value];
  for (const [key, noun] of [['tables', 'tables?'], ['beds', 'beds?'], ['bedrooms', 'bedrooms?'], ['floorCount', '(?:floors?|storeys?|stories)']]) {
    const match = text.match(new RegExp(`\\b(\\d+|zero|no|one|two|three|four|five|six|seven|eight)\\s+${noun}\\b`));
    if (match) { patch[key] = number(match[1]); applied.push(`${patch[key]} ${key}`); }
  }
  const side = text.match(/\bbar\b[^.!?\n]{0,35}\b(left|right|back)\b/);
  if (side) { patch.bar = true; patch.barSide = side[1]; applied.push(`bar on the ${side[1]}`); }
  if (/\b(no|without|remove)\s+(the\s+)?bar\b/.test(text)) { patch.bar = false; applied.push('no bar'); }
  const size = text.match(/\b(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\b/);
  if (size) { patch.width = Number(size[1]); patch.depth = Number(size[2]); applied.push(`${size[1]} × ${size[2]} room`); }
  for (const [key, noun] of [['fireplace', '(?:fireplace|hearth)'], ['shelves', '(?:shelves|bookshelves)'], ['barrels', 'barrels?'], ['rug', '(?:rug|carpet)'], ['kitchen', '(?:kitchen|cooking area)'], ['stairs', '(?:stairs|staircase)'], ['occupants', '(?:occupants|people|patrons|residents)']]) {
    if (new RegExp(`\\b(no|without|remove)\\s+(the\\s+|any\\s+|a\\s+)?${noun}\\b`).test(text)) { patch[key] = false; applied.push(`no ${key}`); }
    else if (new RegExp(`\\b${noun}\\b`).test(text)) { patch[key] = true; applied.push(key); }
  }
  if (/\bground\s+floor\b/.test(text)) { patch.floorIndex = 0; applied.push('ground floor'); }
  else if (/\b(upstairs|upper floor)\b/.test(text)) { patch.floorIndex = 1; patch.floorCount = Math.max(2, patch.floorCount || base.floorCount || 1); applied.push('upper floor'); }
  const floor = text.match(/\bfloor\s+([1-3])\b/);
  if (floor) { patch.floorIndex = Number(floor[1]) - 1; patch.floorCount = Math.max(patch.floorIndex + 1, patch.floorCount || base.floorCount || 1); applied.push(`floor ${floor[1]}`); }
  const variant = text.match(/\b(?:layout|plan|variant)\s+([1-6])\b/);
  if (variant) { patch.layoutVariant = Number(variant[1]) - 1; applied.push(`floor plan ${variant[1]}`); }
  if (/\b(clear|open|wide)\s+(central\s+|centre\s+|center\s+)?(aisle|centre|center|walkway|space)\b/.test(text)) { patch.clearCenter = true; applied.push('clear central aisle'); }
  if (/\b(warm|cozy|cosy|golden|honey)\b/.test(text)) {
    patch.woodColor = '#90643c'; patch.floorColor = '#a77b49'; patch.wallColor = '#cbb991'; patch.accentColor = '#975741';
    applied.push('warm oak, cream walls and muted terracotta');
  } else if (/\b(dark|moody)\b/.test(text)) {
    patch.woodColor = '#654b38'; patch.floorColor = '#806044'; patch.wallColor = '#aaa08b'; patch.accentColor = '#5d7165';
    applied.push('dark walnut and muted sage');
  }
  const config = normalizeInterior({ ...base, ...patch });
  return { config, applied, note: applied.length ? 'Applied the supported layout rules. Use MCP for precise furniture placement and more complex instructions.' : 'No supported layout rule found. Try “tavern, kitchen, four tables, three bedrooms, two floors”, or steer the scene through MCP.' };
}
