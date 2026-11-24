import assert from 'node:assert/strict';
import test from 'node:test';
import { HouseRenderer } from '../dist/renderer.mjs';
import * as THREE from '../dist/vendor/three.module.js';

// Use the real preview methods without constructing a WebGL/software renderer.
// A scene render is deliberately an error unless a test supplies its output.
function preview({ pixelated = false, cell = 1, origin = [0, 0],
  sourceWidth = 400, sourceHeight = 300 } = {}) {
  const draws = [];
  const context = {
    clearRect() {},
    drawImage(...args) { draws.push(args); },
    imageSmoothingEnabled: true,
  };
  const display = {
    width: 800, height: 600, clientWidth: 800, clientHeight: 600,
    getContext(kind) { assert.equal(kind, '2d'); return context; },
  };
  const renderer = Object.assign(Object.create(HouseRenderer.prototype), {
    displayCanvas: display, disposed: false, previewZoom: 1,
    previewOffset: { x: 0, y: 0 }, previewFrame: null,
    previewSnapshot: {
      canvas: { width: sourceWidth, height: sourceHeight }, pixelated,
      fitDisplay: { nativePixelSize: cell, gridOrigin: [...origin] },
    },
    lastMeta: { width: sourceWidth, height: sourceHeight, anchor_px: [20, 30] },
    lastOptions: { pixelated },
    _captureRenderState() { return { camera: new THREE.OrthographicCamera(-5,5,5,-5,.1,100) }; },
    render() { throw new Error('Preview navigation must not render the scene.'); },
  });
  renderer.repaintPreview();
  return { renderer, display, context, draws };
}

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
}

function sourceAt(frame, x, y) {
  return [(x - frame.x) / frame.ratio, (y - frame.y) / frame.ratio];
}

function staysVisible(frame) {
  for (const [start, length, viewport] of [
    [frame.x, frame.drawWidth, frame.width],
    [frame.y, frame.drawHeight, frame.height],
  ]) {
    if (length <= viewport) {
      assert.ok(start >= -1e-8 && start + length <= viewport + 1e-8,
        'A smaller preview remains entirely within its viewport.');
    } else {
      assert.ok(start <= 1e-8 && start + length >= viewport - 1e-8,
        'A magnified preview keeps covering its viewport.');
    }
  }
}

test('illustrated zoom preserves the image point under the cursor without rerendering', () => {
  const { renderer, context } = preview();
  const cursor = [350, 270];
  const before = sourceAt(renderer.previewFrame, ...cursor);
  const frame = renderer.setPreviewZoom(2, ...cursor);
  const after = sourceAt(frame, ...cursor);
  close(after[0], before[0]);
  close(after[1], before[1]);
  assert.equal(context.imageSmoothingEnabled, true);
  assert.equal(renderer.previewZoom, 2);
});

test('zoom limits and large pans keep the preview recoverable at both scale extremes', () => {
  const { renderer } = preview();
  renderer.setPreviewZoom(1000);
  assert.equal(renderer.previewZoom, 8);
  staysVisible(renderer.panPreview(1e8, -1e8));
  staysVisible(renderer.panPreview(-2e8, 2e8));
  renderer.setPreviewZoom(-1000);
  assert.equal(renderer.previewZoom, .25);
  staysVisible(renderer.panPreview(1e8, -1e8));
  staysVisible(renderer.panPreview(-2e8, 2e8));
  renderer.setPreviewZoom(Number.NaN);
  assert.equal(renderer.previewZoom, .25);
});

