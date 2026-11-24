/**
 * Fresh mathematical paint studies for ONE physical surface per texture.
 * No source images, tile grids, model calls, or per-pixel random noise.
 * Map UV 0..1 to one shingle/block/board; cache a few variants per model.
 */

function randomFor(seed, variant, kind) {
  let a = (Number(seed) >>> 0) ^ Math.imul((Number(variant) | 0) + 1, 0x9e3779b1);
  for (let i = 0; i < kind.length; i++) a = Math.imul(a ^ kind.charCodeAt(i), 16777619);
  return () => { a += 0x6d2b79f5; let t = Math.imul(a ^ a >>> 15, a | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function rgbOf(value) {
  if (value?.getHexString) value = '#' + value.getHexString();
  if (typeof value === 'number') value = '#' + (value & 0xffffff).toString(16).padStart(6, '0');
  if (!/^#[0-9a-f]{6}$/i.test(String(value))) value = '#8c7c65';
  return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
}
const blend = (a, b, amount) => a.map((channel, i) => Math.round(channel * (1 - amount) + b[i] * amount));
const ink = (rgb, alpha = 1) => `rgba(${rgb.map(channel => Math.round(channel)).join(',')},${alpha})`;
const light = color => blend(color, [244, 229, 196], 0.40);
const dark = color => blend(color, [50, 39, 30], 0.53);
function polygon(ctx, points, fill) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
}
function stroke(ctx, points, color, width = 2) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}
function cloud(ctx, x, y, radius, color, alpha) {
  const gradient = ctx.createRadialGradient(x, y, radius * 0.05, x, y, radius);
  gradient.addColorStop(0, ink(color, alpha)); gradient.addColorStop(0.55, ink(color, alpha * 0.45)); gradient.addColorStop(1, ink(color, 0));
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 512);
}
function baseWash(ctx, color, high = 0.14, low = 0.14) {
  const gradient = ctx.createLinearGradient(90, 0, 390, 512);
  gradient.addColorStop(0, ink(blend(color, [240, 224, 191], high)));
  gradient.addColorStop(0.48, ink(color));
  gradient.addColorStop(1, ink(blend(color, [67, 49, 36], low)));
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 512);
}
function shingle(ctx, color, r) {
  baseWash(ctx, color, 0.07, 0.23);
  const pale = blend(color, [212, 204, 185], 0.34), shade = blend(color, [61, 49, 40], 0.60), lip = blend(color, [74, 47, 31], 0.57);
  cloud(ctx, 105 + r() * 150, 100 + r() * 140, 290, pale, 0.12);
  cloud(ctx, 325 + r() * 130, 285 + r() * 130, 250, shade, 0.19);
  cloud(ctx, 30 + r() * 170, 410, 180, [132, 116, 91], 0.09);
  // Broad asymmetric facets behave like a few brush-loaded planes, not noise.
  const split = 145 + r() * 170, shoulder = 105 + r() * 155, notch = 270 + r() * 100;
  polygon(ctx, [[0, 0], [512, 0], [440, 35 + r() * 60], [split, shoulder], [25, 205 + r() * 55]], ink(pale, 0.17));
  polygon(ctx, [[split + 45, 48], [512, 29], [512, notch], [350 + r() * 100, notch + 55], [split + 74, shoulder + 34]], ink(shade, 0.23));
  polygon(ctx, [[12, 225 + r() * 90], [split - 20, shoulder + 20], [split + 25, 328], [142 + r() * 60, 451], [0, 472]], ink(pale, 0.16));
  polygon(ctx, [[140 + r() * 100, 372], [355 + r() * 80, notch], [512, 397], [512, 487], [284, 469]], ink(lip, 0.18));
  // A broken brush-shaped light patch crosses one face without following the
  // outline; this survives sprite-sized sampling better than tiny grain/noise.
  const brushX = 35 + r() * 150, brushY = 160 + r() * 155;
  polygon(ctx, [[brushX, brushY], [brushX + 62, brushY - 29], [brushX + 115, brushY - 13], [brushX + 139, brushY + 25], [brushX + 102, brushY + 42], [brushX + 55, brushY + 29], [brushX + 13, brushY + 44]], ink(pale, 0.17));
  const bottom = 474 + r() * 10, chip = 88 + r() * 315;
  polygon(ctx, [[0, bottom], [chip - 28, bottom + 1], [chip - 15, bottom - 7], [chip + 5, bottom + 5], [512, bottom - 2], [512, 512], [0, 512]], ink(lip, 0.69));
  stroke(ctx, [[10, bottom - 4], [chip - 32, bottom - 3], [chip - 12, bottom - 10], [chip + 10, bottom - 2], [498, bottom - 5]], ink(pale, 0.40), 5);
  stroke(ctx, [[9, 420], [11, 133], [19, 18], [196, 12], [390, 17], [495, 12]], ink(pale, 0.60), 9);
  stroke(ctx, [[502, 40], [498, 241], [503, 456]], ink(shade, 0.46), 10);
  const fractures = 1 + Math.floor(r() * 3);
  for (let i = 0; i < fractures; i++) {
    const x = 45 + r() * 425, y = r() < 0.5 ? 24 : 350, length = 55 + r() * 105;
    const points = [[x, y], [x - 6 + r() * 15, y + length * 0.35], [x + 6, y + length * 0.67], [x + 1 + r() * 8, y + length]];
    stroke(ctx, points.map(([px, py]) => [px + 2, py]), ink(pale, 0.18), 2);
    stroke(ctx, points, ink(shade, 0.28), 1.5 + r());
  }
  const wx = 70 + r() * 290, wy = 210 + r() * 140;
  polygon(ctx, [[wx, wy], [wx + 33, wy - 9], [wx + 72, wy + 6], [wx + 56, wy + 18], [wx + 12, wy + 21]], ink(pale, 0.15));
}
function stone(ctx, color, r) {
  baseWash(ctx, color, 0.08, 0.20);
  const pale = light(color), shade = dark(color);
  cloud(ctx, 160 + r() * 130, 155 + r() * 100, 330, pale, 0.16);
  cloud(ctx, 360, 365, 270, shade, 0.10);
  polygon(ctx, [[0, 0], [512, 0], [477, 38], [307, 24], [159, 36], [31, 59], [0, 167]], ink(pale, 0.34));
  polygon(ctx, [[0, 0], [31, 59], [24, 249], [39, 420], [0, 512]], ink(pale, 0.17));
  polygon(ctx, [[512, 0], [478, 38], [473, 329], [451, 459], [512, 512]], ink(shade, 0.27));
  polygon(ctx, [[0, 512], [39, 468], [194, 477], [316, 459], [451, 459], [512, 512]], ink(shade, 0.46));
  const faceX = 177 + r() * 100, faceY = 174 + r() * 92;
  polygon(ctx, [[32, 69], [faceX + 41, 42], [faceX, faceY], [36, 294]], ink(pale, 0.13));
  polygon(ctx, [[faceX + 45, 51], [475, 56], [466, 287], [faceX + 140, faceY - 19]], ink(shade, 0.13));
  polygon(ctx, [[39, 330], [faceX + 35, faceY], [354, 286], [298, 461], [66, 461]], ink(pale, 0.12));
  stroke(ctx, [[25, 110], [31, 59], [159, 36], [307, 24], [471, 38]], ink(pale, 0.46), 6);
  stroke(ctx, [[49, 465], [192, 474], [313, 455], [444, 456]], ink(pale, 0.19), 3);
  for (let i = 0; i < 5; i++) {
    const x = 52 + r() * 385, y = 62 + r() * 360, w = 13 + r() * 45, h = 8 + r() * 24;
    polygon(ctx, [[x, y], [x + w * 0.5, y - h * 0.3], [x + w, y + h * 0.3], [x + w * 0.72, y + h], [x + w * 0.1, y + h * 0.7]], ink(i % 2 ? pale : shade, 0.10 + r() * 0.06));
  }
  if (r() < 0.8) {
    const x = 75 + r() * 340;
    stroke(ctx, [[x, 33], [x + 16, 89], [x + 9, 131], [x + 35, 168]], ink(shade, 0.22), 2.1);
    stroke(ctx, [[x + 16, 89], [x + 42, 105]], ink(shade, 0.16), 1.5);
  }
}
function wood(ctx, color, r) {
  baseWash(ctx, color, 0.055, 0.22);
  // Oak highlights are pale tan rather than saturated yellow. Dark growth
  // bands and narrow warm edges leave broad readable faces between them.
  const pale = blend(color, [224, 196, 151], 0.34), shade = blend(color, [60, 35, 24], 0.60);
  cloud(ctx, 160, 145, 310, pale, 0.10); cloud(ctx, 405, 395, 275, shade, 0.14);
  const face = 135 + r() * 105;
  polygon(ctx, [[21, 0], [face, 0], [face + 29, 183], [face - 13, 347], [face + 7, 512], [35, 512], [48, 245]], ink(pale, 0.12));
  polygon(ctx, [[330 + r() * 30, 0], [465, 0], [457, 218], [484, 512], [381, 512], [353, 319], [370, 173]], ink(shade, 0.16));
  const hasKnot = r() < 0.36, knotX = 145 + r() * 205, knotY = 155 + r() * 215;
  function grain(x, width, opacity, bright = false) {
    const bend = (r() - 0.5) * 64;
    const detour = hasKnot && Math.abs(x - knotX) < 58 ? (x < knotX ? -23 : 23) : 0;
    ctx.beginPath(); ctx.moveTo(x, -12);
    ctx.bezierCurveTo(x + bend, 110, x - bend * 0.4 + detour, knotY - 70, x + detour, knotY);
    ctx.bezierCurveTo(x + bend * 0.5 + detour, knotY + 95, x - bend, 430, x + bend * 0.45, 525);
    ctx.strokeStyle = ink(bright ? pale : shade, opacity); ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke();
  }
  // A few uneven brush-width bands remain visible on a board only 10–20
  // screen pixels across; hairline texture alone vanished at that scale.
  for (let i = 0; i < 5; i++) grain(36 + i * 104 + (r() - 0.5) * 48, 20 + r() * 26, 0.11 + r() * 0.08, i % 3 === 0);
  for (let i = 0; i < 8; i++) grain(20 + i * 65 + (r() - 0.5) * 37, 3 + r() * 4, 0.10 + r() * 0.10, i % 4 === 0);
  if (hasKnot) {
    ctx.save(); ctx.translate(knotX, knotY); ctx.rotate(-0.10 + r() * 0.2);
    for (const [rx, ry, alpha, width] of [[25, 54, 0.15, 4], [13, 31, 0.26, 4]]) {
      ctx.beginPath(); ctx.moveTo(-rx * 0.7, ry * 0.55);
      ctx.bezierCurveTo(-rx * 1.15, -ry * 0.25, -rx * 0.25, -ry, rx * 0.16, -ry * 0.83);
      ctx.bezierCurveTo(rx * 1.1, -ry * 0.45, rx * 0.78, ry * 0.52, -rx * 0.05, ry);
      ctx.strokeStyle = ink(shade, alpha); ctx.lineWidth = width; ctx.stroke();
    }
    ctx.beginPath(); ctx.ellipse(1, 2, 4, 12, 0.12, 0, Math.PI * 2); ctx.fillStyle = ink(shade, 0.35); ctx.fill(); ctx.restore();
  }
  for (let i = 0; i < 2; i++) {
    const x = 70 + r() * 360, top = i === 0, y = top ? 0 : 512, sign = top ? 1 : -1, length = 62 + r() * 65;
    stroke(ctx, [[x, y], [x + 6, y + sign * length * 0.4], [x + 3, y + sign * length]], ink(shade, 0.43), 3.6);
    stroke(ctx, [[x + 6, y + sign * length * 0.4], [x + 16, y + sign * length * 0.61]], ink(shade, 0.27), 2.3);
    stroke(ctx, [[x - 6, y + sign * 18], [x - 2, y + sign * length * 0.55]], ink(pale, 0.38), 5);
  }
  const edge = ctx.createLinearGradient(0, 0, 512, 0);
  edge.addColorStop(0, ink(pale, 0.55)); edge.addColorStop(0.026, ink(pale, 0.25)); edge.addColorStop(0.075, ink(pale, 0));
  edge.addColorStop(0.90, ink(shade, 0)); edge.addColorStop(0.972, ink(shade, 0.38)); edge.addColorStop(1, ink(shade, 0.66));
  ctx.fillStyle = edge; ctx.fillRect(0, 0, 512, 512);
  stroke(ctx, [[7, 10], [6, 230], [8, 495]], ink(pale, 0.50), 5);
  stroke(ctx, [[16, 502], [104, 498], [231, 503], [357, 500], [493, 504]], ink(shade, 0.50), 11);
  stroke(ctx, [[19, 13], [163, 10], [292, 14], [486, 9]], ink(pale, 0.37), 7);
}
function plaster(ctx, color, r) {
  baseWash(ctx, color, 0.07, 0.075);
  const pale = blend(color, [248, 237, 205], 0.40), shade = blend(color, [139, 112, 75], 0.25);
  cloud(ctx, 100 + r() * 150, 120, 340, pale, 0.22);
  cloud(ctx, 340, 360, 300, shade, 0.20);
  cloud(ctx, 80, 470, 220, [179, 149, 99], 0.10);
  polygon(ctx, [[0, 75], [215, 17], [392, 112], [253, 207], [0, 242]], ink(pale, 0.055));
  polygon(ctx, [[129, 225], [425, 153], [512, 321], [328, 426], [81, 375]], ink(shade, 0.05));
  for (let i = 0; i < 3; i++) {
    const x = 40 + r() * 360, y = 345 + r() * 130;
    stroke(ctx, [[x, y], [x + 28, y - 10], [x + 62, y - 5], [x + 85, y - 17]], ink(shade, 0.13), 2 + r() * 3);
  }
}

export function createPaintedSurface(THREE, kind, color, { seed = 742, variant = 0 } = {}) {
  if (!['shingle', 'stone', 'wood', 'plaster'].includes(kind)) throw new RangeError(`Unknown painted surface: ${kind}`);
  const canvas = typeof document !== 'undefined' && document.createElement ? document.createElement('canvas')
    : typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(512, 512) : null;
  if (!canvas) return null; // Geometry-only checks do not need a browser canvas.
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d'); if (!ctx) return null;
  const rgb = rgbOf(color), random = randomFor(seed, variant, kind);
  ({ shingle, stone, wood, plaster })[kind](ctx, rgb, random);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false; texture.needsUpdate = true;
  texture.name = `painted-${kind}-${variant}`;
  texture.userData = { kind, seed, variant, source: 'fresh-procedural-painted-surface', singlePhysicalPiece: true };
  return texture;
}
