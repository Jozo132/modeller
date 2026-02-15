// js/cad/Assembly.js — Assembly design stub for future multi-part assemblies
// This class will eventually support assembly design including:
// - Multiple parts positioned and oriented in 3D space
// - Assembly constraints (mate, align, etc.)
// - Exploded views
// - Bill of materials (BOM)
// - Interference detection

import { Part } from './Part.js';

/**
 * Assembly represents a collection of parts positioned and constrained in 3D space.
 * Currently a stub for future implementation.
 */
export class Assembly {
  constructor(name = 'Assembly1') {
    this.name = name;
    this.description = '';
    this.created = new Date();
    this.modified = new Date();
    
    // Collection of component instances (parts or sub-assemblies)
    this.components = [];
    
    // Future: Assembly constraints (mates, alignments, etc.)
    this.constraints = [];
    
    // Future: BOM (Bill of Materials)
    this.bom = [];
  }

  // -----------------------------------------------------------------------
  // Component management
  // -----------------------------------------------------------------------

  /**
   * Add a component (part or sub-assembly) to this assembly
   * @param {Part|Assembly} component - The component to add
   * @param {Object} transform - Position and orientation transform
   * @returns {Object} Component instance
   */
  addComponent(component, transform = null) {
    this.modified = new Date();
    const instance = {
      id: `component_${this.components.length + 1}`,
      component,
      transform: transform || { 
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
      visible: true,
    };
    this.components.push(instance);
    return instance;
  }

  /**
   * Remove a component from this assembly
   * @param {Object} instance - The component instance to remove
   */
  removeComponent(instance) {
    this.modified = new Date();
    const idx = this.components.indexOf(instance);
    if (idx >= 0) {
      this.components.splice(idx, 1);
    }
  }

  /**
   * Get a component by ID
   * @param {string} id - The component ID
   * @returns {Object|null} The component instance or null if not found
   */
  getComponentById(id) {
    return this.components.find(c => c.id === id) || null;
  }

  // -----------------------------------------------------------------------
  // Future: Assembly constraint operations (stubs)
  // -----------------------------------------------------------------------

  /**
   * Future: Add a mate constraint between two components
   * @param {Object} componentA - First component instance
   * @param {Object} componentB - Second component instance
   * @param {string} mateType - Type of mate (coincident, parallel, etc.)
   * @returns {Object} Constraint object (stub)
   */
  addMate(componentA, componentB, mateType) {
    this.modified = new Date();
    console.warn('Assembly.addMate() is not yet implemented');
    // Future implementation
    return { type: 'mate', componentA, componentB, mateType };
  }

  /**
   * Future: Create an exploded view
   * @param {number} explosionFactor - How far to explode the components
   * @returns {Object} Exploded view configuration (stub)
   */
  createExplodedView(explosionFactor = 1.0) {
    console.warn('Assembly.createExplodedView() is not yet implemented');
    // Future implementation
    return { type: 'explodedView', factor: explosionFactor };
  }

  /**
   * Future: Generate Bill of Materials
   * @returns {Array} BOM entries (stub)
   */
  generateBOM() {
    console.warn('Assembly.generateBOM() is not yet implemented');
    // Future implementation
    return [];
  }

  /**
   * Future: Detect interferences between components
   * @returns {Array} List of interference pairs (stub)
   */
  detectInterferences() {
    console.warn('Assembly.detectInterferences() is not yet implemented');
    // Future implementation
    return [];
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  serialize() {
    return {
      type: 'Assembly',
      name: this.name,
      description: this.description,
      created: this.created.toISOString(),
      modified: this.modified.toISOString(),
      components: this.components.map(c => ({
        id: c.id,
        component: c.component.serialize(),
        transform: c.transform,
        visible: c.visible,
      })),
      constraints: this.constraints,
    };
  }

  static deserialize(data) {
    const assembly = new Assembly();
    if (!data) return assembly;

    assembly.name = data.name || 'Assembly1';
    assembly.description = data.description || '';
    assembly.created = data.created ? new Date(data.created) : new Date();
    assembly.modified = data.modified ? new Date(data.modified) : new Date();
    
    // Deserialize components
    if (data.components) {
      assembly.components = data.components.map(c => ({
        id: c.id,
        component: c.component.type === 'Part' 
          ? Part.deserialize(c.component)
          : Assembly.deserialize(c.component),
        transform: c.transform,
        visible: c.visible !== false,
      }));
    }
    
    // Future: Deserialize constraints
    if (data.constraints) {
      assembly.constraints = data.constraints;
    }

    return assembly;
  }
}
