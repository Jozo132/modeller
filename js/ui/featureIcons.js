// ui/featureIcons.js — SVG icons for feature types used in history tree and parameters panel.
// Path data lives in icons.js; this file is a thin wrapper that builds the full SVG strings.
import { outline } from './icons.js';

// Map feature type names to their icon key in icons.js PATH.
const FEATURE_ICON_MAP = {
  'sketch':      'feature-sketch',
  'extrude':     'feature-extrude',
  'revolve':     'feature-revolve',
  'sweep':       'feature-sweep',
  'loft':        'feature-loft',
  'extrude-cut': 'feature-extrude-cut',
  'chamfer':     'feature-chamfer',
  'fillet':      'fillet',
  'step-import': 'step-import',
};

const defaultIconSVG = outline('add-sketch');

/**
 * Get SVG icon HTML for a feature type.
 * @param {string} type - Feature type (e.g. 'sketch', 'extrude', 'revolve', etc.)
 * @returns {string} SVG markup string
 */
export function getFeatureIconSVG(type) {
  const key = FEATURE_ICON_MAP[type];
  return key ? outline(key) : defaultIconSVG;
}
