// js/ui/icons.js
// Single source of truth for every icon in the application.
//
// Rules:
//   • All paths live in a 20×20 coordinate space (viewBox="0 0 20 20").
//   • Only path geometry lives here — no colour, no size.
//   • Use outline() for stroked icons, solid() for filled icons.
//   • Inner elements may override fill/stroke with explicit attributes
//     when mixed rendering is needed (e.g. a filled dot inside a stroked ring).
//   • initIcons() wires every static and dynamic icon at startup.

// ─── raw path data ────────────────────────────────────────────────────────────

export const PATH = {

  // ── File ───────────────────────────────────────────────────────────────────
  'new-file': `
    <path d="M5 2h7l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z"/>
    <path d="M12 2v4h4"/>
  `,
  'open-file': `
    <path d="M3 16V7h4l2 2h7v7H3z"/>
    <path d="M3 7V5a1 1 0 011-1h4l2 2"/>
  `,
  'save-file': `
    <path d="M5 2h8l4 4v10a2 2 0 01-2 2H5a2 2 0 01-2-2V4a2 2 0 012-2z"/>
    <path d="M7 2v5h6V2"/>
    <rect x="6" y="12" width="8" height="4" rx="0.5"/>
  `,

  // ── Edit ───────────────────────────────────────────────────────────────────
  'select': `
    <path d="M6 2l0 14 4-4 4 6 2-1-4-6 5-1z"/>
  `,
  'undo': `
    <polyline points="1,4 2,9 7,8"/>
    <path d="M2 13.5   A7.5 7.5   0 1 0   2 9"/>
  `,
  'redo': `
    <polyline points="19,4 18,9 13,8"/>
    <path d="M18 13.5 A7.5 7.5 0 1 1 18 9"/>
  `,
  'delete': `
    <polyline points="6,6 7,17 13,17 14,6"/>
    <line x1="4" y1="6" x2="16" y2="6"/>
    <path d="M8 3h4v3H8z"/>
  `,

  // ── View ───────────────────────────────────────────────────────────────────
  'zoom-fit': `
    <polyline points="3,7 3,3 7,3"/>
    <polyline points="13,3 17,3 17,7"/>
    <polyline points="17,13 17,17 13,17"/>
    <polyline points="7,17 3,17 3,13"/>
    <rect x="6" y="6" width="8" height="8" rx="0.5" opacity="0.4"/>
  `,
  'zoom-in': `
    <circle cx="9" cy="9" r="5"/>
    <line x1="13" y1="13" x2="17" y2="17"/>
    <line x1="7" y1="9" x2="11" y2="9"/>
    <line x1="9" y1="7" x2="9" y2="11"/>
  `,
  'zoom-out': `
    <circle cx="9" cy="9" r="5"/>
    <line x1="13" y1="13" x2="17" y2="17"/>
    <line x1="7" y1="9" x2="11" y2="9"/>
  `,
  'grid': `
    <rect x="3" y="3" width="14" height="14" opacity="0.3"/>
    <line x1="7" y1="3" x2="7" y2="17"/>
    <line x1="13" y1="3" x2="13" y2="17"/>
    <line x1="3" y1="7" x2="17" y2="7"/>
    <line x1="3" y1="13" x2="17" y2="13"/>
  `,
  'snap': `
    <circle cx="10" cy="10" r="4"/>
    <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/>
    <line x1="10" y1="2" x2="10" y2="6"/>
    <line x1="10" y1="14" x2="10" y2="18"/>
    <line x1="2" y1="10" x2="6" y2="10"/>
    <line x1="14" y1="10" x2="18" y2="10"/>
  `,
  'autocoincidence': `
    <circle cx="7" cy="10" r="3"/>
    <circle cx="13" cy="10" r="3"/>
    <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/>
  `,
  'ortho': `
    <line x1="4" y1="16" x2="4" y2="4"/>
    <line x1="4" y1="16" x2="16" y2="16"/>
    <rect x="4" y="12" width="4" height="4" opacity="0.5"/>
  `,

  // ── Part: Sketch entry ─────────────────────────────────────────────────────
  'add-sketch': `
    <rect x="4" y="4" width="12" height="12" rx="1"/>
    <line x1="7" y1="10" x2="13" y2="10"/>
    <line x1="10" y1="7" x2="10" y2="13"/>
  `,

  // ── Part: Features ─────────────────────────────────────────────────────────
  'extrude-cut': `
    <rect x="3.5" y="3" width="2.5" height="10"/>
    <rect x="14" y="3" width="2.5" height="10"/>
    <rect x="6" y="3" width="8" height="14"/>
    <line x1="10" y1="3" x2="10" y2="17"/>
    <line x1="8.5" y1="14.5" x2="10" y2="17"/>
    <line x1="11.5" y1="14.5" x2="10" y2="17"/>
    <line x1="6" y1="13" x2="7" y2="13"/>
    <line x1="14" y1="13" x2="13" y2="13"/>
  `,
  'revolve': `
    <ellipse cx="10" cy="10" rx="7" ry="3"/>
    <path d="M3 10 Q3 6 10 6" opacity="0.5"/>
    <path d="M17 10 Q17 14 10 14" opacity="0.5"/>
    <line x1="2" y1="4" x2="2" y2="16" stroke-dasharray="2,2"/>
  `,
  'sweep': `
    <path d="M4 15 C7 4 13 4 16 11"/>
    <rect x="2.8" y="12.8" width="4.2" height="4.2" rx="0.4"/>
    <path d="M13 9 L17 11 L14 14"/>
  `,
  'loft': `
    <rect x="3" y="5" width="5" height="5" rx="0.5"/>
    <rect x="12" y="10" width="5" height="5" rx="0.5"/>
    <path d="M8 5 C10 6 11 8 12 10"/>
    <path d="M8 10 C10 11 11 13 12 15"/>
  `,

  // ── Part: Ops ──────────────────────────────────────────────────────────────
  'chamfer': `
    <path d="M4 16L4 10L10 4L16 4"/>
    <line x1="4" y1="10" x2="10" y2="4" stroke-width="2"/>
  `,
  'fillet': `
    <path d="M4 16L4 12L16"/>
    <path d="M4 12 Q4 4 12 4" stroke-width="2"/>
    <line x1="12" y1="4" x2="16" y2="4"/>
  `,
  'motion': `
    <circle cx="10" cy="10" r="7"/>
    <polygon points="8,6 8,14 14,10" fill="currentColor" stroke="none"/>
  `,

  // ── CAM ────────────────────────────────────────────────────────────────────
  'cam-enter': `
    <path d="M3 15h14"/>
    <path d="M10 2v7"/>
    <path d="M7 9h6l-1.5 5h-3z"/>
    <circle cx="10" cy="16" r="1.5" fill="currentColor" stroke="none"/>
  `,
  'cam-setup': `
    <rect x="4" y="5" width="12" height="10" rx="1"/>
    <line x1="7" y1="8" x2="13" y2="8"/>
    <line x1="7" y1="12" x2="11" y2="12"/>
  `,
  'cam-profile': `
    <rect x="4" y="4" width="12" height="12" rx="1"/>
    <path d="M7 10h6"/>
    <path d="M10 7v6"/>
  `,
  'cam-pocket': `
    <rect x="4" y="4" width="12" height="12" rx="1"/>
    <rect x="7" y="7" width="6" height="6" opacity="0.55"/>
  `,
  'download': `
    <path d="M10 3v9"/>
    <polyline points="6,9 10,13 14,9"/>
    <path d="M4 16h12"/>
  `,
  'back': `
    <path d="M5 10h10"/>
    <polyline points="9,6 5,10 9,14"/>
  `,

  // ── Draw tools ─────────────────────────────────────────────────────────────
  'construction': `
    <line x1="3" y1="6" x2="17" y2="6"/>
    <line x1="3" y1="14" x2="6" y2="14"/>
    <line x1="8" y1="14" x2="10" y2="14"/>
    <line x1="12" y1="14" x2="17" y2="14"/>
  `,
  'point': `
    <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/>
    <circle cx="10" cy="10" r="6"/>
  `,
  'line-draw': `
    <line x1="4" y1="16" x2="16" y2="4"/>
    <circle cx="4" cy="16" r="1.5" fill="currentColor" stroke="none"/>
    <circle cx="16" cy="4" r="1.5" fill="currentColor" stroke="none"/>
  `,
  'rect-draw': `
    <rect x="3" y="5" width="14" height="10" rx="0.5"/>
  `,
  'circle-draw': `
    <circle cx="10" cy="10" r="7"/>
    <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>
  `,
  'arc-draw': `
    <path d="M4 16A9 9 0 0116 4"/>
    <circle cx="4" cy="16" r="1.5" fill="currentColor" stroke="none"/>
    <circle cx="16" cy="4" r="1.5" fill="currentColor" stroke="none"/>
  `,
  'polyline-draw': `
    <polyline points="3,16 7,5 13,14 17,4"/>
    <circle cx="3" cy="16" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="7" cy="5" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="13" cy="14" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="17" cy="4" r="1.2" fill="currentColor" stroke="none"/>
  `,
  'spline': `
    <path d="M3 15 Q5 5 10 10 T17 4"/>
    <circle cx="3" cy="15" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="17" cy="4" r="1.2" fill="currentColor" stroke="none"/>
  `,
  'bezier': `
    <path d="M3 16 C6 4 14 4 17 16"/>
    <circle cx="3" cy="16" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="17" cy="16" r="1.2" fill="currentColor" stroke="none"/>
    <line x1="3" y1="16" x2="6" y2="4" stroke-width="0.5" stroke-dasharray="1,1"/>
    <line x1="17" y1="16" x2="14" y2="4" stroke-width="0.5" stroke-dasharray="1,1"/>
    <circle cx="6" cy="4" r="0.8" fill="currentColor" stroke="none" opacity="0.6"/>
    <circle cx="14" cy="4" r="0.8" fill="currentColor" stroke="none" opacity="0.6"/>
  `,
  'text': `
    <line x1="4" y1="4" x2="16" y2="4"/>
    <line x1="10" y1="4" x2="10" y2="17"/>
    <line x1="7" y1="17" x2="13" y2="17"/>
  `,

  // ── Modify ─────────────────────────────────────────────────────────────────
  'move': `
    <line x1="10" y1="3" x2="10" y2="17"/>
    <line x1="3" y1="10" x2="17" y2="10"/>
    <polyline points="7,5 10,3 13,5"/>
    <polyline points="7,15 10,17 13,15"/>
    <polyline points="5,7 3,10 5,13"/>
    <polyline points="15,7 17,10 15,13"/>
  `,
  'copy': `
    <rect x="7" y="2" width="9" height="11" rx="1"/>
    <rect x="4" y="7" width="9" height="11" rx="1"/>
  `,
  'trim': `
    <line x1="3" y1="10" x2="17" y2="10"/>
    <line x1="10" y1="3" x2="10" y2="17" stroke-dasharray="2,2" opacity="0.5"/>
    <line x1="3" y1="6" x2="3" y2="14"/>
  `,
  'split': `
    <line x1="3" y1="10" x2="8" y2="10"/>
    <line x1="12" y1="10" x2="17" y2="10"/>
    <circle cx="10" cy="10" r="2" fill="currentColor" stroke="none"/>
  `,

  // ── Sketch ops ─────────────────────────────────────────────────────────────
  'disconnect': `
    <circle cx="7" cy="10" r="2.5"/>
    <circle cx="13" cy="10" r="2.5"/>
    <line x1="5" y1="5" x2="15" y2="15" stroke-dasharray="2,2"/>
  `,
  'union': `
    <circle cx="8" cy="10" r="3"/>
    <circle cx="12" cy="10" r="3"/>
    <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>
  `,
  'sketch-fillet': `
    <path d="M4 16V8M8 4H16"/>
    <path d="M4 8Q4 4 8 4" stroke-width="2"/>
    <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none"/>
    <circle cx="8" cy="4" r="1" fill="currentColor" stroke="none"/>
  `,
  'sketch-chamfer': `
    <path d="M4 16V9M9 4H16"/>
    <line x1="4" y1="9" x2="9" y2="4" stroke-width="2"/>
    <circle cx="4" cy="9" r="1" fill="currentColor" stroke="none"/>
    <circle cx="9" cy="4" r="1" fill="currentColor" stroke="none"/>
  `,
  'trace-image': `
    <rect x="3" y="4" width="6" height="6" rx="0.5"/>
    <path d="M4 15C6 12 8 12 10 10C12 8 14 8 16 5"/>
    <circle cx="16" cy="5" r="1" fill="currentColor" stroke="none"/>
  `,

  // ── Constraints ────────────────────────────────────────────────────────────
  'dimension': `
    <line x1="4" y1="14" x2="16" y2="14"/>
    <line x1="4" y1="11" x2="4" y2="17"/>
    <line x1="16" y1="11" x2="16" y2="17"/>
    <polygon points="6,13 4,14 6,15" fill="currentColor" stroke="none"/>
    <polygon points="14,13 16,14 14,15" fill="currentColor" stroke="none"/>
    <text x="8" y="12" font-size="5" fill="currentColor" stroke="none">42</text>
  `,
  'coincident': `
    <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/>
    <circle cx="10" cy="10" r="6"/>
  `,
  'horizontal': `
    <line x1="3" y1="10" x2="17" y2="10"/>
    <polygon points="5,9 3,10 5,11" fill="currentColor" stroke="none"/>
    <polygon points="15,9 17,10 15,11" fill="currentColor" stroke="none"/>
  `,
  'vertical': `
    <line x1="10" y1="3" x2="10" y2="17"/>
    <polygon points="9,5 10,3 11,5" fill="currentColor" stroke="none"/>
    <polygon points="9,15 10,17 11,15" fill="currentColor" stroke="none"/>
  `,
  'parallel': `
    <line x1="4" y1="10" x2="16" y2="4"/>
    <line x1="4" y1="15" x2="16" y2="9"/>
  `,
  'perpendicular': `
    <line x1="4" y1="16" x2="4" y2="4"/>
    <line x1="4" y1="16" x2="16" y2="16"/>
    <rect x="4" y="12" width="4" height="4" opacity="0.6"/>
  `,
  'distance': `
    <circle cx="5" cy="10" r="2" fill="currentColor" stroke="none"/>
    <circle cx="15" cy="10" r="2" fill="currentColor" stroke="none"/>
    <line x1="7" y1="10" x2="13" y2="10" stroke-dasharray="2,2"/>
  `,
  'lock': `
    <rect x="5" y="10" width="10" height="7" rx="1.5"/>
    <path d="M7 10V7a3 3 0 016 0v3"/>
  `,
  'equal': `
    <line x1="6" y1="8" x2="14" y2="8"/>
    <line x1="6" y1="12" x2="14" y2="12"/>
  `,
  'tangent': `
    <circle cx="9" cy="10" r="5"/>
    <line x1="14" y1="4" x2="14" y2="16"/>
  `,
  'angle': `
    <line x1="3" y1="17" x2="17" y2="17"/>
    <line x1="3" y1="17" x2="13" y2="5"/>
    <path d="M8 17 A5 5 0 0 1 7 13"/>
  `,
  'midpoint-snap': `
    <line x1="3" y1="10" x2="17" y2="10"/>
    <circle cx="10" cy="10" r="2.5" fill="currentColor" stroke="none"/>
    <circle cx="3" cy="10" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="17" cy="10" r="1.2" fill="currentColor" stroke="none"/>
  `,

  // ── Pattern ────────────────────────────────────────────────────────────────
  'mirror': `
    <line x1="10" y1="3" x2="10" y2="17" stroke-dasharray="2,2"/>
    <polygon points="4,7 7,4 7,16 4,13"/>
    <polygon points="16,7 13,4 13,16 16,13"/>
  `,
  'linear-pattern': `
    <rect x="2" y="7" width="4" height="6" rx="0.5"/>
    <rect x="8" y="7" width="4" height="6" rx="0.5"/>
    <rect x="14" y="7" width="4" height="6" rx="0.5"/>
    <line x1="6" y1="16" x2="14" y2="16"/>
    <polygon points="13,15 14,16 13,17" fill="currentColor" stroke="none"/>
  `,
  'radial-pattern': `
    <circle cx="10" cy="10" r="7" stroke-dasharray="2,2"/>
    <rect x="8" y="1" width="4" height="4" rx="0.5"/>
    <rect x="15" y="8" width="4" height="4" rx="0.5"/>
    <rect x="8" y="15" width="4" height="4" rx="0.5"/>
    <rect x="1" y="8" width="4" height="4" rx="0.5"/>
  `,

  // ── Transport (play / pause / stop / step) ─────────────────────────────────
  // These are always solid-filled; use solid() wrapper.
  'play': `
    <polygon points="5,3 17,10 5,17" fill="currentColor" stroke="none"/>
  `,
  'pause': `
    <rect x="3" y="3" width="5" height="14" rx="1" fill="currentColor" stroke="none"/>
    <rect x="12" y="3" width="5" height="14" rx="1" fill="currentColor" stroke="none"/>
  `,
  'stop': `
    <rect x="3" y="3" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>
  `,
  'step-back': `
    <line x1="4" y1="2" x2="4" y2="18"/>
    <polygon points="16,3 5,10 16,17" fill="currentColor" stroke="none"/>
  `,
  'step-forward': `
    <polygon points="4,3 15,10 4,17" fill="currentColor" stroke="none"/>
    <line x1="16" y1="2" x2="16" y2="18"/>
  `,

  // ── UI / misc ──────────────────────────────────────────────────────────────
  'eye': `
    <path d="M1 10C3 6.5 6.5 4 10 4s7 2.5 9 6c-2 3.5-5.5 6-9 6s-7-2.5-9-6z"/>
    <circle cx="10" cy="10" r="3"/>
  `,
  'camera': `
    <rect x="2" y="6" width="16" height="11" rx="1.5"/>
    <path d="M7 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
    <circle cx="10" cy="12" r="3"/>
  `,
  'gallery': `
    <rect x="1" y="1" width="10" height="10" rx="0.5"/>
    <rect x="9" y="9" width="10" height="10" rx="0.5"/>
    <circle cx="5" cy="5" r="1.5"/>
    <polyline points="1,10 5,6 9,10"/>
  `,
  'record': `
    <circle cx="10" cy="10" r="7"/>
    <circle cx="10" cy="10" r="4" fill="currentColor" stroke="none"/>
  `,
  'bar-chart': `
    <line x1="4" y1="16" x2="4" y2="8"/>
    <line x1="9" y1="16" x2="9" y2="4"/>
    <line x1="14" y1="16" x2="14" y2="10"/>
    <line x1="2" y1="16" x2="18" y2="16"/>
  `,
  'folder-open': `
    <path d="M2 15V8h5l2-2h9v9H2z"/>
    <line x1="2" y1="11" x2="18" y2="11"/>
  `,
  'folder-download': `
    <path d="M2 16V8h5l2-2h9v10H2z"/>
    <line x1="10" y1="11" x2="10" y2="16"/>
    <polyline points="7,14 10,17 13,14"/>
  `,
  'chevron-left': `
    <polyline points="13,4 5,10 13,16"/>
  `,
  'chevron-up': `
    <polyline points="3,13 10,6 17,13"/>
  `,
  'chevron-down': `
    <polyline points="3,7 10,14 17,7"/>
  `,
  'toolbar-auto': `
    <circle cx="10" cy="10" r="6"/>
    <line x1="10" y1="4" x2="10" y2="16"/>
  `,

  // ── Node tree ──────────────────────────────────────────────────────────────
  'origin-cross': `
    <line x1="10" y1="1" x2="10" y2="19"/>
    <line x1="1" y1="10" x2="19" y2="10"/>
    <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/>
  `,
  'node-grid': `
    <line x1="3" y1="7" x2="17" y2="7"/>
    <line x1="3" y1="10" x2="17" y2="10"/>
    <line x1="3" y1="13" x2="17" y2="13"/>
    <line x1="7" y1="3" x2="7" y2="17"/>
    <line x1="10" y1="3" x2="10" y2="17"/>
    <line x1="13" y1="3" x2="13" y2="17"/>
  `,
  'axis-arrows': `
    <line x1="10" y1="17" x2="10" y2="3"/>
    <polyline points="6,6 10,2 14,6"/>
    <polyline points="6,14 10,18 14,14"/>
  `,
  'plane': `
    <polygon points="1,17 5,6 19,6 15,17"/>
  `,

  // ── Feature types (history tree + parameters panel) ────────────────────────
  'feature-sketch': `
    <rect x="2" y="5" width="12" height="12" rx="1" opacity="0.25"/>
    <path d="M10 12l3.5-7 2.5 2.5-7 3.5z"/>
    <line x1="13.5" y1="5" x2="16" y2="7.5"/>
  `,
  'feature-extrude': `
    <rect x="4" y="13" width="12" height="4" rx="0.5"/>
    <line x1="10" y1="13" x2="10" y2="5"/>
    <polyline points="7,8 10,5 13,8"/>
    <line x1="4" y1="13" x2="4" y2="10" opacity="0.5"/>
    <line x1="16" y1="13" x2="16" y2="10" opacity="0.5"/>
  `,
  'feature-revolve': `
    <line x1="4" y1="2" x2="4" y2="18" stroke-dasharray="2.5,1.5"/>
    <path d="M4 5Q10 5 10 10Q10 15 4 15"/>
    <path d="M14 8 A5 4 0 0 1 14 12"/>
    <polyline points="12,7 14,8 13,11"/>
  `,
  'feature-sweep': `
    <path d="M4 15 C6 6 12 5 16 11"/>
    <rect x="2" y="12" width="5" height="5" rx="0.5"/>
    <polyline points="14,9 16,11 14,13"/>
  `,
  'feature-loft': `
    <rect x="2" y="3" width="6" height="6" rx="0.5"/>
    <ellipse cx="15" cy="14" rx="3.5" ry="3"/>
    <path d="M8 3 C11 3 11.5 11 11.5 11"/>
    <path d="M8 9 C11 9 11.5 17 11.5 17"/>
  `,
  'feature-extrude-cut': `
    <rect x="3" y="3" width="14" height="5" rx="0.5"/>
    <rect x="7" y="8" width="6" height="9" rx="0.5" stroke-dasharray="2,1.5"/>
    <line x1="10" y1="5" x2="10" y2="10"/>
    <polyline points="8,8 10,10 12,8"/>
  `,
  'feature-chamfer': `
    <line x1="4" y1="17" x2="4" y2="8"/>
    <line x1="9" y1="3" x2="17" y2="3"/>
    <line x1="4" y1="8" x2="9" y2="3" stroke-width="2.8"/>
  `,
  'step-import': `
    <path d="M5 18V2h8l4 4v12H5z"/>
    <polyline points="13,2 13,6 17,6"/>
    <line x1="8" y1="10" x2="13" y2="10"/>
    <line x1="8" y1="13" x2="11" y2="13"/>
  `,
};

