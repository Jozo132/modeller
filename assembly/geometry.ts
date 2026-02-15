import { Mat4, Color } from "./math";
import { CommandBuffer } from "./commands";

// Box face data: 6 faces × 2 triangles × 3 vertices = 36 vertices
// Each face defined by 4 corners and a normal direction

export function generateBox(
  cmd: CommandBuffer,
  mvp: Mat4,
  color: Color,
  sizeX: f32, sizeY: f32, sizeZ: f32,
  posX: f32, posY: f32, posZ: f32
): void {
  const hx: f32 = sizeX * 0.5;
  const hy: f32 = sizeY * 0.5;
  const hz: f32 = sizeZ * 0.5;

  // 36 vertices × 3 components
  const verts = new StaticArray<f32>(108);
  const norms = new StaticArray<f32>(108);

  let vi: i32 = 0;

  // Helper to add a triangle
  // Each call adds 3 vertices (9 floats) and 3 normals (9 floats)

  // Front face (+Z)
  vi = addQuad(verts, norms, vi, posX, posY, posZ,
    -hx, -hy, hz,  hx, -hy, hz,  hx, hy, hz,  -hx, hy, hz,
    0, 0, 1);

  // Back face (-Z)
  vi = addQuad(verts, norms, vi, posX, posY, posZ,
    hx, -hy, -hz,  -hx, -hy, -hz,  -hx, hy, -hz,  hx, hy, -hz,
    0, 0, -1);

  // Right face (+X)
  vi = addQuad(verts, norms, vi, posX, posY, posZ,
    hx, -hy, hz,  hx, -hy, -hz,  hx, hy, -hz,  hx, hy, hz,
    1, 0, 0);

  // Left face (-X)
  vi = addQuad(verts, norms, vi, posX, posY, posZ,
    -hx, -hy, -hz,  -hx, -hy, hz,  -hx, hy, hz,  -hx, hy, -hz,
    -1, 0, 0);

  // Top face (+Y)
  vi = addQuad(verts, norms, vi, posX, posY, posZ,
    -hx, hy, hz,  hx, hy, hz,  hx, hy, -hz,  -hx, hy, -hz,
    0, 1, 0);

  // Bottom face (-Y)
  vi = addQuad(verts, norms, vi, posX, posY, posZ,
    -hx, -hy, -hz,  hx, -hy, -hz,  hx, -hy, hz,  -hx, -hy, hz,
    0, -1, 0);

  // Emit solid triangles
  cmd.emitSetProgram(0);
  cmd.emitSetMatrix(mvp);
  cmd.emitSetColor(color.r, color.g, color.b, color.a);
  cmd.emitDrawTriangles(verts, norms, 36);

  // Emit wireframe edges
  const edgeVerts = new StaticArray<f32>(72); // 12 edges × 2 vertices × 3 components
  let ei: i32 = 0;

  // 12 edges of a box
  // Bottom face edges
  ei = addEdge(edgeVerts, ei, posX - hx, posY - hy, posZ - hz, posX + hx, posY - hy, posZ - hz);
  ei = addEdge(edgeVerts, ei, posX + hx, posY - hy, posZ - hz, posX + hx, posY + hy, posZ - hz);
  ei = addEdge(edgeVerts, ei, posX + hx, posY + hy, posZ - hz, posX - hx, posY + hy, posZ - hz);
  ei = addEdge(edgeVerts, ei, posX - hx, posY + hy, posZ - hz, posX - hx, posY - hy, posZ - hz);

  // Top face edges
  ei = addEdge(edgeVerts, ei, posX - hx, posY - hy, posZ + hz, posX + hx, posY - hy, posZ + hz);
  ei = addEdge(edgeVerts, ei, posX + hx, posY - hy, posZ + hz, posX + hx, posY + hy, posZ + hz);
  ei = addEdge(edgeVerts, ei, posX + hx, posY + hy, posZ + hz, posX - hx, posY + hy, posZ + hz);
  ei = addEdge(edgeVerts, ei, posX - hx, posY + hy, posZ + hz, posX - hx, posY - hy, posZ + hz);

  // Vertical edges
  ei = addEdge(edgeVerts, ei, posX - hx, posY - hy, posZ - hz, posX - hx, posY - hy, posZ + hz);
  ei = addEdge(edgeVerts, ei, posX + hx, posY - hy, posZ - hz, posX + hx, posY - hy, posZ + hz);
  ei = addEdge(edgeVerts, ei, posX + hx, posY + hy, posZ - hz, posX + hx, posY + hy, posZ + hz);
  ei = addEdge(edgeVerts, ei, posX - hx, posY + hy, posZ - hz, posX - hx, posY + hy, posZ + hz);

  cmd.emitSetProgram(1);
  cmd.emitSetColor(0.0, 0.0, 0.0, 1.0);
  cmd.emitSetLineWidth(1.0);
  cmd.emitDrawLines(edgeVerts, 24);
}

