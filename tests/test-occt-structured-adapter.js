import assert from 'node:assert/strict';

import { OcctKernelAdapter } from '../js/cad/occt/OcctKernelAdapter.js';

function rectangleProfile() {
  return {
    segments: [
      { type: 'line', start: [0, 0], end: [10, 0] },
      { type: 'line', start: [10, 0], end: [10, 5] },
      { type: 'line', start: [10, 5], end: [0, 5] },
      { type: 'line', start: [0, 5], end: [0, 0] },
    ],
  };
}

class FakeStructuredKernel {
  constructor() {
    this.calls = [];
  }

  createBox(dx, dy, dz) {
    this.calls.push({ method: 'createBox', args: [dx, dy, dz] });
    return 101;
  }

  extrudeProfileWithSpec(request) {
    this.calls.push({ method: 'extrudeProfileWithSpec', request });
    return 201;
  }

  extrudeCutProfileWithSpec(request) {
    this.calls.push({ method: 'extrudeCutProfileWithSpec', request });
    return JSON.stringify({ shape: { id: 202 } });
  }

  revolveProfileWithSpec(request) {
    this.calls.push({ method: 'revolveProfileWithSpec', request });
    return { shapeHandle: 203 };
  }

  revolveCutProfileWithSpec(request) {
    this.calls.push({ method: 'revolveCutProfileWithSpec', request });
    return JSON.stringify({ shapeId: 204 });
  }

  sweepProfileWithSpec(request) {
    this.calls.push({ method: 'sweepProfileWithSpec', request });
    return { id: 205 };
  }

  loftWithSpec(request) {
    this.calls.push({ method: 'loftWithSpec', request });
    return { shape: { shapeHandle: 206 } };
  }
}

class JsonOnlyStructuredKernel {
  extrudeProfileWithSpec(request) {
    if (typeof request !== 'string') throw new Error('json payload required');
    this.payload = JSON.parse(request);
    return '301';
  }
}

class PositionalStructuredKernel {
  constructor() {
    this.calls = [];
  }

  sweepProfileWithSpec(shapeId, profileJson, specJson) {
    this.calls.push({
      method: 'sweepProfileWithSpec',
      shapeId,
      profile: JSON.parse(profileJson),
      spec: JSON.parse(specJson),
    });
    return 401;
  }

  loftWithSpec(shapeId, sectionsJson, specJson) {
    this.calls.push({
      method: 'loftWithSpec',
      shapeId,
      sections: JSON.parse(sectionsJson),
      spec: JSON.parse(specJson),
    });
    return JSON.stringify({ shapeHandle: 402 });
  }
}

class FakeWrappedKernel {
  constructor() {
    this.calls = [];
  }

  createBox(params) {
    this.calls.push({ method: 'createBox', params });
    return { id: 501 };
  }

  sweepProfileWithSpec(params) {
    this.calls.push({ method: 'sweepProfileWithSpec', params });
    return { id: 502 };
  }

  loftWithSpec(params) {
    this.calls.push({ method: 'loftWithSpec', params });
    return { id: 503 };
  }

  tessellate(params) {
    this.calls.push({ method: 'tessellate', params });
    return {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
  }
}

const profile = rectangleProfile();
const kernel = new FakeStructuredKernel();
const adapter = new OcctKernelAdapter({ kernel });

assert.equal(adapter.createBox({ dx: 1, dy: 2, dz: 3 }), 101);
assert.deepEqual(kernel.calls[0], { method: 'createBox', args: [1, 2, 3] });

assert.equal(adapter.extrudeProfileWithSpec({
  shape: { id: 100 },
  profile,
  spec: {
    plane: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      xDirection: [1, 0, 0],
    },
    draftAngleRadians: Math.PI / 12,
    extent: { type: 'blind', distance: 4 },
  },
}), 201);
const extrudeRequest = kernel.calls.at(-1).request;
assert.equal(extrudeRequest.shape, 100);
assert.equal(extrudeRequest.spec.schemaVersion, 1);
assert.equal(Math.round(extrudeRequest.spec.draftAngleDegrees), 15);
assert.equal(extrudeRequest.spec.draftAngleRadians, undefined);
assert.equal(adapter._ownedShapes.has(201), true);

assert.equal(adapter.extrudeCutProfileWithSpec({
  shapeHandle: 201,
  profile,
  spec: { extent: { type: 'throughAll' } },
}), 202);
const cutRequest = kernel.calls.at(-1).request;
assert.equal(cutRequest.shape, 201);
assert.equal(cutRequest.cut, true);
assert.equal(cutRequest.spec.schemaVersion, 1);
assert.equal(adapter._ownedShapes.has(202), true);

