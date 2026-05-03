function distance(a, b) {
  return Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.y ?? 0) - (a?.y ?? 0));
}

function pointLineDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-12) return distance(point, start);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / len;
}

function cleanPoints(points, minDistance) {
  const cleaned = [];
  for (const point of points || []) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && distance(previous, point) <= minDistance) continue;
    cleaned.push(point);
  }
  if (cleaned.length > 2 && distance(cleaned[0], cleaned[cleaned.length - 1]) <= minDistance) {
    cleaned.pop();
  }
  return cleaned;
}

function angleAt(previous, current, next) {
  const ax = previous.x - current.x;
  const ay = previous.y - current.y;
  const bx = next.x - current.x;
  const by = next.y - current.y;
  const al = Math.hypot(ax, ay);
  const bl = Math.hypot(bx, by);
  if (al <= 1e-12 || bl <= 1e-12) return Math.PI;
  const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)));
  return Math.acos(dot);
}

function spanPoints(points, startIndex, endIndex) {
  const span = [points[startIndex]];
  for (let index = (startIndex + 1) % points.length; index !== endIndex; index = (index + 1) % points.length) {
    span.push(points[index]);
  }
  span.push(points[endIndex]);
  return span;
}

function fitsLine(points, tolerance) {
  if (points.length <= 2) return true;
  const start = points[0];
  const end = points[points.length - 1];
  for (let index = 1; index < points.length - 1; index++) {
    if (pointLineDistance(points[index], start, end) > tolerance) return false;
  }
  return true;
}

function rdpOpenIndices(points, tolerance) {
  if (!Array.isArray(points) || points.length <= 2) return points?.map((_, index) => index) || [];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let split = -1;
    let maxDistance = -1;
    for (let index = start + 1; index < end; index++) {
      const d = pointLineDistance(points[index], points[start], points[end]);
      if (d > maxDistance) {
        maxDistance = d;
        split = index;
      }
    }
    if (maxDistance > tolerance && split > start) {
      keep[split] = 1;
      stack.push([start, split], [split, end]);
    }
  }
  const result = [];
  for (let index = 0; index < keep.length; index++) {
    if (keep[index]) result.push(index);
  }
  return result;
}

function rdpClosedIndices(points, tolerance) {
  if (!Array.isArray(points) || points.length <= 3) return points?.map((_, index) => index) || [];
  let anchorA = 0;
  let anchorB = 1;
  let maxDistance = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = distance(points[i], points[j]);
      if (d > maxDistance) {
        maxDistance = d;
        anchorA = i;
        anchorB = j;
      }
    }
  }
  const first = spanPoints(points, anchorA, anchorB);
  const second = spanPoints(points, anchorB, anchorA);
  const firstIndices = rdpOpenIndices(first, tolerance).map((index) => (anchorA + index) % points.length);
  const secondIndices = rdpOpenIndices(second, tolerance).map((index) => (anchorB + index) % points.length);
  return [...new Set([...firstIndices, ...secondIndices])].sort((a, b) => a - b);
}

function signedTurn(a, b, c) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const ul = Math.hypot(ux, uy);
  const vl = Math.hypot(vx, vy);
  if (ul <= 1e-12 || vl <= 1e-12) return 0;
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

function spanLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

function cumulativeParameters(points) {
  const params = [0];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += distance(points[index - 1], points[index]);
    params.push(total);
  }
  if (total <= 1e-12) return params.map(() => 0);
  return params.map((value) => value / total);
}

function bsplineBasis(controlCount, degree, t) {
  const n = controlCount;
  const p = Math.min(degree, n - 1);
  if (n <= 1) return [1];
  t = Math.max(0, Math.min(1, t));
  if (t >= 1) {
    const out = new Array(n).fill(0);
    out[n - 1] = 1;
    return out;
  }
  const knotCount = n + p + 1;
  const knots = new Array(knotCount);
  for (let i = 0; i < knotCount; i++) {
    if (i <= p) knots[i] = 0;
    else if (i >= knotCount - p - 1) knots[i] = 1;
    else knots[i] = (i - p) / (n - p);
  }

  let span = p;
  for (let i = p; i < n; i++) {
    if (t >= knots[i] && t < knots[i + 1]) {
      span = i;
      break;
    }
  }

  const local = new Array(p + 1).fill(0);
  local[0] = 1;
  const left = new Array(p + 1);
  const right = new Array(p + 1);
  for (let j = 1; j <= p; j++) {
    left[j] = t - knots[span + 1 - j];
    right[j] = knots[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      if (Math.abs(denom) < 1e-14) {
        local[r] = saved;
        saved = 0;
      } else {
        const temp = local[r] / denom;
        local[r] = saved + right[r + 1] * temp;
        saved = left[j - r] * temp;
      }
    }
    local[j] = saved;
  }

  const basis = new Array(n).fill(0);
  for (let i = 0; i <= p; i++) {
    basis[span - p + i] = local[i];
  }
  return basis;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let k = col; k <= n; k++) a[col][k] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) < 1e-14) continue;
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row) => row[n]);
}

