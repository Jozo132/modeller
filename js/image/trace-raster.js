function computeOtsuThreshold(histogram, total) {
  let sum = 0;
  for (let index = 0; index < histogram.length; index++) {
    sum += index * histogram[index];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;

  for (let index = 0; index < histogram.length; index++) {
    weightBackground += histogram[index];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += index * histogram[index];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const meanDelta = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * meanDelta * meanDelta;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = index;
    }
  }

  return threshold;
}

function clampByte(value, fallback = 0) {
  const resolved = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(255, Math.round(resolved)));
}

function parseThresholdLevels(value) {
  if (Array.isArray(value)) {
    return value.map((level) => clampByte(Number(level), NaN)).filter(Number.isFinite);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => clampByte(Number(token), NaN))
    .filter(Number.isFinite);
}

export function normalizeTraceOptions(options = {}) {
  const thresholdLevels = parseThresholdLevels(options.thresholdLevels ?? options.thresholds);
  const thresholdMode = options.thresholdMode === 'manual' || thresholdLevels.length > 0 ? 'manual' : 'auto';
  const detectionMode = options.detectionMode === 'edge' ? 'edge' : 'contour';
  const curveMode = options.curveMode === 'spline' || options.curveMode === 'hybrid' || options.curveMode === 'fitting'
    ? options.curveMode
    : 'straight';
  return {
    minAlpha: Number.isFinite(options.minAlpha) ? Math.max(0, Math.min(255, options.minAlpha)) : 16,
    thresholdMode,
    threshold: clampByte(options.threshold, 127),
    thresholdLevels,
    invert: options.invert === true,
    detectionMode,
    edgeThreshold: Number.isFinite(options.edgeThreshold) ? Math.max(1, Math.min(255, options.edgeThreshold)) : 72,
    minSpeckArea: Number.isFinite(options.minSpeckArea) ? Math.max(0, Math.round(options.minSpeckArea)) : 0,
    minArea: Number.isFinite(options.minArea) ? Math.max(0, options.minArea) : 8,
    simplifyTolerance: Number.isFinite(options.simplifyTolerance) ? Math.max(0, options.simplifyTolerance) : 1.25,
    fitTolerance: Number.isFinite(options.fitTolerance) ? Math.max(0, options.fitTolerance) : 1.2,
    fitMaxControls: Number.isFinite(options.fitMaxControls) ? Math.max(4, Math.round(options.fitMaxControls)) : 16,
    curveMode,
  };
}

function buildGrayscaleFromRgba(data, width, height, minAlpha) {
  const histogram = new Array(256).fill(0);
  const grayscale = new Uint8Array(width * height);
  const alphaMask = new Uint8Array(width * height);
  let populated = 0;

  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    const alpha = data[offset + 3];
    if (alpha < minAlpha) {
      grayscale[index] = 255;
      continue;
    }
    const value = Math.round(
      data[offset] * 0.2126
      + data[offset + 1] * 0.7152
      + data[offset + 2] * 0.0722,
    );
    grayscale[index] = value;
    alphaMask[index] = 1;
    histogram[value] += 1;
    populated += 1;
  }

  return { grayscale, alphaMask, histogram, populated };
}

function buildMaskFromRgba(data, width, height, options = {}) {
  const traceOptions = normalizeTraceOptions(options);
  const { grayscale, alphaMask, histogram, populated } = buildGrayscaleFromRgba(data, width, height, traceOptions.minAlpha);

  if (populated === 0) {
    return { mask: new Uint8Array(width * height), threshold: 255, inverted: false };
  }

  const threshold = traceOptions.thresholdMode === 'manual'
    ? traceOptions.threshold
    : computeOtsuThreshold(histogram, populated);
  const invert = traceOptions.thresholdMode === 'manual' ? traceOptions.invert : null;
  const mask = buildThresholdMask(grayscale, alphaMask, width, height, threshold, invert, populated);
  return { mask: filterSmallSpecks(mask, width, height, traceOptions.minSpeckArea), threshold, inverted: !!invert };
}

