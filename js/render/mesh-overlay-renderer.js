import { computeOrbitCameraPosition, computeSilhouetteEdges } from './part-render-core.js';

const DEFAULT_FACE_COLOR = [0.65, 0.75, 0.65, 1];
const DEFAULT_VISUAL_EDGE_COLOR = [0.25, 0.25, 0.25, 0.35];
const DEFAULT_FEATURE_EDGE_COLOR = [0.1, 0.1, 0.1, 1];
const DEFAULT_HIDDEN_FEATURE_EDGE_COLOR = [0.14, 0.14, 0.14, 0.55];
const DEFAULT_SILHOUETTE_COLOR = [0.1, 0.1, 0.1, 1];
const DEFAULT_BOUNDARY_EDGE_COLOR = [1.0, 0.4, 0.7, 1];
const DEFAULT_TRIANGLE_OUTLINE_COLOR = [0.72, 0.72, 0.72, 0.7];
const FEATURE_EDGE_DEPTH_BIAS = 2e-6;

// Build a Float32Array containing only the segments of meshEdges whose adjacent faces
// are front-facing toward the camera.  Used by executors that have no hardware depth test.
function buildFrontFacingEdgeBuffer(meshEdges, meshEdgeSegments, viewDir) {
  if (!meshEdges || !meshEdgeSegments || !viewDir) return { data: meshEdges, count: meshEdges ? meshEdges.length / 3 : 0 };

  const result = [];
  let vertexOffset = 0;

  for (const seg of meshEdgeSegments) {
    const points = seg.points;
    const numPoints = Array.isArray(points) ? points.length : 0;
    const numLines = Math.max(0, numPoints - 1);
    const numVertices = numLines * 2;

    // Keep the edge if it has no normals or at least one adjacent face faces the camera.
    // A face is front-facing when its outward normal has a negative dot product with the
    // view direction (i.e. the normal points toward the camera).
    let frontFacing = !seg.normals || seg.normals.length === 0;
    if (!frontFacing) {
      for (const n of seg.normals) {
        if (n.x * viewDir.x + n.y * viewDir.y + n.z * viewDir.z < 0) {
          frontFacing = true;
          break;
        }
      }
    }

    if (frontFacing) {
      for (let i = 0; i < numVertices; i++) {
        const base = (vertexOffset + i) * 3;
        result.push(meshEdges[base], meshEdges[base + 1], meshEdges[base + 2]);
      }
    }

    vertexOffset += numVertices;
  }

  return result.length > 0
    ? { data: new Float32Array(result), count: result.length / 3 }
    : { data: null, count: 0 };
}

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
    meshEdgeSegments,
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

  const supportsDepthPrepass = typeof executor.drawTriangleDepthPrepass === 'function'
    && typeof executor.setDepthWrite === 'function';
  const visibleEdgeDepthFunc = supportsDepthPrepass ? 'lequal' : 'less';
  const triangleOverlayDepthFunc = supportsDepthPrepass ? 'lequal' : 'less';

  if (supportsDepthPrepass) {
    executor.drawTriangleDepthPrepass(meshTriangles, meshTriangleCount, { mvp });
    executor.setDepthWrite(false);
  }

  if (normalColorShading) {
    executor.drawTriangleBufferNormalColor(meshTriangles, meshTriangleCount, {
      mvp,
      depthFunc: supportsDepthPrepass ? 'lequal' : 'less',
      depthWrite: false,
      polygonOffset: supportsDepthPrepass ? null : [2, 2],
    });
  } else {
    executor.drawTriangleBuffer(meshTriangles, meshTriangleCount, {
      mvp,
      color: faceColor,
      depthFunc: supportsDepthPrepass ? 'lequal' : 'less',
      depthWrite: false,
      polygonOffset: supportsDepthPrepass ? null : [2, 2],
      diagnosticHatch: !!diagnosticHatch,
    });
  }

  if (supportsDepthPrepass) {
    executor.setDepthWrite(true);
  }

  if (meshTriangleOverlayMode === 'outline' && meshTriangleOverlayEdges && meshTriangleOverlayEdgeVertexCount > 0) {
    executor.drawLineBuffer(meshTriangleOverlayEdges, meshTriangleOverlayEdgeVertexCount, {
      mvp,
      color: triangleOutlineColor,
      lineWidth: 1,
      lineDash: [],
      depthFunc: triangleOverlayDepthFunc,
      depthWrite: false,
    });
  }

  // For executors without hardware depth testing (e.g. CanvasCommandExecutor), pre-filter
  // feature edges to front-facing faces only using adjacent face normals. WebGL relies on
  // the depth prepass instead; filtering there drops valid concave edges.
  let visibleEdges = meshEdges;
  let visibleEdgeCount = meshEdgeVertexCount;
  if (!executor.setDepthTest && meshEdgeSegments && orbitState) {
    const camera = computeOrbitCameraPosition(
      orbitState.theta, orbitState.phi, orbitState.radius, orbitState.target
    );
    const tx = orbitState.target?.x || 0;
    const ty = orbitState.target?.y || 0;
    const tz = orbitState.target?.z || 0;
    const dx = tx - camera.x;
    const dy = ty - camera.y;
    const dz = tz - camera.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-10) {
      const viewDir = { x: dx / len, y: dy / len, z: dz / len };
      const filtered = buildFrontFacingEdgeBuffer(meshEdges, meshEdgeSegments, viewDir);
      visibleEdges = filtered.data;
      visibleEdgeCount = filtered.count;
    }
  }

  if (visibleEdges && visibleEdgeCount > 0) {
    executor.drawLineBuffer(visibleEdges, visibleEdgeCount, {
      mvp,
      color: featureEdgeColor,
      lineWidth: 1,
      lineDash: [],
      depthFunc: visibleEdgeDepthFunc,
      depthWrite: false,
      depthBias: supportsDepthPrepass ? FEATURE_EDGE_DEPTH_BIAS : 0,
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
      depthFunc: triangleOverlayDepthFunc,
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
      depthFunc: visibleEdgeDepthFunc,
      depthWrite: false,
    });
  }

  if (meshBoundaryEdges && meshBoundaryEdgeVertexCount > 0) {
    executor.drawLineBuffer(meshBoundaryEdges, meshBoundaryEdgeVertexCount, {
      mvp,
      color: boundaryEdgeColor,
      lineWidth: 2,
      lineDash: [],
      depthFunc: visibleEdgeDepthFunc,
      depthWrite: false,
    });
  }
}