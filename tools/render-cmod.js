import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeCmodPng, writeCmodGalleryPng } from '../js/render/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function printUsage() {
  console.log(`Usage:
  node tools/render-cmod.js --input <model.cmod> --output <image.png> [options]

Options:
  --width <px>         Screenshot width. Default: 1280
  --height <px>        Screenshot height. Default: 720
  --fit-to-view        Ignore stored orbit and fit the model to view
  --orbit <json>       Orbit JSON string with theta, phi, radius, target{x,y,z}
  --theta <rad>        Override orbit theta
  --phi <rad>          Override orbit phi
  --radius <units>     Override orbit radius
  --target <x,y,z>     Override orbit target
  --gallery            Render all scenes as a gallery grid
  --cell-width <px>    Gallery cell width. Default: 320
  --cell-height <px>   Gallery cell height. Default: 240
  --columns <n>        Gallery columns. Default: auto
`);
}

function parseArgs(argv) {
  const options = {
    width: 1280,
    height: 720,
    fitToView: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--input':
        options.input = argv[++index];
        break;
      case '--output':
        options.output = argv[++index];
        break;
      case '--width':
        options.width = Number(argv[++index]);
        break;
      case '--height':
        options.height = Number(argv[++index]);
        break;
      case '--fit-to-view':
        options.fitToView = true;
        break;
      case '--orbit':
        options.orbit = JSON.parse(argv[++index]);
        break;
      case '--theta':
        options.theta = Number(argv[++index]);
        break;
      case '--phi':
        options.phi = Number(argv[++index]);
        break;
      case '--radius':
        options.radius = Number(argv[++index]);
        break;
      case '--target':
        options.target = parseTarget(argv[++index]);
        break;
      case '--gallery':
        options.gallery = true;
        break;
      case '--cell-width':
        options.cellWidth = Number(argv[++index]);
        break;
      case '--cell-height':
        options.cellHeight = Number(argv[++index]);
        break;
      case '--columns':
        options.columns = Number(argv[++index]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseTarget(value) {
  const parts = String(value).split(',').map((entry) => Number(entry.trim()));
  if (parts.length !== 3 || parts.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`Invalid target vector: ${value}`);
  }
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function isFiniteOrbit(orbit) {
  return !!orbit
    && Number.isFinite(orbit.theta)
    && Number.isFinite(orbit.phi)
    && Number.isFinite(orbit.radius)
    && orbit.radius > 0
    && Number.isFinite(orbit.target?.x)
    && Number.isFinite(orbit.target?.y)
    && Number.isFinite(orbit.target?.z);
}

function mergeOrbit(cmodOrbit, options) {
  const merged = { ...(cmodOrbit || {}) };
  if (options.orbit && typeof options.orbit === 'object') Object.assign(merged, options.orbit);
  if (Number.isFinite(options.theta)) merged.theta = options.theta;
  if (Number.isFinite(options.phi)) merged.phi = options.phi;
  if (Number.isFinite(options.radius)) merged.radius = options.radius;
  if (options.target) merged.target = options.target;
  return isFiniteOrbit(merged) ? merged : null;
}

async function loadInputModel(inputPath) {
  const raw = await fs.readFile(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && parsed.part) return parsed;
  throw new Error(`Unsupported model JSON in ${inputPath}`);
}

export async function renderCmodScreenshot(options) {
  if (!options?.input) throw new Error('Missing --input');
  if (!options?.output) throw new Error('Missing --output');
  if (!Number.isFinite(options.width) || options.width <= 0) throw new Error('Width must be a positive number.');
  if (!Number.isFinite(options.height) || options.height <= 0) throw new Error('Height must be a positive number.');

  const inputPath = path.resolve(REPO_ROOT, options.input);
  const outputPath = path.resolve(REPO_ROOT, options.output);
  const cmod = await loadInputModel(inputPath);
  const orbit = mergeOrbit(cmod.orbit || null, options);
  const result = await writeCmodPng({
    cmod,
    orbit,
    fitToView: options.fitToView,
    width: options.width,
    height: options.height,
    outputPath,
  });

  return {
    outputPath,
    orbit: result.orbit || orbit || null,
    metadata: result.metadata || cmod.metadata || null,
    hasGeometry: result.hasGeometry,
    viewport: { width: options.width, height: options.height },
  };
}

export async function renderCmodGalleryScreenshot(options) {
  if (!options?.input) throw new Error('Missing --input');
  if (!options?.output) throw new Error('Missing --output');

  const inputPath = path.resolve(REPO_ROOT, options.input);
  const outputPath = path.resolve(REPO_ROOT, options.output);
  const cmod = await loadInputModel(inputPath);

  const result = await writeCmodGalleryPng({
    cmod,
    cellWidth: options.cellWidth || 320,
    cellHeight: options.cellHeight || 240,
    columns: options.columns || undefined,
    outputPath,
  });

  return {
    outputPath,
    sceneCount: result.sceneCount,
    grid: result.grid,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (options.gallery) {
    const result = await renderCmodGalleryScreenshot(options);
    console.log(`Gallery rendered ${path.relative(REPO_ROOT, result.outputPath)} (${result.grid.cols}x${result.grid.rows} cells, ${result.sceneCount} scenes)`);
  } else {
    const result = await renderCmodScreenshot(options);
    console.log(`Rendered ${path.relative(REPO_ROOT, result.outputPath)} (${result.viewport.width}x${result.viewport.height})`);
    if (result.orbit) {
      console.log(`Orbit theta=${result.orbit.theta} phi=${result.orbit.phi} radius=${result.orbit.radius}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}