function buildThresholdMask(grayscale, alphaMask, width, height, threshold, invert, populated = null) {
  const darkMask = new Uint8Array(width * height);
  let darkCount = 0;
  for (let index = 0; index < width * height; index++) {
    if (!alphaMask[index]) continue;
    if (grayscale[index] <= threshold) {
      darkMask[index] = 1;
      darkCount += 1;
    }
  }

  const shouldInvert = invert == null ? darkCount > (populated ?? width * height) * 0.5 : invert;
  if (!shouldInvert) return darkMask;

  const lightMask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index++) {
    if (!alphaMask[index]) continue;
    if (grayscale[index] >= threshold) lightMask[index] = 1;
  }
  return lightMask;
}

function buildEdgeMaskFromRgba(data, width, height, options = {}) {
  const traceOptions = normalizeTraceOptions(options);
  const { grayscale, alphaMask } = buildGrayscaleFromRgba(data, width, height, traceOptions.minAlpha);
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (!alphaMask[index]) continue;
      const tl = grayscale[(y - 1) * width + x - 1];
      const tc = grayscale[(y - 1) * width + x];
      const tr = grayscale[(y - 1) * width + x + 1];
      const ml = grayscale[y * width + x - 1];
      const mr = grayscale[y * width + x + 1];
      const bl = grayscale[(y + 1) * width + x - 1];
      const bc = grayscale[(y + 1) * width + x];
      const br = grayscale[(y + 1) * width + x + 1];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      if (Math.min(255, Math.hypot(gx, gy) / 4) >= traceOptions.edgeThreshold) {
        mask[index] = 1;
      }
    }
  }
  return {
    mask: filterSmallSpecks(mask, width, height, traceOptions.minSpeckArea),
    threshold: traceOptions.edgeThreshold,
    inverted: false,
  };
}

function filterSmallSpecks(mask, width, height, minSpeckArea) {
  if (!minSpeckArea || minSpeckArea <= 1) return mask;
  const result = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const queue = [];
  const component = [];
  for (let start = 0; start < mask.length; start++) {
    if (!result[start] || visited[start]) continue;
    queue.length = 0;
    component.length = 0;
    queue.push(start);
    visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const next of neighbors) {
        if (next < 0 || visited[next] || !result[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    if (component.length < minSpeckArea) {
      for (const index of component) result[index] = 0;
    }
  }
  return result;
}

function directionCode(segment) {
  const dx = segment.bx - segment.ax;
  const dy = segment.by - segment.ay;
  if (dx > 0) return 0;
  if (dy > 0) return 1;
  if (dx < 0) return 2;
  return 3;
}

function chooseNextSegment(candidates, previousDirection) {
  if (candidates.length <= 1) {
    return candidates[0] || null;
  }
  const preferences = {
    0: [1, 0, 3, 2],
    1: [2, 1, 0, 3],
    2: [3, 2, 1, 0],
    3: [0, 3, 2, 1],
  };
  const order = preferences[previousDirection] || [0, 1, 2, 3];
  for (const direction of order) {
    const match = candidates.find((segment) => directionCode(segment) === direction);
    if (match) return match;
  }
  return candidates[0];
}

function pointKey(x, y) {
  return `${x},${y}`;
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) * 0.5;
}

function removeDuplicateEndpoint(points) {
  if (points.length < 2) return points.slice();
  const result = points.slice();
  const first = result[0];
  const last = result[result.length - 1];
  if (first.x === last.x && first.y === last.y) {
    result.pop();
  }
  return result;
}

function collapseStraightRuns(points) {
  if (points.length <= 3) return points.slice();
  const result = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const dx1 = Math.sign(current.x - previous.x);
    const dy1 = Math.sign(current.y - previous.y);
    const dx2 = Math.sign(next.x - current.x);
    const dy2 = Math.sign(next.y - current.y);
    if (dx1 === dx2 && dy1 === dy2) continue;
    result.push(current);
  }
  return result.length >= 3 ? result : points.slice();
}

function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) <= 1e-9 && Math.abs(dy) <= 1e-9) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / Math.hypot(dx, dy);
}

