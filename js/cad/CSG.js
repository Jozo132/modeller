// js/cad/CSG.js — Constructive Solid Geometry (CSG) boolean operations
// Implements union, subtract, and intersect on polygon meshes using BSP trees.
// Based on the algorithm from "Constructive Solid Geometry Using BSP Tree"
// (Laidlaw, Trumbore, Hughes, 1986) with modifications for numerical robustness.

const EPSILON = 1e-5;

// -----------------------------------------------------------------------
// Vector3 helper
// -----------------------------------------------------------------------

class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  neg() { return new Vec3(-this.x, -this.y, -this.z); }
  plus(b) { return new Vec3(this.x + b.x, this.y + b.y, this.z + b.z); }
  minus(b) { return new Vec3(this.x - b.x, this.y - b.y, this.z - b.z); }
  times(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  dot(b) { return this.x * b.x + this.y * b.y + this.z * b.z; }
  cross(b) {
    return new Vec3(
      this.y * b.z - this.z * b.y,
      this.z * b.x - this.x * b.z,
      this.x * b.y - this.y * b.x
    );
  }
  length() { return Math.sqrt(this.dot(this)); }
  unit() { const l = this.length(); return l > 0 ? this.times(1 / l) : this.clone(); }
  lerp(b, t) { return this.plus(b.minus(this).times(t)); }
  toObj() { return { x: this.x, y: this.y, z: this.z }; }
  static from(o) { return new Vec3(o.x, o.y, o.z); }
}

// -----------------------------------------------------------------------
// Vertex — position + normal
// -----------------------------------------------------------------------

class Vertex {
  constructor(pos, normal) {
    this.pos = pos instanceof Vec3 ? pos : Vec3.from(pos);
    this.normal = normal instanceof Vec3 ? normal : Vec3.from(normal);
  }
  clone() { return new Vertex(this.pos.clone(), this.normal.clone()); }
  flip() { this.normal = this.normal.neg(); }
  interpolate(other, t) {
    return new Vertex(
      this.pos.lerp(other.pos, t),
      this.normal.lerp(other.normal, t).unit()
    );
  }
}

// -----------------------------------------------------------------------
// Polygon — convex polygon with shared normal, optional metadata
// -----------------------------------------------------------------------

class Polygon {
  constructor(vertices, shared = null) {
    this.vertices = vertices;
    this.shared = shared;   // face metadata (type, source feature, etc.)
    this.plane = Plane.fromPoints(
      vertices[0].pos, vertices[1].pos, vertices[2].pos
    );
  }
  clone() {
    return new Polygon(
      this.vertices.map(v => v.clone()),
      this.shared
    );
  }
  flip() {
    this.vertices.reverse().forEach(v => v.flip());
    this.plane.flip();
  }
}

// -----------------------------------------------------------------------
// Plane — defined by normal and distance from origin (ax + by + cz - w = 0)
// -----------------------------------------------------------------------

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

class Plane {
  constructor(normal, w) {
    this.normal = normal;
    this.w = w;
  }
  clone() { return new Plane(this.normal.clone(), this.w); }
  flip() { this.normal = this.normal.neg(); this.w = -this.w; }

  static fromPoints(a, b, c) {
    const n = b.minus(a).cross(c.minus(a)).unit();
    return new Plane(n, n.dot(a));
  }

  /**
   * Split polygon by this plane. Resulting polygons are pushed into the
   * four output arrays: coplanarFront, coplanarBack, front, back.
   */
  splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
    let polygonType = 0;
    const types = [];

    for (const v of polygon.vertices) {
      const t = this.normal.dot(v.pos) - this.w;
      const type = (t < -EPSILON) ? BACK : (t > EPSILON) ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }

    switch (polygonType) {
      case COPLANAR:
        (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        break;
      case FRONT:
        front.push(polygon);
        break;
      case BACK:
        back.push(polygon);
        break;
      case SPANNING: {
        const f = [], b = [];
        for (let i = 0; i < polygon.vertices.length; i++) {
          const j = (i + 1) % polygon.vertices.length;
          const ti = types[i], tj = types[j];
          const vi = polygon.vertices[i], vj = polygon.vertices[j];

          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);

          if ((ti | tj) === SPANNING) {
            const t = (this.w - this.normal.dot(vi.pos)) /
                      this.normal.dot(vj.pos.minus(vi.pos));
            const v = vi.interpolate(vj, t);
            f.push(v);
            b.push(v.clone());
          }
        }
        if (f.length >= 3) front.push(new Polygon(f, polygon.shared));
        if (b.length >= 3) back.push(new Polygon(b, polygon.shared));
        break;
      }
    }
  }
}