function evaluateFittedControls(controls, t) {
  const basis = bsplineBasis(controls.length, 3, t);
  let x = 0;
  let y = 0;
  for (let index = 0; index < controls.length; index++) {
    x += controls[index].x * basis[index];
    y += controls[index].y * basis[index];
  }
  return { x, y };
}

function fitOpenCubicBSpline(points, controlCount) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const n = Math.max(2, Math.min(controlCount, points.length));
  if (n <= 2) return [points[0], points[points.length - 1]];
  const params = cumulativeParameters(points);
  const unknowns = n - 2;
  const ata = Array.from({ length: unknowns }, () => new Array(unknowns).fill(0));
  const atx = new Array(unknowns).fill(0);
  const aty = new Array(unknowns).fill(0);
  const first = points[0];
  const last = points[points.length - 1];

  for (let row = 0; row < points.length; row++) {
    const basis = bsplineBasis(n, 3, params[row]);
    const targetX = points[row].x - basis[0] * first.x - basis[n - 1] * last.x;
    const targetY = points[row].y - basis[0] * first.y - basis[n - 1] * last.y;
    for (let i = 0; i < unknowns; i++) {
      const bi = basis[i + 1];
      atx[i] += bi * targetX;
      aty[i] += bi * targetY;
      for (let j = 0; j < unknowns; j++) {
        ata[i][j] += bi * basis[j + 1];
      }
    }
  }

  for (let i = 0; i < unknowns; i++) ata[i][i] += 1e-9;
  const solvedX = solveLinearSystem(ata, atx);
  const solvedY = solveLinearSystem(ata, aty);
  if (!solvedX || !solvedY) return points.filter((_, index) => index === 0 || index === points.length - 1);

  const controls = [first];
  for (let index = 0; index < unknowns; index++) {
    controls.push({ x: solvedX[index], y: solvedY[index] });
  }
  controls.push(last);
  return controls;
}

function maxFitError(points, controls) {
  if (!Array.isArray(points) || points.length === 0 || !Array.isArray(controls) || controls.length < 2) return Infinity;
  const params = cumulativeParameters(points);
  let maxError = 0;
  for (let index = 0; index < points.length; index++) {
    maxError = Math.max(maxError, distance(points[index], evaluateFittedControls(controls, params[index])));
  }
  return maxError;
}

function pointBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

