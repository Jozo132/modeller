import {
  vec3Sub,
  vec3Add,
  vec3Scale,
  vec3Dot,
  vec3Len,
  vec3Normalize,
  vec3Lerp,
  edgeVKey,
  edgeKeyFromVerts,
} from './toolkit/Vec3Utils.js';

import {
  edgeKey,
  pointOnSegmentStrict,
} from './toolkit/GeometryUtils.js';

import { chainEdgePaths } from './toolkit/EdgePathUtils.js';

import { coplanarFacesTouch } from './toolkit/CoplanarUtils.js';

export function assignCoplanarFaceGroups(faces) {
  // Build a plane key for grouping: quantized normal + plane distance
  function planeKey(normal, vertices) {
    const quantize = (value) => {
      return Math.abs(value) < 1e-10 ? 0 : Math.round(value * 1e4);
    };
    const n = vec3Normalize(normal);
    // Ensure consistent normal direction (flip so largest component is positive)
    let sign = 1;
    if (Math.abs(n.z) > Math.abs(n.x) && Math.abs(n.z) > Math.abs(n.y)) {
      sign = n.z < 0 ? -1 : 1;
    } else if (Math.abs(n.y) > Math.abs(n.x)) {
      sign = n.y < 0 ? -1 : 1;
    } else {
      sign = n.x < 0 ? -1 : 1;
    }
    const nx = quantize(n.x * sign);
    const ny = quantize(n.y * sign);
    const nz = quantize(n.z * sign);
    const d = quantize(vec3Dot(vertices[0], n) * sign);
    return `${nx},${ny},${nz}|${d}`;
  }

  const SMOOTH_COS = Math.cos(15 * Math.PI / 180); // same as feature edge threshold

  // Default: every face is its own group, not curved
  for (let fi = 0; fi < faces.length; fi++) {
    faces[fi].faceGroup = fi;
    faces[fi].isCurved = false;
  }

  // --- Planar face grouping (existing logic) ---
  const planeGroups = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (face.faceType && !face.faceType.startsWith('planar')) continue;
    if (face.vertices.length < 3) continue;

    const key = planeKey(face.normal, face.vertices);
    if (!planeGroups.has(key)) {
      planeGroups.set(key, []);
    }
    planeGroups.get(key).push(fi);
  }

  // Union-find helpers (shared for both planar and curved grouping)
  const parent = {};
  for (let fi = 0; fi < faces.length; fi++) parent[fi] = fi;
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function unite(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Fast path: pre-unite faces sharing the same STEP topoFaceId so that
  // the expensive O(n²) coplanarFacesTouch analysis is skipped for them.
  const topoRep = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const tid = faces[fi].topoFaceId;
    if (tid !== undefined) {
      if (topoRep.has(tid)) unite(fi, topoRep.get(tid));
      else topoRep.set(tid, fi);
    }
  }

  for (const [, group] of planeGroups) {
    if (group.length <= 1) continue;

    const vertexFaces = new Map();
    for (const fi of group) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const key = `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)},${Math.round(v.z * 1e6)}`;
        if (!vertexFaces.has(key)) vertexFaces.set(key, []);
        vertexFaces.get(key).push(fi);
      }
    }

    for (const [, faceIds] of vertexFaces) {
      for (let i = 1; i < faceIds.length; i++) {
        unite(faceIds[0], faceIds[i]);
      }
    }

    // Post-boolean planar fragments often meet via split edges/T-junctions
    // without sharing all corner vertices. Merge same-plane faces when any
    // vertex lies on another face's edge or when collinear edges overlap.
    for (let gi = 0; gi < group.length - 1; gi++) {
      const fa = faces[group[gi]];
      for (let gj = gi + 1; gj < group.length; gj++) {
        if (find(group[gi]) === find(group[gj])) continue; // already merged
        const fb = faces[group[gj]];
        if (coplanarFacesTouch(fa, fb)) unite(group[gi], group[gj]);
      }
    }
  }

  // --- Curved face grouping: merge non-planar faces connected by smooth edges ---
  function vKey(v) { return `${Math.round(v.x * 1e6)},${Math.round(v.y * 1e6)},${Math.round(v.z * 1e6)}`; }
  function eKey(a, b) {
    const ax = Math.round(a.x * 1e6), ay = Math.round(a.y * 1e6), az = Math.round(a.z * 1e6);
    const bx = Math.round(b.x * 1e6), by = Math.round(b.y * 1e6), bz = Math.round(b.z * 1e6);
    if (ax < bx || (ax === bx && (ay < by || (ay === by && az < bz)))) {
      return `${ax},${ay},${az}|${bx},${by},${bz}`;
    }
    return `${bx},${by},${bz}|${ax},${ay},${az}`;
  }

  // Build edge → face indices map
  const edgeFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const key = eKey(verts[i], verts[(i + 1) % verts.length]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(fi);
    }
  }

  // For each shared edge, if adjacent face normals are smooth but NOT coplanar, unite them
  // This catches cone/cylinder quads that are individually planar but collectively curved
  for (const [, fis] of edgeFaces) {
    if (fis.length < 2) continue;
    for (let i = 0; i < fis.length - 1; i++) {
      for (let j = i + 1; j < fis.length; j++) {
        const fa = faces[fis[i]], fb = faces[fis[j]];
        const na = fa.normal, nb = fb.normal;
        const dot = na.x * nb.x + na.y * nb.y + na.z * nb.z;
        // Smooth but not coplanar: normals within 15° but not identical
        if (dot >= SMOOTH_COS && dot < 1 - 1e-6) {
          // Don't merge fillet strip faces with non-fillet faces
          if (!!fa.isFillet !== !!fb.isFillet) continue;
          // Don't merge corner faces with non-corner faces
          if (!!fa.isCorner !== !!fb.isCorner) continue;
          // Keep neighboring blends from different features independently selectable.
          const sourceA = fa.shared && fa.shared.sourceFeatureId ? fa.shared.sourceFeatureId : null;
          const sourceB = fb.shared && fb.shared.sourceFeatureId ? fb.shared.sourceFeatureId : null;
          if ((fa.isFillet || fa.isCorner || fb.isFillet || fb.isCorner) && sourceA !== sourceB) continue;
          // Don't merge faces from different STEP topology faces.
          // STEP import tags each mesh face with topoFaceId — these
          // represent distinct B-Rep surfaces that must remain
          // independently selectable (e.g. separate fillet cylinders).
          if (fa.topoFaceId !== undefined && fb.topoFaceId !== undefined && fa.topoFaceId !== fb.topoFaceId) continue;
          unite(fis[i], fis[j]);
        }
      }
    }
  }

  // Force-merge adjacent corner faces into a single group.
  // Spherical corner patches can span large angular ranges where adjacent
  // triangle normals exceed the smooth threshold, but they are a single
  // continuous surface that must stay in one group.
  // Merge by shared edges first, then by shared vertices (the base triangle
  // shares vertices but not edges with the spherical grid).
  for (const [, fis] of edgeFaces) {
    if (fis.length < 2) continue;
    for (let i = 0; i < fis.length - 1; i++) {
      for (let j = i + 1; j < fis.length; j++) {
        if (faces[fis[i]].isCorner && faces[fis[j]].isCorner) {
          unite(fis[i], fis[j]);
        }
      }
    }
  }
  // Vertex-based merge for corner faces (base triangle ↔ spherical grid)
  const cornerVertFaces = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    if (!faces[fi].isCorner) continue;
    for (const v of faces[fi].vertices) {
      const k = vKey(v);
      if (!cornerVertFaces.has(k)) cornerVertFaces.set(k, []);
      cornerVertFaces.get(k).push(fi);
    }
  }
  for (const [, fis] of cornerVertFaces) {
    for (let i = 1; i < fis.length; i++) unite(fis[0], fis[i]);
  }

  // Force-merge faces from the same STEP topological face.
  // A single B-Rep surface tessellated into many mesh triangles must
  // remain in one group — internal tessellation edges (e.g. on a
  // spherical corner) should never produce visible feature lines.
  // Use direct face-index grouping (not edge-based) to handle adaptive
  // subdivision that may create T-junctions between adjacent triangles.
  const topoFaceGroups = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const tid = faces[fi].topoFaceId;
    if (tid !== undefined) {
      if (!topoFaceGroups.has(tid)) topoFaceGroups.set(tid, []);
      topoFaceGroups.get(tid).push(fi);
    }
  }
  for (const [, fis] of topoFaceGroups) {
    for (let i = 1; i < fis.length; i++) unite(fis[0], fis[i]);
  }

  // Assign final faceGroup from union-find
  for (let fi = 0; fi < faces.length; fi++) {
    faces[fi].faceGroup = find(fi);
  }

  // Mark curved groups: a group is curved if it contains faces with different normals
  const groupNormals = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const g = faces[fi].faceGroup;
    const n = faces[fi].normal;
    if (!groupNormals.has(g)) {
      groupNormals.set(g, n);
    } else {
      const ref = groupNormals.get(g);
      // If any face in the group has a different normal, mark it as curved
      if (ref !== 'curved') {
        const dot = ref.x * n.x + ref.y * n.y + ref.z * n.z;
        if (dot < 1 - 1e-6) {
          groupNormals.set(g, 'curved');
        }
      }
    }
  }
  for (let fi = 0; fi < faces.length; fi++) {
    faces[fi].isCurved = groupNormals.get(faces[fi].faceGroup) === 'curved';
  }
}

