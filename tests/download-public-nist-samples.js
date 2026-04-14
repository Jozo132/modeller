/**
 * tests/download-public-nist-samples.js
 *
 * Download and extract public CAD sample corpora into tests/nist-samples.
 * The NIST STEP files are intended to serve as reference fixtures for the
 * STEP import pipeline, and the script is structured so more CAD sources can
 * be added later without changing the extraction flow.
 *
 * Usage:
 *   node tests/download-public-nist-samples.js
 *   node tests/download-public-nist-samples.js --force
 *   node tests/download-public-nist-samples.js --list
 *   node tests/download-public-nist-samples.js --source nist
 */

import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const NIST_ZIP_URL = process.env.NIST_ZIP_URL ||
  'https://www.nist.gov/system/files/documents/noindex/2024/05/07/NIST-FTC-CTC-PMI-CAD-models.zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(__dirname, 'nist-samples');
const DOWNLOAD_CACHE_DIR = path.join(OUTPUT_ROOT, '_downloads');
const MANIFEST_PATH = path.join(OUTPUT_ROOT, 'manifest.json');

const CAD_FORMAT_BY_EXTENSION = new Map([
  ['.step', 'step'],
  ['.stp', 'step'],
  ['.p21', 'step'],
  ['.stpnc', 'step'],
  ['.iges', 'iges'],
  ['.igs', 'iges'],
  ['.x_t', 'parasolid'],
  ['.x_b', 'parasolid'],
  ['.xmt_txt', 'parasolid'],
  ['.xmt_bin', 'parasolid'],
  ['.sat', 'acis'],
  ['.sab', 'acis'],
  ['.brep', 'brep'],
  ['.brp', 'brep'],
  ['.ifc', 'ifc'],
  ['.jt', 'jt'],
  ['.3dm', '3dm'],
  ['.stl', 'stl'],
  ['.3mf', '3mf'],
  ['.obj', 'obj'],
  ['.off', 'off'],
]);

const CAD_EXTENSIONS = [...CAD_FORMAT_BY_EXTENSION.keys()].sort((a, b) => b.length - a.length);
const STEP_FORMATS = new Set(['.step', '.stp', '.p21', '.stpnc']);

const SOURCES = [
  {
    id: 'nist-ftc-ctc-pmi-cad-models',
    aliases: ['nist'],
    label: 'NIST FTC CTC PMI CAD models',
    type: 'zip',
    url: NIST_ZIP_URL,
    archiveFileName: 'NIST-FTC-CTC-PMI-CAD-models.zip',
  },
];

function log(message) {
  console.log(`[download-public-nist-samples] ${message}`);
}

