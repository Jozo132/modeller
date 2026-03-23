#!/usr/bin/env node
// tests/generate-examples-manifest.js — Scan .cmod files and produce examples.json
//
// Usage:  node tests/generate-examples-manifest.js

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, 'samples');
const OUTPUT = join(SAMPLES_DIR, 'examples.json');

const files = readdirSync(SAMPLES_DIR)
  .filter(f => f.endsWith('.cmod'))
  .sort();

const examples = files.map(file => {
  const data = JSON.parse(readFileSync(join(SAMPLES_DIR, file), 'utf-8'));
  const meta = data.metadata || {};

  // Build a human-readable label from the filename
  const label = meta.description
    || file.replace(/\.cmod$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

  // Unique feature types (deduplicated, ordered)
  const featureTypes = [...new Set(meta.featureTypes || [])];

  return { file, label, featureTypes };
});

writeFileSync(OUTPUT, JSON.stringify(examples, null, 2) + '\n');
console.log(`Generated ${OUTPUT} with ${examples.length} examples.`);
