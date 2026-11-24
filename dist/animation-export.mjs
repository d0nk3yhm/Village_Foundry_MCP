import { applyCharacterPose } from './character-model.mjs';
import { CHARACTER_DURATIONS } from './character-schema.mjs';

/** Render a directional sheet from one rig. Every cell uses the same camera bounds. */
export async function renderAnimationSheet(renderer, group, config, options, spec = {}) {
  const frames = Math.max(4, Math.min(24, Math.round(spec.frames || 8)));
  const directions = [1, 4, 8].includes(spec.directions) ? spec.directions : 4;
  const animation = Object.hasOwn(CHARACTER_DURATIONS, spec.animation) ? spec.animation : config.animation;
  const duration = CHARACTER_DURATIONS[animation] || CHARACTER_DURATIONS.idle;
  const directionAngles = directions === 1 ? [config.direction || 0] : Array.from({length: directions}, (_, i) => i * 360 / directions);
  const fps = spec.fps || frames / duration;
  const sheet = document.createElement('canvas');
  let context, cellWidth, cellHeight, anchor, frameMetadata;
  const cells = [];
  try {
    for (let row = 0; row < directions; row++) for (let col = 0; col < frames; col++) {
      if (spec.shouldCancel?.()) throw new Error('Animation export cancelled.');
      const time = col * duration / frames;
      applyCharacterPose(group, {...config, animation, time, direction: directionAngles[row]});
      const canvas = renderer.render({...options, fixedBounds: true, trim: false}, {previewGround: false});
      if (!context) {
        cellWidth = canvas.width; cellHeight = canvas.height;
        if (cellWidth * frames > 16384 || cellHeight * directions > 16384 || cellWidth * frames * cellHeight * directions > 40000000) {
          throw new Error('This sheet would be too large. Reduce frame detail, export scale, frames or directions.');
        }
        sheet.width = cellWidth * frames; sheet.height = cellHeight * directions;
        context = sheet.getContext('2d'); context.imageSmoothingEnabled = false;
        anchor = [...renderer.lastMeta.anchor_px]; frameMetadata = JSON.parse(JSON.stringify(renderer.lastMeta));
      }
      if (canvas.width !== cellWidth || canvas.height !== cellHeight) throw new Error('Animation frame bounds changed unexpectedly.');
      context.drawImage(canvas, col * cellWidth, row * cellHeight);
      const cell = {index: row * frames + col, row, column: col, x: col * cellWidth, y: row * cellHeight, width: cellWidth, height: cellHeight, direction: directionAngles[row], time, anchor_px: anchor};
      cells.push(cell);
      await spec.onFrame?.(canvas, cell);
      await spec.onProgress?.(cells.length, frames * directions);
    }
    return {canvas: sheet, metadata: {format: 'village-foundry-animation', version: 1, animation, duration, fps, loop: true,
      columns: frames, rows: directions, cellWidth, cellHeight, width: sheet.width, height: sheet.height,
      directionAngles, anchor_px: anchor, frame: frameMetadata, cells}};
  } finally { applyCharacterPose(group, config); }
}