// -----------------------------------------------------------------------
// BSP Node
// -----------------------------------------------------------------------

class Node {
  constructor(polygons) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons && polygons.length) this.build(polygons);
  }

  clone() {
    const node = new Node();
    node.plane = this.plane && this.plane.clone();
    node.front = this.front && this.front.clone();
    node.back = this.back && this.back.clone();
    node.polygons = this.polygons.map(p => p.clone());
    return node;
  }

  /** Convert solid space to empty space and vice versa. */
  invert() {
    for (const p of this.polygons) p.flip();
    if (this.plane) this.plane.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    const tmp = this.front;
    this.front = this.back;
    this.back = tmp;
  }

  /** Recursively remove all polygons in `polygons` that are inside this BSP tree. */
  clipPolygons(polygons) {
    if (!this.plane) return polygons.slice();
    let front = [], back = [];
    for (const p of polygons) {
      this.plane.splitPolygon(p, front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    if (this.back) back = this.back.clipPolygons(back);
    else back = [];
    return front.concat(back);
  }

  /** Remove all polygons in this BSP tree that are inside the other BSP tree. */
  clipTo(bsp) {
    this.polygons = bsp.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(bsp);
    if (this.back) this.back.clipTo(bsp);
  }

  /** Return a list of all polygons in this BSP tree. */
  allPolygons() {
    let polys = this.polygons.slice();
    if (this.front) polys = polys.concat(this.front.allPolygons());
    if (this.back) polys = polys.concat(this.back.allPolygons());
    return polys;
  }

  /** Build a BSP tree out of polygons. */
  build(polygons) {
    if (!polygons.length) return;
    if (!this.plane) this.plane = polygons[0].plane.clone();

    const front = [], back = [];
    for (const p of polygons) {
      this.plane.splitPolygon(p, this.polygons, this.polygons, front, back);
    }
    if (front.length) {
      if (!this.front) this.front = new Node();
      this.front.build(front);
    }
    if (back.length) {
      if (!this.back) this.back = new Node();
      this.back.build(back);
    }
  }
}

// -----------------------------------------------------------------------
// CSG solid — wraps an array of polygons
// -----------------------------------------------------------------------

class CSGSolid {
  constructor() { this.polygons = []; }

  clone() {
    const s = new CSGSolid();
    s.polygons = this.polygons.map(p => p.clone());
    return s;
  }

  /** Return a new CSG solid representing space in either this solid or `csg`. */
  union(csg) {
    const a = new Node(this.clone().polygons);
    const b = new Node(csg.clone().polygons);
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    const result = CSGSolid.fromPolygons(a.allPolygons());
    return result;
  }

  /** Return a new CSG solid representing space in this solid but not `csg`. */
  subtract(csg) {
    const a = new Node(this.clone().polygons);
    const b = new Node(csg.clone().polygons);
    a.invert();
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    a.invert();
    const result = CSGSolid.fromPolygons(a.allPolygons());
    return result;
  }

  /** Return a new CSG solid representing space in both this solid and `csg`. */
  intersect(csg) {
    const a = new Node(this.clone().polygons);
    const b = new Node(csg.clone().polygons);
    a.invert();
    b.clipTo(a);
    b.invert();
    a.clipTo(b);
    b.clipTo(a);
    a.build(b.allPolygons());
    a.invert();
    const result = CSGSolid.fromPolygons(a.allPolygons());
    return result;
  }

  static fromPolygons(polygons) {
    const s = new CSGSolid();
    s.polygons = polygons;
    return s;
  }

  /**
   * Build a CSGSolid from our internal geometry format:
   *   { vertices: [{x,y,z},...], faces: [{vertices:[{x,y,z},...], normal:{x,y,z}},...] }
   * All faces are pre-triangulated before BSP construction to avoid numerical
   * issues with large n-gons (e.g. 32-point circles) being split by the BSP tree.
   */
  static fromGeometry(geometry, shared = null) {
    const polygons = [];
    for (const face of (geometry.faces || [])) {
      if (face.vertices.length < 3) continue;
      const n = face.normal || { x: 0, y: 0, z: 1 };
      const faceShared = face.shared || shared || null;
      const nv = Vec3.from(n);

      // Pre-triangulate: fan from vertex 0 for convex polygons
      if (face.vertices.length === 3) {
        const verts = face.vertices.map(v => new Vertex(Vec3.from(v), nv.clone()));
        polygons.push(new Polygon(verts, faceShared));
      } else {
        const v0 = face.vertices[0];
        for (let i = 1; i < face.vertices.length - 1; i++) {
          const v1 = face.vertices[i];
          const v2 = face.vertices[i + 1];
          const verts = [
            new Vertex(Vec3.from(v0), nv.clone()),
            new Vertex(Vec3.from(v1), nv.clone()),
            new Vertex(Vec3.from(v2), nv.clone()),
          ];
          polygons.push(new Polygon(verts, faceShared));
        }
      }
    }
    return CSGSolid.fromPolygons(polygons);
  }

  /**
   * Convert back to our internal geometry format with face metadata.
   * Each polygon becomes a face with its vertices, normal, and shared metadata.
   * Faces also get a `faceType` classification.
   * Only feature edges (sharp edges between faces with different normals) are included.
   */
  toGeometry() {
    const vertices = [];
    const faces = [];

    for (const poly of this.polygons) {
      const faceVerts = poly.vertices.map(v => v.pos.toObj());
      const normal = poly.plane.normal.toObj();

      // Classify face type based on normal direction
      const faceType = classifyFaceType(normal, faceVerts);

      faces.push({
        vertices: faceVerts,
        normal,
        faceType,
        shared: poly.shared || null,
      });

      for (const v of faceVerts) {
        vertices.push(v);
      }
    }

    // Compute face groups and feature edges
    const { edges, visualEdges } = computeFeatureEdges(faces);

    return { vertices, faces, edges, visualEdges };
  }
}

// -----------------------------------------------------------------------
// Coplanar face grouping
// -----------------------------------------------------------------------

/**
 * Assign a faceGroup ID to coplanar adjacent faces so they can be selected
 * as a single logical face.  Unlike the old mergeCoplanarFaces(), this
 * preserves the original convex CSG polygons (so fan triangulation stays
 * correct) and only annotates each face with a shared group number.
 *
 * Non-planar faces (cylindrical, freeform) are grouped by smooth-edge
 * adjacency: adjacent faces whose normals differ by less than the feature
 * edge threshold (15°) are merged into a single curved group.
 * Each face also gets an `isCurved` boolean.
 *
 * @param {Array} faces - Array of face objects {vertices, normal, faceType, shared}
 *                        Modified in-place: each face gets `faceGroup` and `isCurved` properties.
 */
function assignCoplanarFaceGroups(faces) {
  // Build a plane key for grouping: quantized normal + plane distance
  function planeKey(normal, vertices) {
    const n = Vec3.from(normal).unit();
    // Ensure consistent normal direction (flip so largest component is positive)
    let sign = 1;
    if (Math.abs(n.z) > Math.abs(n.x) && Math.abs(n.z) > Math.abs(n.y)) {
      sign = n.z < 0 ? -1 : 1;
    } else if (Math.abs(n.y) > Math.abs(n.x)) {
      sign = n.y < 0 ? -1 : 1;
    } else {
      sign = n.x < 0 ? -1 : 1;
    }
    const nx = (n.x * sign).toFixed(4);
    const ny = (n.y * sign).toFixed(4);
    const nz = (n.z * sign).toFixed(4);
    const d = (Vec3.from(vertices[0]).dot(n) * sign).toFixed(4);
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

  for (const [, group] of planeGroups) {
    if (group.length <= 1) continue;

    const vertexFaces = new Map();
    for (const fi of group) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const key = `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
        if (!vertexFaces.has(key)) vertexFaces.set(key, []);
        vertexFaces.get(key).push(fi);
      }
    }

    for (const [, faceIds] of vertexFaces) {
      for (let i = 1; i < faceIds.length; i++) {
        unite(faceIds[0], faceIds[i]);
      }
    }
  }

  // --- Curved face grouping: merge non-planar faces connected by smooth edges ---
  const precision = 6;
  function vKey(v) { return `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`; }
  function eKey(a, b) { const ka = vKey(a), kb = vKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; }

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
          unite(fis[i], fis[j]);
        }
      }
    }
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

// -----------------------------------------------------------------------
// Face type classification
// -----------------------------------------------------------------------

/**
 * Classify the type of a face based on its normal and vertex positions.
 * Returns: 'planar-horizontal', 'planar-vertical', 'planar', 'cylindrical', or 'freeform'
 */
function classifyFaceType(normal, vertices) {
  if (vertices.length < 3) return 'planar';

  // Check if all vertices are coplanar (within tolerance)
  const n = Vec3.from(normal);
  const p0 = Vec3.from(vertices[0]);
  const d = n.dot(p0);

  let allCoplanar = true;
  for (const v of vertices) {
    if (Math.abs(n.dot(Vec3.from(v)) - d) > EPSILON * 10) {
      allCoplanar = false;
      break;
    }
  }

  if (allCoplanar) {
    // Check if normal is axis-aligned
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (az > 0.99) return 'planar-horizontal';
    if (ax > 0.99 || ay > 0.99) return 'planar-vertical';
    return 'planar';
  }

  // For quads with non-coplanar verts, assume cylindrical (from extrusion of curves)
  if (vertices.length === 4) return 'cylindrical';

  return 'freeform';
}

/**
 * Create a unique edge key from two vertex positions (order-independent).
 */
function edgeKey(a, b) {
  const precision = 6;
  const ax = a.x.toFixed(precision), ay = a.y.toFixed(precision), az = a.z.toFixed(precision);
  const bx = b.x.toFixed(precision), by = b.y.toFixed(precision), bz = b.z.toFixed(precision);
  const ka = `${ax},${ay},${az}`;
  const kb = `${bx},${by},${bz}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// -----------------------------------------------------------------------
// Feature edge computation
// -----------------------------------------------------------------------

/**
 * Check if point p lies strictly on segment [a, b] (not at endpoints).
 */
function pointOnSegmentStrict(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const px = p.x - a.x, py = p.y - a.y, pz = p.z - a.z;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < EPSILON * EPSILON) return false; // degenerate edge
  const t = (px * dx + py * dy + pz * dz) / lenSq;
  if (t <= EPSILON || t >= 1 - EPSILON) return false; // at or beyond endpoints
  const projX = px - t * dx, projY = py - t * dy, projZ = pz - t * dz;
  return (projX * projX + projY * projY + projZ * projZ) < EPSILON * EPSILON;
}

/**
 * Compute feature edges for a geometry's face list.
 * Assigns coplanar face groups and returns the array of feature edges.
 * Faces are modified in-place (faceGroup, faceType added).
 *
 * @param {Array} faces - Array of face objects {vertices, normal, ...}
 * @returns {Array} Array of {start, end} edge objects
 */
export function computeFeatureEdges(faces) {
  // Group coplanar adjacent faces so they can be selected as one logical face.
  assignCoplanarFaceGroups(faces);

  // Build edge → normal/face tracking
  const edgeNormals = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const faceVerts = face.vertices;
    const normal = face.normal;
    for (let i = 0; i < faceVerts.length; i++) {
      const a = faceVerts[i];
      const b = faceVerts[(i + 1) % faceVerts.length];
      const key = edgeKey(a, b);
      if (!edgeNormals.has(key)) {
        edgeNormals.set(key, { start: a, end: b, normals: [], faceIndices: [] });
      }
      edgeNormals.get(key).normals.push(normal);
      edgeNormals.get(key).faceIndices.push(fi);
    }
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

    // Collect all edges of the group
    const groupEdges = [];
    for (const fi of groupFaceIndices) {
      const verts = faces[fi].vertices;
      for (let i = 0; i < verts.length; i++) {
        groupEdges.push({ a: verts[i], b: verts[(i + 1) % verts.length], fi });
      }
    }

    // Check each edge against vertices/edges of other faces in the same group
    for (const edge of groupEdges) {
      const ek = edgeKey(edge.a, edge.b);
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
  const COPLANAR_THRESHOLD = 1 - 1e-6;
  let edges = [];
  const visualEdges = [];
  for (const [key, info] of edgeNormals) {
    if (info.normals.length === 1) {
      // Boundary edge — only suppress if it's a confirmed T-junction
      if (!tJunctionEdgeKeys.has(key)) {
        edges.push({
          start: info.start, end: info.end,
          faceIndices: info.faceIndices,
          normals: info.normals,
        });
      }
    } else if (info.normals.length >= 2) {
      // Check if any pair of adjacent normals differs significantly
      const n0 = info.normals[0];
      let isFeature = false;
      let minDot = 1;
      for (let i = 1; i < info.normals.length; i++) {
        const n1 = info.normals[i];
        const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
        if (dot < minDot) minDot = dot;
        if (dot < SHARP_THRESHOLD) {
          isFeature = true;
          break;
        }
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
          visualEdges.push({ start: info.start, end: info.end });
        }
      }
    }
  }

  edges = _mergeColinearEdges(edges);

  return { edges, visualEdges };
}

/**
 * Merge connected colinear feature edges into single long edges.
 */
function _mergeColinearEdges(edges) {
  if (edges.length <= 1) return edges;

  const vKey = (v) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;

  // Build vertex → edge indices
  const vertexEdges = new Map();
  const addVE = (v, idx) => {
    const k = vKey(v);
    if (!vertexEdges.has(k)) vertexEdges.set(k, []);
    vertexEdges.get(k).push(idx);
  };
  for (let i = 0; i < edges.length; i++) {
    addVE(edges[i].start, i);
    addVE(edges[i].end, i);
  }

  const visited = new Set();
  const merged = [];

  for (let i = 0; i < edges.length; i++) {
    if (visited.has(i)) continue;
    visited.add(i);

    let chainStart = edges[i].start;
    let chainEnd = edges[i].end;
    const dir = _vec3Normalize(_vec3Sub(edges[i].end, edges[i].start));

    // Walk forward from chainEnd
    let ext = true;
    while (ext) {
      ext = false;
      const k = vKey(chainEnd);
      const cands = vertexEdges.get(k) || [];
      for (const ci of cands) {
        if (visited.has(ci)) continue;
        const ce = edges[ci];
        let other = null;
        if (vKey(ce.start) === k) other = ce.end;
        else if (vKey(ce.end) === k) other = ce.start;
        else continue;
        const d2 = _vec3Normalize(_vec3Sub(other, chainEnd));
        if (_vec3Len(_vec3Cross(dir, d2)) < 1e-4 && _vec3Dot(dir, d2) > 0.999) {
          chainEnd = other;
          visited.add(ci);
          ext = true;
          break;
        }
      }
    }

    // Walk backward from chainStart
    ext = true;
    while (ext) {
      ext = false;
      const k = vKey(chainStart);
      const cands = vertexEdges.get(k) || [];
      for (const ci of cands) {
        if (visited.has(ci)) continue;
        const ce = edges[ci];
        let other = null;
        if (vKey(ce.start) === k) other = ce.end;
        else if (vKey(ce.end) === k) other = ce.start;
        else continue;
        const d2 = _vec3Normalize(_vec3Sub(other, chainStart));
        if (_vec3Len(_vec3Cross(dir, d2)) < 1e-4 && _vec3Dot(dir, d2) < -0.999) {
          chainStart = other;
          visited.add(ci);
          ext = true;
          break;
        }
      }
    }

    merged.push({
      start: chainStart,
      end: chainEnd,
      faceIndices: edges[i].faceIndices || [],
      normals: edges[i].normals || [],
    });
  }

  return merged;
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Perform a boolean operation between two geometries.
 * @param {Object} geomA - First geometry {vertices, faces, edges}
 * @param {Object} geomB - Second geometry {vertices, faces, edges}
 * @param {string} operation - 'union', 'subtract', or 'intersect'
 * @param {Object} sharedA - Optional shared metadata for geometry A faces
 * @param {Object} sharedB - Optional shared metadata for geometry B faces
 * @returns {Object} Resulting geometry {vertices, faces, edges}
 */
export function booleanOp(geomA, geomB, operation, sharedA = null, sharedB = null) {
  const a = CSGSolid.fromGeometry(geomA, sharedA);
  const b = CSGSolid.fromGeometry(geomB, sharedB);

  let result;
  switch (operation) {
    case 'union':
    case 'add':
      result = a.union(b);
      break;
    case 'subtract':
      result = a.subtract(b);
      break;
    case 'intersect':
      result = a.intersect(b);
      break;
    default:
      throw new Error(`Unknown boolean operation: ${operation}`);
  }

  return result.toGeometry();
}

/**
 * Calculate the volume of a geometry using the divergence theorem.
 * Assumes the mesh is closed and consistently wound.
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], ...}]}
 * @returns {number} Signed volume
 */
export function calculateMeshVolume(geometry) {
  let volume = 0;
  for (const face of (geometry.faces || [])) {
    const verts = face.vertices;
    if (verts.length < 3) continue;
    // Fan triangulate and sum signed tetrahedron volumes
    const v0 = verts[0];
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = verts[i], v2 = verts[i + 1];
      volume += (
        v0.x * (v1.y * v2.z - v2.y * v1.z) -
        v1.x * (v0.y * v2.z - v2.y * v0.z) +
        v2.x * (v0.y * v1.z - v1.y * v0.z)
      ) / 6.0;
    }
  }
  return Math.abs(volume);
}

/**
 * Calculate the bounding box of a geometry.
 * @param {Object} geometry - {faces: [{vertices: [{x,y,z},...], ...}]}
 * @returns {Object} {min: {x,y,z}, max: {x,y,z}}
 */
export function calculateBoundingBox(geometry) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const face of (geometry.faces || [])) {
    for (const v of face.vertices) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
  }

  if (minX === Infinity) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

// -----------------------------------------------------------------------
// Edge key helpers for chamfer/fillet
// -----------------------------------------------------------------------

const EDGE_PREC = 5;
function _edgeVKey(v) {
  return `${v.x.toFixed(EDGE_PREC)},${v.y.toFixed(EDGE_PREC)},${v.z.toFixed(EDGE_PREC)}`;
}
function _edgeKeyFromVerts(a, b) {
  const ka = _edgeVKey(a), kb = _edgeVKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function _vec3Sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function _vec3Add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function _vec3Scale(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }
function _vec3Dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function _vec3Cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function _vec3Len(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function _vec3Normalize(v) {
  const len = _vec3Len(v);
  if (len < 1e-10) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
function _vec3Lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Find the two face normals adjacent to an edge in a geometry.
 * Returns { n0, n1 } or null if edge not found.
 */
function _findEdgeNormals(faces, edgeKey) {
  const normals = [];
  for (const face of faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (_edgeKeyFromVerts(a, b) === edgeKey) {
        normals.push(face.normal);
        break;
      }
    }
    if (normals.length >= 2) break;
  }
  return normals.length >= 2 ? { n0: normals[0], n1: normals[1] } : null;
}

// -----------------------------------------------------------------------
// Chamfer / Fillet shared helpers
// -----------------------------------------------------------------------

function _faceCentroid(face) {
  let cx = 0, cy = 0, cz = 0;
  for (const v of face.vertices) { cx += v.x; cy += v.y; cz += v.z; }
  const n = face.vertices.length;
  return { x: cx / n, y: cy / n, z: cz / n };
}

function _trimFaceEdge(face, edgeA, edgeB, newA, newB) {
  const verts = face.vertices;
  const keyA = _edgeVKey(edgeA);
  const keyB = _edgeVKey(edgeB);
  const newVerts = [];
  for (let i = 0; i < verts.length; i++) {
    const vk = _edgeVKey(verts[i]);
    if (vk === keyA) {
      newVerts.push({ ...newA });
    } else if (vk === keyB) {
      newVerts.push({ ...newB });
    } else {
      newVerts.push(verts[i]);
    }
  }
  face.vertices = newVerts;
}

function _collectFaceEdgeKeys(face) {
  const keys = new Set();
  const verts = face.vertices;
  for (let i = 0; i < verts.length; i++) {
    keys.add(_edgeKeyFromVerts(verts[i], verts[(i + 1) % verts.length]));
  }
  return keys;
}

/**
 * At an edge endpoint, split the vertex in every face OTHER THAN face0/face1.
 * The single vertex is replaced by two vertices (p0, p1) in the correct winding order
 * so that the cap face connects seamlessly to both trimmed faces and the bevel/arc.
 */
function _splitVertexAtEndpoint(faces, fi0, fi1, oldVertex, p0, p1, face0Keys, face1Keys) {
  const vk = _edgeVKey(oldVertex);

  for (let fi = 0; fi < faces.length; fi++) {
    if (fi === fi0 || fi === fi1) continue;
    const face = faces[fi];
    const verts = face.vertices;

    let vidx = -1;
    for (let i = 0; i < verts.length; i++) {
      if (_edgeVKey(verts[i]) === vk) { vidx = i; break; }
    }
    if (vidx < 0) continue;

    const prevIdx = (vidx - 1 + verts.length) % verts.length;
    const nextIdx = (vidx + 1) % verts.length;
    const prevEdge = _edgeKeyFromVerts(verts[prevIdx], verts[vidx]);
    const nextEdge = _edgeKeyFromVerts(verts[vidx], verts[nextIdx]);

    const prevInF0 = face0Keys.has(prevEdge);
    const prevInF1 = face1Keys.has(prevEdge);
    const nextInF0 = face0Keys.has(nextEdge);
    const nextInF1 = face1Keys.has(nextEdge);

    let newPts;
    if (prevInF0 && nextInF1) {
      newPts = [{ ...p0 }, { ...p1 }];
    } else if (prevInF1 && nextInF0) {
      newPts = [{ ...p1 }, { ...p0 }];
    } else if (prevInF0 || nextInF1) {
      newPts = [{ ...p0 }, { ...p1 }];
    } else if (prevInF1 || nextInF0) {
      newPts = [{ ...p1 }, { ...p0 }];
    } else {
      newPts = [{ ...p0 }, { ...p1 }];
    }

    const newVerts = [];
    for (let i = 0; i < verts.length; i++) {
      if (i === vidx) {
        newVerts.push(...newPts);
      } else {
        newVerts.push(verts[i]);
      }
    }
    face.vertices = newVerts;
  }
}

/**
 * Compute offset directions perpendicular to edge, lying on each face plane,
 * pointing into the face interior.
 */
function _computeOffsetDirs(face0, face1, edgeA, edgeB) {
  const n0 = _vec3Normalize(face0.normal);
  const n1 = _vec3Normalize(face1.normal);
  const edgeDir = _vec3Normalize(_vec3Sub(edgeB, edgeA));

  const offsDir0 = _vec3Normalize(_vec3Cross(n0, edgeDir));
  const offsDir1 = _vec3Normalize(_vec3Cross(edgeDir, n1));

  const cen0 = _faceCentroid(face0);
  if (_vec3Dot(offsDir0, _vec3Sub(cen0, edgeA)) < 0) {
    offsDir0.x = -offsDir0.x; offsDir0.y = -offsDir0.y; offsDir0.z = -offsDir0.z;
  }
  const cen1 = _faceCentroid(face1);
  if (_vec3Dot(offsDir1, _vec3Sub(cen1, edgeA)) < 0) {
    offsDir1.x = -offsDir1.x; offsDir1.y = -offsDir1.y; offsDir1.z = -offsDir1.z;
  }
  return { offsDir0, offsDir1, edgeDir };
}

/**
 * Find the two faces sharing a given edge key. Returns array of {fi, a, b}.
 */
function _findAdjacentFaces(faces, edgeKey) {
  const adj = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (_edgeKeyFromVerts(a, b) === edgeKey) {
        adj.push({ fi, a, b });
        break;
      }
    }
    if (adj.length >= 2) break;
  }
  return adj;
}

// -----------------------------------------------------------------------
// Chamfer geometry operation
// -----------------------------------------------------------------------

export function applyChamfer(geometry, edgeKeys, distance) {
  if (!geometry || !geometry.faces || edgeKeys.length === 0 || distance <= 0) {
    return geometry;
  }

  let faces = geometry.faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
  }));

  for (const ek of new Set(edgeKeys)) {
    const result = _chamferOneEdge(faces, ek, distance);
    if (result) faces = result;
  }

  const newGeom = { vertices: [], faces };
  const edgeResult = computeFeatureEdges(faces);
  newGeom.edges = edgeResult.edges;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}

