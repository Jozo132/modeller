const EPSILON = 1e-9;

function _isFinitePoint(point) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function _lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function _mapUnitSquareToQuadBilinear(quad, u, v) {
  const bottom = _lerpPoint(quad[0], quad[1], u);
  const top = _lerpPoint(quad[3], quad[2], u);
  return _lerpPoint(bottom, top, v);
}

export function getUnitSquareToQuadMatrix(quad) {
  if (!Array.isArray(quad) || quad.length !== 4 || quad.some((point) => !_isFinitePoint(point))) {
    return null;
  }

  const p0 = quad[0];
  const p1 = quad[1];
  const p2 = quad[2];
  const p3 = quad[3];
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(dx3) <= EPSILON && Math.abs(dy3) <= EPSILON) {
    return [
      p1.x - p0.x, p3.x - p0.x, p0.x,
      p1.y - p0.y, p3.y - p0.y, p0.y,
      0, 0, 1,
    ];
  }

  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) <= EPSILON) {
    return null;
  }

  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

export function applyProjectiveMatrix(matrix, x, y) {
  if (!Array.isArray(matrix) || matrix.length !== 9) {
    return null;
  }

  const denom = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(denom) <= EPSILON) {
    return null;
  }

  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denom,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denom,
  };
}

export function invertProjectiveMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 9) {
    return null;
  }

  const [a, b, c, d, e, f, g, h, i] = matrix;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;

  if (Math.abs(det) <= EPSILON) {
    return null;
  }

  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

export function multiplyProjectiveMatrices(left, right) {
  if (!Array.isArray(left) || left.length !== 9 || !Array.isArray(right) || right.length !== 9) {
    return null;
  }

  return [
    left[0] * right[0] + left[1] * right[3] + left[2] * right[6],
    left[0] * right[1] + left[1] * right[4] + left[2] * right[7],
    left[0] * right[2] + left[1] * right[5] + left[2] * right[8],
    left[3] * right[0] + left[4] * right[3] + left[5] * right[6],
    left[3] * right[1] + left[4] * right[4] + left[5] * right[7],
    left[3] * right[2] + left[4] * right[5] + left[5] * right[8],
    left[6] * right[0] + left[7] * right[3] + left[8] * right[6],
    left[6] * right[1] + left[7] * right[4] + left[8] * right[7],
    left[6] * right[2] + left[7] * right[5] + left[8] * right[8],
  ];
}

export function getQuadToQuadMatrix(sourceQuad, destQuad) {
  const sourceMatrix = getUnitSquareToQuadMatrix(sourceQuad);
  const destMatrix = getUnitSquareToQuadMatrix(destQuad);
  const inverseSource = invertProjectiveMatrix(sourceMatrix);
  if (!inverseSource || !destMatrix) {
    return null;
  }
  return multiplyProjectiveMatrices(destMatrix, inverseSource);
}

export function mapUnitSquareToQuadProjective(quad, u, v) {
  const matrix = getUnitSquareToQuadMatrix(quad);
  if (!matrix) {
    return _mapUnitSquareToQuadBilinear(quad, u, v);
  }
  return applyProjectiveMatrix(matrix, u, v) || _mapUnitSquareToQuadBilinear(quad, u, v);
}

export function buildProjectiveGridGuides(quad, cellsX = 3, cellsY = 3) {
  if (!Array.isArray(quad) || quad.length !== 4 || quad.some((point) => !_isFinitePoint(point))) {
    return [];
  }

  const guides = [];
  const normalizedCellsX = Math.max(1, Math.round(cellsX || 3));
  const normalizedCellsY = Math.max(1, Math.round(cellsY || 3));

  for (let i = 1; i < normalizedCellsY; i++) {
    const t = i / normalizedCellsY;
    guides.push([
      mapUnitSquareToQuadProjective(quad, 0, t),
      mapUnitSquareToQuadProjective(quad, 1, t),
    ]);
  }

  for (let i = 1; i < normalizedCellsX; i++) {
    const t = i / normalizedCellsX;
    guides.push([
      mapUnitSquareToQuadProjective(quad, t, 0),
      mapUnitSquareToQuadProjective(quad, t, 1),
    ]);
  }

  return guides.filter(([a, b]) => _isFinitePoint(a) && _isFinitePoint(b));
}