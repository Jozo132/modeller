import { getSharedSketchToolkitModuleSync } from './SketchToolkitLoader.js';

function resolveToolkitSmartDimensions() {
  const moduleNs = getSharedSketchToolkitModuleSync();
  const candidate = moduleNs?.smartDimensions
    ? moduleNs
    : (moduleNs?.default?.smartDimensions ? moduleNs.default : moduleNs);
  const utils = candidate?.smartDimensions || candidate;
  if (typeof utils?.detectDimensionType !== 'function'
    || typeof utils?.detectAllDimensionTypes !== 'function'
    || typeof utils?.buildSmartSegmentAngleInfo !== 'function') {
    throw new Error('Loaded sketch toolkit module does not export smart dimension utilities');
  }
  return utils;
}

export function detectDimensionType(a, b) {
  return resolveToolkitSmartDimensions().detectDimensionType(a, b);
}

export function detectAllDimensionTypes(a, b) {
  return resolveToolkitSmartDimensions().detectAllDimensionTypes(a, b);
}

export function buildSmartSegmentAngleInfo(segA, segB, options = {}) {
  return resolveToolkitSmartDimensions().buildSmartSegmentAngleInfo(segA, segB, options);
}

export function prefersDiameterByDefault(shape) {
  return resolveToolkitSmartDimensions().prefersDiameterByDefault(shape);
}