// js/svg/export.js — Export sketch geometry as SVG with native bezier/spline support
import { state } from '../state.js';
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
        // Export B-spline by tessellating to polyline (SVG has no native B-spline)
        const pts = ent.tessellate2D(64);
        if (pts.length < 2) break;
        let d = `M ${pts[0].x} ${-pts[0].y}`;
        for (let i = 1; i < pts.length; i++) {
          d += ` L ${pts[i].x} ${-pts[i].y}`;
        }
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
