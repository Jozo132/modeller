function quantizeNumber(value, precision = 6) {
  const normalized = Math.abs(value || 0) < 1e-12 ? 0 : value || 0;
  return normalized.toFixed(precision);
}

function stableStringify(value) {
  if (value == null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    return JSON.stringify(Number.isFinite(value) ? Number(quantizeNumber(value)) : value);
  }
  return JSON.stringify(value);
}

function pointSignature(point) {
  if (!point) return 'null';
  return `${quantizeNumber(point.x)},${quantizeNumber(point.y)},${quantizeNumber(point.z)}`;
}

function curveSignature(curve) {
  if (!curve) return 'line';
  return stableStringify({
    degree: curve.degree ?? null,
    controlPoints: Array.isArray(curve.controlPoints)
      ? curve.controlPoints.map((point) => pointSignature(point))
      : [],
    knots: Array.isArray(curve.knots)
      ? curve.knots.map((knot) => quantizeNumber(knot))
      : [],
    weights: Array.isArray(curve.weights)
      ? curve.weights.map((weight) => quantizeNumber(weight))
      : [],
  });
}

function loopSignature(loop) {
  if (!loop || !Array.isArray(loop.coedges)) return '[]';
  return stableStringify(loop.coedges.map((coedge) => {
    const edge = coedge?.edge || null;
    const sameSense = coedge?.sameSense !== false;
    const startVertex = sameSense ? edge?.startVertex?.point : edge?.endVertex?.point;
    const endVertex = sameSense ? edge?.endVertex?.point : edge?.startVertex?.point;
    return {
      sameSense,
      start: pointSignature(startVertex),
      end: pointSignature(endVertex),
      curve: curveSignature(edge?.curve || null),
    };
  }));
}

export function buildFaceTessellationKey(face) {
  return stableStringify({
    stableHash: face?.stableHash || null,
    surfaceType: face?.surfaceType || null,
    sameSense: face?.sameSense !== false,
    fusedGroupId: face?.fusedGroupId || null,
    surfaceInfo: face?.surfaceInfo || null,
    outerLoop: loopSignature(face?.outerLoop || null),
    innerLoops: Array.isArray(face?.innerLoops)
      ? face.innerLoops.map((loop) => loopSignature(loop))
      : [],
  });
}

export function buildEdgeTessellationKey(edge) {
  return stableStringify({
    stableHash: edge?.stableHash || null,
    start: pointSignature(edge?.startVertex?.point || null),
    end: pointSignature(edge?.endVertex?.point || null),
    curve: curveSignature(edge?.curve || null),
  });
}

export function materializeFaceMesh(cachedFaceMesh, face, faceKey) {
  return {
    vertices: cachedFaceMesh?.vertices || [],
    faces: cachedFaceMesh?.faces || [],
    shared: face?.shared || null,
    isFillet: !!(face?.shared && face.shared.isFillet),
    isCorner: !!(face?.shared && face.shared.isCorner),
    topoFaceId: face?.id,
    fusedGroupId: face?.fusedGroupId || null,
    faceType: face?.surfaceType === 'plane' ? 'planar'
      : face?.surfaceType ? `curved-${face.surfaceType}` : 'unknown',
    tessellationFaceKey: faceKey,
  };
}

export function shouldReuseIncrementalCache(cache, configKey) {
  return !!(cache && cache.configKey === configKey && cache.faceMeshesByKey instanceof Map);
}
