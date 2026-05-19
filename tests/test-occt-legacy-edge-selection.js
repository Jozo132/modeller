import assert from 'node:assert/strict';

import { FilletFeature } from '../js/cad/FilletFeature.js';
import { ChamferFeature } from '../js/cad/ChamferFeature.js';

function makeLegacyEdgeKey(start, end) {
  return [start, end]
    .map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`)
    .sort()
    .join('|');
}

function makeSegmentedOcctSelectionContext(ref) {
  const start = { x: 0, y: 0, z: 0 };
  const middle = { x: 5, y: 0, z: 0 };
  const end = { x: 10, y: 0, z: 0 };
  return {
    selectionKey: makeLegacyEdgeKey(start, end),
    selectionContext: {
      geometry: {
        faces: [],
        edges: [
          {
            start,
            end: middle,
            ...ref,
            faceIndices: [],
          },
          {
            start: middle,
            end,
            ...ref,
            faceIndices: [],
          },
        ],
        paths: [
          {
            edgeIndices: [0, 1],
            ...ref,
            isClosed: false,
          },
        ],
      },
    },
  };
}

function checkLegacySelectionBridge(feature, ref) {
  const { selectionKey, selectionContext } = makeSegmentedOcctSelectionContext(ref);
  const refs = feature._resolveSelectedOcctEdgeRefs(selectionContext, [selectionKey]);
  assert.deepEqual(refs, [ref]);
}

function checkLegacyToleranceBridge(feature, ref) {
  const selectionContext = {
    geometry: {
      faces: [],
      edges: [
        {
          start: { x: 11.9456, y: 21.9397, z: 17 },
          end: { x: 31.7151, y: 18.9116, z: 17 },
          ...ref,
          faceIndices: [],
        },
      ],
      paths: [{ edgeIndices: [0], isClosed: false }],
    },
  };
  const refs = feature._resolveSelectedOcctEdgeRefs(selectionContext, [
    '11.94565,21.93972,17.00000|31.71509,18.91165,17.00000',
  ]);
  assert.deepEqual(refs, [ref]);
}

checkLegacySelectionBridge(new FilletFeature('Fillet 1', 1), { stableHash: 'occt-path-fillet' });
checkLegacySelectionBridge(new FilletFeature('Fillet 1', 1), { topoId: 17 });
checkLegacySelectionBridge(new ChamferFeature('Chamfer 1', 1), { stableHash: 'occt-path-chamfer' });
checkLegacySelectionBridge(new ChamferFeature('Chamfer 1', 1), { topoId: 23 });
checkLegacyToleranceBridge(new FilletFeature('Fillet 1', 1), { stableHash: 'occt-fuzzy-fillet' });
checkLegacyToleranceBridge(new ChamferFeature('Chamfer 1', 1), { stableHash: 'occt-fuzzy-chamfer' });

console.log('ok');