export function computeFeatureEdges(faces) {
  // Group coplanar adjacent faces so they can be selected as one logical face.
  assignCoplanarFaceGroups(faces);

  // Build edge → normal/face tracking
  const edgeNormals = new Map();
  // Cache edge keys per face: edgeKeysPerFace[fi][i] = key for edge i→(i+1)
  const edgeKeysPerFace = new Array(faces.length);
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const faceVerts = face.vertices;
    const normal = face.normal;
    const keys = new Array(faceVerts.length);
    for (let i = 0; i < faceVerts.length; i++) {
      const a = faceVerts[i];
      const b = faceVerts[(i + 1) % faceVerts.length];
      const key = edgeKey(a, b);
      keys[i] = key;
      if (!edgeNormals.has(key)) {
        edgeNormals.set(key, { start: a, end: b, normals: [], faceIndices: [] });
      }
      const entry = edgeNormals.get(key);
      entry.normals.push(normal);
      entry.faceIndices.push(fi);
    }
    edgeKeysPerFace[fi] = keys;
  }

  // Collect faces per group (only groups with multiple faces need T-junction analysis)
  const facesPerGroup = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const g = faces[fi].faceGroup;
    if (!facesPerGroup.has(g)) facesPerGroup.set(g, []);
    facesPerGroup.get(g).push(fi);
  }

  // Pre-compute T-junction edge keys for each multi-face group.
  // A boundary edge is a T-junction internal edge if:
  //   (a) another face in the same group has a vertex that lies strictly on this edge, or
  //   (b) one of this edge's endpoints lies strictly on an edge of another group face.
  const tJunctionEdgeKeys = new Set();
  for (const [, groupFaceIndices] of facesPerGroup) {
    if (groupFaceIndices.length <= 1) continue;

    // Skip T-junction analysis for STEP topology faces — their boundary
    // edges are suppressed later via the topoFaceId check, so the expensive
    // O(n²) point-on-segment tests are unnecessary.
    if (faces[groupFaceIndices[0]].topoFaceId !== undefined) continue;

    // Collect all edges of the group with pre-computed keys
    const groupEdges = [];
    for (const fi of groupFaceIndices) {
      const verts = faces[fi].vertices;
      const keys = edgeKeysPerFace[fi];
      for (let i = 0; i < verts.length; i++) {
        groupEdges.push({ a: verts[i], b: verts[(i + 1) % verts.length], fi, key: keys[i] });
      }
    }

    // Check each edge against vertices/edges of other faces in the same group
    for (const edge of groupEdges) {
      const ek = edge.key;
      if (tJunctionEdgeKeys.has(ek)) continue; // already marked
      // Only process boundary edges (we only suppress boundary edges)
      const info = edgeNormals.get(ek);
      if (!info || info.normals.length !== 1) continue;

      let isTJunction = false;

      // (a) Does any vertex of another group face lie on this edge?
      for (const otherFi of groupFaceIndices) {
        if (otherFi === edge.fi) continue;
        for (const v of faces[otherFi].vertices) {
          if (pointOnSegmentStrict(v, edge.a, edge.b)) {
            isTJunction = true;
            break;
          }
        }
        if (isTJunction) break;
      }

      // (b) Does either endpoint lie on an edge of another group face?
      if (!isTJunction) {
        for (const other of groupEdges) {
          if (other.fi === edge.fi) continue;
          if (pointOnSegmentStrict(edge.a, other.a, other.b) ||
              pointOnSegmentStrict(edge.b, other.a, other.b)) {
            isTJunction = true;
            break;
          }
        }
      }

      if (isTJunction) tJunctionEdgeKeys.add(ek);
    }
  }

  // Build feature edges: boundary edges or sharp edges
  // Also build visual edges: tessellation edges on curved surfaces (non-selectable wireframe)
  const SHARP_THRESHOLD = Math.cos(15 * Math.PI / 180); // ~0.966
  // Relaxed threshold for edges within the same face group / topo face:
  // coarsely tessellated smooth surfaces (e.g. spherical corners) can have
  // adjacent triangle normals diverging beyond 15° but are still part of one
  // continuous surface.  Use 30° so only genuinely sharp creases register.
  const SAME_FACE_SHARP_THRESHOLD = Math.cos(30 * Math.PI / 180); // ~0.866
  const COPLANAR_THRESHOLD = 1 - 1e-6;
  let edges = [];
  const visualEdges = [];
  for (const [key, info] of edgeNormals) {
    if (info.normals.length === 1) {
      // Boundary edge — only suppress if it's a confirmed T-junction
      // Also suppress boundary edges from STEP topology faces: in a
      // properly closed B-Rep solid, every edge is shared by two faces,
      // so a boundary (1-face) edge within a STEP mesh is always an
      // internal tessellation artifact (e.g. from adaptive subdivision).
      if (!tJunctionEdgeKeys.has(key)) {
        const fi0 = info.faceIndices[0];
        if (faces[fi0].topoFaceId !== undefined) {
          // STEP artifact — suppress
        } else {
          edges.push({
            start: info.start, end: info.end,
            faceIndices: info.faceIndices,
            normals: info.normals,
          });
        }
      }
    } else if (info.normals.length >= 2) {
      // Determine if both faces belong to the same logical surface
      const sameGroup = info.faceIndices.length >= 2 &&
        new Set(info.faceIndices.map(fi => faces[fi].faceGroup)).size === 1;
      const threshold = sameGroup ? SAME_FACE_SHARP_THRESHOLD : SHARP_THRESHOLD;

      // Check if any pair of adjacent normals differs significantly
      const n0 = info.normals[0];
      let isFeature = false;
      let minDot = 1;
      for (let i = 1; i < info.normals.length; i++) {
        const n1 = info.normals[i];
        const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
        if (dot < minDot) minDot = dot;
        if (dot < threshold) {
          isFeature = true;
          break;
        }
      }
      // Force feature edge at fillet-to-flat face boundary
      if (!isFeature && info.faceIndices.length >= 2) {
        const hasF = info.faceIndices.some(fi => faces[fi].isFillet);
        const hasNF = info.faceIndices.some(fi => !faces[fi].isFillet);
        if (hasF && hasNF) isFeature = true;
      }
      // Force feature edge at STEP topology face boundaries: edges between
      // different topoFaceId values represent B-Rep surface seams that should
      // always be selectable, even when the normals are nearly continuous
      // (e.g. tangent-continuous fillet-to-corner transitions).
      if (!isFeature && info.faceIndices.length >= 2) {
        const groups = new Set(info.faceIndices.map(fi => faces[fi].faceGroup));
        const topoIds = new Set();
        for (const fi of info.faceIndices) {
          if (faces[fi].topoFaceId !== undefined) topoIds.add(faces[fi].topoFaceId);
        }
        if (topoIds.size > 1 && groups.size > 1) isFeature = true;
      }
      // Suppress feature edges at the corner base seam: the flat base triangle
      // connecting the spherical corner to the trimmed box faces is a geometric
      // necessity for manifold closure but should not produce visible feature lines.
      if (isFeature && info.faceIndices.length >= 2) {
        const hasCorner = info.faceIndices.some(fi => faces[fi].isCorner);
        const allNonFillet = info.faceIndices.every(fi => !faces[fi].isFillet);
        if (hasCorner && allNonFillet) isFeature = false;
      }
      // Suppress feature edges between faces from the same STEP topology
      // face — these are internal tessellation artifacts, never real B-Rep
      // seams.  This overrides angle thresholds so that coarse subdivision
      // on a spherical corner never shows internal lines.
      if (isFeature && info.faceIndices.length >= 2) {
        const fa = faces[info.faceIndices[0]], fb = faces[info.faceIndices[1]];
        if (fa.topoFaceId !== undefined && fa.topoFaceId === fb.topoFaceId) {
          isFeature = false;
        }
      }
      // Faces already merged into one logical coplanar face must never
      // expose their internal triangulation seam as a selectable feature edge.
      if (isFeature && sameGroup) {
        isFeature = false;
      }
      if (isFeature) {
        edges.push({
          start: info.start, end: info.end,
          faceIndices: info.faceIndices,
          normals: info.normals,
        });
      } else if (minDot < COPLANAR_THRESHOLD) {
        // Normals differ but not enough for a feature edge — curved surface tessellation edge
        // Only include if faces are in different coplanar groups
        const groups = new Set(info.faceIndices.map(fi => faces[fi].faceGroup));
        if (groups.size > 1) {
          // Suppress visual edges between faces from the same STEP topology
          // face — these are internal subdivision artifacts on curved surfaces
          // (e.g. sphere patches) that should never show wireframe lines.
          const topoIds = new Set(info.faceIndices.map(fi => faces[fi].topoFaceId).filter(id => id !== undefined));
          if (topoIds.size > 1 || topoIds.size === 0) {
            visualEdges.push({ start: info.start, end: info.end });
          }
        }
      }
    }
  }

  // Chain connected feature edges into paths.  A path is a maximal connected
  // sequence of edges where every *internal* vertex has exactly 2 incident
  // feature edges (i.e. the path continues through that vertex).  Vertices
  // with 1 or 3+ connections become path endpoints; if every vertex in a
  // connected component has valence 2 the path is closed (loop).
  const paths = chainEdgePaths(edges);

  return { edges, paths, visualEdges };
}

