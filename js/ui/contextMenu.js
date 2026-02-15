// js/ui/contextMenu.js — Lightweight context menu system (styled like VovkPLCEditor)

let _menuEl = null;
let _onCloseCallback = null;

function _ensureRoot() {
  if (_menuEl) return _menuEl;
  _menuEl = document.createElement('div');
  _menuEl.className = 'context-menu hidden';
  document.body.appendChild(_menuEl);

  // Click-away closes menu
  document.addEventListener('mousedown', (e) => {
    if (_menuEl.classList.contains('hidden')) return;
    if (_menuEl.contains(e.target)) return;
    closeContextMenu();
  });

  // Escape closes menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !_menuEl.classList.contains('hidden')) {
      closeContextMenu();
    }
  });

  return _menuEl;
}

/**
 * Build menu items from a declaration array.
 * Each entry is one of:
 *   { type: 'item', label, icon?, shortcut?, disabled?, action? }
 *   { type: 'separator' }
 *   { type: 'submenu', label, icon?, items: [...] }
 */
function _buildItems(container, items) {
  for (const item of items) {
    if (item.type === 'separator') {
      container.appendChild(document.createElement('hr'));
      continue;
    }

    const row = document.createElement('div');
    row.className = 'menu-item';
    if (item.disabled) row.classList.add('disabled');

    // Icon
    const iconSpan = document.createElement('span');
    iconSpan.className = 'menu-icon';
    if (item.iconHtml) {
      iconSpan.innerHTML = item.iconHtml;
    } else {
      iconSpan.textContent = item.icon || '';
    }
    row.appendChild(iconSpan);

    // Label
    const labelSpan = document.createElement('span');
    labelSpan.className = 'menu-label';
    if (item.labelHtml) {
      labelSpan.innerHTML = item.labelHtml;
    } else {
      labelSpan.textContent = item.label || '';
    }
    row.appendChild(labelSpan);

    if (item.type === 'submenu') {
      // Arrow indicator
      const arrow = document.createElement('span');
      arrow.className = 'menu-submenu-arrow';
      arrow.textContent = '▸';
      row.appendChild(arrow);

      // Submenu container
      const sub = document.createElement('div');
      sub.className = 'submenu-container';
      _buildItems(sub, item.items || []);
      row.appendChild(sub);
    } else {
      // Shortcut
      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'menu-shortcut';
        sc.textContent = item.shortcut;
        row.appendChild(sc);
      }

      // Action
      if (item.action && !item.disabled) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          closeContextMenu();
          item.action();
        });
      }
    }

    container.appendChild(row);
  }
}

/**
 * Show a context menu at (x, y) screen coordinates.
 * @param {number} x - clientX
 * @param {number} y - clientY
 * @param {Array} items - menu item declarations
 * @param {Function} [onClose] - called when menu closes
 */
export function showContextMenu(x, y, items, onClose) {
  const menu = _ensureRoot();
  menu.innerHTML = '';
  _onCloseCallback = onClose || null;

  _buildItems(menu, items);

  // Position
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';

  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const offset = 2;
  let posX = x + offset;
  let posY = y + offset;

  if (posX + mw > window.innerWidth) posX = x - mw - offset;
  if (posY + mh > window.innerHeight) posY = y - mh - offset;
  if (posX < 0) posX = offset;
  if (posY < 0) posY = offset;

  menu.style.left = posX + 'px';
  menu.style.top = posY + 'px';
}

/** Close the context menu */
export function closeContextMenu() {
  if (!_menuEl) return;
  _menuEl.classList.add('hidden');
  _menuEl.innerHTML = '';
  if (_onCloseCallback) {
    const cb = _onCloseCallback;
    _onCloseCallback = null;
    cb();
  }
}

/** Check if context menu is open */
export function isContextMenuOpen() {
  return _menuEl && !_menuEl.classList.contains('hidden');
}