function _chamferOneEdge(faces, edgeKey, dist) {
  const adj = _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const face0 = faces[adj[0].fi];
  const face1 = faces[adj[1].fi];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  // Pre-compute face edge keys before any modifications
  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1 } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  const p0a = _vec3Add(edgeA, _vec3Scale(offsDir0, dist));
  const p0b = _vec3Add(edgeB, _vec3Scale(offsDir0, dist));
  const p1a = _vec3Add(edgeA, _vec3Scale(offsDir1, dist));
  const p1b = _vec3Add(edgeB, _vec3Scale(offsDir1, dist));

  // Trim the two adjacent faces
  _trimFaceEdge(face0, edgeA, edgeB, p0a, p0b);
  _trimFaceEdge(face1, edgeA, edgeB, p1a, p1b);

  // Split vertices at edge endpoints in all other faces
  _splitVertexAtEndpoint(faces, adj[0].fi, adj[1].fi, edgeA, p0a, p1a, face0Keys, face1Keys);
  _splitVertexAtEndpoint(faces, adj[0].fi, adj[1].fi, edgeB, p0b, p1b, face0Keys, face1Keys);

  // Chamfer bevel face: [p0a, p1a, p1b, p0b] — correct CCW winding for outward normal
  const chamferNormal = _vec3Normalize(_vec3Cross(
    _vec3Sub(p1a, p0a), _vec3Sub(p1b, p0a)
  ));
  faces.push({
    vertices: [{ ...p0a }, { ...p1a }, { ...p1b }, { ...p0b }],
    normal: chamferNormal,
    shared: face0.shared ? { ...face0.shared } : null,
  });

  return faces;
}