function simplifyOpenPolyline(points, tolerance) {
  if (points.length <= 2) return points.slice();
  let maxDistance = -1;
  let splitIndex = -1;
  for (let index = 1; index < points.length - 1; index++) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = index;
    }
  }
  if (maxDistance <= tolerance || splitIndex < 0) {
    return [points[0], points[points.length - 1]];
  }
  const left = simplifyOpenPolyline(points.slice(0, splitIndex + 1), tolerance);
  const right = simplifyOpenPolyline(points.slice(splitIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyClosedPolygon(points, tolerance) {
  if (points.length <= 3 || tolerance <= 0) return points.slice();
  const open = [...points, points[0]];
  const simplified = simplifyOpenPolyline(open, tolerance);
  const result = removeDuplicateEndpoint(simplified);
  return result.length >= 3 ? result : points.slice();
}

function traceMaskContours(mask, width, height) {
  const segments = [];
  const startMap = new Map();

  function addSegment(ax, ay, bx, by) {
    const segment = { id: segments.length, ax, ay, bx, by };
    segments.push(segment);
    const key = pointKey(ax, ay);
    const bucket = startMap.get(key);
    if (bucket) {
      bucket.push(segment);
    } else {
      startMap.set(key, [segment]);
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (y === 0 || !mask[(y - 1) * width + x]) addSegment(x, y, x + 1, y);
      if (x === width - 1 || !mask[y * width + x + 1]) addSegment(x + 1, y, x + 1, y + 1);
      if (y === height - 1 || !mask[(y + 1) * width + x]) addSegment(x + 1, y + 1, x, y + 1);
      if (x === 0 || !mask[y * width + x - 1]) addSegment(x, y + 1, x, y);
    }
  }

  const remaining = new Set(segments.map((segment) => segment.id));
  const contours = [];
  while (remaining.size > 0) {
    const firstId = remaining.values().next().value;
    let current = segments[firstId];
    remaining.delete(current.id);
    const contour = [{ x: current.ax, y: current.ay }];
    let guard = 0;
    while (guard < segments.length + 4) {
      guard += 1;
      contour.push({ x: current.bx, y: current.by });
      if (current.bx === contour[0].x && current.by === contour[0].y) {
        break;
      }
      const nextCandidates = (startMap.get(pointKey(current.bx, current.by)) || [])
        .filter((candidate) => remaining.has(candidate.id) && !(candidate.bx === current.ax && candidate.by === current.ay));
      if (nextCandidates.length === 0) {
        break;
      }
      current = chooseNextSegment(nextCandidates, directionCode(current));
      remaining.delete(current.id);
    }
    const cleaned = collapseStraightRuns(removeDuplicateEndpoint(contour));
    if (cleaned.length >= 3) {
      contours.push(cleaned);
    }
  }
  return contours;
}

export function traceImageDataContours(data, width, height, options = {}) {
  if (!(data instanceof Uint8ClampedArray) || width <= 0 || height <= 0) {
    return [];
  }
  const traceOptions = normalizeTraceOptions(options);
  const maskResults = [];
  if (traceOptions.detectionMode === 'edge') {
    maskResults.push(buildEdgeMaskFromRgba(data, width, height, traceOptions));
  } else if (traceOptions.thresholdMode === 'manual' && traceOptions.thresholdLevels.length > 0) {
    const { grayscale, alphaMask, populated } = buildGrayscaleFromRgba(data, width, height, traceOptions.minAlpha);
    for (const threshold of traceOptions.thresholdLevels) {
      const mask = buildThresholdMask(grayscale, alphaMask, width, height, threshold, traceOptions.invert, populated);
      maskResults.push({
        mask: filterSmallSpecks(mask, width, height, traceOptions.minSpeckArea),
        threshold,
        inverted: traceOptions.invert,
      });
    }
  } else {
    maskResults.push(buildMaskFromRgba(data, width, height, traceOptions));
  }

  const contours = maskResults.flatMap(({ mask }) => traceMaskContours(mask, width, height));
  return contours
    .map((points) => simplifyClosedPolygon(points, traceOptions.simplifyTolerance))
    .filter((points) => points.length >= 3 && polygonArea(points) >= traceOptions.minArea);
}