export function makeEdgeKey(a, b) {
  return edgeKeyFromVerts(a, b);
}

/**
 * Given a geometry (with .edges and .paths) and a set of edge keys from the
 * user's selection, expand each key to include ALL edges that belong to the
 * same path AND any tangent-connected paths (paths sharing an endpoint with
 * similar edge direction).  This allows selecting one segment of a circular
 * edge to automatically select the whole circle and any tangent continuations.
 *
 * @param {Object} geometry - Geometry with .edges[] and .paths[]
 * @param {string[]} edgeKeys - Edge keys selected by the user
 * @returns {string[]} Expanded edge keys covering full paths (deduplicated)
 */
export function expandPathEdgeKeys(geometry, edgeKeys) {
  if (!geometry || !geometry.edges || !geometry.paths || edgeKeys.length === 0) {
    return edgeKeys;
  }

  // Build edge-index → path-index lookup
  const edgeToPath = new Map();
  for (let pi = 0; pi < geometry.paths.length; pi++) {
    for (const ei of geometry.paths[pi].edgeIndices) {
      edgeToPath.set(ei, pi);
    }
  }

  // Build edge-key → edge-index lookup
  const keyToIndex = new Map();
  for (let i = 0; i < geometry.edges.length; i++) {
    const e = geometry.edges[i];
    keyToIndex.set(edgeKeyFromVerts(e.start, e.end), i);
  }

  const parseEdgeKey = (key) => {
    if (typeof key !== 'string') return null;
    const sep = key.indexOf('|');
    if (sep < 0) return null;
    const parsePoint = (text) => {
      const coords = text.split(',').map(Number);
      if (coords.length !== 3 || coords.some((value) => Number.isNaN(value))) return null;
      return { x: coords[0], y: coords[1], z: coords[2] };
    };
    const start = parsePoint(key.slice(0, sep));
    const end = parsePoint(key.slice(sep + 1));
    return start && end ? { start, end } : null;
  };

  const pointToSegmentDistance = (point, start, end) => {
    const seg = vec3Sub(end, start);
    const lenSq = vec3Dot(seg, seg);
    if (lenSq < 1e-10) return vec3Len(vec3Sub(point, start));
    const t = Math.max(0, Math.min(1, vec3Dot(vec3Sub(point, start), seg) / lenSq));
    const closest = vec3Add(start, vec3Scale(seg, t));
    return vec3Len(vec3Sub(point, closest));
  };

  const fuzzyMatchEdgeIndex = (edgeKey) => {
    const parsed = parseEdgeKey(edgeKey);
    if (!parsed) return undefined;
    const origDelta = vec3Sub(parsed.end, parsed.start);
    const origLen = vec3Len(origDelta);
    if (origLen < 1e-10) return undefined;
    const origDir = vec3Normalize(origDelta);
    const origMid = vec3Lerp(parsed.start, parsed.end, 0.5);

    let bestIndex = undefined;
    let bestScore = Infinity;
    for (let i = 0; i < geometry.edges.length; i++) {
      const edge = geometry.edges[i];
      if (!edge || !edge.start || !edge.end) continue;
      const edgeDelta = vec3Sub(edge.end, edge.start);
      const edgeLen = vec3Len(edgeDelta);
      if (edgeLen < 1e-10) continue;
      const edgeDir = vec3Normalize(edgeDelta);
      if (Math.abs(vec3Dot(edgeDir, origDir)) < 0.95) continue;

      const distA = pointToSegmentDistance(parsed.start, edge.start, edge.end);
      const distB = pointToSegmentDistance(parsed.end, edge.start, edge.end);
      const tol = Math.max(origLen, edgeLen) * 0.1 + 1e-4;
      if (distA > tol || distB > tol) continue;

      const edgeMid = vec3Lerp(edge.start, edge.end, 0.5);
      const midDist = vec3Len(vec3Sub(edgeMid, origMid));
      const lenRatio = edgeLen / origLen;
      if (lenRatio < 0.1 || lenRatio > 10) continue;

      const score = distA + distB + midDist + Math.abs(Math.log(lenRatio)) * 0.01;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  // Collect all path indices touched by the input keys
  const touchedPaths = new Set();
  const matchedKeys = new Set();
  for (const ek of edgeKeys) {
    const ei = keyToIndex.get(ek) ?? fuzzyMatchEdgeIndex(ek);
    if (ei !== undefined) {
      matchedKeys.add(ek);
      const pi = edgeToPath.get(ei);
      if (pi !== undefined) touchedPaths.add(pi);
    }
  }

  function pathExpansionSignature(pi) {
    const path = geometry.paths[pi];
    let hasFillet = false;
    let hasNonFillet = false;
    const featureIds = new Set();

    for (const ei of path.edgeIndices) {
      const edge = geometry.edges[ei];
      for (const fi of edge.faceIndices || []) {
        const face = geometry.faces && geometry.faces[fi];
        if (!face) continue;
        if (face.isFillet) hasFillet = true;
        else hasNonFillet = true;
        const featureId = face.shared && face.shared.sourceFeatureId;
        if (featureId) featureIds.add(featureId);
      }
    }

    const kind = hasFillet
      ? (hasNonFillet ? 'blend-boundary' : 'blend-only')
      : 'sharp-only';
    return `${kind}|${[...featureIds].sort().join(',')}`;
  }

  const pathSignatures = geometry.paths.map((_, pi) => pathExpansionSignature(pi));

  // --- Tangent path expansion ---
  // Build path endpoint → path index map and endpoint edge directions
  const vKey = (v) => edgeVKey(v);
  const pathEndpoints = new Map(); // vertexKey → [{pi, dir}]

  for (let pi = 0; pi < geometry.paths.length; pi++) {
    const path = geometry.paths[pi];
    if (path.isClosed || path.edgeIndices.length === 0) continue;

    // First edge start vertex
    const firstEi = path.edgeIndices[0];
    const firstEdge = geometry.edges[firstEi];
    const startVk = vKey(firstEdge.start);
    const startDir = vec3Normalize(vec3Sub(firstEdge.end, firstEdge.start));

    // Last edge end vertex
    const lastEi = path.edgeIndices[path.edgeIndices.length - 1];
    const lastEdge = geometry.edges[lastEi];
    const endVk = vKey(lastEdge.end);
    const endDir = vec3Normalize(vec3Sub(lastEdge.end, lastEdge.start));

    if (!pathEndpoints.has(startVk)) pathEndpoints.set(startVk, []);
    pathEndpoints.get(startVk).push({ pi, dir: { x: -startDir.x, y: -startDir.y, z: -startDir.z } });

    if (!pathEndpoints.has(endVk)) pathEndpoints.set(endVk, []);
    pathEndpoints.get(endVk).push({ pi, dir: endDir });
  }

  // Expand tangent-connected paths: if a touched path endpoint meets
  // another path's endpoint at the same vertex with similar direction,
  // include that path too (and recurse)
  // Cosine threshold for tangent detection (~26° tolerance).
  // Two path endpoints are considered tangent when the cosine of the angle
  // between their edge directions exceeds this value.
  const TANGENT_THRESHOLD = 0.9;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pi of touchedPaths) {
      const path = geometry.paths[pi];
      if (path.isClosed || path.edgeIndices.length === 0) continue;

      const firstEi = path.edgeIndices[0];
      const lastEi = path.edgeIndices[path.edgeIndices.length - 1];
      const firstEdge = geometry.edges[firstEi];
      const lastEdge = geometry.edges[lastEi];

      for (const endpointVk of [vKey(firstEdge.start), vKey(lastEdge.end)]) {
        const neighbors = pathEndpoints.get(endpointVk);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (neighbor.pi === pi || touchedPaths.has(neighbor.pi)) continue;
          if (pathSignatures[neighbor.pi] !== pathSignatures[pi]) continue;

          // Check tangency: find the direction at this endpoint for the current path
          let curDir;
          if (endpointVk === vKey(firstEdge.start)) {
            curDir = vec3Normalize(vec3Sub(firstEdge.start, firstEdge.end)); // pointing outward
          } else {
            curDir = vec3Normalize(vec3Sub(lastEdge.end, lastEdge.start));
          }

          const dot = Math.abs(vec3Dot(curDir, neighbor.dir));
          if (dot >= TANGENT_THRESHOLD) {
            touchedPaths.add(neighbor.pi);
            changed = true;
          }
        }
      }
    }
  }

  // Expand: emit every edge key in every touched path
  const result = new Set();
  for (const pi of touchedPaths) {
    for (const ei of geometry.paths[pi].edgeIndices) {
      const e = geometry.edges[ei];
      result.add(edgeKeyFromVerts(e.start, e.end));
    }
  }

  // Also keep any input keys that didn't match a path (fuzzy fallback)
  for (const ek of edgeKeys) {
    if (!matchedKeys.has(ek)) result.add(ek);
  }

  return [...result];
}
