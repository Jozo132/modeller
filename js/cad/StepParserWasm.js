// js/cad/StepParserWasm.js — JS bridge for the native STEP entity parser
//
// Stage B/C of the WASM STEP migration.  Runs the WASM lexer+parser and
// decodes the output into the same Map<id, {id, type, args}> shape that
// js/cad/StepImport.js#_resolveEntities produces — so the rest of the
// importer can consume it as a drop-in replacement.
//
// Args shape matches the JS parser:
//   • null              — from $ or *
//   • "#N"              — entity reference (kept as a string for compatibility)
//   • 123.45            — number (parsed via parseFloat on the source slice)
//   • "text"            — string literal (quotes stripped, '' escapes preserved)
//   • ".IDENT."         — enum literal (dots kept, matching _parseToken)
//   • Array<...>        — nested list
//
// Complex entities (#N = (SUB_A() SUB_B(args) ...)) surface with:
//   { type: '__COMPLEX_WASM__',
//     args: [ [keyword:string, argsArray], [keyword, argsArray], ... ] }
// and StepImport.js merges them via _mergeComplexEntityFromWasm().

import { loadReleaseWasmModule } from '../load-release-wasm.js';

let _wasm = null;
let _wasmLoadPromise = null;

const ARG_NULL = 0;
const ARG_REF = 1;
const ARG_NUMBER = 2;
const ARG_STRING = 3;
const ARG_ENUM = 4;
const ARG_LIST = 5;

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

/** Force-load the WASM parser. */
export async function ensureStepParserReady() { return _loadWasm(); }

/** Returns true if parseStepEntitiesSync can be called without awaiting. */
export function stepParserReadySync() { return _wasm != null; }

/**
 * Parse a STEP Part 21 source string into the resolved-entity map
 * consumed by StepImport.js.  Uses WASM lexer + parser.
 *
 * @param {string} stepText
 * @returns {Map<number, {id:number, type:string, args:Array}>}
 */
export function parseStepEntitiesSync(stepText) {
  if (!_wasm) {
    throw new Error('StepParserWasm: call ensureStepParserReady() first.');
  }
  const w = _wasm;
  const mem = w.memory;

  // ── 1. Write input into WASM ──────────────────────────────────
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(stepText);
  const inputPtr = w.stepLexGetInputPtr();
  const inputCap = w.stepLexGetInputCapacity();
  if (inputBytes.length > inputCap) {
    throw new Error(
      `StepParserWasm: input ${inputBytes.length} bytes exceeds capacity ${inputCap}`
    );
  }
  new Uint8Array(mem.buffer, inputPtr, inputBytes.length).set(inputBytes);

  // ── 2. Lex ────────────────────────────────────────────────────
  const lexRc = w.stepLexRun(inputBytes.length);
  if (lexRc !== 0) {
    const off = w.stepLexGetErrorOffset();
    throw new Error(`StepParserWasm: lexer error ${lexRc} at byte ${off}`);
  }

  // ── 3. Parse ──────────────────────────────────────────────────
  const parseRc = w.stepParseRun();
  if (parseRc !== 0) {
    const tokIdx = w.stepParseGetErrorTokenIdx();
    throw new Error(`StepParserWasm: parser error ${parseRc} at token ${tokIdx}`);
  }

  // ── 4. Decode entities + args ─────────────────────────────────
  return _decodeEntityTable(w, mem);
}

function _decodeEntityTable(w, mem) {
  const entityCount = w.stepParseGetEntityCount();
  const entityStride = w.stepParseGetEntityStride();
  const entityBufPtr = w.stepParseGetEntityBufPtr();

  const argBufPtr = w.stepParseGetArgBufPtr();
  const argStride = w.stepParseGetArgStride();
  // const argCount = w.stepParseGetArgCount();  // not strictly needed (we walk LISTs recursively)

  const strPoolPtr = w.stepLexGetStringPoolPtr();
  const strPoolLen = w.stepLexGetStringPoolLen();

  const entityDv = new DataView(mem.buffer, entityBufPtr, entityCount * entityStride);
  const argDv = new DataView(mem.buffer, argBufPtr);  // full buffer view; we index by argIdx * stride
  const strPool = new Uint8Array(mem.buffer, strPoolPtr, strPoolLen);
  const textDecoder = new TextDecoder('utf-8');

  const poolSlice = (off, len) => len === 0 ? '' : textDecoder.decode(strPool.subarray(off, off + len));

  // Recursive arg decoder.  Returns { value, nextIdx }.
  const decodeArg = (idx) => {
    const base = idx * argStride;
    const kind = argDv.getUint8(base);
    const a0 = argDv.getUint32(base + 4, true);
    const a1 = argDv.getUint32(base + 8, true);

    switch (kind) {
      case ARG_NULL:
        return { value: null, nextIdx: idx + 1 };
      case ARG_REF:
        return { value: '#' + a0, nextIdx: idx + 1 };
      case ARG_NUMBER: {
        const txt = poolSlice(a0, a1);
        const n = parseFloat(txt);
        return { value: Number.isFinite(n) ? n : txt, nextIdx: idx + 1 };
      }
      case ARG_STRING:
        // JS parity: the existing parser collapses runs of whitespace
        // (including physical line breaks that wrap long strings) into
        // a single space via `rawLine.replace(/\s+/g, ' ')`.  We match
        // that here so downstream code sees identical text.
        return { value: poolSlice(a0, a1).replace(/\s+/g, ' '), nextIdx: idx + 1 };
      case ARG_ENUM:
        // JS _parseToken returns the enum with surrounding dots preserved.
        return { value: '.' + poolSlice(a0, a1) + '.', nextIdx: idx + 1 };
      case ARG_LIST: {
        const count = a0;
        const list = new Array(count);
        let cursor = idx + 1;
        for (let k = 0; k < count; k++) {
          const child = decodeArg(cursor);
          list[k] = child.value;
          cursor = child.nextIdx;
        }
        return { value: list, nextIdx: cursor };
      }
      default:
        throw new Error(`StepParserWasm: unknown arg kind ${kind} at idx ${idx}`);
    }
  };

  const resolved = new Map();

  for (let i = 0; i < entityCount; i++) {
    const eb = i * entityStride;
    const stepId = entityDv.getUint32(eb + 0, true);
    const typeOff = entityDv.getUint32(eb + 4, true);
    const typeLen = entityDv.getUint32(eb + 8, true);
    const argRootIdx = entityDv.getUint32(eb + 12, true);
    const isComplex = entityDv.getUint8(eb + 16);

    const rootDecoded = decodeArg(argRootIdx);
    // For simple entities the root is a LIST; its elements are the args.
    // For complex entities the root is a LIST whose children are themselves
    // [keyword, argsList] pairs.
    if (isComplex) {
      resolved.set(stepId, {
        id: stepId,
        type: '__COMPLEX_WASM__',
        args: rootDecoded.value,
      });
    } else {
      resolved.set(stepId, {
        id: stepId,
        type: poolSlice(typeOff, typeLen),
        args: rootDecoded.value,
      });
    }
  }

  return resolved;
}
