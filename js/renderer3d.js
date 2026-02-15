// renderer3d.js - 3D rendering engine using Three.js

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Renderer3D - Manages 3D visualization using Three.js
 */
export class Renderer3D {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.meshes = new Map(); // Map of featureId -> mesh
    this.edges = new Map(); // Map of featureId -> edges
    this.animationId = null;

    this.init();
  }

  init() {
    // Setup camera
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    this.camera.position.set(300, 300, 300);
    this.camera.lookAt(0, 0, 0);

    // Setup renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0xf5f5f5, 1);
    this.container.appendChild(this.renderer.domElement);

    // Setup controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 5000;

    // Setup lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight1.position.set(100, 200, 100);
    this.scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-100, -100, -100);
    this.scene.add(directionalLight2);

    // Add grid helper
    const gridHelper = new THREE.GridHelper(500, 50, 0x888888, 0xcccccc);
    this.scene.add(gridHelper);

    // Add axes helper
    const axesHelper = new THREE.AxesHelper(100);
    this.scene.add(axesHelper);

    // Handle window resize
    window.addEventListener('resize', () => this.onWindowResize());

    // Start animation loop
    this.animate();
  }

  onWindowResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Render a Part's geometry
   * @param {Part} part - The Part object with feature tree
   */
  renderPart(part) {
    // Clear existing meshes
    this.clearGeometry();

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
   * Clear all geometry from the scene
   */
  clearGeometry() {
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
    const fov = this.camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraZ *= 1.5; // Add some padding

    this.camera.position.set(center.x + cameraZ, center.y + cameraZ, center.z + cameraZ);
    this.camera.lookAt(center);
    this.controls.target.copy(center);
    this.controls.update();
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
    window.removeEventListener('resize', () => this.onWindowResize());
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
