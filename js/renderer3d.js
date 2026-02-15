// renderer3d.js - Unified 3D rendering engine using Three.js for both 2D sketching and 3D viewing

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Renderer3D - Unified renderer for 2D sketching (orthographic view) and 3D viewing
 */
export class Renderer3D {
  constructor(container, viewport = null) {
    this.container = container;
    this.viewport = viewport; // Optional viewport for coordinate conversion
    this.scene = new THREE.Scene();
    this.perspectiveCamera = null;
    this.orthographicCamera = null;
    this.camera = null; // Active camera
    this.renderer = null;
    this.controls = null;
    this.meshes = new Map(); // Map of featureId -> mesh
    this.edges = new Map(); // Map of featureId -> edges
    this.sketchObjects = new Map(); // 2D sketch entities
    this.animationId = null;
    this.mode = '2d'; // '2d' for orthographic sketching, '3d' for perspective viewing
    
    // Grid and overlay objects
    this.gridPlane = null;
    this.gridLines = null;
    this.axesHelper = null;

    // Origin planes for 3D view (XY, XZ, YZ)
    this.originPlanes = {};
    this.originPlaneLabels = {};

    // Sketch mode state
    this.sketchMode = false;
    this.sketchPlane = null; // 'xy', 'xz', or 'yz'

    this.init();
  }

  init() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const aspect = width / height;

