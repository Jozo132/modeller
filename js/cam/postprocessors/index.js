import { linuxCncPostprocessor } from './linuxcnc.js';

const registry = new Map();

export function registerPostprocessor(id, processor) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('Postprocessor id is required');
  const postprocessor = typeof processor === 'function'
    ? { id: id.trim(), label: id.trim(), postprocess: processor }
    : { ...processor, id: id.trim() };
  if (typeof postprocessor.postprocess !== 'function') {
    throw new Error(`Postprocessor ${id} must provide a postprocess function`);
  }
  registry.set(postprocessor.id, postprocessor);
  return postprocessor;
}

export function getPostprocessor(id = 'linuxcnc') {
  const postprocessorId = id || 'linuxcnc';
  const postprocessor = registry.get(postprocessorId);
  if (!postprocessor) throw new Error(`Unknown postprocessor: ${id}`);
  return postprocessor;
}

export function listPostprocessors() {
  return [...registry.values()].map(({ id, label }) => ({ id, label: label || id }));
}

export function postprocessToolpaths(toolpaths, options = {}) {
  const postprocessor = getPostprocessor(options.postprocessorId || options.camConfig?.postprocessorId || 'linuxcnc');
  return postprocessor.postprocess(toolpaths, options);
}

registerPostprocessor(linuxCncPostprocessor.id, linuxCncPostprocessor);