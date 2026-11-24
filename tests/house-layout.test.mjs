import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4, Vector3 } from '../dist/vendor/three.module.js';
import { buildHouse, disposeHouse, randomizeHouse } from '../dist/house-model.mjs';
import { HOUSE_FACES, PRESETS, houseEntrance, normalizeHouse, pickHousePreset } from '../dist/house-schema.mjs';

function instanceMatrix(model, name) {
  const matrix = new Matrix4();
  model.getObjectByName(name).getMatrixAt(0, matrix);
  return matrix;
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.00001, `Expected ${actual} to be within tolerance of ${expected}`);
}

test('the visible step and porch follow a centered entrance on every wall', () => {
  for (const face of HOUSE_FACES) {
    const params = { preset: 'inn', width: 4, depth: 7, doorFace: face, doorPosition: 'center', porch: true };
    const model = buildHouse({ ...params, usePaintedSurfaces: false });
    try {
      const entrance = model.userData.entrance;
      const [nx, nz] = entrance.direction;
      const wallDistance = nx ? params.width / 2 : params.depth / 2;
      const door = new Vector3().setFromMatrixPosition(instanceMatrix(model, 'door-opening'));
      close(door.x, nx * (wallDistance + .08));
      close(door.z, nz * (wallDistance + .08));
      const step = new Vector3().setFromMatrixPosition(instanceMatrix(model, 'porch-step'));
      close(step.x, entrance.porch.step.x);
      close(step.z, entrance.porch.step.z);
      assert.ok((step.x - door.x) * nx + (step.z - door.z) * nz > 0);
      for (const position of ['left', 'right']) {
        const side = houseEntrance({ ...params, doorPosition: position });
        const wallOffset = side.door.x * nz - side.door.z * nx;
        assert.equal(Math.sign(wallOffset), position === 'left' ? -1 : 1);
      }
    } finally { disposeHouse(model); }
  }
});

test('rotating the ridge changes the roof geometry independently of the door', () => {
  for (const roofRotation of [0, 90]) {
    const model = buildHouse({ width: 4, depth: 7, doorFace: 'left', roofRotation, usePaintedSurfaces: false });
    try {
      const axis = new Vector3().setFromMatrixColumn(instanceMatrix(model, 'main-roof-ridge-underlay'), 2);
      close(Math.abs(axis.x), roofRotation === 90 ? 4.62 : 0);
      close(Math.abs(axis.z), roofRotation === 90 ? 0 : 7.62);
      assert.deepEqual(model.userData.entrance.direction, [-1, 0]);
    } finally { disposeHouse(model); }
  }
});

test('main-wall counts, alignment and door clearance hold on both storeys', () => {
  const counts = { front: 3, back: 1, left: 2, right: 0 }, rear = {};
  for (const alignment of ['left', 'even', 'right']) {
    const model = buildHouse({ width: 3, depth: 3, floors: 2, doorPosition: 'center',
      windowCounts: counts, windowAlignment: alignment, porch: true, shutters: true, usePaintedSurfaces: false });
    try {
      const { wallWindows, entrance } = model.userData;
      for (const face of HOUSE_FACES) {
        for (const floor of [0, 1]) {
          const windows = wallWindows.filter(w => w.face === face && w.floor === floor);
          assert.equal(windows.length, counts[face]);
          for (const w of windows) {
            assert.ok(w.w > 0 && Math.abs(w.u) + w.w / 2 < 1.5);
            if (face === 'front' && floor === 0) assert.ok(Math.abs(w.u) - w.w / 2 > entrance.porch.width / 2);
          }
        }
      }
      rear[alignment] = wallWindows.find(w => w.face === 'back' && w.floor === 0).u;
    } finally { disposeHouse(model); }
  }
  assert.ok(rear.left < rear.even && rear.even < rear.right);
});

test('original recipes keep their doorway offsets and mixed batches can pick every template', () => {
  for (const [preset, fraction] of Object.entries({ source: -.72, cottage: 0, village: .53, inn: .53, manor: .53 })) {
    const params = normalizeHouse({ preset });
    close(houseEntrance(params).u, fraction * params.width / 2);
    assert.equal(params.doorFace, 'front');
    assert.equal(params.roofRotation, 0);
    assert.deepEqual(params.windowCounts, {});
  }
  const templates = new Set(Array.from({ length: 100 }, (_, index) => pickHousePreset(index / 100)));
  assert.deepEqual(templates, new Set(Object.keys(PRESETS)));
  const variation = randomizeHouse('longhouse', 42, .8);
  assert.deepEqual(variation, randomizeHouse('longhouse', 42, .8));
});
