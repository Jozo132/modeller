// js/ui/viewcube.js — Navigation ViewCube widget
//
// Renders a 3D orientation cube with chamfered edges and corners in the
// top-right corner of the viewport. Clicking faces, edges, or corners
// navigates to the corresponding standard view.
//
// Coordinate convention: right-handed, Z-up.
//   FRONT  = -Y  (camera on +Y looking toward -Y)
//   BACK   = +Y
//   RIGHT  = +X  (camera on -X looking toward +X → wait, RIGHT means looking from +X)
//   LEFT   = -X
//   TOP    = +Z
//   BOTTOM = -Z

const CUBE_SIZE_DEFAULT = 120;  // widget pixel size (desktop)
const CUBE_SIZE_MOBILE  = 70;   // widget pixel size (mobile)
const MARGIN    = 12;          // distance from viewport edges
const CHAMFER   = 0.25;        // chamfer ratio (0–0.5)

/** Return the cube size, reduced on small (mobile) screens. */
function getCubeSize() {
  return (typeof window !== 'undefined' && window.innerWidth < 780) ? CUBE_SIZE_MOBILE : CUBE_SIZE_DEFAULT;
}

// Face label definitions: name → outward normal (world space)
const FACE_DEFS = [
  { name: 'FRONT',  normal: [ 0, -1,  0] },
  { name: 'BACK',   normal: [ 0,  1,  0] },
  { name: 'RIGHT',  normal: [ 1,  0,  0] },
  { name: 'LEFT',   normal: [-1,  0,  0] },
  { name: 'TOP',    normal: [ 0,  0,  1] },
  { name: 'BOTTOM', normal: [ 0,  0, -1] },
];

// Camera orbit angles (theta, phi) for each standard view.
// theta = azimuthal (around Z), phi = polar (from +Z).
const VIEW_ANGLES = {
  // Faces
  FRONT:  { theta: -Math.PI / 2, phi: Math.PI / 2 },
  BACK:   { theta:  Math.PI / 2, phi: Math.PI / 2 },
  RIGHT:  { theta:  0,           phi: Math.PI / 2 },
  LEFT:   { theta:  Math.PI,     phi: Math.PI / 2 },
  TOP:    { theta: -Math.PI / 2, phi: 0.001 },
  BOTTOM: { theta: -Math.PI / 2, phi: Math.PI - 0.001 },
  // Edges (midpoint between two faces)
  'FRONT-TOP':    { theta: -Math.PI / 2, phi: Math.PI / 4 },
  'FRONT-BOTTOM': { theta: -Math.PI / 2, phi: 3 * Math.PI / 4 },
  'FRONT-RIGHT':  { theta: -Math.PI / 4, phi: Math.PI / 2 },
  'FRONT-LEFT':   { theta: -3 * Math.PI / 4, phi: Math.PI / 2 },
  'BACK-TOP':     { theta:  Math.PI / 2, phi: Math.PI / 4 },
  'BACK-BOTTOM':  { theta:  Math.PI / 2, phi: 3 * Math.PI / 4 },
  'BACK-RIGHT':   { theta:  Math.PI / 4, phi: Math.PI / 2 },
  'BACK-LEFT':    { theta:  3 * Math.PI / 4, phi: Math.PI / 2 },
  'RIGHT-TOP':    { theta:  0, phi: Math.PI / 4 },
  'RIGHT-BOTTOM': { theta:  0, phi: 3 * Math.PI / 4 },
  'LEFT-TOP':     { theta:  Math.PI, phi: Math.PI / 4 },
  'LEFT-BOTTOM':  { theta:  Math.PI, phi: 3 * Math.PI / 4 },
  // Corners (midpoint between three faces)
  'FRONT-RIGHT-TOP':    { theta: -Math.PI / 4,     phi: Math.atan(Math.SQRT2) },
  'FRONT-LEFT-TOP':     { theta: -3 * Math.PI / 4, phi: Math.atan(Math.SQRT2) },
  'FRONT-RIGHT-BOTTOM': { theta: -Math.PI / 4,     phi: Math.PI - Math.atan(Math.SQRT2) },
  'FRONT-LEFT-BOTTOM':  { theta: -3 * Math.PI / 4, phi: Math.PI - Math.atan(Math.SQRT2) },
  'BACK-RIGHT-TOP':     { theta:  Math.PI / 4,     phi: Math.atan(Math.SQRT2) },
  'BACK-LEFT-TOP':      { theta:  3 * Math.PI / 4, phi: Math.atan(Math.SQRT2) },
  'BACK-RIGHT-BOTTOM':  { theta:  Math.PI / 4,     phi: Math.PI - Math.atan(Math.SQRT2) },
  'BACK-LEFT-BOTTOM':   { theta:  3 * Math.PI / 4, phi: Math.PI - Math.atan(Math.SQRT2) },
};

