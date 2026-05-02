import { projectFacesToEdges, exportFacesDXF } from '../dxf/export.js';

/**
 * DXF Export sidebar panel — shows selection info, mini preview, and Export button.
 * On Export, opens a full-screen 2D preview with zoom/pan, Download & Exit.
 */
export class DxfExportPanel {
  constructor({ getSelectedFaces, getRenderer, getExactTopoBody, onExit, setStatus, buildSelectionList }) {
    this._getSelectedFaces = getSelectedFaces;
    this._getRenderer = getRenderer;
    this._getExactTopoBody = getExactTopoBody;
    this._onExit = onExit;
    this._setStatus = setStatus;
    this._buildSelectionList = buildSelectionList;
    this._container = null;
    this._selectionWrap = null;
    this._previewCanvas = null;
    this._previewCtx = null;
    this._cachedProjection = null; // { edges, bounds, faces }
    this._overlay = null;
  }

  /** Build the sidebar panel DOM and return it */
  build(parentEl) {
    this._container = document.createElement('div');
    this._container.className = 'dxf-export-panel';

    // Title
    const title = document.createElement('h3');
    title.textContent = 'DXF Export';
    title.style.cssText = 'margin:0 0 8px;font-size:13px;color:var(--text-primary)';
    this._container.appendChild(title);

    // Selection list (same as the standard selection UI)
    this._selectionWrap = document.createElement('div');
    this._selectionWrap.className = 'dxf-export-selection';
    this._container.appendChild(this._selectionWrap);

    // Mini preview canvas
    const previewWrap = document.createElement('div');
    previewWrap.className = 'dxf-export-preview-wrap';
    this._previewCanvas = document.createElement('canvas');
    this._previewCanvas.className = 'dxf-export-preview';
    this._previewCanvas.width = 190;
    this._previewCanvas.height = 140;
    previewWrap.appendChild(this._previewCanvas);
    this._container.appendChild(previewWrap);
    this._previewCtx = this._previewCanvas.getContext('2d');

    // Stats
    this._statsEl = document.createElement('div');
    this._statsEl.className = 'dxf-export-stats';
    this._container.appendChild(this._statsEl);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px';

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.className = 'dxf-export-btn primary';
    exportBtn.addEventListener('click', () => this._openPreviewOverlay());
    btnRow.appendChild(exportBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'dxf-export-btn';
    cancelBtn.addEventListener('click', () => this._onExit?.());
    btnRow.appendChild(cancelBtn);

    this._container.appendChild(btnRow);
    parentEl.innerHTML = '';
    parentEl.appendChild(this._container);

    this.refresh();
  }

  /** Refresh selection list, preview, and stats */
  refresh() {
    // Rebuild the selection list
    if (this._selectionWrap && this._buildSelectionList) {
      this._selectionWrap.innerHTML = '';
      this._selectionWrap.appendChild(this._buildSelectionList());
    }

    // Update preview
    const faces = this._collectFaces();
    if (!faces || faces.length === 0) {
      this._statsEl.textContent = 'Select faces to preview export';
      this._clearPreview();
      this._cachedProjection = null;
      return;
    }

    const topoBody = this._getExactTopoBody?.() || null;
    const proj = projectFacesToEdges(faces, undefined, { topoBody });
    this._cachedProjection = proj ? { ...proj, faces, topoBody } : null;

    if (proj) {
      const curveCount = proj.curves ? proj.curves.length : proj.edges.length;
      this._statsEl.textContent = `${curveCount} curves · ${proj.bounds.width.toFixed(2)} × ${proj.bounds.height.toFixed(2)}`;
      this._drawMiniPreview(proj);
    } else {
      this._statsEl.textContent = topoBody
        ? 'Exact boundary projection failed'
        : 'Exact B-Rep topology required for face DXF export';
      this._clearPreview();
    }
  }

  _collectFaces() {
    const selectedFaces = this._getSelectedFaces();
    const renderer = this._getRenderer();
    if (!selectedFaces || selectedFaces.size === 0 || !renderer) return null;

    // Expand selection to all faces in the same feature face group(s)
    const allFaces = renderer.getAllFaces();
    if (!allFaces) return null;

    const selectedGroups = new Set();
    for (const faceIndex of selectedFaces.keys()) {
      const info = renderer.getFaceInfo(faceIndex);
      if (info) selectedGroups.add(info.faceGroup != null ? info.faceGroup : faceIndex);
    }

    const faces = [];
    for (let i = 0; i < allFaces.length; i++) {
      const face = allFaces[i];
      const group = face.faceGroup != null ? face.faceGroup : i;
      if (selectedGroups.has(group)) faces.push(face);
    }

    return faces.length > 0 ? faces : null;
  }

  _clearPreview() {
    const ctx = this._previewCtx;
    if (!ctx) return;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, this._previewCanvas.width, this._previewCanvas.height);
    ctx.fillStyle = '#555';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No preview', this._previewCanvas.width / 2, this._previewCanvas.height / 2);
  }

