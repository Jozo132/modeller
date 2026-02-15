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

    // Setup controls — higher damping and speed values for snappier, more responsive camera
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.25; // Higher = settles faster (default 0.05 felt sluggish)
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
  render2DScene(scene, overlays = {}) {
    // Clear previous 2D objects
    this.sketchObjects.forEach(obj => {
      this.scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (Array.isArray(obj.material)) {
        for (const m of obj.material) m.dispose?.();
      } else if (obj.material) {
        obj.material.dispose();
      }
    });
    this.sketchObjects.clear();

    if (!scene) return;

    const zBase = 0.02;
    const wpp = this._worldPerPixel();
    const isLayerVisible = overlays.isLayerVisible || (() => true);
    const getLayerColor = overlays.getLayerColor || (() => '#9CDCFE');
    const hoverEntity = overlays.hoverEntity || null;
    const previewEntities = overlays.previewEntities || [];
    const snapPoint = overlays.snapPoint || null;
    const cursorWorld = overlays.cursorWorld || null;
    const allDimensionsVisible = overlays.allDimensionsVisible !== false;
    const constraintIconsVisible = overlays.constraintIconsVisible !== false;

    const colorForEntity = (entity) => {
      if (entity.selected) return 0x00bfff;
      if (hoverEntity && hoverEntity.id === entity.id) return 0x7fd8ff;
      if (entity.construction) return 0x90EE90;
      return new THREE.Color(entity.color || getLayerColor(entity.layer)).getHex();
    };

    const dashPattern = (style) => {
      if (style === 'dotted') return [2 * wpp, 4 * wpp];
      if (style === 'dash-dot') return [12 * wpp, 4 * wpp];
      return [10 * wpp, 5 * wpp];
    };

    const addLine = (key, points, color, z = zBase, dashed = false, dashStyle = 'dashed') => {
      if (!points || points.length < 2) return;
      const verts = [];
      for (const p of points) verts.push(p.x, p.y, z);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      let material;
      if (dashed) {
        const [dashSize, gapSize] = dashPattern(dashStyle);
        material = new THREE.LineDashedMaterial({ color, dashSize, gapSize, transparent: true, opacity: 0.95 });
      } else {
        material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.98 });
      }
      const line = new THREE.Line(geometry, material);
      if (dashed) line.computeLineDistances();
      this.scene.add(line);
      this.sketchObjects.set(key, line);
    };

    const addCircle = (key, cx, cy, radius, color, z = zBase, dashed = false, dashStyle = 'dashed', startA = 0, endA = Math.PI * 2) => {
      const curve = new THREE.EllipseCurve(cx, cy, radius, radius, startA, endA, false, 0);
      const pts = curve.getPoints(72).map(p => ({ x: p.x, y: p.y }));
      addLine(key, pts, color, z, dashed, dashStyle);
    };

    const addTextSprite = (key, text, x, y, color, z = zBase + 0.05, rotation = 0) => {
      const pad = 6;
      const fontPx = 22;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.font = `${fontPx}px Consolas, monospace`;
      const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
      const height = fontPx + pad * 2;
      canvas.width = Math.max(8, width);
      canvas.height = Math.max(8, height);
      const c2 = canvas.getContext('2d');
      c2.clearRect(0, 0, canvas.width, canvas.height);
      c2.font = `${fontPx}px Consolas, monospace`;
      c2.textBaseline = 'middle';
      c2.fillStyle = color;
      c2.fillText(text, pad, canvas.height / 2 + 0.5);

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, rotation });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, y, z);
      sprite.scale.set(canvas.width * wpp, canvas.height * wpp, 1);
      this.scene.add(sprite);
      this.sketchObjects.set(key, sprite);
    };

    const addArrowTriangle = (key, x, y, angle, len, color, z = zBase + 0.04) => {
      const wing = len * 0.5;
      const pTip = { x, y };
      const p1 = { x: x - len * Math.cos(angle - 0.45), y: y - len * Math.sin(angle - 0.45) };
      const p2 = { x: x - len * Math.cos(angle + 0.45), y: y - len * Math.sin(angle + 0.45) };
      const shape = new THREE.Shape();
      shape.moveTo(pTip.x, pTip.y);
      shape.lineTo(p1.x, p1.y);
      shape.lineTo(p2.x, p2.y);
      shape.closePath();
      const geom = new THREE.ShapeGeometry(shape);
      const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.z = z;
      this.scene.add(mesh);
      this.sketchObjects.set(key, mesh);
      void wing;
    };

    // Segments
    if (scene.segments) {
      scene.segments.forEach((segment, index) => {
        if (!segment.visible || !isLayerVisible(segment.layer) || !segment.p1 || !segment.p2) return;
        const color = colorForEntity(segment);
        const dashed = !!segment.construction;
        const style = segment.constructionDash || 'dashed';

        if (segment.construction) {
          const dx = segment.p2.x - segment.p1.x;
          const dy = segment.p2.y - segment.p1.y;
          const len = Math.hypot(dx, dy) || 1e-9;
          const ux = dx / len, uy = dy / len;
          const ext = Math.max(this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight) * wpp * 2;
          const ct = segment.constructionType || 'finite';
          let ax, ay, bx, by;
          if (ct === 'infinite-both') {
            ax = segment.p1.x - ux * ext; ay = segment.p1.y - uy * ext;
            bx = segment.p2.x + ux * ext; by = segment.p2.y + uy * ext;
          } else if (ct === 'infinite-start') {
            ax = segment.p1.x - ux * ext; ay = segment.p1.y - uy * ext;
            bx = segment.p2.x; by = segment.p2.y;
          } else if (ct === 'infinite-end') {
            ax = segment.p1.x; ay = segment.p1.y;
            bx = segment.p2.x + ux * ext; by = segment.p2.y + uy * ext;
          } else {
            ax = segment.p1.x; ay = segment.p1.y;
            bx = segment.p2.x; by = segment.p2.y;
          }
          addLine(`segment-${index}`, [{ x: ax, y: ay }, { x: bx, y: by }], color, zBase, dashed, style);
        } else {
          addLine(`segment-${index}`, [{ x: segment.p1.x, y: segment.p1.y }, { x: segment.p2.x, y: segment.p2.y }], color, zBase, dashed, style);
        }
      });
    }

    // Circles
    if (scene.circles) {
      scene.circles.forEach((circle, index) => {
        if (!circle.visible || !isLayerVisible(circle.layer)) return;
        const color = colorForEntity(circle);
        addCircle(`circle-${index}`, circle.center.x, circle.center.y, circle.radius, color, zBase, !!circle.construction, circle.constructionDash || 'dashed');
      });
    }

    // Arcs
    if (scene.arcs) {
      scene.arcs.forEach((arc, index) => {
        if (!arc.visible || !isLayerVisible(arc.layer)) return;
        const color = colorForEntity(arc);
        addCircle(`arc-${index}`, arc.center.x, arc.center.y, arc.radius, color, zBase, !!arc.construction, arc.constructionDash || 'dashed', arc.startAngle, arc.endAngle);
      });
    }

    // Text primitives
    if (scene.texts) {
      scene.texts.forEach((text, index) => {
        if (!text.visible || !isLayerVisible(text.layer)) return;
        const colorHex = colorForEntity(text);
        const color = `#${new THREE.Color(colorHex).getHexString()}`;
        addTextSprite(`text-${index}`, text.text, text.x, text.y, color, zBase + 0.03, -(text.rotation || 0) * Math.PI / 180);
      });
    }

    // Dimensions
    if (allDimensionsVisible && scene.dimensions) {
      scene.dimensions.forEach((dim, index) => {
        if (!dim.visible || !isLayerVisible(dim.layer)) return;
        const dimColorHex = dim.selected ? 0x00bfff : (hoverEntity && hoverEntity.id === dim.id ? 0x7fd8ff : (!dim.isConstraint ? 0xffb432 : new THREE.Color(dim.color || getLayerColor(dim.layer)).getHex()));
        const dimTextColor = `#${new THREE.Color(dimColorHex).getHexString()}`;

        if (dim.dimType === 'angle') {
          const r = Math.abs(dim.offset);
          const startA = dim._angleStart != null ? dim._angleStart : 0;
          const sweepA = dim._angleSweep != null ? dim._angleSweep : 0;
          addCircle(`dim-arc-${index}`, dim.x1, dim.y1, r, dimColorHex, zBase + 0.02, false, 'dashed', startA, startA + sweepA);

          const endA = startA + sweepA;
          const ex = dim.x1 + r * Math.cos(endA);
          const ey = dim.y1 + r * Math.sin(endA);
          addArrowTriangle(`dim-arrow-${index}`, ex, ey, endA - Math.PI / 2, 8 * wpp, dimColorHex, zBase + 0.03);

          const midA = startA + sweepA / 2;
          const lx = dim.x1 + (r + 14 * wpp) * Math.cos(midA);
          const ly = dim.y1 + (r + 14 * wpp) * Math.sin(midA);
          addTextSprite(`dim-label-${index}`, dim.displayLabel, lx, ly, dimTextColor, zBase + 0.05);
          return;
        }

        const dx = dim.x2 - dim.x1;
        const dy = dim.y2 - dim.y1;
        const len = Math.hypot(dx, dy) || 1e-9;
        const nx = -dy / len;
        const ny = dx / len;
        let p1 = { x: dim.x1, y: dim.y1 };
        let p2 = { x: dim.x2, y: dim.y2 };
        let d1;
        let d2;

        if (dim.dimType === 'dx') {
          const dimY = dim.y1 + dim.offset;
          d1 = { x: dim.x1, y: dimY };
          d2 = { x: dim.x2, y: dimY };
        } else if (dim.dimType === 'dy') {
          const dimX = dim.x1 + dim.offset;
          d1 = { x: dimX, y: dim.y1 };
          d2 = { x: dimX, y: dim.y2 };
        } else {
          d1 = { x: dim.x1 + nx * dim.offset, y: dim.y1 + ny * dim.offset };
          d2 = { x: dim.x2 + nx * dim.offset, y: dim.y2 + ny * dim.offset };
        }

        const extColor = !dim.isConstraint ? 0xffb432 : 0xffffff;
        addLine(`dim-ext1-${index}`, [p1, d1], extColor, zBase + 0.01);
        addLine(`dim-ext2-${index}`, [p2, d2], extColor, zBase + 0.01);
        addLine(`dim-line-${index}`, [d1, d2], dimColorHex, zBase + 0.02);

        const angle = Math.atan2(d2.y - d1.y, d2.x - d1.x);
        const style = dim.arrowStyle || 'auto';
        if (style !== 'none') {
          const pixDist = Math.hypot((d2.x - d1.x) / wpp, (d2.y - d1.y) / wpp);
          const useOutside = style === 'outside' || (style === 'auto' && pixDist < 32);
          if (useOutside) {
            addArrowTriangle(`dim-a1-${index}`, d1.x, d1.y, angle, 8 * wpp, dimColorHex, zBase + 0.03);
            addArrowTriangle(`dim-a2-${index}`, d2.x, d2.y, angle + Math.PI, 8 * wpp, dimColorHex, zBase + 0.03);
          } else {
            addArrowTriangle(`dim-a1-${index}`, d1.x, d1.y, angle + Math.PI, 8 * wpp, dimColorHex, zBase + 0.03);
            addArrowTriangle(`dim-a2-${index}`, d2.x, d2.y, angle, 8 * wpp, dimColorHex, zBase + 0.03);
          }
        }

        const mx = (d1.x + d2.x) / 2;
        const my = (d1.y + d2.y) / 2;
        let ta = angle;
        if (ta > Math.PI / 2 || ta < -Math.PI / 2) ta += Math.PI;
        addTextSprite(`dim-label-${index}`, dim.displayLabel, mx, my + 12 * wpp, dimTextColor, zBase + 0.05, ta);
      });
    }

    // Shared/fixed/selected points
    if (scene.points) {
      scene.points.forEach((point, index) => {
        const refs = scene.shapesUsingPoint ? scene.shapesUsingPoint(point).length : 1;
        const isHover = hoverEntity && hoverEntity.id === point.id;
        if (refs <= 1 && !point.selected && !point.fixed && !isHover) return;
        const color = point.selected ? 0x00bfff : isHover ? 0x7fd8ff : point.fixed ? 0xff6644 : 0xffff66;
        const size = point.selected ? 7 : (isHover ? 6 : (point.fixed ? 5 : 4));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([point.x, point.y, zBase + 0.06], 3));
        const material = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, depthWrite: false });
        const pointMesh = new THREE.Points(geometry, material);
        this.scene.add(pointMesh);
        this.sketchObjects.set(`point-${index}`, pointMesh);
      });
    }

    // Constraint icons
    if (constraintIconsVisible && scene.constraints) {
      const iconMap = {
        coincident: '⊙', distance: '↔', fixed: '⊕',
        horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥',
        angle: '∠', equal_length: '=', length: 'L', radius: 'R', tangent: 'T',
        on_line: '—·', on_circle: '○·', midpoint: 'M',
      };
      scene.constraints.forEach((constraint, index) => {
        if (constraint.type === 'dimension') return;
        if (typeof constraint.involvedPoints !== 'function') return;
        const pts = constraint.involvedPoints();
        if (!pts || pts.length === 0) return;
        let cx = 0;
        let cy = 0;
        for (const point of pts) {
          cx += point.x;
          cy += point.y;
        }
        cx /= pts.length;
        cy /= pts.length;
        const icon = iconMap[constraint.type] || '?';
        const ok = (typeof constraint.error === 'function') ? constraint.error() < 1e-4 : false;
        const color = ok ? '#00e676' : '#ff643c';
        addTextSprite(`constraint-${index}`, icon, cx + 12 * wpp, cy + 10 * wpp, color, zBase + 0.07);
      });
    }

    // Preview entities
    if (previewEntities && previewEntities.length > 0) {
      const previewColor = 0x00bfff;
      previewEntities.forEach((entity, idx) => {
        if (!entity) return;
        if (entity.type === 'segment' && entity.p1 && entity.p2) {
          addLine(`preview-seg-${idx}`, [{ x: entity.p1.x, y: entity.p1.y }, { x: entity.p2.x, y: entity.p2.y }], previewColor, zBase + 0.08, false);
        } else if (entity.type === 'circle' && entity.center) {
          addCircle(`preview-cir-${idx}`, entity.center.x, entity.center.y, entity.radius, previewColor, zBase + 0.08);
        } else if (entity.type === 'arc' && entity.center) {
          addCircle(`preview-arc-${idx}`, entity.center.x, entity.center.y, entity.radius, previewColor, zBase + 0.08, false, 'dashed', entity.startAngle, entity.endAngle);
        } else if (entity.type === 'dimension') {
          const dx = entity.x2 - entity.x1;
          const dy = entity.y2 - entity.y1;
          const len = Math.hypot(dx, dy) || 1e-9;
          const nx = -dy / len;
          const ny = dx / len;
          const d1 = { x: entity.x1 + nx * entity.offset, y: entity.y1 + ny * entity.offset };
          const d2 = { x: entity.x2 + nx * entity.offset, y: entity.y2 + ny * entity.offset };
          addLine(`preview-dim-${idx}`, [d1, d2], previewColor, zBase + 0.08, false);
          const label = entity.displayLabel || '';
          if (label) addTextSprite(`preview-dim-label-${idx}`, label, (d1.x + d2.x) / 2, (d1.y + d2.y) / 2 + 10 * wpp, '#00bfff', zBase + 0.09);
        }
      });
    }

    // Snap indicator
    if (snapPoint) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([snapPoint.x, snapPoint.y, zBase + 0.12], 3));
      const m = new THREE.PointsMaterial({ color: 0x00ff99, size: 9, sizeAttenuation: false, depthTest: false, depthWrite: false });
      const p = new THREE.Points(g, m);
      this.scene.add(p);
      this.sketchObjects.set('snap-indicator', p);
    }

    // Crosshair
    if (cursorWorld && this.mode === '2d') {
      const spanX = (this.orthographicCamera.right - this.orthographicCamera.left) * 2;
      const spanY = (this.orthographicCamera.top - this.orthographicCamera.bottom) * 2;
      addLine('crosshair-x', [{ x: cursorWorld.x - spanX, y: cursorWorld.y }, { x: cursorWorld.x + spanX, y: cursorWorld.y }], 0x2a2a2a, zBase - 0.005);
      addLine('crosshair-y', [{ x: cursorWorld.x, y: cursorWorld.y - spanY }, { x: cursorWorld.x, y: cursorWorld.y + spanY }], 0x2a2a2a, zBase - 0.005);
    }

  }

  _worldPerPixel() {
    if (!this.renderer || !this.renderer.domElement) return 1;
    const h = Math.max(1, this.renderer.domElement.clientHeight || 1);
    if (this.mode === '2d') {
      return (this.orthographicCamera.top - this.orthographicCamera.bottom) / h;
    }
    const dist = this.camera.position.length() || 1;
    return (dist * Math.tan((this.perspectiveCamera.fov * Math.PI / 180) / 2) * 2) / h;
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
