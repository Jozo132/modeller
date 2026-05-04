// js/cad/StepLexerWasm.js — JS bridge for the native STEP lexer
//
// Provides a token stream decoded from WASM memory that matches the token
// semantics of the JS lexer in StepImport.js.  This is Stage A of the
// WASM STEP migration — no parsing, no entity resolution; the JS importer
// is unchanged.  Callers use `lexStep(text)` to get an Array of plain tokens
// they can drive a parser from later.
//
// Token object shape (all fields present on every token):
//   { kind:   one of 'EOF'|'HASH_ID'|'HASH_REF'|'KEYWORD'|'NUMBER'|
//                    'STRING'|'ENUM'|'DOLLAR'|'STAR'|'LPAREN'|'RPAREN'|
//                    'COMMA'|'EQUALS'|'SEMICOLON',
//     id:     number   // only valid for HASH_ID / HASH_REF
//     text:   string   // payload for KEYWORD / NUMBER / STRING / ENUM; '' otherwise
//   }
//
// The lexer is lazy-loaded from ../../build/release.js once per process.

import { loadReleaseWasmModule } from '../load-release-wasm.js';

let _wasm = null;
let _wasmLoadPromise = null;

const KIND_NAMES = [
  'EOF',        // 0
  'HASH_ID',    // 1
  'HASH_REF',   // 2
  'KEYWORD',    // 3
  'NUMBER',     // 4
  'STRING',     // 5
  'ENUM',       // 6
  'DOLLAR',     // 7
  'STAR',       // 8
  'LPAREN',     // 9
  'RPAREN',     // 10
  'COMMA',      // 11
  'EQUALS',     // 12
  'SEMICOLON',  // 13
];

const ERR_NAMES = {
  0: 'OK',
  1: 'BAD_CHAR',
  2: 'UNTERMINATED_STRING',
  3: 'INPUT_TOO_LARGE',
  4: 'TOKEN_OVERFLOW',
  5: 'STRPOOL_OVERFLOW',
};

async function _loadWasm() {
  if (_wasm) return _wasm;
  if (_wasmLoadPromise) return _wasmLoadPromise;
  _wasmLoadPromise = (async () => {
    const mod = await loadReleaseWasmModule();
    _wasm = mod;
    return mod;
  })();
  return _wasmLoadPromise;
}

/** Force-load the WASM module.  Optional — lexStep() will auto-load. */
export async function ensureStepLexerReady() {
  return _loadWasm();
}

function _getWasmMemory(wasm) {
  // AssemblyScript ESM bindings expose memory as `wasm.memory` (a WebAssembly.Memory).
  // If not present, try `wasm.__memory` as a fallback.
  return wasm.memory || wasm.__memory;
}

/**
 * Tokenize a STEP source string using the native WASM lexer.
 *
 * @param {string} stepText - Full contents of a STEP Part 21 file.
 * @returns {Array<{kind:string,id:number,text:string}>}  Tokens in source order.
 *          The final token is always `{ kind: 'EOF', ... }`.
 * @throws  If the WASM lexer has not been loaded yet (call ensureStepLexerReady()
 *          first) or if the lexer returns a non-OK error code.
 */
export function lexStep(stepText) {
  if (!_wasm) {
    throw new Error(
      'StepLexerWasm: call ensureStepLexerReady() before lexStep().'
    );
  }
  const wasm = _wasm;

  // Encode JS string to UTF-8 bytes.  STEP files are effectively ASCII but
  // header strings can contain UTF-8; we treat the whole file as opaque bytes.
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(stepText);

  const memory = _getWasmMemory(wasm);
  const inputPtr = wasm.stepLexGetInputPtr();
  const inputCap = wasm.stepLexGetInputCapacity();
  if (inputBytes.length > inputCap) {
    throw new Error(
      `StepLexerWasm: input of ${inputBytes.length} bytes exceeds WASM ` +
      `capacity ${inputCap}.  Either increase MAX_INPUT in step_lexer.ts ` +
      `or split the file.`
    );
  }

  // Copy input text into WASM linear memory.
  const heapU8 = new Uint8Array(memory.buffer, inputPtr, inputBytes.length);
  heapU8.set(inputBytes);

  const rc = wasm.stepLexRun(inputBytes.length);
  // STEP_LEX_OK === 0; avoid relying on AS-exported const symbols.
  if (rc !== 0) {
    const offset = wasm.stepLexGetErrorOffset();
    const name = ERR_NAMES[rc] || `ERR_${rc}`;
    throw new Error(
      `StepLexerWasm: lexer failed with ${name} (code ${rc}) at byte offset ${offset}.`
    );
  }

  return _decodeTokenStream(wasm, memory);
}

function _decodeTokenStream(wasm, memory) {
  const count = wasm.stepLexGetTokenCount();
  const stride = wasm.stepLexGetTokenStride();
  const tokBufPtr = wasm.stepLexGetTokenBufPtr();
  const strPoolPtr = wasm.stepLexGetStringPoolPtr();
  const strPoolLen = wasm.stepLexGetStringPoolLen();

  const dv = new DataView(memory.buffer, tokBufPtr, count * stride);
  const strPool = new Uint8Array(memory.buffer, strPoolPtr, strPoolLen);
  const decoder = new TextDecoder('utf-8');

  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const kind = dv.getUint8(base);
    const arg0 = dv.getUint32(base + 8, true);
    const arg1 = dv.getUint32(base + 12, true);

    const tok = { kind: KIND_NAMES[kind] || `K${kind}`, id: 0, text: '' };
    if (kind === 1 /* HASH_ID */ || kind === 2 /* HASH_REF */) {
      tok.id = arg0;
    } else if (arg1 > 0) {
      tok.text = decoder.decode(strPool.subarray(arg0, arg0 + arg1));
    }
    out[i] = tok;
  }
  return out;
}
