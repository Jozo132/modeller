// ui/featureIcons.js - Shared SVG icon definitions for feature types
// These match the toolbar button icons in index.html

/**
 * SVG icon markup for each feature type.
 * All icons use viewBox="0 0 20 20" and inherit stroke from currentColor.
 */
const featureIconSVGs = {
  'sketch': '<svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="1" fill="none"/><line x1="7" y1="10" x2="13" y2="10"/><line x1="10" y1="7" x2="10" y2="13"/></svg>',
  'extrude': '<svg viewBox="0 0 20 20"><rect x="5" y="12" width="10" height="5" rx="0.5" fill="none"/><rect x="7" y="5" width="6" height="7" rx="0.5" fill="none"/><line x1="7" y1="5" x2="5" y2="12"/><line x1="13" y1="5" x2="15" y2="12"/></svg>',
  'revolve': '<svg viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="7" ry="3" fill="none"/><path d="M3 10 Q3 6 10 6" fill="none" opacity="0.5"/><path d="M17 10 Q17 14 10 14" fill="none" opacity="0.5"/><line x1="2" y1="4" x2="2" y2="16" stroke-dasharray="2,2"/></svg>',
  'sweep': '<svg viewBox="0 0 20 20"><path d="M4 15 C7 4 13 4 16 11" fill="none"/><rect x="2.8" y="12.8" width="4.2" height="4.2" rx="0.4" fill="none"/><path d="M13 9 L17 11 L14 14" fill="none"/></svg>',
  'loft': '<svg viewBox="0 0 20 20"><rect x="3" y="5" width="5" height="5" rx="0.5" fill="none"/><rect x="12" y="10" width="5" height="5" rx="0.5" fill="none"/><path d="M8 5 C10 6 11 8 12 10" fill="none"/><path d="M8 10 C10 11 11 13 12 15" fill="none"/></svg>',
  'extrude-cut': '<svg viewBox="0 0 20 20"><rect x="5" y="4" width="10" height="5" rx="0.5" fill="none"/><rect x="7" y="9" width="6" height="8" rx="0.5" fill="none"/><line x1="7" y1="9" x2="5" y2="9"/><line x1="13" y1="9" x2="15" y2="9"/><polyline points="8,18 10,20 12,18" fill="none"/></svg>',
  'chamfer': '<svg viewBox="0 0 20 20"><path d="M4 16L4 8L8 4L16 4" fill="none"/><line x1="4" y1="8" x2="8" y2="4" stroke-width="2"/></svg>',
  'fillet': '<svg viewBox="0 0 20 20"><path d="M4 16L4 8L16 4" fill="none"/><path d="M4 8 Q4 4 8 4" fill="none" stroke-width="2"/><line x1="8" y1="4" x2="16" y2="4" fill="none"/></svg>',
  'step-import': '<svg viewBox="0 0 20 20"><path d="M4 16L4 4L12 4L16 8L16 16Z" fill="none"/><polyline points="12,4 12,8 16,8" fill="none"/></svg>',
};

const defaultIconSVG = '<svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="1" fill="none"/></svg>';

/**
 * Get SVG icon HTML for a feature type
 * @param {string} type - Feature type (e.g. 'sketch', 'extrude', 'revolve', etc.)
 * @returns {string} SVG markup string
 */
export function getFeatureIconSVG(type) {
  return featureIconSVGs[type] || defaultIconSVG;
}
