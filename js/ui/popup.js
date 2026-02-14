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