// ─── builders ─────────────────────────────────────────────────────────────────

/**
 * Build a complete SVG element string.
 * @param {string} key    - Key in PATH
 * @param {object} [o]
 * @param {string} [o.fill='none']
 * @param {string} [o.stroke='currentColor']
 * @param {string|number} [o.sw=1.5]    stroke-width
 * @param {number|null} [o.size=null]   rendered width=height in px; null = CSS controls
 * @param {string} [o.style='']         extra inline style on the <svg>
 */
export function icon(key, { fill = 'none', stroke = 'currentColor', sw = 1.5, size = null, style = '' } = {}) {
  const dims  = size  != null ? ` width="${size}" height="${size}"` : '';
  const sty   = style          ? ` style="${style}"`               : '';
  return `<svg viewBox="0 0 20 20"${dims} fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${sty}>${PATH[key]}</svg>`;
}

/** Stroked (outline) icon. size=null lets CSS control width/height. */
export const outline = (key, size = null) =>
  icon(key, { size });

/** Solid (filled) icon — play, pause, stop, etc. */
export const solid = (key, size = null) =>
  icon(key, { fill: 'currentColor', stroke: 'none', sw: 0, size });

// ─── initIcons ────────────────────────────────────────────────────────────────

/** Map of button id → icon key for all toolbar buttons (CSS provides size/colour). */
const TOOLBAR_BUTTONS = {
  // Row 1: File
  'btn-new':                    'new-file',
  'btn-open':                   'open-file',
  'btn-save':                   'save-file',
  // Row 1: Edit
  'btn-select':                 'select',
  'btn-undo':                   'undo',
  'btn-redo':                   'redo',
  'btn-delete':                 'delete',
  // Row 1: View
  'btn-zoom-fit':               'zoom-fit',
  'btn-zoom-in':                'zoom-in',
  'btn-zoom-out':               'zoom-out',
  'btn-grid-toggle':            'grid',
  'btn-snap-toggle':            'snap',
  'btn-autocoincidence-toggle': 'autocoincidence',
  // Row 1: Sketch entry
  'btn-sketch-on-plane':        'feature-sketch',
  'btn-create-plane':           'plane',
  // Row 1: Features
  'btn-extrude':                'feature-extrude',
  'btn-extrude-cut':            'extrude-cut',
  'btn-revolve':                'revolve',
  'btn-sweep':                  'sweep',
  'btn-loft':                   'loft',
  // Row 1: Ops
  'btn-chamfer':                'chamfer',
  'btn-fillet':                 'fillet',
  'btn-motion':                 'motion',
  // Row 1: CAM
  'btn-enter-cam':              'cam-enter',
  'btn-cam-setup':              'cam-setup',
  'btn-cam-profile':            'cam-profile',
  'btn-cam-pocket':             'cam-pocket',
  'btn-cam-export':             'download',
  'btn-exit-cam':               'back',
  // Row 2: Draw
  'btn-construction':           'construction',
  'btn-point':                  'point',
  'btn-line':                   'line-draw',
  'btn-rect':                   'rect-draw',
  'btn-circle':                 'circle-draw',
  'btn-arc':                    'arc-draw',
  'btn-polyline':               'polyline-draw',
  'btn-spline':                 'spline',
  'btn-bezier':                 'bezier',
  'btn-text':                   'text',
  // Row 2: Modify
  'btn-move':                   'move',
  'btn-copy':                   'copy',
  'btn-trim':                   'trim',
  'btn-split':                  'split',
  // Row 2: Sketch ops
  'btn-disconnect':             'disconnect',
  'btn-union':                  'union',
  'btn-sketch-fillet':          'sketch-fillet',
  'btn-sketch-chamfer':         'sketch-chamfer',
  'btn-trace-image':            'trace-image',
  // Row 3: Constraints
  'btn-dimension':              'dimension',
  'btn-coincident':             'coincident',
  'btn-horizontal':             'horizontal',
  'btn-vertical':               'vertical',
  'btn-parallel':               'parallel',
  'btn-perpendicular':          'perpendicular',
  'btn-distance':               'distance',
  'btn-lock':                   'lock',
  'btn-equal':                  'equal',
  'btn-tangent':                'tangent',
  'btn-angle':                  'angle',
  'btn-midpoint-snap':          'midpoint-snap',
  // Row 3: Pattern
  'btn-mirror':                 'mirror',
  'btn-linear-pattern':         'linear-pattern',
  'btn-radial-pattern':         'radial-pattern',
};

