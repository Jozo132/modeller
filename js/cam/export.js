import { normalizeCamConfig } from './model.js';
import { generateToolpaths } from './toolpath.js';
import { postprocessToolpaths } from './postprocessors/index.js';

export function exportGCode(camConfig, toolpathsOrOptions = null, maybeOptions = {}) {
  const config = normalizeCamConfig(camConfig);
  const explicitToolpaths = Array.isArray(toolpathsOrOptions) ? toolpathsOrOptions : null;
  const options = explicitToolpaths ? maybeOptions : (toolpathsOrOptions || {});
  const generation = explicitToolpaths ? { toolpaths: explicitToolpaths, warnings: [] } : generateToolpaths(config);
  const gcode = postprocessToolpaths(generation.toolpaths, {
    ...options,
    camConfig: config,
    postprocessorId: options.postprocessorId || config.postprocessorId,
  });
  return { gcode, toolpaths: generation.toolpaths, warnings: generation.warnings || [] };
}

export function downloadGCode(camConfig, filename = 'program.ngc', options = {}) {
  const { gcode, toolpaths, warnings } = exportGCode(camConfig, options);
  const blob = new Blob([gcode], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { gcode, toolpaths, warnings };
}