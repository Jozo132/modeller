import { computeSilhouetteEdges } from './part-render-core.js';

const DEFAULT_FACE_COLOR = [0.65, 0.75, 0.65, 1];
const DEFAULT_VISUAL_EDGE_COLOR = [0.25, 0.25, 0.25, 0.35];
const DEFAULT_FEATURE_EDGE_COLOR = [0.1, 0.1, 0.1, 1];
const DEFAULT_HIDDEN_FEATURE_EDGE_COLOR = [0.14, 0.14, 0.14, 0.55];
const DEFAULT_SILHOUETTE_COLOR = [0.1, 0.1, 0.1, 1];
const DEFAULT_BOUNDARY_EDGE_COLOR = [1.0, 0.4, 0.7, 1];
const DEFAULT_TRIANGLE_OUTLINE_COLOR = [0.72, 0.72, 0.72, 0.7];

export function renderBaseMeshOverlay(executor, options) {
  const {
    meshTriangles,
    meshTriangleCount,
    meshVisualEdges,
    meshVisualEdgeVertexCount,
    meshTriangleOverlayEdges,
    meshTriangleOverlayEdgeVertexCount,
    meshEdges,
    meshEdgeVertexCount,
    meshDashedFeatureEdges,
    meshDashedFeatureEdgeVertexCount,
    meshSilhouetteCandidates,
    meshBoundaryEdges,
    meshBoundaryEdgeVertexCount,
    orbitState,
    mvp,
    faceColor = DEFAULT_FACE_COLOR,
    visualEdgeColor = DEFAULT_VISUAL_EDGE_COLOR,
    featureEdgeColor = DEFAULT_FEATURE_EDGE_COLOR,
    hiddenFeatureEdgeColor = DEFAULT_HIDDEN_FEATURE_EDGE_COLOR,
    silhouetteColor = DEFAULT_SILHOUETTE_COLOR,
    boundaryEdgeColor = DEFAULT_BOUNDARY_EDGE_COLOR,
    triangleOutlineColor = DEFAULT_TRIANGLE_OUTLINE_COLOR,
    showInvisibleEdges = false,
    meshTriangleOverlayMode = 'off',
  } = options;

  if (!meshTriangles || meshTriangleCount === 0 || !mvp) return;

  // Diagnostic hatch uses a combined front+back face pass with painter's algorithm
  const { diagnosticHatch, normalColorShading } = options;

  if (normalColorShading) {
    executor.drawTriangleBufferNormalColor(meshTriangles, meshTriangleCount, {
      mvp,
      polygonOffset: [2, 2],
    });
  } else {
    executor.drawTriangleBuffer(meshTriangles, meshTriangleCount, {
      mvp,
      color: faceColor,
      polygonOffset: [2, 2],
      diagnosticHatch: !!diagnosticHatch,
    });
  }

  if (meshTriangleOverlayMode === 'outline' && meshTriangleOverlayEdges && meshTriangleOverlayEdgeVertexCount > 0) {
    executor.drawLineBuffer(meshTriangleOverlayEdges, meshTriangleOverlayEdgeVertexCount, {
      mvp,
      color: triangleOutlineColor,
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
      depthFunc: 'less',
      depthWrite: false,
    });
  }

  if (showInvisibleEdges && meshDashedFeatureEdges && meshDashedFeatureEdgeVertexCount > 0) {
    executor.drawLineBuffer(meshDashedFeatureEdges, meshDashedFeatureEdgeVertexCount, {
      mvp,
      color: hiddenFeatureEdgeColor,
      lineWidth: 1,
      lineDash: [],
      depthFunc: 'greater',
      depthWrite: false,
    });
  }

  if (meshVisualEdges && meshVisualEdgeVertexCount > 0 && meshTriangleOverlayMode === 'outline') {
    executor.drawLineBuffer(meshVisualEdges, meshVisualEdgeVertexCount, {
      mvp,
      color: visualEdgeColor,
      lineWidth: 1,
      lineDash: [],
      depthFunc: 'less',
      depthWrite: false,
    });
  }

  const silhouetteEdges = computeSilhouetteEdges(meshSilhouetteCandidates, orbitState);
  if (silhouetteEdges) {
    executor.drawLineBuffer(silhouetteEdges, silhouetteEdges.length / 3, {
      mvp,
      color: silhouetteColor,
      lineWidth: 1,
      lineDash: [],
      depthFunc: 'less',
      depthWrite: false,
    });
  }

  if (meshBoundaryEdges && meshBoundaryEdgeVertexCount > 0) {
    executor.drawLineBuffer(meshBoundaryEdges, meshBoundaryEdgeVertexCount, {
      mvp,
      color: boundaryEdgeColor,
      lineWidth: 2,
      lineDash: [],
      depthFunc: 'less',
      depthWrite: false,
    });
  }
}