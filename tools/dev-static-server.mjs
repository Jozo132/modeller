import http from 'node:http';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const occtMountPath = '/vendor/occt-kernel/dist';
const occtDistRoot = path.resolve(
  process.env.OCCT_KERNEL_DIST
  || process.env.CAD_OCCT_KERNEL_DIST
  || 'C:\\Users\\HP\\OneDrive\\Documents\\C++ Projects\\occt-kernel-wasm\\dist'
);

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.d.ts', 'text/plain; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
]);

function parsePort(args) {
  const cliArgs = Array.isArray(args) ? args : [];
  for (let index = 0; index < cliArgs.length; index += 1) {
    const value = cliArgs[index];
    if (value === '--port' || value === '-p') {
      return Number.parseInt(cliArgs[index + 1], 10) || null;
    }
    if (/^\d+$/.test(String(value))) {
      return Number.parseInt(value, 10) || null;
    }
  }
  return Number.parseInt(process.env.PORT || '', 10) || 3000;
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getMimeType(filePath) {
  return mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function resolveMount(urlPath) {
  if (urlPath === occtMountPath || urlPath.startsWith(`${occtMountPath}/`)) {
    return {
      rootPath: occtDistRoot,
      relativeUrl: urlPath.slice(occtMountPath.length) || '/',
      isRepoMount: false,
    };
  }
  return {
    rootPath: repoRoot,
    relativeUrl: urlPath,
    isRepoMount: true,
  };
}

async function buildDirectoryListing(filePath, requestPath) {
  const entries = await fs.readdir(filePath, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  const basePath = requestPath.endsWith('/') ? requestPath : `${requestPath}/`;
  const items = entries.map((entry) => {
    const href = `${basePath}${encodeURIComponent(entry.name)}${entry.isDirectory() ? '/' : ''}`;
    const label = `${entry.name}${entry.isDirectory() ? '/' : ''}`;
    return `<li><a href="${href}">${htmlEscape(label)}</a></li>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Index of ${htmlEscape(requestPath)}</title>
  <style>
    body { font-family: Consolas, monospace; margin: 2rem; }
    h1 { font-size: 1.1rem; }
    ul { line-height: 1.7; }
  </style>
</head>
<body>
  <h1>Index of ${htmlEscape(requestPath)}</h1>
  <ul>
${items}
  </ul>
</body>
</html>`;
}

async function resolveRequestFile(urlPath) {
  const { rootPath, relativeUrl, isRepoMount } = resolveMount(urlPath);
  const decodedPath = decodeURIComponent(relativeUrl);
  const relativePath = decodedPath.replace(/^\/+/, '');
  const targetPath = path.resolve(rootPath, relativePath || '.');

  if (!isPathInside(rootPath, targetPath)) {
    return { statusCode: 403, body: 'Forbidden', contentType: 'text/plain; charset=utf-8' };
  }

  try {
    const stats = await fs.stat(targetPath);
    if (stats.isDirectory()) {
      const indexPath = path.join(targetPath, 'index.html');
      try {
        const indexStats = await fs.stat(indexPath);
        if (indexStats.isFile()) {
          return { filePath: indexPath, stats: indexStats };
        }
      } catch {
        const body = await buildDirectoryListing(targetPath, urlPath);
        return { statusCode: 200, body, contentType: 'text/html; charset=utf-8' };
      }
    }

    if (!stats.isFile()) {
      return { statusCode: 404, body: 'Not found', contentType: 'text/plain; charset=utf-8' };
    }

    return { filePath: targetPath, stats };
  } catch {
    if (isRepoMount && !path.extname(urlPath)) {
      const indexPath = path.join(repoRoot, 'index.html');
      const indexStats = await fs.stat(indexPath);
      return { filePath: indexPath, stats: indexStats };
    }
    return { statusCode: 404, body: 'Not found', contentType: 'text/plain; charset=utf-8' };
  }
}

function sendResponse(res, statusCode, body, contentType) {
  const buffer = Buffer.from(body);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': buffer.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const resolved = await resolveRequestFile(requestUrl.pathname);

    if (!resolved.filePath) {
      sendResponse(res, resolved.statusCode, method === 'HEAD' ? '' : resolved.body, resolved.contentType);
      return;
    }

    res.writeHead(200, {
      'Content-Type': getMimeType(resolved.filePath),
      'Content-Length': resolved.stats.size,
      'Cache-Control': 'no-store',
    });

    if (method === 'HEAD') {
      res.end();
      return;
    }

    createReadStream(resolved.filePath).pipe(res);
  } catch (error) {
    sendResponse(res, 500, String(error?.stack || error || 'Internal server error'), 'text/plain; charset=utf-8');
  }
});

const port = parsePort(process.argv.slice(2));
server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${repoRoot} at http://127.0.0.1:${port}`);
  if (existsSync(occtDistRoot)) {
    console.log(`Mounted ${occtMountPath} -> ${occtDistRoot}`);
  } else {
    console.warn(`Mounted ${occtMountPath} -> ${occtDistRoot} (missing on disk)`);
  }
});