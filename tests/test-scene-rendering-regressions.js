import './_watchdog.mjs';
import assert from 'assert';
import { readFileSync } from 'fs';
import { getWebGL2ContextOptions, isLikelySamsungAndroidChrome } from '../js/webgl-executor.js';

console.log('=== Scene Rendering Regression Tests ===\n');

const samsungChromeUa = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
assert.strictEqual(isLikelySamsungAndroidChrome(samsungChromeUa), true, 'Samsung Android Chrome should be detected');

const samsungOptions = getWebGL2ContextOptions(samsungChromeUa);
assert.ok(samsungOptions.length > 0, 'Should provide WebGL2 context options');
assert.deepStrictEqual(
  samsungOptions[0],
  { antialias: true, alpha: false, preserveDrawingBuffer: false, stencil: false },
  'Samsung Android Chrome should first try the safe no-preserve/no-stencil context',
);
assert.ok(
  samsungOptions.every(options => !(options.preserveDrawingBuffer && options.stencil)),
  'Samsung Android Chrome should not request preserveDrawingBuffer and stencil together',
);

const desktopOptions = getWebGL2ContextOptions('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
assert.deepStrictEqual(
  desktopOptions[0],
  { antialias: true, alpha: false, preserveDrawingBuffer: true, stencil: true },
  'Desktop should keep the high-quality context first',
);

const mainSource = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
assert.match(
  mainSource,
  /shouldAllowLeftClickOrbit\s*=\s*\(\)\s*=>\s*false/,
  'Mouse left button should stay available for selection; orbit uses middle/right mouse or touch gestures',
);
assert.match(
  mainSource,
  /_leftClickOrbitEnabled\s*=\s*false/,
  'Part-mode state updates must not re-enable conflicting mouse left-click orbit',
);

console.log('ok');
