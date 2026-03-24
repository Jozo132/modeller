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