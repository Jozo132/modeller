let modalBusy = false;

function getRoot() {
  return document.getElementById('app-modal-root');
}

function closeModal(root) {
  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = '';
  modalBusy = false;
}

function buildBase({ title = 'Confirm', message = '' }) {
  const root = getRoot();
  if (!root || modalBusy) return null;
  modalBusy = true;

  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');

  const backdrop = document.createElement('div');
  backdrop.className = 'app-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'app-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const titleEl = document.createElement('div');
  titleEl.className = 'app-modal-title';
  titleEl.textContent = title;

  const msgEl = document.createElement('div');
  msgEl.className = 'app-modal-message';
  msgEl.textContent = message;

  modal.appendChild(titleEl);
  modal.appendChild(msgEl);

  root.appendChild(backdrop);
  root.appendChild(modal);

  return { root, backdrop, modal };
}

export function showConfirm({ title = 'Confirm', message = '', okText = 'OK', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const ui = buildBase({ title, message });
    if (!ui) {
      resolve(false);
      return;
    }

    const { root, backdrop, modal } = ui;
    const actions = document.createElement('div');
    actions.className = 'app-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'app-modal-btn';
    cancelBtn.textContent = cancelText;

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-modal-btn primary';
    okBtn.textContent = okText;

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    modal.appendChild(actions);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      closeModal(root);
      resolve(value);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    backdrop.addEventListener('click', () => finish(false));
    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));

    okBtn.focus();
  });
}

export function showPrompt({
  title = 'Input',
  message = '',
  defaultValue = '',
  okText = 'OK',
  cancelText = 'Cancel',
  validate = null,
} = {}) {
  return new Promise((resolve) => {
    const ui = buildBase({ title, message });
    if (!ui) {
      resolve(null);
      return;
    }

    const { root, backdrop, modal } = ui;
    const input = document.createElement('input');
    input.className = 'app-modal-input';
    input.type = 'text';
    input.value = defaultValue;
    // Stop keyboard events from propagating to prevent tool hotkeys
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());

    const actions = document.createElement('div');
    actions.className = 'app-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'app-modal-btn';
    cancelBtn.textContent = cancelText;

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-modal-btn primary';
    okBtn.textContent = okText;

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    modal.appendChild(input);
    modal.appendChild(actions);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      closeModal(root);
      resolve(value);
    };

    const trySubmit = () => {
      const value = input.value;
      if (typeof validate === 'function' && !validate(value)) return;
      finish(value);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        trySubmit();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    backdrop.addEventListener('click', () => finish(null));
    cancelBtn.addEventListener('click', () => finish(null));
    okBtn.addEventListener('click', trySubmit);

    input.focus();
    input.select();
  });
}

// ---------------------------------------------------------------------------
// Inline dimension input — floating widget anchored near the canvas
// ---------------------------------------------------------------------------
let _inlineWidget = null;

function _removeInlineWidget() {
  if (_inlineWidget) {
    _inlineWidget.container.remove();
    if (_inlineWidget.cleanup) _inlineWidget.cleanup();
    _inlineWidget = null;
  }
}

/**
 * Show an inline dimension input floating near the cursor / canvas center.
 *
 * @param {object} opts
 * @param {string}  opts.dimType      — e.g. 'distance', 'angle', 'radius', 'length'
 * @param {string}  opts.defaultValue — pre-filled value string
 * @param {boolean} opts.driven       — initial state of "Driven" toggle
 * @param {string}  [opts.hint]       — optional extra description
 * @param {HTMLElement} [opts.anchor] — element to position near (e.g. canvas)
 * @param {{x:number,y:number}} [opts.screenPos] — screen-space position for the widget
 * @returns {Promise<{value:string, driven:boolean}|null>}  null = cancelled
 */