function addQuad(
  verts: StaticArray<f32>, norms: StaticArray<f32>, vi: i32,
  px: f32, py: f32, pz: f32,
  x0: f32, y0: f32, z0: f32,
  x1: f32, y1: f32, z1: f32,
  x2: f32, y2: f32, z2: f32,
  x3: f32, y3: f32, z3: f32,
  nx: f32, ny: f32, nz: f32
): i32 {
  // Triangle 1: v0, v1, v2
  vi = addVertex(verts, norms, vi, px + x0, py + y0, pz + z0, nx, ny, nz);
  vi = addVertex(verts, norms, vi, px + x1, py + y1, pz + z1, nx, ny, nz);
  vi = addVertex(verts, norms, vi, px + x2, py + y2, pz + z2, nx, ny, nz);
  // Triangle 2: v0, v2, v3
  vi = addVertex(verts, norms, vi, px + x0, py + y0, pz + z0, nx, ny, nz);
  vi = addVertex(verts, norms, vi, px + x2, py + y2, pz + z2, nx, ny, nz);
  vi = addVertex(verts, norms, vi, px + x3, py + y3, pz + z3, nx, ny, nz);
  return vi;
}

@inline
function addVertex(
  verts: StaticArray<f32>, norms: StaticArray<f32>, vi: i32,
  x: f32, y: f32, z: f32, nx: f32, ny: f32, nz: f32
): i32 {
  unchecked(verts[vi] = x);
  unchecked(verts[vi + 1] = y);
  unchecked(verts[vi + 2] = z);
  unchecked(norms[vi] = nx);
  unchecked(norms[vi + 1] = ny);
  unchecked(norms[vi + 2] = nz);
  return vi + 3;
}

@inline
function addEdge(
  verts: StaticArray<f32>, ei: i32,
  x1: f32, y1: f32, z1: f32,
  x2: f32, y2: f32, z2: f32
): i32 {
  unchecked(verts[ei] = x1);
  unchecked(verts[ei + 1] = y1);
  unchecked(verts[ei + 2] = z1);
  unchecked(verts[ei + 3] = x2);
  unchecked(verts[ei + 4] = y2);
  unchecked(verts[ei + 5] = z2);
  return ei + 6;
}

export function generateGridLines(
  cmd: CommandBuffer,
  mvp: Mat4,
  size: f32,
  divisions: i32,
  color: Color
): void {
  const half: f32 = size * 0.5;
  const step: f32 = size / <f32>divisions;
  const lineCount: i32 = (divisions + 1) * 2; // lines along X + lines along Y
  const vertCount: i32 = lineCount * 2;
  const verts = new StaticArray<f32>(vertCount * 3);

  let vi: i32 = 0;

  // Lines parallel to Y axis
  for (let i: i32 = 0; i <= divisions; i++) {
    const x: f32 = -half + <f32>i * step;
    vi = addEdge(verts, vi, x, -half, 0, x, half, 0);
  }

  // Lines parallel to X axis
  for (let i: i32 = 0; i <= divisions; i++) {
    const y: f32 = -half + <f32>i * step;
    vi = addEdge(verts, vi, -half, y, 0, half, y, 0);
  }

  cmd.emitSetProgram(1);
  cmd.emitSetMatrix(mvp);
  cmd.emitSetColor(color.r, color.g, color.b, color.a);
  cmd.emitSetLineWidth(1.0);
  cmd.emitDrawLines(verts, vertCount);
}