    // Setup perspective camera for 3D viewing
    this.perspectiveCamera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000);
    this.perspectiveCamera.position.set(300, 300, 300);
    this.perspectiveCamera.lookAt(0, 0, 0);

    // Setup orthographic camera for 2D sketching (top-down view)
    // Standard 2D coordinates: X+ right, Y+ up when looking down from +Z
    const viewSize = 500;
    this.orthographicCamera = new THREE.OrthographicCamera(
      -viewSize * aspect, viewSize * aspect,  // left, right
      viewSize, -viewSize,                     // top, bottom (Y+ at top of screen)
      0.1, 10000                               // near, far
    );
    this.orthographicCamera.position.set(0, 0, 500);
    this.orthographicCamera.lookAt(0, 0, 0);

    // Start with orthographic camera for 2D mode
    this.camera = this.orthographicCamera;

    // Setup renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x1e1e1e, 1); // Dark background like original 2D canvas
    this.container.appendChild(this.renderer.domElement);

    // Setup controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.25;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 5000;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 1.0;
    
    // In 2D mode, constrain rotation
    this.controls.enableRotate = false;

    // Setup lights (for 3D viewing)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight1.position.set(100, 200, 100);
    this.scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-100, -100, -100);
    this.scene.add(directionalLight2);

    // Create grid for 2D sketching on XY plane
    this.createSketchGrid();

    // Add axes helper
    this.axesHelper = new THREE.AxesHelper(100);
    this.scene.add(this.axesHelper);

    // Create origin planes for 3D view
    this.createOriginPlanes();

    // Handle window resize
    this.resizeHandler = () => this.onWindowResize();
    window.addEventListener('resize', this.resizeHandler);

    // Start animation loop
    this.animate();
  }

  /**
   * Create a grid on the XY plane for 2D sketching
   */
  createSketchGrid() {
    // Remove existing grid
    if (this.gridPlane) {
      this.scene.remove(this.gridPlane);
      this.gridPlane.geometry.dispose();
      this.gridPlane.material.dispose();
    }
    if (this.gridLines) {
      this.scene.remove(this.gridLines);
      this.gridLines.geometry.dispose();
      this.gridLines.material.dispose();
    }

    // Create grid lines on XY plane (Z=0)
    const gridSize = 1000;
    const gridDivisions = 100;
    const gridStep = gridSize / gridDivisions;
    
    const gridGeometry = new THREE.BufferGeometry();
    const vertices = [];
    
    // Horizontal lines
    for (let i = 0; i <= gridDivisions; i++) {
      const y = -gridSize / 2 + i * gridStep;
      vertices.push(-gridSize / 2, y, 0);
      vertices.push(gridSize / 2, y, 0);
    }
    
    // Vertical lines
    for (let i = 0; i <= gridDivisions; i++) {
      const x = -gridSize / 2 + i * gridStep;
      vertices.push(x, -gridSize / 2, 0);
      vertices.push(x, gridSize / 2, 0);
    }
    
    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    
    const gridMaterial = new THREE.LineBasicMaterial({
      color: 0x333333,
      transparent: true,
      opacity: 0.3
    });
    
    this.gridLines = new THREE.LineSegments(gridGeometry, gridMaterial);
    this.scene.add(this.gridLines);

    // Add major grid lines (every 10th line)
    const majorGridGeometry = new THREE.BufferGeometry();
    const majorVertices = [];
    
    for (let i = 0; i <= gridDivisions; i += 10) {
      const y = -gridSize / 2 + i * gridStep;
      majorVertices.push(-gridSize / 2, y, 0);
      majorVertices.push(gridSize / 2, y, 0);
    }
    
    for (let i = 0; i <= gridDivisions; i += 10) {
      const x = -gridSize / 2 + i * gridStep;
      majorVertices.push(x, -gridSize / 2, 0);
      majorVertices.push(x, gridSize / 2, 0);
    }
    
    majorGridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(majorVertices, 3));
    
    const majorGridMaterial = new THREE.LineBasicMaterial({
      color: 0x555555,
      transparent: true,
      opacity: 0.5
    });
    
    const majorGridLines = new THREE.LineSegments(majorGridGeometry, majorGridMaterial);
    this.scene.add(majorGridLines);
  }

  /**
   * Create semi-transparent origin planes for XY, XZ, YZ in 3D view
   */
  createOriginPlanes() {
    const planeSize = 100;

    // XY plane (blue tint) — normal along Z
    const xyGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const xyMat = new THREE.MeshBasicMaterial({
      color: 0x2196F3, side: THREE.DoubleSide,
      transparent: true, opacity: 0.08, depthWrite: false
    });
    const xyPlane = new THREE.Mesh(xyGeo, xyMat);
    xyPlane.position.set(planeSize / 2, planeSize / 2, 0);
    xyPlane.userData = { originPlane: 'xy' };
    this.scene.add(xyPlane);

    // XY border
    const xyBorder = new THREE.LineSegments(
      new THREE.EdgesGeometry(xyGeo),
      new THREE.LineBasicMaterial({ color: 0x2196F3, transparent: true, opacity: 0.4 })
    );
    xyBorder.position.copy(xyPlane.position);
    this.scene.add(xyBorder);

    // XZ plane (green tint) — normal along Y, rotated -90° about X
    const xzGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const xzMat = new THREE.MeshBasicMaterial({
      color: 0x4CAF50, side: THREE.DoubleSide,
      transparent: true, opacity: 0.08, depthWrite: false
    });
    const xzPlane = new THREE.Mesh(xzGeo, xzMat);
    xzPlane.rotation.x = -Math.PI / 2;
    xzPlane.position.set(planeSize / 2, 0, planeSize / 2);
    xzPlane.userData = { originPlane: 'xz' };
    this.scene.add(xzPlane);

    // XZ border
    const xzBorder = new THREE.LineSegments(
      new THREE.EdgesGeometry(xzGeo),
      new THREE.LineBasicMaterial({ color: 0x4CAF50, transparent: true, opacity: 0.4 })
    );
    xzBorder.rotation.x = -Math.PI / 2;
    xzBorder.position.copy(xzPlane.position);
    this.scene.add(xzBorder);

    // YZ plane (red tint) — normal along X, rotated 90° about Y
    const yzGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const yzMat = new THREE.MeshBasicMaterial({
      color: 0xF44336, side: THREE.DoubleSide,
      transparent: true, opacity: 0.08, depthWrite: false
    });
    const yzPlane = new THREE.Mesh(yzGeo, yzMat);
    yzPlane.rotation.y = Math.PI / 2;
    yzPlane.position.set(0, planeSize / 2, planeSize / 2);
    yzPlane.userData = { originPlane: 'yz' };
    this.scene.add(yzPlane);

    // YZ border
    const yzBorder = new THREE.LineSegments(
      new THREE.EdgesGeometry(yzGeo),
      new THREE.LineBasicMaterial({ color: 0xF44336, transparent: true, opacity: 0.4 })
    );
    yzBorder.rotation.y = Math.PI / 2;
    yzBorder.position.copy(yzPlane.position);
    this.scene.add(yzBorder);

    this.originPlanes = { xy: xyPlane, xz: xzPlane, yz: yzPlane };
    this.originPlaneBorders = { xy: xyBorder, xz: xzBorder, yz: yzBorder };

    // Initially hidden (shown only in 3D mode)
    this.setOriginPlanesVisible(false);
  }

  /**
   * Show or hide origin planes
   */
  setOriginPlanesVisible(visible) {
    for (const key of ['xy', 'xz', 'yz']) {
      if (this.originPlanes[key]) this.originPlanes[key].visible = visible;
      if (this.originPlaneBorders[key]) this.originPlaneBorders[key].visible = visible;
    }
  }

  /**
   * Highlight a specific origin plane (for hover/selection)
   */
  highlightOriginPlane(planeName) {
    for (const key of ['xy', 'xz', 'yz']) {
      if (this.originPlanes[key]) {
        this.originPlanes[key].material.opacity = (key === planeName) ? 0.25 : 0.08;
      }
    }
  }

  /**
   * Raycast to find which origin plane is under the mouse
   * @param {number} screenX - screen X
   * @param {number} screenY - screen Y
   * @returns {string|null} 'xy', 'xz', 'yz', or null
   */
  pickOriginPlane(screenX, screenY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((screenX - rect.left) / rect.width) * 2 - 1;
    const y = -((screenY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);

    const planeObjects = Object.values(this.originPlanes).filter(p => p.visible);
    const intersects = raycaster.intersectObjects(planeObjects);
    if (intersects.length > 0) {
      return intersects[0].object.userData.originPlane;
    }
    return null;
  }

  onWindowResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const aspect = width / height;
    
    // Update perspective camera
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    
    // Update orthographic camera (maintain Y+ up convention)
    const viewSize = 500;
    this.orthographicCamera.left = -viewSize * aspect;
    this.orthographicCamera.right = viewSize * aspect;
    this.orthographicCamera.top = viewSize;      // Y+ at top of screen
    this.orthographicCamera.bottom = -viewSize;  // Y- at bottom of screen
    this.orthographicCamera.updateProjectionMatrix();
    
    this.renderer.setSize(width, height);
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Switch between 2D sketching mode and 3D viewing mode
   * @param {string} mode - '2d' or '3d'
   */
  setMode(mode) {
    this.mode = mode;
    
    if (mode === '2d') {
      // Switch to orthographic camera for 2D sketching
      this.camera = this.orthographicCamera;
      this.controls.object = this.orthographicCamera;
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      
      // Position camera to look down at XY plane
      this.orthographicCamera.position.set(0, 0, 500);
      this.orthographicCamera.lookAt(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      
      // Show grid, hide origin planes
      if (this.gridLines) this.gridLines.visible = true;
      this.setOriginPlanesVisible(false);
      this.sketchMode = true;
      this.sketchPlane = 'xy';
      
    } else if (mode === '3d') {
      // Switch to perspective camera for 3D viewing
      this.camera = this.perspectiveCamera;
      this.controls.object = this.perspectiveCamera;
      this.controls.enableRotate = true;
      this.controls.screenSpacePanning = false;
      
      // Position camera for isometric-like view
      this.perspectiveCamera.position.set(300, 300, 300);
      this.perspectiveCamera.lookAt(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      
      // Keep grid visible in 3D mode too, show origin planes
      if (this.gridLines) this.gridLines.visible = true;
      this.setOriginPlanesVisible(true);
      this.sketchMode = false;
      this.sketchPlane = null;
    }
    
    this.controls.update();
  }

  /**
   * Render 2D sketch entities on the XY plane
   * @param {Scene} scene - The 2D scene with entities
   */
  render2DScene(scene) {
    // Clear previous 2D objects
    this.sketchObjects.forEach(obj => {
      this.scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    this.sketchObjects.clear();

    if (!scene) return;

    // Render segments (lines)
    if (scene.segments) {
      scene.segments.forEach((segment, index) => {
        if (segment.p1 && segment.p2) {
          const geometry = new THREE.BufferGeometry();
          const vertices = new Float32Array([
            segment.p1.x, segment.p1.y, 0,
            segment.p2.x, segment.p2.y, 0
          ]);
          geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
          
          const material = new THREE.LineBasicMaterial({
            color: segment.construction ? 0x90EE90 : 0xFFFFFF,
            linewidth: 1
          });
          
          const line = new THREE.Line(geometry, material);
          this.scene.add(line);
          this.sketchObjects.set(`segment-${index}`, line);
        }
      });
    }

    // Render circles
    if (scene.circles) {
      scene.circles.forEach((circle, index) => {
        const geometry = new THREE.CircleGeometry(circle.radius, 64);
        const edges = new THREE.EdgesGeometry(geometry);
        const material = new THREE.LineBasicMaterial({
          color: circle.construction ? 0x90EE90 : 0xFFFFFF
        });
        const line = new THREE.LineSegments(edges, material);
        line.position.set(circle.center.x, circle.center.y, 0);
        this.scene.add(line);
        this.sketchObjects.set(`circle-${index}`, line);
      });
    }

    // Render arcs
    if (scene.arcs) {
      scene.arcs.forEach((arc, index) => {
        const curve = new THREE.EllipseCurve(
          arc.center.x, arc.center.y,
          arc.radius, arc.radius,
          arc.startAngle, arc.endAngle,
          false, 0
        );
        const points = curve.getPoints(50);
        const geometry = new THREE.BufferGeometry().setFromPoints(
          points.map(p => new THREE.Vector3(p.x, p.y, 0))
        );
        const material = new THREE.LineBasicMaterial({
          color: arc.construction ? 0x90EE90 : 0xFFFFFF
        });
        const line = new THREE.Line(geometry, material);
        this.scene.add(line);
        this.sketchObjects.set(`arc-${index}`, line);
      });
    }

    // Render points
    if (scene.points) {
      scene.points.forEach((point, index) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([point.x, point.y, 0], 3));
        const material = new THREE.PointsMaterial({
          color: 0xFFFFFF,
          size: 5,
          sizeAttenuation: false
        });
        const pointMesh = new THREE.Points(geometry, material);
        this.scene.add(pointMesh);
        this.sketchObjects.set(`point-${index}`, pointMesh);
      });
    }
  }

  /**
   * Render a Part's geometry
   * @param {Part} part - The Part object with feature tree
   */
  renderPart(part) {
    // Clear existing 3D meshes (but keep 2D sketch objects)
    this.clearPartGeometry();

    if (!part) return;

    // Get final geometry from the part
    const finalGeometry = part.getFinalGeometry();
    
    if (!finalGeometry) return;

    if (finalGeometry.type === 'solid' && finalGeometry.geometry) {
      this.renderSolid(finalGeometry.geometry, 'final');
    } else if (finalGeometry.type === 'sketch' && finalGeometry.profiles) {
      this.renderSketch(finalGeometry);
    }
  }

  /**
   * Render a solid geometry (vertices and faces)
   * @param {Object} geometry - Object with vertices and faces arrays
   * @param {string} id - Identifier for this geometry
   */
  renderSolid(geometry, id = 'default') {
    const threeGeometry = new THREE.BufferGeometry();

    // Convert vertices to Three.js format
    const vertices = [];
    const normals = [];
    
    geometry.faces.forEach(face => {
      // Get vertices for this face
      const v0 = geometry.vertices[face.indices[0]];
      const v1 = geometry.vertices[face.indices[1]];
      const v2 = geometry.vertices[face.indices[2]];

      // Add vertices
      vertices.push(v0.x, v0.y, v0.z);
      vertices.push(v1.x, v1.y, v1.z);
      vertices.push(v2.x, v2.y, v2.z);

      // Calculate face normal
      const vec0 = new THREE.Vector3(v0.x, v0.y, v0.z);
      const vec1 = new THREE.Vector3(v1.x, v1.y, v1.z);
      const vec2 = new THREE.Vector3(v2.x, v2.y, v2.z);
      
      const edge1 = new THREE.Vector3().subVectors(vec1, vec0);
      const edge2 = new THREE.Vector3().subVectors(vec2, vec0);
      const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

      // Add normals for each vertex
      normals.push(normal.x, normal.y, normal.z);
      normals.push(normal.x, normal.y, normal.z);
      normals.push(normal.x, normal.y, normal.z);
    });

    threeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    threeGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    threeGeometry.computeBoundingSphere();

    // Create mesh with material
    const material = new THREE.MeshPhongMaterial({
      color: 0x4CAF50,
      side: THREE.DoubleSide,
      flatShading: false,
      shininess: 30
    });
    const mesh = new THREE.Mesh(threeGeometry, material);
    this.scene.add(mesh);
    this.meshes.set(id, mesh);

    // Create edges
    const edgesGeometry = new THREE.EdgesGeometry(threeGeometry, 15);
    const edgesMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    this.scene.add(edges);
    this.edges.set(id, edges);
  }

  /**
   * Render a 2D sketch in 3D space
   * @param {Object} sketchData - Sketch data with profiles
   */
  renderSketch(sketchData) {
    if (!sketchData.profiles || sketchData.profiles.length === 0) return;

    sketchData.profiles.forEach((profile, index) => {
      const points = [];
      profile.forEach(point => {
        points.push(new THREE.Vector3(point.x, point.y, 0));
      });
      
      // Close the profile
      if (points.length > 0) {
        points.push(points[0].clone());
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: 0x2196F3, linewidth: 2 });
      const line = new THREE.Line(geometry, material);
      this.scene.add(line);
      this.meshes.set(`sketch-${index}`, line);
    });
  }

  /**
   * Clear 3D part geometry (meshes and edges) but keep 2D sketch objects
   */
  clearPartGeometry() {
    this.meshes.forEach(mesh => {
      this.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    this.meshes.clear();

    this.edges.forEach(edge => {
      this.scene.remove(edge);
      if (edge.geometry) edge.geometry.dispose();
      if (edge.material) edge.material.dispose();
    });
    this.edges.clear();
  }

  /**
   * Clear all geometry from the scene (both 2D and 3D)
   */
  clearGeometry() {
    this.clearPartGeometry();
    
    this.sketchObjects.forEach(obj => {
      this.scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    this.sketchObjects.clear();
  }

  /**
   * Fit camera to view all geometry
   */
  fitToView() {
    const box = new THREE.Box3();
    
    this.meshes.forEach(mesh => {
      box.expandByObject(mesh);
    });

    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    
    if (this.mode === '3d') {
      const fov = this.perspectiveCamera.fov * (Math.PI / 180);
      let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
      cameraZ *= 1.5; // Add some padding

      this.perspectiveCamera.position.set(center.x + cameraZ, center.y + cameraZ, center.z + cameraZ);
      this.perspectiveCamera.lookAt(center);
      this.controls.target.copy(center);
    }
    
    this.controls.update();
  }

  /**
   * Convert screen coordinates to world coordinates on the XY plane
   * @param {number} screenX - Screen X coordinate
   * @param {number} screenY - Screen Y coordinate
   * @returns {Object} World coordinates {x, y}
   */
  screenToWorld(screenX, screenY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((screenX - rect.left) / rect.width) * 2 - 1;
    const y = -((screenY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);

    // Intersect with XY plane (Z=0)
    const planeZ = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(planeZ, intersection);

    return { x: intersection.x, y: intersection.y };
  }

  /**
   * Clean up resources
   */
  dispose() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.clearGeometry();
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
    if (this.controls) {
      this.controls.dispose();
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
  }

  /**
   * Set visibility of the 3D view
   */
  setVisible(visible) {
    if (this.renderer && this.renderer.domElement) {
      this.renderer.domElement.style.display = visible ? 'block' : 'none';
    }
  }
}