test('pixel zoom anchors using the snapped scale and aligns a padded native pixel grid', () => {
  const origin = [7, 11], cell = 3;
  const { renderer, context } = preview({ pixelated: true, cell, origin,
    sourceWidth: 160, sourceHeight: 100 });
  const cursor = [380, 290];
  const sourcePoint = sourceAt(renderer.previewFrame, ...cursor);
  const frame = renderer.setPreviewZoom(1.5, ...cursor);
  close(frame.ratio * cell, Math.round(frame.ratio * cell));
  close(frame.x + origin[0] * frame.ratio, Math.round(frame.x + origin[0] * frame.ratio));
  close(frame.y + origin[1] * frame.ratio, Math.round(frame.y + origin[1] * frame.ratio));
  // Grid alignment may move the anchored point by at most half a display pixel.
  close(frame.x + sourcePoint[0] * frame.ratio, cursor[0], .500000001);
  close(frame.y + sourcePoint[1] * frame.ratio, cursor[1], .500000001);
  assert.equal(context.imageSmoothingEnabled, false);
});

test('small wheel increments accumulate through pixel snapping thresholds', () => {
  const { renderer } = preview({ pixelated: true, cell: 2 });
  const initialRatio = renderer.previewFrame.ratio;
  for (let i = 0; i < 20; i++) renderer.setPreviewZoom(renderer.previewZoom * 1.01, 400, 300);
  close(renderer.previewZoom, 1.01 ** 20);
  assert.ok(renderer.previewFrame.ratio > initialRatio,
    'Continuous zoom intent must not be discarded when a pixel scale has not changed yet.');
});

test('show owns its snapshot independently of export renders, metadata mutation, and model swaps', () => {
  const { renderer, draws, context } = preview();
  const shown = { width: 160, height: 100 }, exported = { width: 2048, height: 1536 };
  const shownMeta = { width: 160, height: 100, anchor_px: [80,90], pixelsPerUnit: 10,
    fitDisplay: { nativePixelSize: 3, gridOrigin: [7, 11] } };
  const exportMeta = { width: 2048, height: 1536,
    fitDisplay: { nativePixelSize: 8, gridOrigin: [400, 500] } };
  let renders = 0;
  renderer.render = (options, flags) => {
    renders++;
    renderer.lastOptions = { pixelated: !options.export };
    renderer.lastMeta = options.export ? exportMeta : shownMeta;
    if (!options.export) assert.equal(flags.previewGround, true);
    return options.export ? exported : shown;
  };
  assert.equal(renderer.show({}), shown);
  assert.equal(renders, 1);
  // A caller can reuse its metadata array; preview must have copied the origin.
  shownMeta.fitDisplay.gridOrigin[0] = 999;
  shownMeta.fitDisplay.nativePixelSize = 99;
  renderer.scene = { remove() {}, add() {} };
  renderer.house = { name: 'shown house' };
  renderer.setHouse({ name: 'temporary export house' });
  assert.equal(renderer.render({ export: true }, { previewGround: false }), exported);
  renderer.setPreviewZoom(1.5, 380, 290);
  renderer.panPreview(5, -5);
  assert.equal(renders, 2, 'Only show and the explicit export may render geometry.');
  assert.equal(draws.at(-1)[0], shown);
  assert.equal(context.imageSmoothingEnabled, false);
  assert.deepEqual(renderer.previewSnapshot.fitDisplay, { nativePixelSize: 3, gridOrigin: [7, 11] });
  assert.equal(renderer.lastMeta, exportMeta);
  assert.deepEqual(renderer.lastOptions, { pixelated: false });
});

test('Fit resets only preview navigation and restores the original fitted drawing', () => {
  const { renderer } = preview({ pixelated: true, cell: 3, origin: [7, 11] });
  const originalFrame = { ...renderer.previewFrame };
  const metadata = structuredClone(renderer.lastMeta);
  const options = structuredClone(renderer.lastOptions);
  renderer.setPreviewZoom(3, 360, 280);
  renderer.panPreview(75, -40);
  renderer.resetPreview();
  assert.equal(renderer.previewZoom, 1);
  assert.deepEqual(renderer.previewOffset, { x: 0, y: 0 });
  assert.deepEqual(renderer.previewFrame, originalFrame);
  assert.deepEqual(renderer.lastMeta, metadata);
  assert.deepEqual(renderer.lastOptions, options);
});