function usage() {
  console.log(
    'Usage: node tests/download-public-nist-samples.js ' +
    '[--force] [--list] [--source <id-or-alias>]',
  );
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function detectCadExtension(filename) {
  const lower = filename.toLowerCase();
  for (const ext of CAD_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

function parseArgs(argv) {
  const options = {
    force: false,
    list: false,
    sourceTokens: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--source') {
      const next = argv[++i];
      if (!next) throw new Error('Missing value for --source');
      options.sourceTokens.push(next);
      continue;
    }
    if (arg.startsWith('--source=')) {
      options.sourceTokens.push(arg.slice('--source='.length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveSources(sourceTokens) {
  if (!sourceTokens.length) return SOURCES;

  const resolved = [];
  for (const token of sourceTokens) {
    const normalized = token.trim().toLowerCase();
    const source = SOURCES.find((candidate) =>
      candidate.id.toLowerCase() === normalized ||
      (candidate.aliases || []).some((alias) => alias.toLowerCase() === normalized),
    );
    if (!source) {
      throw new Error(`Unknown source '${token}'. Use --list to see available IDs.`);
    }
    if (!resolved.includes(source)) resolved.push(source);
  }
  return resolved;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function walkFiles(dirPath) {
  const files = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(entryPath));
      continue;
    }
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

async function downloadToFile(url, destinationPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }

  await ensureDir(path.dirname(destinationPath));
  try {
    await pipeline(Readable.fromWeb(response.body), nodeFs.createWriteStream(destinationPath));
  } catch (error) {
    await fs.rm(destinationPath, { force: true });
    throw error;
  }
}

function extractZipArchive(zipPath, destinationDir) {
  const attempts = [
    { command: 'unzip', args: ['-oq', zipPath, '-d', destinationDir] },
    { command: 'tar', args: ['-xf', zipPath, '-C', destinationDir] },
    { command: '7z', args: ['x', '-y', `-o${destinationDir}`, zipPath] },
    {
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destinationDir)} -Force`,
      ],
    },
  ];

  const failures = [];
  for (const attempt of attempts) {
    const result = spawnSync(attempt.command, attempt.args, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status === 0) return attempt.command;

    const reason = result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      `exit ${result.status}`;
    failures.push(`${attempt.command}: ${reason}`);
  }

  throw new Error(`Unable to extract ZIP archive ${zipPath}\n${failures.join('\n')}`);
}

async function copyCadFiles(sourceDir, destinationDir) {
  const stagedFiles = await walkFiles(sourceDir);
  const copiedFiles = [];

  for (const absolutePath of stagedFiles.sort()) {
    const relativeSourcePath = toPosix(path.relative(sourceDir, absolutePath));
    if (!relativeSourcePath || relativeSourcePath.startsWith('__MACOSX/')) continue;

    const extension = detectCadExtension(relativeSourcePath);
    if (!extension) continue;

    const destinationPath = path.join(destinationDir, ...relativeSourcePath.split('/'));
    await ensureDir(path.dirname(destinationPath));
    await fs.copyFile(absolutePath, destinationPath);

    const stats = await fs.stat(destinationPath);
    copiedFiles.push({
      extension,
      format: CAD_FORMAT_BY_EXTENSION.get(extension),
      relativePath: toPosix(path.relative(OUTPUT_ROOT, destinationPath)),
      sourceRelativePath: relativeSourcePath,
      bytes: stats.size,
      sha256: await sha256File(destinationPath),
    });
  }

  return copiedFiles;
}

async function scanCadFiles(dirPath) {
  const files = [];
  const absolutePaths = await walkFiles(dirPath);

  for (const absolutePath of absolutePaths.sort()) {
    const relativePath = toPosix(path.relative(OUTPUT_ROOT, absolutePath));
    const extension = detectCadExtension(relativePath);
    if (!extension) continue;

    const stats = await fs.stat(absolutePath);
    files.push({
      extension,
      format: CAD_FORMAT_BY_EXTENSION.get(extension),
      relativePath,
      sourceRelativePath: toPosix(path.relative(dirPath, absolutePath)),
      bytes: stats.size,
      sha256: await sha256File(absolutePath),
    });
  }

  return files;
}

async function buildSourceManifest(source, archivePath, outputDir, files, metadata = {}) {
  const archiveStats = await fs.stat(archivePath);
  const stepFileCount = files.filter((file) => STEP_FORMATS.has(file.extension)).length;
  const formatCounts = {};

  for (const file of files) {
    formatCounts[file.format] = (formatCounts[file.format] || 0) + 1;
  }

  return {
    id: source.id,
    label: source.label,
    type: source.type,
    url: source.url,
    archive: {
      relativePath: toPosix(path.relative(OUTPUT_ROOT, archivePath)),
      bytes: archiveStats.size,
      modifiedAt: archiveStats.mtime.toISOString(),
      extractedWith: metadata.extractedWith || null,
    },
    outputDir: toPosix(path.relative(OUTPUT_ROOT, outputDir)),
    cadFileCount: files.length,
    stepFileCount,
    formatCounts,
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

async function loadExistingManifest() {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function findPreviousSourceManifest(previousManifest, sourceId) {
  return previousManifest?.sources?.find((source) => source.id === sourceId) || null;
}

async function processSource(source, options, previousSourceManifest = null) {
  if (source.type !== 'zip') {
    throw new Error(`Unsupported source type '${source.type}' for ${source.id}`);
  }

  const archivePath = path.join(DOWNLOAD_CACHE_DIR, source.archiveFileName || `${source.id}.zip`);
  const outputDir = path.join(OUTPUT_ROOT, source.id);

  await ensureDir(OUTPUT_ROOT);
  await ensureDir(DOWNLOAD_CACHE_DIR);

  const shouldDownload = options.force || !(await exists(archivePath));
  if (shouldDownload) {
    log(`${source.id}: downloading archive`);
    await downloadToFile(source.url, archivePath);
  } else {
    log(`${source.id}: using cached archive`);
  }

  const shouldExtract = options.force || !(await exists(outputDir));
  let extractedWith = previousSourceManifest?.archive?.extractedWith || null;
  let files = [];

  if (shouldExtract) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modeller-cad-samples-'));
    const stagingDir = path.join(tempRoot, source.id);
    try {
      await ensureDir(stagingDir);
      log(`${source.id}: extracting archive`);
      extractedWith = extractZipArchive(archivePath, stagingDir);

      await fs.rm(outputDir, { recursive: true, force: true });
      await ensureDir(outputDir);
      files = await copyCadFiles(stagingDir, outputDir);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  } else {
    log(`${source.id}: using existing extracted files`);
    files = await scanCadFiles(outputDir);
  }

  if (files.length === 0) {
    throw new Error(`${source.id}: no CAD files were found after extraction`);
  }

  const stepFileCount = files.filter((file) => STEP_FORMATS.has(file.extension)).length;
  log(`${source.id}: ready with ${files.length} CAD file(s), ${stepFileCount} STEP file(s)`);

  return buildSourceManifest(source, archivePath, outputDir, files, { extractedWith });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    for (const source of SOURCES) {
      const aliases = source.aliases?.length ? ` (${source.aliases.join(', ')})` : '';
      console.log(`${source.id}${aliases}: ${source.url}`);
    }
    return;
  }

  const selectedSources = resolveSources(options.sourceTokens);
  const previousManifest = await loadExistingManifest();
  const sourceManifests = [];

  for (const source of selectedSources) {
    sourceManifests.push(
      await processSource(source, options, findPreviousSourceManifest(previousManifest, source.id)),
    );
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    outputRoot: toPosix(path.relative(__dirname, OUTPUT_ROOT)),
    cadExtensions: CAD_EXTENSIONS,
    sources: sourceManifests,
  };

  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  log(`manifest written to ${toPosix(path.relative(__dirname, MANIFEST_PATH))}`);
}

main().catch((error) => {
  console.error(`[download-public-nist-samples] ${error.message}`);
  process.exitCode = 1;
});
