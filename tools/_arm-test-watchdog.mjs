// Internal one-shot script: prepend `import './_watchdog.mjs';` to every
// tests/test-*.js that does not already import the watchdog. Safe to
// re-run.
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'tests';
const IMPORT_LINE = "import './_watchdog.mjs';\n";

let patched = 0;
for (const f of fs.readdirSync(DIR)) {
  if (!/^test-.*\.js$/.test(f)) continue;
  const fp = path.join(DIR, f);
  const src = fs.readFileSync(fp, 'utf8');
  if (src.includes('_watchdog.mjs')) continue;
  fs.writeFileSync(fp, IMPORT_LINE + src);
  console.log('patched', f);
  patched++;
}
console.log('total', patched);
