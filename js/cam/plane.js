function normalizePoint3OrNull(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  const z = Number(point?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function vectorLength(vector) {
  return Math.hypot(Number(vector?.x) || 0, Number(vector?.y) || 0, Number(vector?.z) || 0);
}

function normalizeVector3OrNull(vector) {
  const point = normalizePoint3OrNull(vector);
  if (!point) return null;
  const length = vectorLength(point);
  if (length <= 1e-12) return null;
  return {
    x: point.x / length,
    y: point.y / length,
    z: point.z / length,
  };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function centroid(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
    sumZ += point.z;
  }
  return {
    x: sumX / points.length,
    y: sumY / points.length,
    z: sumZ / points.length,
  };
}

function newellNormal(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    nx += (current.y - next.y) * (current.z + next.z);
    ny += (current.z - next.z) * (current.x + next.x);
    nz += (current.x - next.x) * (current.y + next.y);
  }
  return normalizeVector3OrNull({ x: nx, y: ny, z: nz });
}

function perpendicularAxis(normal) {
  const reference = Math.abs(normal.z) < 0.9
    ? { x: 0, y: 0, z: 1 }
    : { x: 1, y: 0, z: 0 };
  return normalizeVector3OrNull(cross(reference, normal));
}

export function normalizeCamPlane(input) {
  if (!input || typeof input !== 'object') return null;
  const origin = normalizePoint3OrNull(input.origin);
  const normal = normalizeVector3OrNull(input.normal);
  const xAxis = normalizeVector3OrNull(input.xAxis);
  const yAxis = normalizeVector3OrNull(input.yAxis);
  if (!origin || !normal || !xAxis || !yAxis) return null;
  return { origin, normal, xAxis, yAxis };
}

export function buildCamPlaneFromFace(vertices, normalHint = null) {
  const points = (Array.isArray(vertices) ? vertices : []).map((point) => normalizePoint3OrNull(point)).filter(Boolean);
  if (points.length < 3) return null;

  const origin = centroid(points);
  const normal = normalizeVector3OrNull(normalHint) || newellNormal(points);
  if (!origin || !normal) return null;

  const xAxis = perpendicularAxis(normal);
  if (!xAxis) return null;
  const yAxis = normalizeVector3OrNull(cross(normal, xAxis));
  if (!yAxis) return null;

  return { origin, normal, xAxis, yAxis };
}

export function isWorldZAlignedPlane(plane, tolerance = 1e-6) {
  const normalized = normalizeCamPlane(plane);
  if (!normalized) return false;
  return Math.abs(normalized.normal.x) <= tolerance
    && Math.abs(normalized.normal.y) <= tolerance
    && Math.abs(Math.abs(normalized.normal.z) - 1) <= tolerance;
}