  _drawMiniPreview(proj) {
    const canvas = this._previewCanvas;
    const ctx = this._previewCtx;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, W, H);

    const { edges, bounds } = proj;
    if (edges.length === 0) return;

    const pad = 12;
    const scaleX = (W - pad * 2) / (bounds.width || 1);
    const scaleY = (H - pad * 2) / (bounds.height || 1);
    const scale = Math.min(scaleX, scaleY);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;

    const tx = v => (v - cx) * scale + W / 2;
    const ty = v => -(v - cy) * scale + H / 2; // flip Y for screen

    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const e of edges) {
      ctx.moveTo(tx(e.x1), ty(e.y1));
      ctx.lineTo(tx(e.x2), ty(e.y2));
    }
    ctx.stroke();
  }

  /** Open full-screen preview overlay */
  _openPreviewOverlay() {
    if (!this._cachedProjection) {
      this._setStatus?.('Nothing to export — select faces first');
      return;
    }

    const { edges, bounds, faces } = this._cachedProjection;
    const curveCount = this._cachedProjection.curves ? this._cachedProjection.curves.length : edges.length;

    // Build overlay DOM
    const overlay = document.createElement('div');
    overlay.className = 'dxf-preview-overlay';

    // Top bar
    const topBar = document.createElement('div');
    topBar.className = 'dxf-preview-topbar';

    const exitBtn = document.createElement('button');
    exitBtn.className = 'dxf-preview-btn exit';
    exitBtn.textContent = 'Exit';
    exitBtn.addEventListener('click', () => this._closeOverlay());

    const titleSpan = document.createElement('span');
    titleSpan.className = 'dxf-preview-title';
    titleSpan.textContent = `DXF Preview — ${curveCount} curves`;

    const dlBtn = document.createElement('button');
    dlBtn.className = 'dxf-preview-btn download';
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', () => {
      this._downloadDXF(faces);
      this._closeOverlay();
    });

    topBar.appendChild(exitBtn);
    topBar.appendChild(titleSpan);
    topBar.appendChild(dlBtn);
    overlay.appendChild(topBar);

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'dxf-preview-canvas';
    overlay.appendChild(canvas);

    document.body.appendChild(overlay);
    this._overlay = overlay;

    // Size canvas to overlay
    const rect = overlay.getBoundingClientRect();
    const barH = topBar.offsetHeight;
    canvas.width = rect.width;
    canvas.height = rect.height - barH;
    canvas.style.top = barH + 'px';

    // Initialize pan/zoom state
    const pz = {
      zoom: 1,
      panX: 0,
      panY: 0,
      dragging: false,
      lastX: 0,
      lastY: 0,
    };

    // Fit content
    const pad = 40;
    const scaleX = (canvas.width - pad * 2) / (bounds.width || 1);
    const scaleY = (canvas.height - pad * 2) / (bounds.height || 1);
    pz.zoom = Math.min(scaleX, scaleY);
    pz.panX = canvas.width / 2 - ((bounds.minX + bounds.maxX) / 2) * pz.zoom;
    pz.panY = canvas.height / 2 + ((bounds.minY + bounds.maxY) / 2) * pz.zoom;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, W, H);

      // Grid
      const gridStep = this._niceGridStep(pz.zoom);
      if (gridStep > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const left = -pz.panX / pz.zoom;
        const right = (W - pz.panX) / pz.zoom;
        const top = pz.panY / pz.zoom;
        const bottom = -(H - pz.panY) / pz.zoom;
        const startX = Math.floor(left / gridStep) * gridStep;
        const startY = Math.floor(bottom / gridStep) * gridStep;
        for (let x = startX; x <= right; x += gridStep) {
          const sx = x * pz.zoom + pz.panX;
          ctx.moveTo(sx, 0); ctx.lineTo(sx, H);
        }
        for (let y = startY; y <= top; y += gridStep) {
          const sy = -y * pz.zoom + pz.panY;
          ctx.moveTo(0, sy); ctx.lineTo(W, sy);
        }
        ctx.stroke();
      }

      // Origin crosshair
      const ox = pz.panX, oy = pz.panY;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox, 0); ctx.lineTo(ox, H);
      ctx.moveTo(0, oy); ctx.lineTo(W, oy);
      ctx.stroke();

      // Edges
      ctx.strokeStyle = '#4fc3f7';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const e of edges) {
        const x1 = e.x1 * pz.zoom + pz.panX;
        const y1 = -e.y1 * pz.zoom + pz.panY;
        const x2 = e.x2 * pz.zoom + pz.panX;
        const y2 = -e.y2 * pz.zoom + pz.panY;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();

      // Vertices (dots)
      ctx.fillStyle = '#81d4fa';
      const seen = new Set();
      for (const e of edges) {
        for (const [vx, vy] of [[e.x1, e.y1], [e.x2, e.y2]]) {
          const key = `${vx.toFixed(4)},${vy.toFixed(4)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sx = vx * pz.zoom + pz.panX;
          const sy = -vy * pz.zoom + pz.panY;
          ctx.beginPath();
          ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    draw();

    // Mouse events for pan/zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      pz.panX = mx - (mx - pz.panX) * factor;
      pz.panY = my - (my - pz.panY) * factor;
      pz.zoom *= factor;
      draw();
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 1) {
        pz.dragging = true;
        pz.lastX = e.clientX;
        pz.lastY = e.clientY;
        canvas.style.cursor = 'grabbing';
      }
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!pz.dragging) return;
      pz.panX += e.clientX - pz.lastX;
      pz.panY += e.clientY - pz.lastY;
      pz.lastX = e.clientX;
      pz.lastY = e.clientY;
      draw();
    });
    const stopDrag = () => { pz.dragging = false; canvas.style.cursor = 'grab'; };
    canvas.addEventListener('mouseup', stopDrag);
    canvas.addEventListener('mouseleave', stopDrag);
    canvas.style.cursor = 'grab';

    // Escape to close
    this._overlayKeyHandler = (e) => {
      if (e.key === 'Escape') this._closeOverlay();
    };
    document.addEventListener('keydown', this._overlayKeyHandler);

    // Handle resize
    this._overlayResizeHandler = () => {
      const r = overlay.getBoundingClientRect();
      canvas.width = r.width;
      canvas.height = r.height - barH;
      draw();
    };
    window.addEventListener('resize', this._overlayResizeHandler);
  }

  _niceGridStep(zoom) {
    const targetPx = 40; // desired pixel spacing
    const raw = targetPx / zoom;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / pow;
    if (norm < 2) return 2 * pow;
    if (norm < 5) return 5 * pow;
    return 10 * pow;
  }

  _downloadDXF(faces) {
    const topoBody = this._getExactTopoBody?.() || null;
    const content = exportFacesDXF(faces, undefined, { topoBody });
    if (!content) { this._setStatus?.('Export produced empty output'); return; }
    const blob = new Blob([content], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'faces.dxf';
    a.click();
    URL.revokeObjectURL(url);
    this._setStatus?.('DXF downloaded');
  }

  _closeOverlay() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    if (this._overlayKeyHandler) {
      document.removeEventListener('keydown', this._overlayKeyHandler);
      this._overlayKeyHandler = null;
    }
    if (this._overlayResizeHandler) {
      window.removeEventListener('resize', this._overlayResizeHandler);
      this._overlayResizeHandler = null;
    }
  }

  destroy() {
    this._closeOverlay();
    if (this._container) {
      this._container.remove();
      this._container = null;
    }
  }
}
