import { Vec3, Mat4, Color } from "./math";
import { Camera } from "./camera";
import { CommandBuffer } from "./commands";
import { generateBox, generateGridLines, generateAxes } from "./geometry";

// Geometry types
export const GEOM_BOX: i32 = 0;
export const GEOM_CUSTOM: i32 = 1;

export class SceneNode {
  id: i32;
  position: Vec3;
  rotation: Vec3;
  scaleVec: Vec3;
  color: Color;
  geometryType: i32;
  sizeX: f32;
  sizeY: f32;
  sizeZ: f32;
  visible: bool;

  constructor(id: i32) {
    this.id = id;
    this.position = new Vec3(0, 0, 0);
    this.rotation = new Vec3(0, 0, 0);
    this.scaleVec = new Vec3(1, 1, 1);
    this.color = new Color(0.7, 0.7, 0.7, 1.0);
    this.geometryType = GEOM_BOX;
    this.sizeX = 1;
    this.sizeY = 1;
    this.sizeZ = 1;
    this.visible = true;
  }

  getModelMatrix(): Mat4 {
    const t = Mat4.translation(this.position.x, this.position.y, this.position.z);
    const rx = Mat4.rotationX(this.rotation.x);
    const ry = Mat4.rotationY(this.rotation.y);
    const rz = Mat4.rotationZ(this.rotation.z);
    const s = Mat4.scaling(this.scaleVec.x, this.scaleVec.y, this.scaleVec.z);
    // T * Rz * Ry * Rx * S
    return t.multiply(rz).multiply(ry).multiply(rx).multiply(s);
  }
}

export class Scene {
  nodes: Array<SceneNode>;
  camera: Camera;
  canvasWidth: i32;
  canvasHeight: i32;

  gridVisible: bool;
  axesVisible: bool;
  gridSize: f32;
  gridDivisions: i32;
  gridColor: Color;
  axesSize: f32;

  private nextId: i32;

  constructor() {
    this.nodes = new Array<SceneNode>();
    this.camera = new Camera();
    this.canvasWidth = 800;
    this.canvasHeight = 600;
    this.gridVisible = true;
    this.axesVisible = true;
    this.gridSize = 20.0;
    this.gridDivisions = 20;
    this.gridColor = new Color(0.5, 0.5, 0.5, 0.5);
    this.axesSize = 5.0;
    this.nextId = 1;
  }

  addNode(): SceneNode {
    const node = new SceneNode(this.nextId);
    this.nextId++;
    this.nodes.push(node);
    return node;
  }

  removeNode(id: i32): void {
    for (let i: i32 = 0; i < this.nodes.length; i++) {
      if (unchecked(this.nodes[i]).id == id) {
        this.nodes.splice(i, 1);
        return;
      }
    }
  }

  getNode(id: i32): SceneNode | null {
    for (let i: i32 = 0; i < this.nodes.length; i++) {
      if (unchecked(this.nodes[i]).id == id) {
        return unchecked(this.nodes[i]);
      }
    }
    return null;
  }

  clear(): void {
    this.nodes = new Array<SceneNode>();
    this.nextId = 1;
  }

  renderScene(cmd: CommandBuffer): void {
    cmd.reset();

    // Clear
    cmd.emitClear(0.15, 0.15, 0.15, 1.0);
    cmd.emitSetDepthTest(true);

    // View-projection matrix
    const vp = this.camera.getViewProjectionMatrix();

    // Grid
    if (this.gridVisible) {
      generateGridLines(cmd, vp, this.gridSize, this.gridDivisions, this.gridColor);
    }

    // Axes
    if (this.axesVisible) {
      generateAxes(cmd, vp, this.axesSize);
    }

    // Nodes
    for (let i: i32 = 0; i < this.nodes.length; i++) {
      const node = unchecked(this.nodes[i]);
      if (!node.visible) continue;

      const model = node.getModelMatrix();
      const mvp = vp.multiply(model);

      if (node.geometryType == GEOM_BOX) {
        generateBox(cmd, mvp, node.color,
          node.sizeX, node.sizeY, node.sizeZ,
          0, 0, 0);
      }
    }

    cmd.emitEnd();
  }
}
