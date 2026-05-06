// js/cad/ConstraintAnalysis.js — lightweight sketch constraint state analysis

function _isCircleLike(shape) {
  return !!shape && (shape.type === 'circle' || shape.type === 'arc') && typeof shape.radius === 'number';
}

/**
 * Estimate which sketch points and primitives are fully constrained.
 * This is intentionally conservative: entities are marked fully constrained only
 * when all of their geometric degrees of freedom are known from fixed points and
 * dimensional/topological constraints.
 */
export function computeFullyConstrained(scene) {
  const ps = new Map();
  for (const pt of scene.points || []) {
    ps.set(pt, {
      xLock: !!pt.fixed,
      yLock: !!pt.fixed,
      radials: new Set(),
      onFCLine: false,
    });
  }
  if (scene._originPoint) {
    for (const rp of [scene._originPoint, scene._xAxisLine && scene._xAxisLine.p2, scene._yAxisLine && scene._yAxisLine.p2]) {
      if (rp && !ps.has(rp)) ps.set(rp, { xLock: true, yLock: true, radials: new Set(), onFCLine: false });
    }
  }

  const ss = new Map();
  for (const seg of scene.segments || []) ss.set(seg, { dirKnown: false, lenKnown: false });
  if (scene._xAxisLine && !ss.has(scene._xAxisLine)) ss.set(scene._xAxisLine, { dirKnown: true, lenKnown: true });
  if (scene._yAxisLine && !ss.has(scene._yAxisLine)) ss.set(scene._yAxisLine, { dirKnown: true, lenKnown: true });

  const cs = new Map();
  for (const circ of scene.circles || []) cs.set(circ, { radiusKnown: false });
  for (const arc of scene.arcs || []) cs.set(arc, { radiusKnown: false });

  const isFC = (s) => {
    if (!s) return false;
    if (s.xLock && s.yLock) return true;
    const axes = (s.xLock ? 1 : 0) + (s.yLock ? 1 : 0);
    if (axes >= 1 && (s.radials.size >= 1 || s.onFCLine)) return true;
    if (s.radials.size >= 2) return true;
    if (s.onFCLine && s.radials.size >= 1) return true;
    return false;
  };
  const markFC = (s) => {
    if (!s) return false;
    let ch = false;
    if (!s.xLock) { s.xLock = true; ch = true; }
    if (!s.yLock) { s.yLock = true; ch = true; }
    return ch;
  };

  let changed = true;
  let safety = 100;
  while (changed && safety-- > 0) {
    changed = false;

    for (const c of scene.constraints || []) {
      switch (c.type) {
        case 'fixed': {
          const sp = ps.get(c.pt);
          if (sp && markFC(sp)) changed = true;
          break;
        }
        case 'parallel':
        case 'perpendicular': {
          const siA = ss.get(c.segA), siB = ss.get(c.segB);
          if (siA && siB) {
            if (siA.dirKnown && !siB.dirKnown) { siB.dirKnown = true; changed = true; }
            if (siB.dirKnown && !siA.dirKnown) { siA.dirKnown = true; changed = true; }
          }
          break;
        }
        case 'horizontal':
        case 'vertical': {
          const si = ss.get(c.seg);
          if (si && !si.dirKnown) { si.dirKnown = true; changed = true; }
          break;
        }
        case 'coincident': {
          const sa = ps.get(c.ptA), sb = ps.get(c.ptB);
          if (sa && sb) {
            if (isFC(sa) && !isFC(sb) && markFC(sb)) changed = true;
            if (isFC(sb) && !isFC(sa) && markFC(sa)) changed = true;
          }
          break;
        }
        case 'angle': {
          const siA = ss.get(c.segA), siB = ss.get(c.segB);
          if (siA && siB) {
            if (siA.dirKnown && !siB.dirKnown) { siB.dirKnown = true; changed = true; }
            if (siB.dirKnown && !siA.dirKnown) { siA.dirKnown = true; changed = true; }
          }
          break;
        }
        case 'length': {
          const si = ss.get(c.seg);
          if (si && !si.lenKnown) { si.lenKnown = true; changed = true; }
          break;
        }
        case 'radius': {
          const ci = cs.get(c.shape);
          if (ci && !ci.radiusKnown) { ci.radiusKnown = true; changed = true; }
          break;
        }
        case 'equal_length': {
          if (_isCircleLike(c.segA) && _isCircleLike(c.segB)) {
            const ciA = cs.get(c.segA), ciB = cs.get(c.segB);
            if (ciA && ciB) {
              if (ciA.radiusKnown && !ciB.radiusKnown) { ciB.radiusKnown = true; changed = true; }
              if (ciB.radiusKnown && !ciA.radiusKnown) { ciA.radiusKnown = true; changed = true; }
            }
          } else {
            const siA = ss.get(c.segA), siB = ss.get(c.segB);
            if (siA && siB) {
              if (siA.lenKnown && !siB.lenKnown) { siB.lenKnown = true; changed = true; }
              if (siB.lenKnown && !siA.lenKnown) { siA.lenKnown = true; changed = true; }
            }
          }
          break;
        }
        case 'distance': {
          const sa = ps.get(c.ptA), sb = ps.get(c.ptB);
          if (sa && sb) {
            if (isFC(sa) && !sb.radials.has(c.ptA)) { sb.radials.add(c.ptA); changed = true; }
            if (isFC(sb) && !sa.radials.has(c.ptB)) { sa.radials.add(c.ptB); changed = true; }
          }
          for (const seg of scene.segments || []) {
            const si = ss.get(seg);
            if (!si || si.lenKnown) continue;
            if ((seg.p1 === c.ptA && seg.p2 === c.ptB) || (seg.p1 === c.ptB && seg.p2 === c.ptA)) {
              si.lenKnown = true; changed = true;
            }
          }
          break;
        }
        case 'on_line': {
          const sp = ps.get(c.pt);
          const s1 = ps.get(c.seg?.p1), s2 = ps.get(c.seg?.p2);
          if (sp && s1 && s2 && isFC(s1) && isFC(s2) && !sp.onFCLine) {
            sp.onFCLine = true; changed = true;
          }
          break;
        }
        case 'on_circle': {
          const sp = ps.get(c.pt), sc = ps.get(c.circle?.center), ci = cs.get(c.circle);
          if (sp && sc && ci?.radiusKnown && isFC(sc) && !sp.radials.has(c.circle.center)) {
            sp.radials.add(c.circle.center); changed = true;
          }
          break;
        }
        case 'midpoint': {
          const sp = ps.get(c.pt);
          const s1 = ps.get(c.seg?.p1), s2 = ps.get(c.seg?.p2);
          if (sp && s1 && s2) {
            if (isFC(s1) && isFC(s2) && !isFC(sp) && markFC(sp)) changed = true;
            if (isFC(sp) && isFC(s1) && !isFC(s2) && markFC(s2)) changed = true;
            if (isFC(sp) && isFC(s2) && !isFC(s1) && markFC(s1)) changed = true;
          }
          break;
        }
        default: break;
      }

      if (c.type === 'dimension' && c.isConstraint && c.sourceA) {
        if (c.dimType === 'distance' && c.sourceA.type === 'point' && c.sourceB?.type === 'point') {
          const sa = ps.get(c.sourceA), sb = ps.get(c.sourceB);
          if (sa && sb) {
            if (isFC(sa) && !sb.radials.has(c.sourceA)) { sb.radials.add(c.sourceA); changed = true; }
            if (isFC(sb) && !sa.radials.has(c.sourceB)) { sa.radials.add(c.sourceB); changed = true; }
          }
        } else if (c.dimType === 'distance' && c.sourceA.type === 'segment' && !c.sourceB) {
          const si = ss.get(c.sourceA);
          if (si && !si.lenKnown) { si.lenKnown = true; changed = true; }
        } else if ((c.dimType === 'radius' || c.dimType === 'diameter') && _isCircleLike(c.sourceA)) {
          const ci = cs.get(c.sourceA);
          if (ci && !ci.radiusKnown) { ci.radiusKnown = true; changed = true; }
        } else if (c.dimType === 'angle' && c.sourceA.type === 'segment' && c.sourceB?.type === 'segment') {
          const siA = ss.get(c.sourceA), siB = ss.get(c.sourceB);
          if (siA && siB) {
            if (siA.dirKnown && !siB.dirKnown) { siB.dirKnown = true; changed = true; }
            if (siB.dirKnown && !siA.dirKnown) { siA.dirKnown = true; changed = true; }
          }
        }
      }
    }

    for (const seg of scene.segments || []) {
      const si = ss.get(seg);
      if (!si) continue;
      const s1 = ps.get(seg.p1), s2 = ps.get(seg.p2);
      if (!s1 || !s2) continue;
      if (si.dirKnown && si.lenKnown) {
        if (isFC(s1) && !isFC(s2) && markFC(s2)) changed = true;
        if (isFC(s2) && !isFC(s1) && markFC(s1)) changed = true;
      }
      if (si.lenKnown && !si.dirKnown) {
        if (isFC(s1) && !s2.radials.has(seg.p1)) { s2.radials.add(seg.p1); changed = true; }
        if (isFC(s2) && !s1.radials.has(seg.p2)) { s1.radials.add(seg.p2); changed = true; }
      }
    }
  }

  const fcPoints = new Set();
  for (const [pt, s] of ps) if (isFC(s)) fcPoints.add(pt);
  const fcEntities = new Set();
  for (const seg of scene.segments || []) {
    if (fcPoints.has(seg.p1) && fcPoints.has(seg.p2)) fcEntities.add(seg);
  }
  for (const circ of scene.circles || []) {
    if (fcPoints.has(circ.center) && cs.get(circ)?.radiusKnown) fcEntities.add(circ);
  }
  for (const arc of scene.arcs || []) {
    if (fcPoints.has(arc.center) && fcPoints.has(arc.startPoint) && fcPoints.has(arc.endPoint)) fcEntities.add(arc);
  }
  for (const spl of scene.splines || []) {
    if (spl.points.every(p => fcPoints.has(p))) fcEntities.add(spl);
  }
  for (const bez of scene.beziers || []) {
    if (bez.points.every(p => fcPoints.has(p))) fcEntities.add(bez);
  }

  return { points: fcPoints, entities: fcEntities, circleStates: cs };
}
