// tests/test-step-lexer-wasm.js — parity test for the native STEP lexer
//
// Stage A of the STEP → WASM migration.  Verifies that the WASM lexer
// (assembly/kernel/step_lexer.ts) produces the same token stream as a
// reference JS tokenizer on real STEP corpus files.
//
// Runs quickly; no mesh/tess work.  Integrated into the normal test runner.

import './_watchdog.mjs';
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ensureStepLexerReady, lexStep } from '../js/cad/StepLexerWasm.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
    if (err.stack) {
      for (const line of err.stack.split('\n').slice(1, 4)) {
        console.log(`    ${line.trim()}`);
      }
    }
    failed++;
  }
}

// ────────────────────────────────────────────────────────────────
// Reference JS lexer — same token shape as the WASM lexer.
// Used solely for parity verification.
// ────────────────────────────────────────────────────────────────
function jsLex(text) {
  const out = [];
  const n = text.length;
  let i = 0;

  const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const isDigit = c => c >= '0' && c <= '9';
  const isAlphaUpper = c => c >= 'A' && c <= 'Z';
  const isKeywordCh = c => isAlphaUpper(c) || isDigit(c) || c === '_';

  while (i < n) {
    const c = text[i];
    if (isWs(c)) { i++; continue; }

    if (c === '(') { out.push({ kind: 'LPAREN', id: 0, text: '' }); i++; continue; }
    if (c === ')') { out.push({ kind: 'RPAREN', id: 0, text: '' }); i++; continue; }
    if (c === ',') { out.push({ kind: 'COMMA', id: 0, text: '' }); i++; continue; }
    if (c === '=') { out.push({ kind: 'EQUALS', id: 0, text: '' }); i++; continue; }
    if (c === ';') { out.push({ kind: 'SEMICOLON', id: 0, text: '' }); i++; continue; }
    if (c === '$') { out.push({ kind: 'DOLLAR', id: 0, text: '' }); i++; continue; }
    if (c === '*') { out.push({ kind: 'STAR', id: 0, text: '' }); i++; continue; }

    // comment /* ... */
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // #N — distinguish definition (followed by '=') vs reference
    if (c === '#') {
      const start = i;
      i++;
      if (!isDigit(text[i] || '')) throw new Error(`Bad '#' at ${start}`);
      let id = 0;
      while (i < n && isDigit(text[i])) {
        id = id * 10 + (text.charCodeAt(i) - 48);
        i++;
      }
      let k = i;
      while (k < n && isWs(text[k])) k++;
      const kind = (text[k] === '=') ? 'HASH_ID' : 'HASH_REF';
      out.push({ kind, id, text: '' });
      continue;
    }

    // 'string' (with '' escape)
    if (c === "'") {
      i++;
      const start = i;
      let s = '';
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { s += "''"; i += 2; continue; }
          break;
        }
        s += text[i];
        i++;
      }
      if (i >= n) throw new Error(`Unterminated string at ${start - 1}`);
      i++;
      out.push({ kind: 'STRING', id: 0, text: s });
      continue;
    }

    // .ENUM.
    if (c === '.') {
      const next = text[i + 1] || '';
      if (isAlphaUpper(next)) {
        const dotStart = i;
        i++;
        const identStart = i;
        while (i < n && (isAlphaUpper(text[i]) || isDigit(text[i]) || text[i] === '_')) i++;
        const identEnd = i;
        if (text[i] !== '.') throw new Error(`Bad enum at ${dotStart}`);
        i++;
        out.push({ kind: 'ENUM', id: 0, text: text.slice(identStart, identEnd) });
        continue;
      }
      // fallthrough to number
    }

    // keyword
    if (isAlphaUpper(c)) {
      const start = i;
      while (i < n) {
        const cc = text[i];
        if (isKeywordCh(cc)) { i++; continue; }
        // Accept '-' inside a keyword if followed by alpha/digit; required
        // for the STEP footer "END-ISO-10303-21".
        if (cc === '-' && i + 1 < n) {
          const nn = text[i + 1];
          if (isAlphaUpper(nn) || isDigit(nn)) { i++; continue; }
        }
        break;
      }
      out.push({ kind: 'KEYWORD', id: 0, text: text.slice(start, i) });
      continue;
    }

    // number
    if (isDigit(c) || c === '+' || c === '-' || c === '.') {
      const start = i;
      if (c === '+' || c === '-') i++;
      let sawDot = false, sawDigit = false;
      while (i < n) {
        const cc = text[i];
        if (isDigit(cc)) { sawDigit = true; i++; continue; }
        if (cc === '.' && !sawDot) { sawDot = true; i++; continue; }
        break;
      }
      if (text[i] === 'E' || text[i] === 'e') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        while (i < n && isDigit(text[i])) { sawDigit = true; i++; }
      }
      if (!sawDigit) throw new Error(`Bad number at ${start}`);
      out.push({ kind: 'NUMBER', id: 0, text: text.slice(start, i) });
      continue;
    }

    throw new Error(`Unexpected char ${JSON.stringify(c)} at offset ${i}`);
  }

  out.push({ kind: 'EOF', id: 0, text: '' });
  return out;
}

