#!/usr/bin/env node
// tools/cad-cli.mjs — CLI entrypoint for CBREP operations
//
// Commands:
//   step2cbrep     <input.step> <output.cbrep>  — Convert STEP → CBREP v0
//   cbrep2step     <input.cbrep> <output.step>  — Convert CBREP v0 → STEP
//   cbrep2stl      <input.cbrep> <output.stl>   — Convert CBREP v0 → STL
//   cmod2cbrep     <input.cmod>  <output.cbrep>  — Extract/convert .cmod → CBREP v0
//   validate-cbrep <input.cbrep>                — Validate a CBREP file
//   hash           <input.cbrep>                — Compute content hash
//   snapshot       <dir>                        — Hash all .step files → corpus manifest

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

import { canonicalize } from '../packages/ir/canonicalize.js';
import { writeCbrep } from '../packages/ir/writer.js';
import { readCbrep, validateCbrep, setTopoDeps } from '../packages/ir/reader.js';
import { hashCbrep } from '../packages/ir/hash.js';

// Import topology classes
import {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  SurfaceType, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { parseSTEPTopology } from '../js/cad/StepImport.js';
import { exportSTEP } from '../js/cad/StepExport.js';

// Register topology deps for the reader
const topoDeps = {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  NurbsCurve, NurbsSurface, SurfaceType,
};
setTopoDeps(topoDeps);

// ── Command dispatch ──

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  step2cbrep,
  cbrep2step,
  cbrep2stl,
  cmod2cbrep,
  'validate-cbrep': validateCbrepCmd,
  hash: hashCmd,
  snapshot: snapshotCmd,
};

if (!cmd || !commands[cmd]) {
  console.error(`Usage: cad-cli.mjs <command> [args...]`);
  console.error(`Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  commands[cmd](...args);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// ── Command implementations ──

function step2cbrep(inputPath, outputPath) {
  if (!inputPath || !outputPath) {
    console.error('Usage: step2cbrep <input.step> <output.cbrep>');
    process.exit(1);
  }
  const stepStr = readFileSync(resolve(inputPath), 'utf-8');
  resetTopoIds();
  const body = parseSTEPTopology(stepStr);
  if (!body || !body.shells || body.shells.length === 0) {
    throw new Error('No valid topology found in STEP file');
  }
  const canon = canonicalize(body);
  const buf = writeCbrep(canon);
  const hash = hashCbrep(buf);
  writeFileSync(resolve(outputPath), Buffer.from(buf));
  console.log(`Written ${buf.byteLength} bytes → ${outputPath} (hash: ${hash})`);
}

function cbrep2step(inputPath, outputPath) {
  if (!inputPath || !outputPath) {
    console.error('Usage: cbrep2step <input.cbrep> <output.step>');
    process.exit(1);
  }
  const data = readFileSync(resolve(inputPath));
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  resetTopoIds();
  const body = readCbrep(buf, topoDeps);
  const stepStr = exportSTEP(body, { filename: 'cbrep-export' });
  writeFileSync(resolve(outputPath), stepStr, 'utf-8');
  console.log(`Written STEP → ${outputPath}`);
}

function cbrep2stl(inputPath, outputPath) {
  if (!inputPath || !outputPath) {
    console.error('Usage: cbrep2stl <input.cbrep> <output.stl>');
    process.exit(1);
  }
  // Stub: tessellation integration is not yet available in CLI context.
  // Future: import tessellateForSTL from js/cad/Tessellation.js and wire it here.
  console.error('Error: cbrep2stl is not yet implemented (requires tessellation module integration)');
  process.exit(1);
}

function cmod2cbrep(inputPath, outputPath) {
  if (!inputPath || !outputPath) {
    console.error('Usage: cmod2cbrep <input.cmod> <output.cbrep>');
    process.exit(1);
  }
  const raw = readFileSync(resolve(inputPath), 'utf-8');
  const cmod = JSON.parse(raw);

  // Check for embedded CBREP payload first
  if (cmod._cbrepPayload) {
    const binary = Buffer.from(cmod._cbrepPayload, 'base64');
    const buf = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
    const result = validateCbrep(buf);
    if (result.ok) {
      writeFileSync(resolve(outputPath), binary);
      console.log(`Extracted embedded CBREP → ${outputPath}`);
      return;
    }
  }

  // Otherwise try to reconstruct from part data
  if (!cmod.part || !cmod.part.features) {
    throw new Error('No part data found in .cmod file');
  }

  // Look for feature results with topoBody
  let body = null;
  for (const f of cmod.part.features) {
    if (f.result && f.result.body) {
      resetTopoIds();
      body = TopoBody.deserialize(f.result.body);
      break;
    }
  }

  if (!body) {
    throw new Error('No TopoBody found in .cmod feature results');
  }

  const canon = canonicalize(body);
  const buf = writeCbrep(canon);
  writeFileSync(resolve(outputPath), Buffer.from(buf));
  console.log(`Written ${buf.byteLength} bytes → ${outputPath}`);
}

function validateCbrepCmd(inputPath) {
  if (!inputPath) {
    console.error('Usage: validate-cbrep <input.cbrep>');
    process.exit(1);
  }
  const data = readFileSync(resolve(inputPath));
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const result = validateCbrep(buf);
  if (result.ok) {
    const hash = hashCbrep(buf);
    console.log(`✓ Valid CBREP v0 (${buf.byteLength} bytes, hash: ${hash})`);
  } else {
    console.error(`✗ Invalid CBREP: ${result.error}`);
    process.exit(1);
  }
}

function hashCmd(inputPath) {
  if (!inputPath) {
    console.error('Usage: hash <input.cbrep>');
    process.exit(1);
  }
  const data = readFileSync(resolve(inputPath));
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const result = validateCbrep(buf);
  if (!result.ok) {
    console.error(`✗ Invalid CBREP: ${result.error}`);
    process.exit(1);
  }
  console.log(hashCbrep(buf));
}

function snapshotCmd(dirPath) {
  if (!dirPath) {
    console.error('Usage: snapshot <dir>');
    process.exit(1);
  }
  const dir = resolve(dirPath);
  const files = readdirSync(dir).filter(f => f.endsWith('.step')).sort();
  if (files.length === 0) {
    console.error(`No .step files found in ${dir}`);
    process.exit(1);
  }
  const manifest = {};
  for (const file of files) {
    const stepStr = readFileSync(join(dir, file), 'utf-8');
    resetTopoIds();
    try {
      const body = parseSTEPTopology(stepStr);
      if (!body || !body.shells || body.shells.length === 0) {
        manifest[file] = { error: 'No valid topology found' };
        continue;
      }
      const canon = canonicalize(body);
      const buf = writeCbrep(canon);
      manifest[file] = { hash: hashCbrep(buf), bytes: buf.byteLength };
    } catch (err) {
      manifest[file] = { error: err.message };
    }
  }
  console.log(JSON.stringify(manifest, null, 2));
}
