// js/svg/export.js — Export sketch geometry as SVG with native bezier/spline support
import { state } from '../state.js';
import { NurbsCurve } from '../cad/NurbsCurve.js';
import { info, debug } from '../logger.js';

/**
 * Export the current sketch scene as an SVG string.
 * Lines, arcs, circles, splines, and beziers are all represented natively.
 * @returns {string} SVG content
 */
export function exportSVG() {
  const scene = state.scene;
  const entities = [...scene.shapes()];
  info('SVG export started', { entities: entities.length });

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ent of entities) {
    if (ent.construction || !ent.visible) continue;
    const b = ent.getBounds();
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }

  const margin = 5;
  const vbX = minX - margin;
  const vbY = minY - margin;
  const vbW = (maxX - minX) + margin * 2;
  const vbH = (maxY - minY) + margin * 2;

  const paths = [];

  for (const ent of entities) {
    if (ent.construction || !ent.visible) continue;

    switch (ent.type) {
      case 'segment': {
        const { p1, p2 } = ent;
        paths.push(`<line x1="${p1.x}" y1="${-p1.y}" x2="${p2.x}" y2="${-p2.y}" stroke="black" stroke-width="0.5" fill="none"/>`);
        break;
      }
      case 'circle': {
        const { center, radius } = ent;
        paths.push(`<circle cx="${center.x}" cy="${-center.y}" r="${radius}" stroke="black" stroke-width="0.5" fill="none"/>`);
        break;
      }
      case 'arc': {
        const { center, radius, startAngle, endAngle } = ent;
        const sx = center.x + Math.cos(startAngle) * radius;
        const sy = center.y + Math.sin(startAngle) * radius;
        const ex = center.x + Math.cos(endAngle) * radius;
        const ey = center.y + Math.sin(endAngle) * radius;
        let sweep = endAngle - startAngle;
        if (sweep < 0) sweep += Math.PI * 2;
        const largeArc = sweep > Math.PI ? 1 : 0;
        // SVG arc: sweep=1 means clockwise in SVG coords (which is Y-down)
        paths.push(`<path d="M ${sx} ${-sy} A ${radius} ${radius} 0 ${largeArc} 0 ${ex} ${-ey}" stroke="black" stroke-width="0.5" fill="none"/>`);
        break;
      }
      case 'spline': {
        const d = splineToSvgPathData(ent);
        if (!d) throw new Error('SVG export requires exact spline decomposition');
        paths.push(`<path d="${d}" stroke="black" stroke-width="0.5" fill="none"/>`);
        break;
      }
      case 'bezier': {
        // Export as native SVG cubic/quadratic bezier path commands
        let d = '';
        for (let si = 0; si < ent.segmentCount; si++) {
          const v0 = ent.vertices[si];
          const v1 = ent.vertices[si + 1];
          const p0 = v0.point, p3 = v1.point;
          const ho = v0.handleOut;
          const hi = v1.handleIn;

          if (si === 0) d += `M ${p0.x} ${-p0.y}`;

          if (ho && hi) {
            // Cubic bezier
            const c1x = p0.x + ho.dx, c1y = p0.y + ho.dy;
            const c2x = p3.x + hi.dx, c2y = p3.y + hi.dy;
            d += ` C ${c1x} ${-c1y} ${c2x} ${-c2y} ${p3.x} ${-p3.y}`;
          } else if (ho) {
            // Quadratic bezier (only out handle)
            const cx = p0.x + ho.dx, cy = p0.y + ho.dy;
            d += ` Q ${cx} ${-cy} ${p3.x} ${-p3.y}`;
          } else if (hi) {
            // Quadratic bezier (only in handle)
            const cx = p3.x + hi.dx, cy = p3.y + hi.dy;
            d += ` Q ${cx} ${-cy} ${p3.x} ${-p3.y}`;
          } else {
            // Linear
            d += ` L ${p3.x} ${-p3.y}`;
          }
        }
        if (d) paths.push(`<path d="${d}" stroke="black" stroke-width="0.5" fill="none"/>`);
        break;
      }
    }
  }

  // Note: SVG Y-axis is flipped (positive down), so we negate Y in output
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${-maxY - margin} ${vbW} ${vbH}" width="${vbW}mm" height="${vbH}mm">`,
    ...paths,
    `</svg>`,
  ].join('\n');

  debug('SVG export complete', { bytes: svg.length });
  return svg;
}

/**
 * Trigger browser download of SVG file.
 */
export function downloadSVG(filename = 'sketch.svg') {
  const svgContent = exportSVG();
  const blob = new Blob([svgContent], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  info('SVG file downloaded', { filename });
}

function splineToSvgPathData(entity) {
  if (!entity || typeof entity._knotVector !== 'function' || !Array.isArray(entity.points) || entity.points.length < 2) {
    return '';
  }
  const { knots, degree } = entity._knotVector();
  const curve = new NurbsCurve(
    degree,
    entity.points.map((point) => ({ x: point.x, y: point.y, z: 0 })),
    knots,
  );
  const spans = decomposeToBezierSpans(curve);
  if (spans.length === 0) return '';
  const firstPoint = spans[0].controlPoints?.[0];
  if (!firstPoint) return '';

  let d = `M ${firstPoint.x} ${-firstPoint.y}`;
  for (const span of spans) {
    if (span.weights?.some((weight) => Math.abs((weight ?? 1) - 1) > 1e-9)) {
      return '';
    }
    const cps = span.controlPoints || [];
    if (span.degree === 1 && cps.length === 2) {
      d += ` L ${cps[1].x} ${-cps[1].y}`;
    } else if (span.degree === 2 && cps.length === 3) {
      d += ` Q ${cps[1].x} ${-cps[1].y} ${cps[2].x} ${-cps[2].y}`;
    } else if (span.degree === 3 && cps.length === 4) {
      d += ` C ${cps[1].x} ${-cps[1].y} ${cps[2].x} ${-cps[2].y} ${cps[3].x} ${-cps[3].y}`;
    } else {
      return '';
    }
  }
  return d;
}

function decomposeToBezierSpans(curve) {
  const splitKnots = uniqueInteriorKnots(curve);
  let spans = [curve.clone()];
  for (const knot of splitKnots) {
    const nextSpans = [];
    for (const span of spans) {
      if (knot <= span.uMin + 1e-9 || knot >= span.uMax - 1e-9) {
        nextSpans.push(span);
        continue;
      }
      const split = span.splitAt(knot);
      if (!split) {
        nextSpans.push(span);
        continue;
      }
      nextSpans.push(split[0], split[1]);
    }
    spans = nextSpans;
  }
  return spans;
}

function uniqueInteriorKnots(curve) {
  const knots = [];
  for (let i = curve.degree + 1; i < curve.controlPoints.length; i++) {
    const knot = curve.knots[i];
    if (knot <= curve.uMin + 1e-9 || knot >= curve.uMax - 1e-9) continue;
    if (knots.length === 0 || Math.abs(knots[knots.length - 1] - knot) > 1e-9) knots.push(knot);
  }
  return knots;
}