// ─── Geometry helpers ──────────────────────────────────────────────────

function rotX(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function rotZ(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/** Build camera view matrix from orbit angles (theta, phi). */
function viewFromOrbit(theta, phi) {
  // Camera position on unit sphere
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const st = Math.sin(theta), ct = Math.cos(theta);
  const eye = [sp * ct, sp * st, cp];

  // forward = -eye (looking at origin)
  const fwd = [-eye[0], -eye[1], -eye[2]];

  // right = fwd × Z-up, then normalise
  let right = [fwd[1], -fwd[0], 0];
  let rLen = Math.hypot(right[0], right[1]);
  if (rLen < 1e-8) { right = [1, 0, 0]; rLen = 1; }
  right[0] /= rLen; right[1] /= rLen;

  // up = right × fwd
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];

  return { right, up, fwd, eye };
}

/** Orthographic project: world [x,y,z] → screen [sx,sy,depth]. */
function project(v, cam, cx, cy, scale) {
  const dx = v[0], dy = v[1], dz = v[2];
  const sx = cx + (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2]) * scale;
  const sy = cy - (dx * cam.up[0]    + dy * cam.up[1]    + dz * cam.up[2])    * scale;
  const depth = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
  return { x: sx, y: sy, z: depth };
}

// ─── Chamfered cube mesh ───────────────────────────────────────────────

/** Generate vertices for a cube with chamfered edges and corners.
 *  Returns { faces: [{verts, normal, region}], edges: [{a, b, region}] }
 *  All verts are in [-1,1]³ range.
 */
function buildChamferedCube(c) {
  const h = 1 - c; // half-extent of inner face
  const faces = [];

  // Helper: push a quad (as two triangles)
  const quad = (a, b, cc, d, normal, region) => {
    faces.push({ verts: [a, b, cc, d], normal, region });
  };

  // Main faces (6) — each is a smaller square inset by the chamfer
  // +X face
  quad([1, -h, -h], [1,  h, -h], [1, h, h], [1, -h, h], [1, 0, 0], 'RIGHT');
  // -X face
  quad([-1, h, -h], [-1, -h, -h], [-1, -h, h], [-1, h, h], [-1, 0, 0], 'LEFT');
  // +Y face
  quad([h, 1, -h], [-h, 1, -h], [-h, 1, h], [h, 1, h], [0, 1, 0], 'BACK');
  // -Y face
  quad([-h, -1, -h], [h, -1, -h], [h, -1, h], [-h, -1, h], [0, -1, 0], 'FRONT');
  // +Z face
  quad([-h, -h, 1], [h, -h, 1], [h, h, 1], [-h, h, 1], [0, 0, 1], 'TOP');
  // -Z face
  quad([-h, h, -1], [h, h, -1], [h, -h, -1], [-h, -h, -1], [0, 0, -1], 'BOTTOM');

  // Edge chamfer strips (12 edges, each a quad strip)
  const n707 = Math.SQRT1_2;

  // Edges along Z axis (4)
  quad([h, -1, -h], [1, -h, -h], [1, -h, h], [h, -1, h], [n707, -n707, 0], 'FRONT-RIGHT');
  quad([-1, -h, -h], [-h, -1, -h], [-h, -1, h], [-1, -h, h], [-n707, -n707, 0], 'FRONT-LEFT');
  quad([1, h, -h], [h, 1, -h], [h, 1, h], [1, h, h], [n707, n707, 0], 'BACK-RIGHT');
  quad([-h, 1, -h], [-1, h, -h], [-1, h, h], [-h, 1, h], [-n707, n707, 0], 'BACK-LEFT');

  // Edges along X axis (4)
  quad([-h, -1, h], [h, -1, h], [h, -h, 1], [-h, -h, 1], [0, -n707, n707], 'FRONT-TOP');
  quad([h, -1, -h], [-h, -1, -h], [-h, -h, -1], [h, -h, -1], [0, -n707, -n707], 'FRONT-BOTTOM');
  quad([h, 1, h], [-h, 1, h], [-h, h, 1], [h, h, 1], [0, n707, n707], 'BACK-TOP');
  quad([-h, 1, -h], [h, 1, -h], [h, h, -1], [-h, h, -1], [0, n707, -n707], 'BACK-BOTTOM');

  // Edges along Y axis (4)
  quad([1, -h, h], [1, h, h], [h, h, 1], [h, -h, 1], [n707, 0, n707], 'RIGHT-TOP');
  quad([1, h, -h], [1, -h, -h], [h, -h, -1], [h, h, -1], [n707, 0, -n707], 'RIGHT-BOTTOM');
  quad([-1, h, h], [-1, -h, h], [-h, -h, 1], [-h, h, 1], [-n707, 0, n707], 'LEFT-TOP');
  quad([-1, -h, -h], [-1, h, -h], [-h, h, -1], [-h, -h, -1], [-n707, 0, -n707], 'LEFT-BOTTOM');

  // Corner chamfer triangles (8 corners)
  const n577 = 1 / Math.sqrt(3);
  const tri = (a, b, cc, normal, region) => {
    faces.push({ verts: [a, b, cc], normal, region });
  };

  tri([1, -h, h], [h, -1, h], [h, -h, 1], [n577, -n577, n577], 'FRONT-RIGHT-TOP');
  tri([h, -1, -h], [1, -h, -h], [h, -h, -1], [n577, -n577, -n577], 'FRONT-RIGHT-BOTTOM');
  tri([-h, -1, h], [-1, -h, h], [-h, -h, 1], [-n577, -n577, n577], 'FRONT-LEFT-TOP');
  tri([-1, -h, -h], [-h, -1, -h], [-h, -h, -1], [-n577, -n577, -n577], 'FRONT-LEFT-BOTTOM');
  tri([h, 1, h], [1, h, h], [h, h, 1], [n577, n577, n577], 'BACK-RIGHT-TOP');
  tri([1, h, -h], [h, 1, -h], [h, h, -1], [n577, n577, -n577], 'BACK-RIGHT-BOTTOM');
  tri([-1, h, h], [-h, 1, h], [-h, h, 1], [-n577, n577, n577], 'BACK-LEFT-TOP');
  tri([-h, 1, -h], [-1, h, -h], [-h, h, -1], [-n577, n577, -n577], 'BACK-LEFT-BOTTOM');

  return faces;
}

