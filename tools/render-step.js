#!/usr/bin/env node
// tools/render-step.js — Render a STEP file to a PNG image
//
// Usage:
//   node tools/render-step.js --input <file.step> [--output <file.png>] [--width 1280] [--height 720]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Part } from '../js/cad/Part.js';
import { StepImportFeature } from '../js/cad/StepImportFeature.js';
import { writeCmodPng } from '../js/render/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  let input, output, width = 1280, height = 720;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': input = args[++i]; break;
      case '--output': output = args[++i]; break;
      case '--width': width = Number(args[++i]); break;
      case '--height': height = Number(args[++i]); break;
      default:
        if (!input) input = args[i];
        else throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  if (!input) {
    console.log('Usage: node tools/render-step.js --input <file.step> [--output <file.png>] [--width 1280] [--height 720]');
    process.exit(1);
  }

  const inputPath = path.resolve(REPO_ROOT, input);
  if (!output) {
    output = inputPath.replace(/\.step$/i, '.png');
  } else {
    output = path.resolve(REPO_ROOT, output);
  }

  console.log(`Reading STEP file: ${inputPath}`);
  const stepData = await fs.readFile(inputPath, 'utf8');

  // Build a Part with a single StepImportFeature
  const part = new Part();
  part.name = path.basename(inputPath, path.extname(inputPath));
  const feature = new StepImportFeature('STEP Import', stepData, { curveSegments: 64 });
  part.featureTree.addFeature(feature);

  // Execute the feature tree
  console.log('Executing feature tree...');
  part.featureTree.executeAll();

  const geo = part.getFinalGeometry();
  if (!geo || !geo.geometry) {
    console.error('No geometry produced from STEP import.');
    process.exit(1);
  }

  const faceCount = geo.geometry.faces?.length || 0;
  const edgeCount = geo.geometry.edges?.length || 0;
  const visualEdgeCount = geo.geometry.visualEdges?.length || 0;
  console.log(`Geometry: ${faceCount} faces, ${edgeCount} feature edges, ${visualEdgeCount} visual edges`);

  // Serialize the part to cmod format
  const cmod = { part: part.serialize() };

  // Render to PNG
  console.log(`Rendering ${width}x${height} to: ${output}`);
  const result = await writeCmodPng({
    cmod,
    fitToView: true,
    width,
    height,
    outputPath: output,
  });

  console.log(`Done. hasGeometry=${result.hasGeometry}`);
  if (result.orbit) {
    console.log(`Orbit: theta=${result.orbit.theta.toFixed(3)} phi=${result.orbit.phi.toFixed(3)} radius=${result.orbit.radius.toFixed(3)}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