function compareStreams(label, js, wasm) {
  assert.strictEqual(wasm.length, js.length,
    `${label}: token count mismatch — WASM ${wasm.length} vs JS ${js.length}`);
  for (let i = 0; i < js.length; i++) {
    const a = js[i], b = wasm[i];
    if (a.kind !== b.kind || a.id !== b.id || a.text !== b.text) {
      const ctxStart = Math.max(0, i - 2);
      const ctxEnd = Math.min(js.length, i + 3);
      let msg = `${label}: token #${i} differs\n`;
      for (let k = ctxStart; k < ctxEnd; k++) {
        const mark = k === i ? '>>' : '  ';
        msg += `    ${mark} js[${k}]=${JSON.stringify(js[k])}  wasm[${k}]=${JSON.stringify(wasm[k])}\n`;
      }
      throw new Error(msg);
    }
  }
}

await ensureStepLexerReady();

console.log('Running test-step-lexer-wasm.js');

const files = [
  fileURLToPath(new URL('./step/box-fillet-3.step', import.meta.url)),
  fileURLToPath(new URL('./step/Unnamed-Body.step', import.meta.url)),
];

for (const path of files) {
  const name = path.split(/[\\/]/).pop();
  const src = readFileSync(path, 'utf-8');

  test(`lex ${name} — stream matches JS reference`, () => {
    const js = jsLex(src);
    const wasm = lexStep(src);
    compareStreams(name, js, wasm);
  });

  test(`lex ${name} — HASH_ID count == entity count`, () => {
    const tokens = lexStep(src);
    const hashIds = tokens.filter(t => t.kind === 'HASH_ID').length;
    // Every DATA-section entity definition begins with "#N =".
    const reEntities = src.match(/#\d+\s*=/g) || [];
    assert.strictEqual(hashIds, reEntities.length,
      `${name}: HASH_ID count ${hashIds} vs '#N=' regex count ${reEntities.length}`);
  });
}

// ── Synthetic edge cases ────────────────────────────────────────────
test('escaped quotes in string literal', () => {
  const src = "#1 = FOO('it''s fine');";
  const toks = lexStep(src);
  const strTok = toks.find(t => t.kind === 'STRING');
  assert.strictEqual(strTok.text, "it''s fine", 'escape kept literal');
});

test('comment is skipped', () => {
  const src = "#1 = FOO(/* skip me */ 42);";
  const toks = lexStep(src);
  const nums = toks.filter(t => t.kind === 'NUMBER');
  assert.strictEqual(nums.length, 1);
  assert.strictEqual(nums[0].text, '42');
});

test('boolean enums', () => {
  const src = "#1 = FOO(.T., .F., .UNSPECIFIED.);";
  const toks = lexStep(src);
  const enums = toks.filter(t => t.kind === 'ENUM').map(t => t.text);
  assert.deepStrictEqual(enums, ['T', 'F', 'UNSPECIFIED']);
});

test('scientific notation numbers', () => {
  const src = "#1 = P(1.5E-3, -2.0E+12, 0., .5);";
  const toks = lexStep(src);
  const nums = toks.filter(t => t.kind === 'NUMBER').map(t => t.text);
  assert.deepStrictEqual(nums, ['1.5E-3', '-2.0E+12', '0.', '.5']);
});

test('reference vs definition classification', () => {
  const src = "#1 = A(#2, #3);\n#2 = B();";
  const toks = lexStep(src);
  const defs = toks.filter(t => t.kind === 'HASH_ID').map(t => t.id);
  const refs = toks.filter(t => t.kind === 'HASH_REF').map(t => t.id);
  assert.deepStrictEqual(defs, [1, 2]);
  assert.deepStrictEqual(refs, [2, 3]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