// ─── ViewCube class ────────────────────────────────────────────────────

export class ViewCube {
  /**
   * @param {HTMLElement} container — the viewport element to attach to
   * @param {object} opts
   * @param {() => {theta:number, phi:number}} opts.getOrbit — read current orbit angles
   * @param {(theta:number, phi:number) => void} opts.setOrbit — animate to orbit angles
   */
  constructor(container, { getOrbit, setOrbit } = {}) {
    this._container = container;
    this._getOrbit = getOrbit;
    this._setOrbit = setOrbit;
    this._hovered = null;
    this._faces = buildChamferedCube(CHAMFER);

    // Create canvas
    const dpr = window.devicePixelRatio || 1;
    const size = getCubeSize();
    const canvas = document.createElement('canvas');
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.position = 'absolute';
    canvas.style.top = MARGIN + 'px';
    canvas.style.right = MARGIN + 'px';
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    canvas.style.zIndex = '50';
    canvas.style.cursor = 'pointer';
    canvas.style.pointerEvents = 'auto';
    container.appendChild(canvas);

    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._dpr = dpr;
    this._size = size;

    // Interaction
    canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    canvas.addEventListener('mouseleave', () => { this._hovered = null; this.render(); });
    canvas.addEventListener('click', (e) => this._onClick(e));

    // Initial render
    this.render();
  }

