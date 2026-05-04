import { getOrCreateConsoleViewController } from './console-view.js';

const controller = getOrCreateConsoleViewController();

function updateStartupRecoveryMessage() {
  if (window.__modellerMainAppInitialized) return;
  const label = document.getElementById('startup-loading-label');
  if (!label) return;
  label.textContent = 'Startup encountered an error. Open Console to inspect logs while the rest of the app is recovering.';
}

function bindConsoleRecovery() {
  controller.bind();
  controller.syncWithLocation();

  window.addEventListener('hashchange', () => controller.syncWithLocation());
  window.addEventListener('error', updateStartupRecoveryMessage);
  window.addEventListener('unhandledrejection', updateStartupRecoveryMessage);

  document.addEventListener('click', (event) => {
    const recoveryButton = event.target.closest('#startup-open-console');
    if (recoveryButton) {
      event.preventDefault();
      controller.open({ isolate: true, updateHash: true });
      return;
    }

    if (window.__modellerMainAppInitialized) return;

    const helpLabel = event.target.closest('.menu-item[data-menu="help"] > .menu-label');
    if (helpLabel) {
      event.preventDefault();
      event.stopPropagation();
      const helpItem = helpLabel.closest('.menu-item[data-menu="help"]');
      const shouldOpen = !helpItem.classList.contains('open');
      document.querySelectorAll('#menu-bar .menu-item.open').forEach((item) => item.classList.remove('open'));
      helpItem.classList.toggle('open', shouldOpen);
      return;
    }

    const consoleButton = event.target.closest('[data-action="help-console"]');
    if (consoleButton) {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector('.menu-item[data-menu="help"]')?.classList.remove('open');
      controller.open({ isolate: true, updateHash: true });
      return;
    }

    if (!event.target.closest('#menu-bar')) {
      document.querySelector('.menu-item[data-menu="help"]')?.classList.remove('open');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindConsoleRecovery, { once: true });
} else {
  bindConsoleRecovery();
}