assert.equal(adapter.revolveProfileWithSpec({
  profile,
  spec: {
    axisOrigin: [0, 0, 0],
    axisDirection: [0, 0, 1],
    extent: { type: 'angle', angleRadians: Math.PI },
  },
}), 203);
const revolveRequest = kernel.calls.at(-1).request;
assert.equal(revolveRequest.spec.extent.angleRadians, undefined);
assert.equal(Math.round(revolveRequest.spec.extent.angleDegrees), 180);

assert.equal(adapter.revolveCutProfileWithSpec({ profile, spec: { extent: { type: 'throughAll' } } }), 204);
assert.equal(kernel.calls.at(-1).request.cut, true);

assert.equal(adapter.sweepProfileWithSpec({
  shapeHandle: 203,
  profile,
  spec: {
    spine: { segments: [{ type: 'line', start: [0, 0, 0], end: [0, 0, 5] }] },
  },
}), 205);
assert.equal(kernel.calls.at(-1).request.shape, 203);
assert.equal(kernel.calls.at(-1).request.spec.schemaVersion, 1);

assert.equal(adapter.loftWithSpec({
  sections: [{ type: 'profile', profile }],
  spec: { solid: true },
}), 206);
assert.equal(kernel.calls.at(-1).request.spec.schemaVersion, 1);

const jsonOnlyKernel = new JsonOnlyStructuredKernel();
const jsonOnlyAdapter = new OcctKernelAdapter({ kernel: jsonOnlyKernel });
assert.equal(jsonOnlyAdapter.extrudeProfileWithSpec({ profile, spec: { extent: { type: 'blind', distance: 2 } } }), 301);
assert.equal(jsonOnlyKernel.payload.spec.schemaVersion, 1);
assert.equal(jsonOnlyAdapter._ownedShapes.has(301), true);

const positionalKernel = new PositionalStructuredKernel();
const positionalAdapter = new OcctKernelAdapter({ kernel: positionalKernel });
assert.equal(positionalAdapter.sweepProfileWithSpec({
  shapeHandle: 77,
  profile,
  spec: {
    spine: { segments: [{ type: 'line', start: [0, 0, 0], end: [0, 0, 6] }] },
  },
}), 401);
assert.equal(positionalKernel.calls[0].shapeId, 77);
assert.equal(positionalKernel.calls[0].profile.segments.length, 4);
assert.equal(positionalKernel.calls[0].spec.schemaVersion, 1);

assert.equal(positionalAdapter.loftWithSpec({
  shape: 88,
  sections: [{ type: 'profile', profile }],
  spec: { solid: true },
}), 402);
assert.equal(positionalKernel.calls[1].shapeId, 88);
assert.equal(positionalKernel.calls[1].sections.length, 1);
assert.equal(positionalKernel.calls[1].spec.schemaVersion, 1);

const wrappedKernel = new FakeWrappedKernel();
const wrappedAdapter = new OcctKernelAdapter({ kernel: wrappedKernel, wrapperApi: true });
assert.equal(wrappedAdapter.createBox({ dx: 3, dy: 4, dz: 5 }), 501);
assert.deepEqual(wrappedKernel.calls[0], {
  method: 'createBox',
  params: { dx: 3, dy: 4, dz: 5 },
});

assert.equal(wrappedAdapter.sweepProfileWithSpec({
  shape: 501,
  profile,
  spec: {
    plane: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      xDirection: [1, 0, 0],
    },
    spine: { segments: [{ type: 'line', start: [0, 0, 0], end: [0, 0, 10] }] },
  },
}), 502);
assert.equal(wrappedKernel.calls[1].params.shape.id, 501);
assert.equal(wrappedKernel.calls[1].params.spec.schemaVersion, 1);

assert.equal(wrappedAdapter.loftWithSpec({
  shape: 501,
  sections: [{ type: 'profile', profile }],
  spec: { solid: true },
}), 503);
assert.equal(wrappedKernel.calls[2].params.shape.id, 501);
assert.equal(wrappedKernel.calls[2].params.spec.schemaVersion, 1);

const wrappedMesh = wrappedAdapter.tessellate(501);
assert.equal(wrappedMesh.vertices.length, 3);
assert.equal(wrappedMesh.faces.length, 1);

console.log('ok');