/**
 * Populate every icon-bearing element in the DOM.
 * Call once after the HTML has been parsed (main.js calls this at startup).
 */
export function initIcons() {
  // ── Toolbar buttons (CSS handles size + colour) ───────────────────────────
  for (const [id, key] of Object.entries(TOOLBAR_BUTTONS)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = outline(key);
  }

  // ── Node-tree icons (CSS handles size + colour via .node-tree-icon svg) ───
  const nt = (sel, key) => {
    const el = document.querySelector(sel);
    if (el) el.innerHTML = outline(key);
  };
  nt('.node-tree-origin .node-tree-icon',      'origin-cross');
  nt('#node-tree-grid .node-tree-icon',         'node-grid');
  nt('#node-tree-origin-axis .node-tree-icon',  'axis-arrows');
  for (const el of document.querySelectorAll('.node-tree-plane .node-tree-icon')) {
    el.innerHTML = outline('plane');
  }

  // ── Left-panel toggle-all buttons (12 px, inline attrs required) ──────────
  for (const id of ['btn-toggle-all-dims', 'btn-toggle-all-constraints']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = outline('eye', 12);
  }

  // ── Scene manager buttons (12 px icons + text labels) ─────────────────────
  const inl = 'vertical-align:middle;margin-right:3px';
  const scDl = document.getElementById('scene-download-image');
  if (scDl)  scDl.innerHTML  = icon('camera',  { size: 12, style: inl }) + ' Download';
  const scGal = document.getElementById('scene-gallery');
  if (scGal) scGal.innerHTML = icon('gallery', { size: 12, style: inl }) + ' Gallery';

  // ── Recording bar (14 px, inline attrs required) ──────────────────────────
  const recMap = {
    'btn-record':        outline('record',       14),
    'btn-record-export': outline('download',     14),
    'btn-record-open':   outline('folder-open',  14),
    'btn-play-prev':     outline('step-back',    14),  // mixed: line + filled polygon
    'btn-play-toggle':   solid('play',           14),
    'btn-play-next':     outline('step-forward', 14),  // mixed: filled polygon + line
    'btn-play-stop':     solid('stop',           14),
  };
  for (const [id, html] of Object.entries(recMap)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  // ── Motion panel ──────────────────────────────────────────────────────────
  const mi  = 'vertical-align:middle;margin-right:4px';
  const mi3 = 'vertical-align:middle;margin-right:3px';

  const motTitle = document.querySelector('.motion-title');
  if (motTitle) motTitle.innerHTML = icon('motion', { size: 13, style: mi }) + 'Motion Analysis';

  const motExport = document.getElementById('motion-export-csv');
  if (motExport) motExport.innerHTML = icon('bar-chart', { size: 11, style: mi3 }) + ' CSV';

  const motRun = document.getElementById('motion-run');
  if (motRun) motRun.innerHTML = icon('play', { fill: 'currentColor', stroke: 'none', sw: 0, size: 11, style: mi }) + ' Run Analysis';

  const motPlay = document.getElementById('motion-play');
  if (motPlay) motPlay.innerHTML = solid('play', 12);

  const motStop = document.getElementById('motion-stop');
  if (motStop) motStop.innerHTML = icon('stop', { fill: 'currentColor', stroke: 'none', sw: 0, size: 11, style: mi3 }) + ' Stop';

  // ── Exit sketch / extrude floating buttons ────────────────────────────────
  for (const [id, label] of [['btn-exit-sketch', 'Exit Sketch'], ['btn-exit-extrude', 'Exit Extrude']]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = icon('chevron-left', { size: 20, sw: 2.5 }) + '\n    ' + label;
  }

  // ── Toolbar toggle chevron (initial state = open) ─────────────────────────
  const ttIcon = document.getElementById('toolbar-toggle-icon');
  if (ttIcon) {
    ttIcon.setAttribute('viewBox', '0 0 20 20');
    ttIcon.innerHTML = PATH['chevron-up'];
  }

  // ── File drop overlay (48 px folder icon) ─────────────────────────────────
  const dropIcon = document.querySelector('#file-drop-overlay .drop-icon');
  if (dropIcon) dropIcon.innerHTML = icon('folder-download', { size: 48, sw: 2 });
}