test('viewport resizing redraws the cached source while preserving zoom intent and export metadata', () => {
  const { renderer, display, draws } = preview();
  renderer.setPreviewZoom(2, 350, 270);
  const metadata = structuredClone(renderer.lastMeta), source = renderer.previewSnapshot.canvas;
  display.clientWidth = 460;
  display.clientHeight = 320;
  const frame = renderer.repaintPreview();
  assert.equal(display.width, 460);
  assert.equal(display.height, 320);
  assert.equal(renderer.previewZoom, 2);
  assert.equal(draws.at(-1)[0], source);
  assert.deepEqual(renderer.lastMeta, metadata);
  staysVisible(frame);
});

test('DPR2 changes backing density without doubling CSS cursor coordinates', () => {
  const previous=globalThis.devicePixelRatio;
  globalThis.devicePixelRatio=2;
  try{
    const {renderer,display}=preview();
    assert.equal(display.width,1600);assert.equal(display.height,1200);
    assert.equal(renderer.previewFrame.width,800);assert.equal(renderer.previewFrame.height,600);
    const cursor=[350,270],before=sourceAt(renderer.previewFrame,...cursor);
    const after=sourceAt(renderer.setPreviewZoom(2,...cursor),...cursor);
    close(after[0],before[0]);close(after[1],before[1]);
  }finally{
    if(previous===undefined)delete globalThis.devicePixelRatio;else globalThis.devicePixelRatio=previous;
  }
});

test('cropped camera maps world points through final contain padding and stays viewport-sized at 8×', () => {
  const {renderer}=preview({sourceWidth:1000,sourceHeight:700});
  const camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,100);
  camera.position.set(4,7,10);camera.lookAt(0,1,0);camera.updateMatrixWorld(true);
  const house={name:'unchanged geometry'};renderer.house=house;
  Object.assign(renderer.previewSnapshot,{house,state:{camera},anchor:[340,580],pixelsPerUnit:60});
  renderer.setPreviewZoom(8,360,280);
  const frame=renderer.previewFrame,plan=renderer.previewDetailPlan();
  assert.ok(plan.width<=frame.width*frame.pixelRatio+5);
  assert.ok(plan.height<=frame.height*frame.pixelRatio+5);
  assert.ok(plan.width*plan.height<4194304);
  const origin=new THREE.Vector3().applyMatrix4(camera.matrixWorldInverse);
  for(const xyz of [[0,0,0],[1,2,3],[-2,1,-1]]){
    const point=new THREE.Vector3(...xyz),view=point.clone().applyMatrix4(camera.matrixWorldInverse);
    const expectedX=frame.x+(340+(view.x-origin.x)*60)*frame.ratio;
    const expectedY=frame.y+(580-(view.y-origin.y)*60)*frame.ratio;
    const projected=point.project(plan.camera);
    close(plan.x+(projected.x+1)*plan.drawWidth/2,expectedX,1e-8);
    close(plan.y+(1-projected.y)*plan.drawHeight/2,expectedY,1e-8);
  }
  assert.equal(renderer.house,house);
});

test('pixel detail crops on the original native grid instead of supersampling it', () => {
  const {renderer}=preview({pixelated:true,cell:3,origin:[7,11],sourceWidth:160,sourceHeight:100});
  const camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,100),house={};
  camera.position.z=10;camera.updateMatrixWorld(true);renderer.house=house;
  Object.assign(renderer.previewSnapshot,{house,state:{camera},anchor:[80,90],pixelsPerUnit:30});
  renderer.setPreviewZoom(4);
  const plan=renderer.previewDetailPlan(),frame=renderer.previewFrame;
  close(plan.screenPixelsPerUnit*plan.density,10);
  close((plan.x-frame.x-7*frame.ratio)/(3*frame.ratio),Math.round((plan.x-frame.x-7*frame.ratio)/(3*frame.ratio)));
  close((plan.y-frame.y-11*frame.ratio)/(3*frame.ratio),Math.round((plan.y-frame.y-11*frame.ratio)/(3*frame.ratio)));
  assert.ok(plan.width<frame.width);
});