export function showDimensionInput({
  dimType = 'distance',
  defaultValue = '',
  driven = false,
  hint = '',
  anchor = null,
  screenPos = null,
  alternateTypes = null,   // array of { label, dimType, selected } or null
  onTypeChange = null,     // callback(idx) → { dimType, value } or null
} = {}) {
  _removeInlineWidget(); // only one at a time

  return new Promise((resolve) => {
    const container = document.createElement('div');
    container.className = 'dim-inline-widget';

    // --- Tooltip / header ---
    const tooltip = document.createElement('div');
    tooltip.className = 'dim-inline-tooltip';

    const typeLabel = document.createElement('span');
    typeLabel.className = 'dim-inline-type';
    typeLabel.textContent = dimType.charAt(0).toUpperCase() + dimType.slice(1);
    tooltip.appendChild(typeLabel);

    if (hint) {
      const hintEl = document.createElement('span');
      hintEl.className = 'dim-inline-hint';
      hintEl.textContent = hint;
      tooltip.appendChild(hintEl);
    }

    // --- Driven checkbox ---
    const drivenRow = document.createElement('label');
    drivenRow.className = 'dim-inline-driven';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = driven;
    drivenRow.appendChild(cb);
    drivenRow.appendChild(document.createTextNode(' Driven'));
    tooltip.appendChild(drivenRow);

    container.appendChild(tooltip);

    // --- Dimension type selector (when alternates exist) ---
    if (alternateTypes && alternateTypes.length > 1) {
      const typeRow = document.createElement('div');
      typeRow.className = 'dim-type-selector';

      alternateTypes.forEach((alt, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dim-type-btn' + (alt.selected ? ' active' : '');
        btn.textContent = alt.label;
        btn.title = alt.label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Update active state
          typeRow.querySelectorAll('.dim-type-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          // Notify tool of type change
          if (onTypeChange) {
            const result = onTypeChange(idx);
            if (result) {
              typeLabel.textContent = result.dimType.charAt(0).toUpperCase() + result.dimType.slice(1);
              input.value = result.value;
              input.select();
            }
          }
        });
        // Also stop keyboard events from bubbling
        btn.addEventListener('keydown', (e) => e.stopPropagation());
        typeRow.appendChild(btn);
      });

      container.appendChild(typeRow);
    }

    // --- Input row ---
    const inputRow = document.createElement('div');
    inputRow.className = 'dim-inline-input-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dim-inline-input';
    input.value = defaultValue;
    input.placeholder = 'value or variable…';
    // Stop all keyboard events from bubbling up to prevent tool hotkeys
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());
    inputRow.appendChild(input);

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'dim-inline-ok';
    okBtn.textContent = '✓';
    okBtn.title = 'Confirm (Enter)';
    inputRow.appendChild(okBtn);

    container.appendChild(inputRow);

    // --- Position the widget ---
    const canvasEl = anchor || document.getElementById('cad-canvas');
    if (canvasEl) {
      const rect = canvasEl.getBoundingClientRect();
      if (screenPos) {
        container.style.left = `${rect.left + screenPos.x}px`;
        container.style.top = `${rect.top + screenPos.y - 80}px`;
      } else {
        container.style.left = `${rect.left + rect.width / 2}px`;
        container.style.top = `${rect.top + rect.height / 2 - 40}px`;
      }
    }

    document.body.appendChild(container);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onOutsideClick, true);
      _removeInlineWidget();
      resolve(result);
    };

    const trySubmit = () => {
      finish({ value: input.value, driven: cb.checked });
    };

    const onKeyDown = (e) => {
      // Stop all key events from propagating to the main keyboard handler
      // This prevents tool hotkeys (like 'X' for Trim) from triggering while typing
      // Use stopImmediatePropagation to ensure no other listeners on document fire
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        trySubmit();
      }
    };

    const onOutsideClick = (e) => {
      if (!container.contains(e.target)) {
        finish(null);
      }
    };

    // Defer outside-click listener to avoid immediate close from the click that opened us
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onOutsideClick, true);
    });

    document.addEventListener('keydown', onKeyDown, true);
    // Also add container-level handler as backup
    container.addEventListener('keydown', (e) => e.stopPropagation(), true);
    okBtn.addEventListener('click', trySubmit);

    _inlineWidget = { container, cleanup: () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onOutsideClick, true);
    }};

    input.focus();
    input.select();
  });
}

/** Dismiss any open inline dimension input (e.g. on tool switch). */
export function dismissDimensionInput() {
  if (_inlineWidget) {
    _removeInlineWidget();
  }
}