  /** Render the cube to reflect the current camera orientation. */
  render() {
    const orbit = this._getOrbit ? this._getOrbit() : { theta: Math.PI / 4, phi: Math.PI / 3 };
    const { theta, phi } = orbit;
    const cam = viewFromOrbit(theta, phi);

    const dpr = this._dpr;
    const ctx = this._ctx;
    const size = this._size;
    const cx = size / 2;
    const cy = size / 2;
    const scale = size * 0.3;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Painter's algorithm: sort faces by depth (back to front)
    const projected = this._faces.map((face) => {
      // Centroid depth
      let zSum = 0;
      const pts = face.verts.map(v => {
        const p = project(v, cam, cx, cy, scale);
        zSum += p.z;
        return p;
      });
      return { ...face, pts, zAvg: zSum / face.verts.length };
    });
    projected.sort((a, b) => a.zAvg - b.zAvg);

    // Store projected faces for hit testing (front to back order)
    this._projected = projected.slice().reverse();

    // Draw faces
    for (const face of projected) {
      const { pts, normal, region } = face;
      // Lighting: simple directional from camera
      const dot = normal[0] * cam.eye[0] + normal[1] * cam.eye[1] + normal[2] * cam.eye[2];
      if (dot < -0.05) continue; // backface cull

      const isHover = this._hovered === region;
      const brightness = 0.35 + 0.45 * Math.max(0, dot);
      const isFace = FACE_DEFS.some(f => f.name === region);

      let fillR, fillG, fillB;
      if (isHover) {
        fillR = 60; fillG = 160; fillB = 255;
      } else if (isFace) {
        const base = Math.round(brightness * 255);
        fillR = Math.round(base * 0.42);
        fillG = Math.round(base * 0.46);
        fillB = Math.round(base * 0.52);
      } else {
        // Edge/corner — slightly darker
        const base = Math.round(brightness * 220);
        fillR = Math.round(base * 0.35);
        fillG = Math.round(base * 0.38);
        fillB = Math.round(base * 0.42);
      }

      ctx.fillStyle = `rgb(${fillR},${fillG},${fillB})`;
      ctx.strokeStyle = `rgba(80,90,100,${isHover ? 0.9 : 0.5})`;
      ctx.lineWidth = 0.5;

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Draw face labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const fd of FACE_DEFS) {
      const n = fd.normal;
      // Visibility: face normal must point toward camera
      const dot = n[0] * cam.eye[0] + n[1] * cam.eye[1] + n[2] * cam.eye[2];
      if (dot < 0.15) continue;

      const center = project(n, cam, cx, cy, scale);
      const alpha = Math.min(1, (dot - 0.15) / 0.5);

      const isHover = this._hovered === fd.name;
      ctx.fillStyle = isHover ? '#ffffff' : `rgba(200,210,220,${alpha})`;
      const fontSize = fd.name.length > 4 ? 8 : 10;
      ctx.font = `bold ${fontSize}px "Segoe UI", Arial, sans-serif`;
      ctx.fillText(fd.name, center.x, center.y);
    }

    // Draw axis indicators at bottom-left of cube
    this._drawAxisIndicators(ctx, cam, size * 0.15, size - size * 0.15, size * 0.12);
  }

  _drawAxisIndicators(ctx, cam, cx, cy, len) {
    const axes = [
      { label: 'X', dir: [1, 0, 0], color: '#ff4444' },
      { label: 'Y', dir: [0, 1, 0], color: '#44ff44' },
      { label: 'Z', dir: [0, 0, 1], color: '#4488ff' },
    ];
    for (const axis of axes) {
      const tip = project(axis.dir, cam, cx, cy, len);
      const orig = project([0, 0, 0], cam, cx, cy, len);
      ctx.strokeStyle = axis.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(orig.x, orig.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.fillStyle = axis.color;
      ctx.font = 'bold 9px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const dx = tip.x - orig.x, dy = tip.y - orig.y;
      const d = Math.hypot(dx, dy) || 1;
      ctx.fillText(axis.label, tip.x + (dx / d) * 7, tip.y + (dy / d) * 7);
    }
  }

  /** Hit-test: find which region the mouse is over. */
  _hitTest(mx, my) {
    if (!this._projected) return null;
    const ctx = this._ctx;
    for (const face of this._projected) {
      // Only test front-facing faces
      const orbit = this._getOrbit ? this._getOrbit() : { theta: Math.PI / 4, phi: Math.PI / 3 };
      const cam = viewFromOrbit(orbit.theta, orbit.phi);
      const dot = face.normal[0] * cam.eye[0] + face.normal[1] * cam.eye[1] + face.normal[2] * cam.eye[2];
      if (dot < -0.05) continue;

      ctx.beginPath();
      ctx.moveTo(face.pts[0].x, face.pts[0].y);
      for (let i = 1; i < face.pts.length; i++) ctx.lineTo(face.pts[i].x, face.pts[i].y);
      ctx.closePath();
      if (ctx.isPointInPath(mx * this._dpr, my * this._dpr)) {
        return face.region;
      }
    }
    return null;
  }

  _onMouseMove(e) {
    const rect = this._canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const region = this._hitTest(mx, my);
    if (region !== this._hovered) {
      this._hovered = region;
      this.render();
    }
  }

  _onClick(e) {
    const rect = this._canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const region = this._hitTest(mx, my);
    if (region && VIEW_ANGLES[region] && this._setOrbit) {
      const target = VIEW_ANGLES[region];
      this._setOrbit(target.theta, target.phi);
    }
  }

  /** Show or hide the ViewCube. */
  setVisible(visible) {
    this._canvas.style.display = visible ? '' : 'none';
  }

  /** Remove the widget from the DOM. */
  dispose() {
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
  }
}