export function generateAxes(
  cmd: CommandBuffer,
  mvp: Mat4,
  size: f32
): void {
  const verts = new StaticArray<f32>(18); // 3 axes × 2 vertices × 3 components

  // X axis
  unchecked(verts[0]  = 0); unchecked(verts[1]  = 0); unchecked(verts[2]  = 0);
  unchecked(verts[3]  = size); unchecked(verts[4]  = 0); unchecked(verts[5]  = 0);
  // Y axis
  unchecked(verts[6]  = 0); unchecked(verts[7]  = 0); unchecked(verts[8]  = 0);
  unchecked(verts[9]  = 0); unchecked(verts[10] = size); unchecked(verts[11] = 0);
  // Z axis
  unchecked(verts[12] = 0); unchecked(verts[13] = 0); unchecked(verts[14] = 0);
  unchecked(verts[15] = 0); unchecked(verts[16] = 0); unchecked(verts[17] = size);

  cmd.emitSetProgram(1);
  cmd.emitSetMatrix(mvp);
  cmd.emitSetLineWidth(2.0);

  // X axis - Red
  const xVerts = new StaticArray<f32>(6);
  unchecked(xVerts[0] = 0); unchecked(xVerts[1] = 0); unchecked(xVerts[2] = 0);
  unchecked(xVerts[3] = size); unchecked(xVerts[4] = 0); unchecked(xVerts[5] = 0);
  cmd.emitSetColor(1.0, 0.0, 0.0, 1.0);
  cmd.emitDrawLines(xVerts, 2);

  // Y axis - Green
  const yVerts = new StaticArray<f32>(6);
  unchecked(yVerts[0] = 0); unchecked(yVerts[1] = 0); unchecked(yVerts[2] = 0);
  unchecked(yVerts[3] = 0); unchecked(yVerts[4] = size); unchecked(yVerts[5] = 0);
  cmd.emitSetColor(0.0, 1.0, 0.0, 1.0);
  cmd.emitDrawLines(yVerts, 2);

  // Z axis - Blue
  const zVerts = new StaticArray<f32>(6);
  unchecked(zVerts[0] = 0); unchecked(zVerts[1] = 0); unchecked(zVerts[2] = 0);
  unchecked(zVerts[3] = 0); unchecked(zVerts[4] = 0); unchecked(zVerts[5] = size);
  cmd.emitSetColor(0.0, 0.0, 1.0, 1.0);
  cmd.emitDrawLines(zVerts, 2);
}

export function generateLineSegment(
  cmd: CommandBuffer,
  mvp: Mat4,
  color: Color,
  x1: f32, y1: f32, z1: f32,
  x2: f32, y2: f32, z2: f32
): void {
  const verts = new StaticArray<f32>(6);
  unchecked(verts[0] = x1); unchecked(verts[1] = y1); unchecked(verts[2] = z1);
  unchecked(verts[3] = x2); unchecked(verts[4] = y2); unchecked(verts[5] = z2);

  cmd.emitSetProgram(1);
  cmd.emitSetMatrix(mvp);
  cmd.emitSetColor(color.r, color.g, color.b, color.a);
  cmd.emitDrawLines(verts, 2);
}

export function generateTriangles(
  cmd: CommandBuffer,
  mvp: Mat4,
  color: Color,
  vertices: StaticArray<f32>,
  normals: StaticArray<f32>,
  count: i32
): void {
  cmd.emitSetProgram(0);
  cmd.emitSetMatrix(mvp);
  cmd.emitSetColor(color.r, color.g, color.b, color.a);
  cmd.emitDrawTriangles(vertices, normals, count);
}