function isStableFittedSpline(points, controls, tolerance, minSegmentLength) {
  if (!Array.isArray(controls) || controls.length < 4) return false;
  if (!controls.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return false;
  const bounds = pointBounds(points);
  const diagonal = Math.max(1e-9, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
  const margin = Math.max(tolerance * 4, minSegmentLength * 4, diagonal * 0.12);
  const maxControlStep = diagonal * 1.35 + margin;
  for (let index = 0; index < controls.length; index++) {
    const point = controls[index];
    if (
      point.x < bounds.minX - margin
      || point.x > bounds.maxX + margin
      || point.y < bounds.minY - margin
      || point.y > bounds.maxY + margin
    ) {
      return false;
    }
    if (index > 0 && distance(controls[index - 1], point) > maxControlStep) return false;
  }
  return maxFitError(points, controls) <= Math.max(tolerance * 3, minSegmentLength * 3, diagonal * 0.08);
}

function fitSplineControlPoints(points, options = {}) {
  const minFitPoints = Math.max(4, Math.round(options.minFitPoints || 12));
  if (!Array.isArray(points) || points.length < minFitPoints) return [];
  const minControls = Math.max(4, Math.min(points.length, Math.round(options.minControls || 4)));
  const maxControls = Math.max(minControls, Math.min(points.length, Math.round(options.maxControls || 14)));
  const tolerance = Math.max(0, options.tolerance ?? 0.25);
  const minSegmentLength = Math.max(0, options.minSegmentLength ?? 0);
  let best = null;
  let bestError = Infinity;
  for (let count = minControls; count <= maxControls; count++) {
    const controls = fitOpenCubicBSpline(points, count);
    const error = maxFitError(points, controls);
    if (error < bestError && isStableFittedSpline(points, controls, tolerance, minSegmentLength)) {
      best = controls;
      bestError = error;
    }
    if (best && error <= tolerance) break;
  }
  return best || [];
}

function cleanSplineControlPoints(points, minDistance, { closed = false } = {}) {
  const cleaned = cleanPoints(points, minDistance);
  if (cleaned.length < 2) return [];
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (closed && distance(first, last) > minDistance) {
    cleaned.push({ ...first });
  }
  return cleaned.length >= (closed ? 4 : 3) ? cleaned : [];
}

function buildCornerIndices(points, minSegmentLength, cornerAngle) {
  const corners = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (distance(previous, current) <= minSegmentLength || distance(current, next) <= minSegmentLength) continue;
    if (angleAt(previous, current, next) <= cornerAngle) corners.push(index);
  }
  return corners;
}

function simplifiedFallbackPoints(points, tolerance, minSegmentLength, { closed = false } = {}) {
  const minDistance = Math.max(minSegmentLength, 1e-6);
  const simplifyTolerance = Math.max(tolerance * 0.45, minDistance);
  const source = closed ? [...points, points[0]] : points;
  const indices = rdpOpenIndices(source, simplifyTolerance);
  const simplified = indices.map((index) => source[index]);
  return cleanSplineControlPoints(simplified, minDistance, { closed });
}

function pushFallbackSpline(result, points, tolerance, minSegmentLength, options = {}) {
  const fallback = simplifiedFallbackPoints(points, tolerance, minSegmentLength, options);
  if (fallback.length < (options.closed ? 4 : 3)) return false;
  result.splines.push(fallback);
  return true;
}

export function buildFittedTraceEntities(points, options = {}) {
  const minSegmentLength = Number.isFinite(options.minSegmentLength) ? options.minSegmentLength : 0;
  const unitPerPixel = Number.isFinite(options.unitPerPixel) ? Math.max(options.unitPerPixel, 1e-9) : 1;
  const tolerance = Number.isFinite(options.fitTolerance)
    ? Math.max(0, options.fitTolerance) * unitPerPixel
    : Math.max(minSegmentLength * 2.5, unitPerPixel * 1.2);
  const maxControls = Number.isFinite(options.fitMaxControls)
    ? Math.max(4, Math.round(options.fitMaxControls))
    : 16;
  const cornerAngle = Number.isFinite(options.fitCornerAngle)
    ? options.fitCornerAngle
    : Math.PI * 0.64;
  const cleaned = cleanPoints(points, Math.max(0, minSegmentLength * 0.25));
  const result = { segments: [], splines: [] };
  if (cleaned.length < 4) return result;

  let corners = buildCornerIndices(cleaned, Math.max(minSegmentLength, unitPerPixel * 0.5), cornerAngle);
  if (corners.length < 2) {
    const closed = [...cleaned, cleaned[0]];
    const controls = fitSplineControlPoints(closed, {
      tolerance,
      maxControls,
      minControls: Math.min(6, closed.length),
      minSegmentLength,
    });
    if (controls.length >= 4) result.splines.push(controls);
    else pushFallbackSpline(result, cleaned, tolerance, minSegmentLength, { closed: true });
    return result;
  }

  corners = corners.sort((a, b) => a - b);
  for (let index = 0; index < corners.length; index++) {
    const span = spanPoints(cleaned, corners[index], corners[(index + 1) % corners.length]);
    if (span.length < 2 || distance(span[0], span[span.length - 1]) <= minSegmentLength) continue;
    if (fitsLine(span, tolerance * 0.65)) {
      pushLine(result, span[0], span[span.length - 1], minSegmentLength);
      continue;
    }
    const controls = fitSplineControlPoints(span, {
      tolerance,
      maxControls: Math.min(maxControls, Math.max(4, Math.ceil(span.length * 0.75))),
      minControls: Math.min(4, span.length),
      minSegmentLength,
    });
    if (controls.length >= 4) result.splines.push(controls);
    else if (!pushFallbackSpline(result, span, tolerance, minSegmentLength)) {
      pushLine(result, span[0], span[span.length - 1], minSegmentLength);
    }
  }

  return result;
}

function pushLine(result, start, end, minSegmentLength) {
  if (distance(start, end) <= minSegmentLength) return;
  const previous = result.segments[result.segments.length - 1];
  if (previous && distance(previous.end, start) <= minSegmentLength * 0.5) {
    const merged = [previous.start, previous.end, end];
    if (fitsLine(merged, minSegmentLength * 0.8)) {
      previous.end = end;
      return;
    }
  }
  result.segments.push({ start, end });
}

function pushSpline(result, points, minSegmentLength, options = {}) {
  const detailDistance = Number.isFinite(options.detailDistance)
    ? Math.max(0, options.detailDistance)
    : Math.max(minSegmentLength, 1e-6);
  const spline = cleanSplineControlPoints(points, detailDistance, options);
  if (spline.length >= (options.closed ? 4 : 3)) result.splines.push(spline);
}

function emitClassifiedSpan(span, result, config) {
  const {
    lineTolerance,
    minSegmentLength,
    curveTurnThreshold,
    curveLengthRatio,
    cornerDetailRadius,
    highDetailTurn,
    curvePointDistance,
    cornerPointDistance,
  } = config;
  if (!Array.isArray(span) || span.length < 2) return;
  const start = span[0];
  const end = span[span.length - 1];
  const chordLength = distance(start, end);
  if (chordLength <= minSegmentLength) return;

  if (fitsLine(span, lineTolerance)) {
    pushLine(result, start, end, minSegmentLength);
    return;
  }

  let totalAbsTurn = 0;
  let maxAbsTurn = 0;
  for (let index = 1; index < span.length - 1; index++) {
    const turn = Math.abs(signedTurn(span[index - 1], span[index], span[index + 1]));
    totalAbsTurn += turn;
    maxAbsTurn = Math.max(maxAbsTurn, turn);
  }

  const length = spanLength(span);
  const curveLike = totalAbsTurn >= curveTurnThreshold
    || length / Math.max(chordLength, 1e-9) >= curveLengthRatio;
  if (curveLike) {
    const detailDistance = maxAbsTurn >= highDetailTurn
      ? cornerPointDistance
      : curvePointDistance;
    pushSpline(result, span, minSegmentLength, { detailDistance });
    return;
  }

  const splitIndices = rdpOpenIndices(span, lineTolerance);
  for (let i = 0; i < splitIndices.length - 1; i++) {
    const chunk = span.slice(splitIndices[i], splitIndices[i + 1] + 1);
    if (fitsLine(chunk, lineTolerance * 1.15)) {
      pushLine(result, chunk[0], chunk[chunk.length - 1], minSegmentLength);
    } else {
      pushSpline(result, chunk, minSegmentLength, { detailDistance: cornerPointDistance });
    }
  }
  if (splitIndices.length <= 1 && maxAbsTurn > 0) {
    pushSpline(result, span, minSegmentLength, { detailDistance: cornerPointDistance });
  }

  if (cornerDetailRadius > 0) {
    const detailStart = [];
    let lengthFromStart = 0;
    for (let index = 0; index < span.length; index++) {
      if (index > 0) lengthFromStart += distance(span[index - 1], span[index]);
      if (lengthFromStart > cornerDetailRadius) break;
      detailStart.push(span[index]);
    }
    if (detailStart.length >= 3 && !fitsLine(detailStart, lineTolerance * 0.5)) {
      pushSpline(result, detailStart, minSegmentLength, { detailDistance: cornerPointDistance });
    }

    const detailEnd = [];
    let lengthFromEnd = 0;
    for (let index = span.length - 1; index >= 0; index--) {
      if (index < span.length - 1) lengthFromEnd += distance(span[index + 1], span[index]);
      if (lengthFromEnd > cornerDetailRadius) break;
      detailEnd.push(span[index]);
    }
    detailEnd.reverse();
    if (detailEnd.length >= 3 && !fitsLine(detailEnd, lineTolerance * 0.5)) {
      pushSpline(result, detailEnd, minSegmentLength, { detailDistance: cornerPointDistance });
    }
  }
}

export function buildHybridTraceEntities(points, options = {}) {
  const minSegmentLength = Number.isFinite(options.minSegmentLength) ? options.minSegmentLength : 0;
  const unitPerPixel = Number.isFinite(options.unitPerPixel) ? Math.max(options.unitPerPixel, 1e-9) : 1;
  const simplifyToleranceWorld = Number.isFinite(options.simplifyTolerance)
    ? Math.max(0, options.simplifyTolerance) * unitPerPixel
    : 0;
  const edgeMode = options.detectionMode === 'edge';
  const lineTolerance = Number.isFinite(options.lineTolerance)
    ? Math.max(0, options.lineTolerance)
    : Math.max(
        minSegmentLength * (edgeMode ? 2.5 : 1.35),
        simplifyToleranceWorld * (edgeMode ? 0.7 : 0.45),
        1e-6,
      );
  const cornerAngle = Number.isFinite(options.cornerAngle)
    ? options.cornerAngle
    : Math.PI * (edgeMode ? 0.80 : 0.78);
  const curveTurnThreshold = Number.isFinite(options.curveTurnThreshold)
    ? Math.max(0, options.curveTurnThreshold)
    : Math.PI * (edgeMode ? 0.30 : 0.22);
  const curveLengthRatio = Number.isFinite(options.curveLengthRatio)
    ? Math.max(1, options.curveLengthRatio)
    : (edgeMode ? 1.025 : 1.015);
  const cornerDetailRadius = Number.isFinite(options.cornerDetailRadius)
    ? Math.max(0, options.cornerDetailRadius)
    : Math.max(minSegmentLength * 6, lineTolerance * 2.5);
  const localCornerAngle = Number.isFinite(options.localCornerAngle)
    ? options.localCornerAngle
    : Math.PI * (edgeMode ? 0.82 : 0.76);
  const localDetailTurn = Number.isFinite(options.localDetailTurn)
    ? Math.max(0, options.localDetailTurn)
    : Math.PI * (edgeMode ? 0.16 : 0.20);
  const highDetailTurn = Number.isFinite(options.highDetailTurn)
    ? Math.max(0, options.highDetailTurn)
    : Math.PI * 0.34;
  const curvePointDistance = Math.max(minSegmentLength * (edgeMode ? 0.75 : 1.0), 1e-6);
  const cornerPointDistance = Math.max(minSegmentLength * 0.35, 1e-6);
  const cleaned = cleanPoints(points, Math.max(0, minSegmentLength * 0.35));
  const result = { segments: [], splines: [] };
  if (cleaned.length < 3) return result;

  const dominantIndices = rdpClosedIndices(cleaned, lineTolerance);
  const dominant = dominantIndices.map((index) => cleaned[index]);
  const corners = [];
  for (let i = 0; i < dominantIndices.length; i++) {
    const previous = dominant[(i - 1 + dominant.length) % dominant.length];
    const current = dominant[i];
    const next = dominant[(i + 1) % dominant.length];
    const prevLength = distance(previous, current);
    const nextLength = distance(current, next);
    if (prevLength <= minSegmentLength || nextLength <= minSegmentLength) continue;
    if (angleAt(previous, current, next) <= cornerAngle) corners.push(dominantIndices[i]);
  }
  for (let index = 0; index < cleaned.length; index++) {
    const previous = cleaned[(index - 1 + cleaned.length) % cleaned.length];
    const current = cleaned[index];
    const next = cleaned[(index + 1) % cleaned.length];
    if (distance(previous, current) <= minSegmentLength || distance(current, next) <= minSegmentLength) continue;
    const angle = angleAt(previous, current, next);
    const turn = Math.abs(signedTurn(previous, current, next));
    const deviation = pointLineDistance(current, previous, next);
    if (angle > localCornerAngle && (turn < localDetailTurn || deviation < lineTolerance * 0.65)) continue;
    if (corners.some((corner) => distance(cleaned[corner], current) <= cornerDetailRadius * 0.15)) continue;
    corners.push(index);
  }

  if (corners.length < 2) {
    if (dominantIndices.length >= 3 && dominantIndices.length <= 8) {
      let emittedLines = 0;
      for (let i = 0; i < dominantIndices.length; i++) {
        const startIndex = dominantIndices[i];
        const endIndex = dominantIndices[(i + 1) % dominantIndices.length];
        const span = spanPoints(cleaned, startIndex, endIndex);
        if (fitsLine(span, lineTolerance * 1.2)) {
          pushLine(result, span[0], span[span.length - 1], minSegmentLength);
          emittedLines++;
        }
      }
      if (emittedLines >= 3) return result;
    }
    pushSpline(result, cleaned, minSegmentLength, { closed: true });
    return result;
  }

  corners.sort((a, b) => a - b);
  for (let cursor = 0; cursor < corners.length; cursor++) {
    const startIndex = corners[cursor];
    const endIndex = corners[(cursor + 1) % corners.length];
    const span = spanPoints(cleaned, startIndex, endIndex);
    emitClassifiedSpan(span, result, {
      lineTolerance,
      minSegmentLength,
      curveTurnThreshold,
      curveLengthRatio,
      cornerDetailRadius,
      highDetailTurn,
      curvePointDistance,
      cornerPointDistance,
    });
  }

  return result;
}
