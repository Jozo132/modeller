// WGSL compute shader for GPU-side NURBS surface tessellation.
//
// Evaluates NURBS surface points + normals on the GPU using Cox-de Boor
// basis functions. Input: surface headers, knot vectors, control points
// from the WASM kernel/gpu.ts batch buffers. Output: position + normal
// per tessellation vertex, written directly to a vertex buffer.
//
// This matches the std430 layout from assembly/kernel/gpu.ts:
//   GpuSurfaceHeader: 12 × u32 = 48 bytes
//   GpuControlPoint:  4 × f32 = 16 bytes (x,y,z,w)
//   Knots:            1 × f32 each

export const NURBS_TESS_WGSL = /* wgsl */`

// ─── Bindings ────────────────────────────────────────────────────────

struct SurfaceHeader {
  degreeU:    u32,
  degreeV:    u32,
  numCtrlU:   u32,
  numCtrlV:   u32,
  knotOffsetU: u32,
  knotOffsetV: u32,
  ctrlOffset:  u32,
  tessSegsU:   u32,
  tessSegsV:   u32,
  _pad0:       u32,
  _pad1:       u32,
  _pad2:       u32,
};

struct ControlPoint {
  x: f32,
  y: f32,
  z: f32,
  w: f32,
};

struct TessVertex {
  px: f32, py: f32, pz: f32, _ppad: f32,
  nx: f32, ny: f32, nz: f32, _npad: f32,
};

@group(0) @binding(0) var<storage, read> headers: array<SurfaceHeader>;
@group(0) @binding(1) var<storage, read> ctrlPts: array<ControlPoint>;
@group(0) @binding(2) var<storage, read> knots:   array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<TessVertex>;

// Uniform: surfaceIndex and output vertex offset
struct Params {
  surfaceIndex: u32,
  vertexOffset: u32,
  _pad0: u32,
  _pad1: u32,
};
@group(0) @binding(4) var<uniform> params: Params;

// ─── Constants ───────────────────────────────────────────────────────

const MAX_DEGREE: u32 = 15u;
const MAX_ORDER:  u32 = 16u; // MAX_DEGREE + 1

// ─── Cox-de Boor basis evaluation ────────────────────────────────────

// Evaluate B-spline basis functions at parameter t.
// Writes non-zero basis values into basisOut[0..degree].
// Returns the span index (first non-zero basis function index).
fn bSplineBasis(
  degree: u32,
  numCtrl: u32,
  knotOffset: u32,
  t: f32,
  basisOut: ptr<function, array<f32, 16>>,
  basisDeriv: ptr<function, array<f32, 16>>,
) -> u32 {
  let n = numCtrl;
  let p = degree;
  let numKnots = n + p + 1u;

  // Find span (clamped binary search)
  var span = p;
  for (var i = p + 1u; i < n; i++) {
    if (t < knots[knotOffset + i]) {
      break;
    }
    span = i;
  }

  // De Boor recursion
  var left:  array<f32, 16>;
  var right: array<f32, 16>;

  (*basisOut)[0] = 1.0;

  for (var j = 1u; j <= p; j++) {
    left[j]  = t - knots[knotOffset + span + 1u - j];
    right[j] = knots[knotOffset + span + j] - t;
    var saved = 0.0f;
    for (var r = 0u; r < j; r++) {
      let denom = right[r + 1u] + left[j - r];
      if (abs(denom) < 1e-10) {
        (*basisOut)[r] = saved;
        saved = 0.0;
        continue;
      }
      let temp = (*basisOut)[r] / denom;
      (*basisOut)[r] = saved + right[r + 1u] * temp;
      saved = left[j - r] * temp;
    }
    (*basisOut)[j] = saved;
  }

  // Derivatives (first order)
  for (var j = 0u; j <= p; j++) {
    (*basisDeriv)[j] = 0.0;
  }
  if (p > 0u) {
    for (var j = 0u; j <= p; j++) {
      let jm1 = select(0.0, (*basisOut)[j - 1u], j > 0u);
      let jp0 = select(0.0, (*basisOut)[j], j <= p);
      let leftK  = knots[knotOffset + span + 1u + j - p] ;
      let rightK = knots[knotOffset + span + 1u + j];
      let denomL = select(1.0, knots[knotOffset + span + j] - leftK, j > 0u);
      let denomR = select(1.0, rightK - knots[knotOffset + span + 1u + j - p], j < p);

      var d = 0.0f;
      if (j > 0u && abs(denomL) > 1e-10) {
        d += f32(p) * jm1 / denomL;
      }
      if (j < p && abs(denomR) > 1e-10) {
        d -= f32(p) * jp0 / denomR;
      }
      (*basisDeriv)[j] = d;
    }
  }

  return span;
}

// ─── Main compute kernel ─────────────────────────────────────────────

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let surfIdx = params.surfaceIndex;
  let hdr = headers[surfIdx];

  let segsU = hdr.tessSegsU;
  let segsV = hdr.tessSegsV;
  let totalVerts = (segsU + 1u) * (segsV + 1u);

  let vertIdx = gid.x;
  if (vertIdx >= totalVerts) {
    return;
  }

  let iu = vertIdx / (segsV + 1u);
  let iv = vertIdx % (segsV + 1u);

  // Map grid indices to parameter values
  let uMin = knots[hdr.knotOffsetU + hdr.degreeU];
  let uMax = knots[hdr.knotOffsetU + hdr.numCtrlU];
  let vMin = knots[hdr.knotOffsetV + hdr.degreeV];
  let vMax = knots[hdr.knotOffsetV + hdr.numCtrlV];

  let u = uMin + (f32(iu) / f32(segsU)) * (uMax - uMin);
  let v = vMin + (f32(iv) / f32(segsV)) * (vMax - vMin);

  // Evaluate basis functions
  var basisU:  array<f32, 16>;
  var basisV:  array<f32, 16>;
  var dBasisU: array<f32, 16>;
  var dBasisV: array<f32, 16>;

  let spanU = bSplineBasis(hdr.degreeU, hdr.numCtrlU, hdr.knotOffsetU, u, &basisU, &dBasisU);
  let spanV = bSplineBasis(hdr.degreeV, hdr.numCtrlV, hdr.knotOffsetV, v, &basisV, &dBasisV);

  // Evaluate surface point + partial derivatives (rational)
  var pos  = vec3f(0.0);
  var dPdU = vec3f(0.0);
  var dPdV = vec3f(0.0);
  var wSum  = 0.0f;
  var dwdU  = 0.0f;
  var dwdV  = 0.0f;

  for (var ki = 0u; ki <= hdr.degreeU; ki++) {
    let ctrlRowStart = hdr.ctrlOffset + (spanU - hdr.degreeU + ki) * hdr.numCtrlV;
    let Nu  = basisU[ki];
    let dNu = dBasisU[ki];

    for (var kj = 0u; kj <= hdr.degreeV; kj++) {
      let ctrlIdx = ctrlRowStart + spanV - hdr.degreeV + kj;
      let cp = ctrlPts[ctrlIdx];
      let Nv  = basisV[kj];
      let dNv = dBasisV[kj];

      let w = cp.w;
      let NuNv = Nu * Nv;
      let pt = vec3f(cp.x, cp.y, cp.z) * w;

      pos  += NuNv * pt;
      wSum += NuNv * w;

      dPdU += dNu * Nv * pt;
      dwdU += dNu * Nv * w;

      dPdV += Nu * dNv * pt;
      dwdV += Nu * dNv * w;
    }
  }

  // Rational projection
  let invW = select(1.0, 1.0 / wSum, abs(wSum) > 1e-10);
  let S = pos * invW;

  // Rational derivatives: dS/du = (dPdU - dwdU * S) / wSum
  let dSdU = (dPdU - dwdU * S) * invW;
  let dSdV = (dPdV - dwdV * S) * invW;

  // Normal = cross(dSdU, dSdV), normalized
  var normal = cross(dSdU, dSdV);
  let nLen = length(normal);
  if (nLen > 1e-10) {
    normal = normal / nLen;
  }

  // Write output
  let outIdx = params.vertexOffset + vertIdx;
  output[outIdx].px = S.x;
  output[outIdx].py = S.y;
  output[outIdx].pz = S.z;
  output[outIdx]._ppad = 1.0;
  output[outIdx].nx = normal.x;
  output[outIdx].ny = normal.y;
  output[outIdx].nz = normal.z;
  output[outIdx]._npad = 0.0;
}
`;
