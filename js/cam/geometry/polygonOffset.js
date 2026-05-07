const EPSILON = 1e-9;

export function polygonArea(points) {
  const loop = cleanLoop(points);
  let area = 0;
  for (let index = 0; index < loop.length; index++) {
    const a = loop[index];
    const b = loop[(index + 1) % loop.length];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return area * 0.5;
}

export function cleanLoop(points) {
  if (!Array.isArray(points)) return [];
  const loop = [];
  for (const point of points) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const previous = loop[loop.length - 1];
    if (previous && Math.hypot(previous.x - x, previous.y - y) <= EPSILON) continue;
    loop.push({ x, y });
  }
  if (loop.length > 1) {
    const first = loop[0];
    const last = loop[loop.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) loop.pop();
  }
  return loop;
}

export function offsetPolygon(points, distance) {
  const loop = cleanLoop(points);
  if (loop.length < 3) return [];
  if (Math.abs(distance) <= EPSILON) return loop.map((point) => ({ ...point }));

  const area = polygonArea(loop);
  if (Math.abs(area) <= EPSILON) return [];
  const outwardSign = area > 0 ? 1 : -1;

  const lines = [];
  for (let index = 0; index < loop.length; index++) {
    const a = loop[index];
    const b = loop[(index + 1) % loop.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= EPSILON) return [];
    const nx = outwardSign * dy / len;
    const ny = -outwardSign * dx / len;
    lines.push({
      point: { x: a.x + nx * distance, y: a.y + ny * distance },
      dir: { x: dx / len, y: dy / len },
      normal: { x: nx, y: ny },
    });
  }

  const result = [];
  for (let index = 0; index < loop.length; index++) {
    const previous = lines[(index - 1 + lines.length) % lines.length];
    const current = lines[index];
    const point = intersectLines(previous, current) || averagedCorner(loop[index], previous, current, distance);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    result.push(point);
  }

  const cleaned = cleanLoop(result);
  if (cleaned.length < 3) return [];
  const newArea = polygonArea(cleaned);
  if (Math.abs(newArea) <= EPSILON || Math.sign(newArea) !== Math.sign(area)) return [];
  if (distance < -EPSILON) {
    if (Math.abs(newArea) >= Math.abs(area) - EPSILON) return [];
    if (!cleaned.every((point) => pointInsideOrOnPolygon(point, loop))) return [];
  }
  return cleaned;
}

function pointInsideOrOnPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
    const a = polygon[index];
    const b = polygon[previousIndex];
    if (pointOnSegment(point, a, b)) return true;
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const cross = abx * apy - aby * apx;
  if (Math.abs(cross) > EPSILON) return false;
  const dot = apx * abx + apy * aby;
  if (dot < -EPSILON) return false;
  const lenSq = abx * abx + aby * aby;
  return dot <= lenSq + EPSILON;
}

function intersectLines(a, b) {
  const cross = a.dir.x * b.dir.y - a.dir.y * b.dir.x;
  if (Math.abs(cross) <= EPSILON) return null;
  const dx = b.point.x - a.point.x;
  const dy = b.point.y - a.point.y;
  const t = (dx * b.dir.y - dy * b.dir.x) / cross;
  return {
    x: a.point.x + a.dir.x * t,
    y: a.point.y + a.dir.y * t,
  };
}

function averagedCorner(original, previous, current, distance) {
  const nx = previous.normal.x + current.normal.x;
  const ny = previous.normal.y + current.normal.y;
  const len = Math.hypot(nx, ny);
  if (len <= EPSILON) return null;
  return {
    x: original.x + (nx / len) * distance,
    y: original.y + (ny / len) * distance,
  };
}