// -----------------------------------------------------------------------
// Fillet geometry operation
// -----------------------------------------------------------------------

export function applyFillet(geometry, edgeKeys, radius, segments = 8) {
  if (!geometry || !geometry.faces || edgeKeys.length === 0 || radius <= 0) {
    return geometry;
  }

  let faces = geometry.faces.map(f => ({
    vertices: f.vertices.map(v => ({ ...v })),
    normal: { ...f.normal },
    shared: f.shared ? { ...f.shared } : null,
  }));

  for (const ek of new Set(edgeKeys)) {
    const result = _filletOneEdge(faces, ek, radius, segments);
    if (result) faces = result;
  }

  const newGeom = { vertices: [], faces };
  const edgeResult = computeFeatureEdges(faces);
  newGeom.edges = edgeResult.edges;
  newGeom.visualEdges = edgeResult.visualEdges;
  return newGeom;
}

function _filletOneEdge(faces, edgeKey, radius, segments) {
  const adj = _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const face0 = faces[adj[0].fi];
  const face1 = faces[adj[1].fi];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  // Pre-compute face edge keys before any modifications
  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1 } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  // Angle between offset directions determines arc geometry
  const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
  if (alpha < 1e-6) return null; // Faces nearly coplanar

  const tangentDist = radius / Math.tan(alpha / 2);
  const centerDist = radius / Math.sin(alpha / 2);
  const sweep = Math.PI - alpha;

  // Bisector points into the interior angle between the two faces
  const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));

  // Trim points on each face
  const t0a = _vec3Add(edgeA, _vec3Scale(offsDir0, tangentDist));
  const t0b = _vec3Add(edgeB, _vec3Scale(offsDir0, tangentDist));
  const t1a = _vec3Add(edgeA, _vec3Scale(offsDir1, tangentDist));
  const t1b = _vec3Add(edgeB, _vec3Scale(offsDir1, tangentDist));

  // Compute arc points at each endpoint using proper circular arc
  function computeArc(vertex) {
    const center = _vec3Add(vertex, _vec3Scale(bisector, centerDist));
    const t0 = _vec3Add(vertex, _vec3Scale(offsDir0, tangentDist));
    const e0 = _vec3Normalize(_vec3Sub(t0, center));
    const t1 = _vec3Add(vertex, _vec3Scale(offsDir1, tangentDist));
    const e1 = _vec3Normalize(_vec3Sub(t1, center));

    // Perpendicular in the arc plane: perp = (e1 - cos(sweep)*e0) / sin(sweep)
    const cosSweep = Math.cos(sweep);
    const sinSweep = Math.sin(sweep);
    const perp = sinSweep > 1e-10
      ? _vec3Scale(_vec3Sub(e1, _vec3Scale(e0, cosSweep)), 1 / sinSweep)
      : e1;

    const points = [];
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * sweep;
      points.push(_vec3Add(center, _vec3Add(
        _vec3Scale(e0, radius * Math.cos(theta)),
        _vec3Scale(perp, radius * Math.sin(theta))
      )));
    }
    return points;
  }

  const arcA = computeArc(edgeA);
  const arcB = computeArc(edgeB);

  // Trim the two adjacent faces
  _trimFaceEdge(face0, edgeA, edgeB, t0a, t0b);
  _trimFaceEdge(face1, edgeA, edgeB, t1a, t1b);

  // Split vertices at edge endpoints in all other faces
  _splitVertexAtEndpoint(faces, adj[0].fi, adj[1].fi, edgeA, t0a, t1a, face0Keys, face1Keys);
  _splitVertexAtEndpoint(faces, adj[0].fi, adj[1].fi, edgeB, t0b, t1b, face0Keys, face1Keys);

  // Create fillet strip quads: [arcA[s], arcA[s+1], arcB[s+1], arcB[s]]
  const shared = face0.shared ? { ...face0.shared } : null;
  for (let s = 0; s < segments; s++) {
    const faceNormal = _vec3Normalize(_vec3Cross(
      _vec3Sub(arcA[s + 1], arcA[s]),
      _vec3Sub(arcB[s + 1], arcA[s])
    ));
    faces.push({
      vertices: [{ ...arcA[s] }, { ...arcA[s + 1] }, { ...arcB[s + 1] }, { ...arcB[s] }],
      normal: faceNormal,
      shared,
    });
  }

  // Fan triangles at vertex A endpoint (fills crescent between arc and cap face)
  for (let s = 1; s < segments; s++) {
    const triNormal = _vec3Normalize(_vec3Cross(
      _vec3Sub(arcA[s + 1], arcA[0]),
      _vec3Sub(arcA[s], arcA[0])
    ));
    faces.push({
      vertices: [{ ...arcA[0] }, { ...arcA[s + 1] }, { ...arcA[s] }],
      normal: triNormal,
      shared,
    });
  }

  // Fan triangles at vertex B endpoint (opposite winding)
  for (let s = 1; s < segments; s++) {
    const triNormal = _vec3Normalize(_vec3Cross(
      _vec3Sub(arcB[s], arcB[0]),
      _vec3Sub(arcB[s + 1], arcB[0])
    ));
    faces.push({
      vertices: [{ ...arcB[0] }, { ...arcB[s] }, { ...arcB[s + 1] }],
      normal: triNormal,
      shared,
    });
  }

  return faces;
}

/**
 * Make an edge key from two vertex positions (for persistent edge identity).
 */
export function makeEdgeKey(a, b) {
  return _edgeKeyFromVerts(a, b);
}
