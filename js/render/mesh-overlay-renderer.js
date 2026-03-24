import { computeSilhouetteEdges } from './part-render-core.js';

const DEFAULT_FACE_COLOR = [0.65, 0.75, 0.65, 1];
const DEFAULT_VISUAL_EDGE_COLOR = [0.25, 0.25, 0.25, 0.35];
const DEFAULT_FEATURE_EDGE_COLOR = [0.1, 0.1, 0.1, 1];
const DEFAULT_SILHOUETTE_COLOR = [0.1, 0.1, 0.1, 1];

export function renderBaseMeshOverlay(executor, options) {
  const {
    meshTriangles,
    meshTriangleCount,
    meshVisualEdges,
    meshVisualEdgeVertexCount,
    meshEdges,
    meshEdgeVertexCount,
    meshSilhouetteCandidates,
    orbitState,
    mvp,
    faceColor = DEFAULT_FACE_COLOR,
    visualEdgeColor = DEFAULT_VISUAL_EDGE_COLOR,
    featureEdgeColor = DEFAULT_FEATURE_EDGE_COLOR,
    silhouetteColor = DEFAULT_SILHOUETTE_COLOR,
  } = options;

  if (!meshTriangles || meshTriangleCount === 0 || !mvp) return;

  executor.drawTriangleBuffer(meshTriangles, meshTriangleCount, {
    mvp,
    color: faceColor,
    polygonOffset: [1, 1],
  });

  if (meshVisualEdges && meshVisualEdgeVertexCount > 0) {
    executor.drawLineBuffer(meshVisualEdges, meshVisualEdgeVertexCount, {
      mvp,
      color: visualEdgeColor,
      lineWidth: 1,
      lineDash: [],
    });
  }

  if (meshEdges && meshEdgeVertexCount > 0) {
    executor.drawLineBuffer(meshEdges, meshEdgeVertexCount, {
      mvp,
      color: featureEdgeColor,
      lineWidth: 1,
      lineDash: [],
    });
  }

  const silhouetteEdges = computeSilhouetteEdges(meshSilhouetteCandidates, orbitState);
  if (silhouetteEdges) {
    executor.drawLineBuffer(silhouetteEdges, silhouetteEdges.length / 3, {
      mvp,
      color: silhouetteColor,
      lineWidth: 1,
      lineDash: [],
    });
  }
}