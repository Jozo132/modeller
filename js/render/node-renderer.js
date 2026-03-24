import fs from 'node:fs/promises';
import path from 'node:path';

import { createCanvas } from '@napi-rs/canvas';

import { Part } from '../cad/Part.js';
import { CanvasCommandExecutor } from './canvas-command-executor.js';
import { SceneRenderer } from './scene-renderer.js';

export async function renderCmodToPngBuffer(options) {
  const width = Math.max(1, options.width || 1280);
  const height = Math.max(1, options.height || 720);
  const canvas = createCanvas(width, height);
  const executor = new CanvasCommandExecutor(canvas);
  const renderer = new SceneRenderer({ canvas, executor });
  await renderer.init();

  if (!options.cmod?.part) {
    throw new Error('CMOD data must include a serialized part.');
  }

  const part = Part.deserialize(options.cmod.part);
  renderer.renderPart(part);

  if (options.fitToView) {
    renderer.fitToView();
  } else if (options.orbit) {
    renderer.setOrbitState(options.orbit);
  } else if (options.cmod.orbit) {
    renderer.setOrbitState(options.cmod.orbit);
  } else {
    renderer.fitToView();
  }

  renderer.renderFrame();
  renderer.renderFrame();

  return {
    buffer: await canvas.encode('png'),
    orbit: renderer.getOrbitState(),
    hasGeometry: renderer.hasGeometry(),
    metadata: options.cmod.metadata || null,
  };
}

export async function writeCmodPng(options) {
  const result = await renderCmodToPngBuffer(options);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, result.buffer);
  return result;
}

export async function renderCmodGalleryPng(options) {
  const cellW = Math.max(1, options.cellWidth || 320);
  const cellH = Math.max(1, options.cellHeight || 240);
  const cmod = options.cmod;
  if (!cmod?.part) throw new Error('CMOD data must include a serialized part.');
  const scenes = Array.isArray(cmod.scenes) ? cmod.scenes : [];
  if (scenes.length === 0) throw new Error('CMOD contains no scenes.');

  const cols = options.columns || Math.ceil(Math.sqrt(scenes.length));
  const rows = Math.ceil(scenes.length / cols);

  // Create renderer at cell size
  const cellCanvas = createCanvas(cellW, cellH);
  const executor = new CanvasCommandExecutor(cellCanvas);
  const renderer = new SceneRenderer({ canvas: cellCanvas, executor });
  await renderer.init();

  const part = Part.deserialize(cmod.part);
  renderer.renderPart(part);

  // Create the gallery grid canvas
  const grid = createCanvas(cols * cellW, rows * cellH);
  const gctx = grid.getContext('2d');
  gctx.fillStyle = '#1e1e1e';
  gctx.fillRect(0, 0, grid.width, grid.height);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    renderer.setOrbitState(scene.orbit);
    renderer.renderFrame();
    renderer.renderFrame();

    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;

    gctx.drawImage(cellCanvas, x, y, cellW, cellH);

    // Draw scene name label
    gctx.save();
    gctx.fillStyle = 'rgba(0,0,0,0.55)';
    gctx.fillRect(x, y + cellH - 28, cellW, 28);
    gctx.fillStyle = '#fff';
    gctx.font = '13px Inter, system-ui, sans-serif';
    gctx.fillText(scene.name, x + 8, y + cellH - 9);
    gctx.restore();
  }

  return {
    buffer: await grid.encode('png'),
    sceneCount: scenes.length,
    grid: { cols, rows, cellWidth: cellW, cellHeight: cellH },
  };
}

export async function writeCmodGalleryPng(options) {
  const result = await renderCmodGalleryPng(options);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, result.buffer);
  return result;
}