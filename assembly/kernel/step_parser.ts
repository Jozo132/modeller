// kernel/step_parser — native entity parser for STEP Part 21
//
// Stage B of the WASM STEP migration.  Consumes the token stream produced
// by step_lexer (same input buffer / string pool) and emits:
//   • An entity table: one record per "#N = TYPE(...);" statement in DATA.
//   • A flat argument arena: each argument is a fixed-size 16-byte record.
//     LIST arguments are prefix-encoded (count followed by that many child
//     records immediately inline in the arena).  This is directly decodable
//     recursively on the JS side with a single index cursor.
//
// Complex entities — "#N = (TYPE_A() TYPE_B(args) ...);" — are still parsed
// here: the root argument is emitted as a LIST of sub-entity LIST pairs,
// each pair being [STRING(keyword), LIST(args)].  JS reconstructs the
// "merged" entity form with the existing CAD-specific heuristics.

import {
  TOKEN_EOF, TOKEN_HASH_ID, TOKEN_HASH_REF, TOKEN_KEYWORD, TOKEN_NUMBER,
  TOKEN_STRING, TOKEN_ENUM, TOKEN_DOLLAR, TOKEN_STAR,
  TOKEN_LPAREN, TOKEN_RPAREN, TOKEN_COMMA, TOKEN_EQUALS, TOKEN_SEMICOLON,
  stepLexGetTokenCount, stepLexGetTokenBufPtr, stepLexGetStringPoolPtr
} from './step_lexer';

export const ARG_NULL: u8 = 0;
export const ARG_REF: u8 = 1;
export const ARG_NUMBER: u8 = 2;
export const ARG_STRING: u8 = 3;
export const ARG_ENUM: u8 = 4;
export const ARG_LIST: u8 = 5;

export const STEP_PARSE_OK: i32 = 0;
export const STEP_PARSE_ERR_UNEXPECTED_TOKEN: i32 = 1;
export const STEP_PARSE_ERR_ENTITY_OVERFLOW: i32 = 2;
export const STEP_PARSE_ERR_ARG_OVERFLOW: i32 = 3;
export const STEP_PARSE_ERR_MISSING_DATA_SECTION: i32 = 4;
export const STEP_PARSE_ERR_BAD_COMPLEX_ENTITY: i32 = 5;

const MAX_ENTITIES: u32 = 2 * 1024 * 1024;
const MAX_ARGS: u32 = 16 * 1024 * 1024;
const ENTITY_STRIDE: u32 = 20;
const ARG_STRIDE: u32 = 16;

const entityBuf = new StaticArray<u8>(MAX_ENTITIES * ENTITY_STRIDE);
const argBuf = new StaticArray<u8>(MAX_ARGS * ARG_STRIDE);

let entityCount: u32 = 0;
let argUsed: u32 = 0;
let lastErrCode: i32 = STEP_PARSE_OK;
let lastErrTokenIdx: u32 = 0;
let tCursor: u32 = 0;

export function stepParseGetEntityBufPtr(): usize { return changetype<usize>(entityBuf); }
export function stepParseGetEntityStride(): u32 { return ENTITY_STRIDE; }
export function stepParseGetEntityCount(): u32 { return entityCount; }

export function stepParseGetArgBufPtr(): usize { return changetype<usize>(argBuf); }
export function stepParseGetArgStride(): u32 { return ARG_STRIDE; }
export function stepParseGetArgCount(): u32 { return argUsed; }

export function stepParseGetErrorCode(): i32 { return lastErrCode; }
export function stepParseGetErrorTokenIdx(): u32 { return lastErrTokenIdx; }

export function stepParseReset(): void {
  entityCount = 0;
  argUsed = 0;
  lastErrCode = STEP_PARSE_OK;
  lastErrTokenIdx = 0;
  tCursor = 0;
}

@inline
function tokKind(tokenBufPtr: usize, idx: u32): u8 {
  return load<u8>(tokenBufPtr + <usize>idx * 16);
}
@inline
function tokArg0(tokenBufPtr: usize, idx: u32): u32 {
  return load<u32>(tokenBufPtr + <usize>idx * 16 + 8);
}
@inline
function tokArg1(tokenBufPtr: usize, idx: u32): u32 {
  return load<u32>(tokenBufPtr + <usize>idx * 16 + 12);
}

@inline
function writeU32LE(buf: StaticArray<u8>, offset: u32, val: u32): void {
  unchecked(buf[offset]     = <u8>(val & 0xFF));
  unchecked(buf[offset + 1] = <u8>((val >> 8) & 0xFF));
  unchecked(buf[offset + 2] = <u8>((val >> 16) & 0xFF));
  unchecked(buf[offset + 3] = <u8>((val >> 24) & 0xFF));
}

@inline
function allocArg(kind: u8, arg0: u32, arg1: u32): u32 {
  if (argUsed >= MAX_ARGS) {
    lastErrCode = STEP_PARSE_ERR_ARG_OVERFLOW;
    return 0xFFFFFFFF;
  }
  const idx = argUsed;
  const off = idx * ARG_STRIDE;
  unchecked(argBuf[off] = kind);
  writeU32LE(argBuf, off + 4, arg0);
  writeU32LE(argBuf, off + 8, arg1);
  writeU32LE(argBuf, off + 12, 0);
  argUsed++;
  return idx;
}

@inline
function patchArg0(idx: u32, newArg0: u32): void {
  const off = idx * ARG_STRIDE;
  writeU32LE(argBuf, off + 4, newArg0);
}

@inline
function kwEqualsDATA(tokenBufPtr: usize, idx: u32): bool {
  const off = tokArg0(tokenBufPtr, idx);
  const len = tokArg1(tokenBufPtr, idx);
  if (len != 4) return false;
  const p = stepLexGetStringPoolPtr() + <usize>off;
  return load<u8>(p) == 0x44
      && load<u8>(p + 1) == 0x41
      && load<u8>(p + 2) == 0x54
      && load<u8>(p + 3) == 0x41;
}

@inline
function kwEqualsENDSEC(tokenBufPtr: usize, idx: u32): bool {
  const off = tokArg0(tokenBufPtr, idx);
  const len = tokArg1(tokenBufPtr, idx);
  if (len != 6) return false;
  const p = stepLexGetStringPoolPtr() + <usize>off;
  return load<u8>(p)     == 0x45
      && load<u8>(p + 1) == 0x4E
      && load<u8>(p + 2) == 0x44
      && load<u8>(p + 3) == 0x53
      && load<u8>(p + 4) == 0x45
      && load<u8>(p + 5) == 0x43;
}

export function stepParseRun(): i32 {
  entityCount = 0;
  argUsed = 0;
  lastErrCode = STEP_PARSE_OK;
  lastErrTokenIdx = 0;
  tCursor = 0;

  const tokenBufPtr = stepLexGetTokenBufPtr();
  const tokenCount = stepLexGetTokenCount();

  let sawData: bool = false;
  while (tCursor < tokenCount) {
    const k = tokKind(tokenBufPtr, tCursor);
    if (k == TOKEN_KEYWORD && kwEqualsDATA(tokenBufPtr, tCursor)) {
      if (tCursor + 1 < tokenCount && tokKind(tokenBufPtr, tCursor + 1) == TOKEN_SEMICOLON) {
        sawData = true;
        tCursor += 2;
        break;
      }
    }
    tCursor++;
  }
  if (!sawData) {
    lastErrCode = STEP_PARSE_ERR_MISSING_DATA_SECTION;
    return lastErrCode;
  }

  while (tCursor < tokenCount) {
    const k = tokKind(tokenBufPtr, tCursor);
    if (k == TOKEN_EOF) break;
    if (k == TOKEN_KEYWORD && kwEqualsENDSEC(tokenBufPtr, tCursor)) break;

    if (k != TOKEN_HASH_ID) {
      lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
      lastErrTokenIdx = tCursor;
      return lastErrCode;
    }
    const stepId = tokArg0(tokenBufPtr, tCursor);
    tCursor++;

    if (tCursor >= tokenCount || tokKind(tokenBufPtr, tCursor) != TOKEN_EQUALS) {
      lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
      lastErrTokenIdx = tCursor;
      return lastErrCode;
    }
    tCursor++;

    if (entityCount >= MAX_ENTITIES) {
      lastErrCode = STEP_PARSE_ERR_ENTITY_OVERFLOW;
      lastErrTokenIdx = tCursor;
      return lastErrCode;
    }
    if (tCursor >= tokenCount) {
      lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
      lastErrTokenIdx = tCursor;
      return lastErrCode;
    }

    const headKind = tokKind(tokenBufPtr, tCursor);
    const entIdx = entityCount;
    const entOff = entIdx * ENTITY_STRIDE;
    entityCount++;

    if (headKind == TOKEN_LPAREN) {
      const rootIdx = allocArg(ARG_LIST, 0, 0);
      if (rootIdx == 0xFFFFFFFF) return lastErrCode;
      tCursor++;

      let subCount: u32 = 0;
      while (tCursor < tokenCount && tokKind(tokenBufPtr, tCursor) != TOKEN_RPAREN) {
        if (tokKind(tokenBufPtr, tCursor) != TOKEN_KEYWORD) {
          lastErrCode = STEP_PARSE_ERR_BAD_COMPLEX_ENTITY;
          lastErrTokenIdx = tCursor;
          return lastErrCode;
        }
        const subKwOff = tokArg0(tokenBufPtr, tCursor);
        const subKwLen = tokArg1(tokenBufPtr, tCursor);
        tCursor++;
        if (tCursor >= tokenCount || tokKind(tokenBufPtr, tCursor) != TOKEN_LPAREN) {
          lastErrCode = STEP_PARSE_ERR_BAD_COMPLEX_ENTITY;
          lastErrTokenIdx = tCursor;
          return lastErrCode;
        }
        const pairIdx = allocArg(ARG_LIST, 2, 0);
        if (pairIdx == 0xFFFFFFFF) return lastErrCode;
        if (allocArg(ARG_STRING, subKwOff, subKwLen) == 0xFFFFFFFF) return lastErrCode;
        const argsListIdx = parseListArg(tokenBufPtr, tokenCount);
        if (argsListIdx == 0xFFFFFFFF) return lastErrCode;
        subCount++;
      }
      if (tCursor >= tokenCount) {
        lastErrCode = STEP_PARSE_ERR_BAD_COMPLEX_ENTITY;
        lastErrTokenIdx = tCursor;
        return lastErrCode;
      }
      tCursor++;
      patchArg0(rootIdx, subCount);

      if (tCursor >= tokenCount || tokKind(tokenBufPtr, tCursor) != TOKEN_SEMICOLON) {
        lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
        lastErrTokenIdx = tCursor;
        return lastErrCode;
      }
      tCursor++;

      writeU32LE(entityBuf, entOff + 0, stepId);
      writeU32LE(entityBuf, entOff + 4, 0);
      writeU32LE(entityBuf, entOff + 8, 0);
      writeU32LE(entityBuf, entOff + 12, rootIdx);
      unchecked(entityBuf[entOff + 16] = 1);
      unchecked(entityBuf[entOff + 17] = 0);
      unchecked(entityBuf[entOff + 18] = 0);
      unchecked(entityBuf[entOff + 19] = 0);
    } else if (headKind == TOKEN_KEYWORD) {
      const typeOff = tokArg0(tokenBufPtr, tCursor);
      const typeLen = tokArg1(tokenBufPtr, tCursor);
      tCursor++;
      if (tCursor >= tokenCount || tokKind(tokenBufPtr, tCursor) != TOKEN_LPAREN) {
        lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
        lastErrTokenIdx = tCursor;
        return lastErrCode;
      }
      const rootListIdx = parseListArg(tokenBufPtr, tokenCount);
      if (rootListIdx == 0xFFFFFFFF) return lastErrCode;

      if (tCursor >= tokenCount || tokKind(tokenBufPtr, tCursor) != TOKEN_SEMICOLON) {
        lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
        lastErrTokenIdx = tCursor;
        return lastErrCode;
      }
      tCursor++;

      writeU32LE(entityBuf, entOff + 0, stepId);
      writeU32LE(entityBuf, entOff + 4, typeOff);
      writeU32LE(entityBuf, entOff + 8, typeLen);
      writeU32LE(entityBuf, entOff + 12, rootListIdx);
      unchecked(entityBuf[entOff + 16] = 0);
      unchecked(entityBuf[entOff + 17] = 0);
      unchecked(entityBuf[entOff + 18] = 0);
      unchecked(entityBuf[entOff + 19] = 0);
    } else {
      lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
      lastErrTokenIdx = tCursor;
      return lastErrCode;
    }
  }

  return STEP_PARSE_OK;
}

function parseListArg(tokenBufPtr: usize, tokenCount: u32): u32 {
  if (tokKind(tokenBufPtr, tCursor) != TOKEN_LPAREN) {
    lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
    lastErrTokenIdx = tCursor;
    return 0xFFFFFFFF;
  }
  tCursor++;

  const listIdx = allocArg(ARG_LIST, 0, 0);
  if (listIdx == 0xFFFFFFFF) return 0xFFFFFFFF;

  let count: u32 = 0;
  let expectArg: bool = true;

  while (tCursor < tokenCount) {
    const k = tokKind(tokenBufPtr, tCursor);
    if (k == TOKEN_RPAREN) {
      tCursor++;
      break;
    }
    if (k == TOKEN_COMMA) {
      if (expectArg) {
        lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
        lastErrTokenIdx = tCursor;
        return 0xFFFFFFFF;
      }
      tCursor++;
      expectArg = true;
      continue;
    }
    if (!expectArg) {
      lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
      lastErrTokenIdx = tCursor;
      return 0xFFFFFFFF;
    }

    if (k == TOKEN_DOLLAR || k == TOKEN_STAR) {
      if (allocArg(ARG_NULL, 0, 0) == 0xFFFFFFFF) return 0xFFFFFFFF;
      tCursor++;
    } else if (k == TOKEN_HASH_REF) {
      if (allocArg(ARG_REF, tokArg0(tokenBufPtr, tCursor), 0) == 0xFFFFFFFF) return 0xFFFFFFFF;
      tCursor++;
    } else if (k == TOKEN_NUMBER) {
      if (allocArg(ARG_NUMBER, tokArg0(tokenBufPtr, tCursor), tokArg1(tokenBufPtr, tCursor)) == 0xFFFFFFFF) return 0xFFFFFFFF;
      tCursor++;
    } else if (k == TOKEN_STRING) {
      if (allocArg(ARG_STRING, tokArg0(tokenBufPtr, tCursor), tokArg1(tokenBufPtr, tCursor)) == 0xFFFFFFFF) return 0xFFFFFFFF;
      tCursor++;
    } else if (k == TOKEN_ENUM) {
      if (allocArg(ARG_ENUM, tokArg0(tokenBufPtr, tCursor), tokArg1(tokenBufPtr, tCursor)) == 0xFFFFFFFF) return 0xFFFFFFFF;
      tCursor++;
    } else if (k == TOKEN_KEYWORD) {
      if (allocArg(ARG_STRING, tokArg0(tokenBufPtr, tCursor), tokArg1(tokenBufPtr, tCursor)) == 0xFFFFFFFF) return 0xFFFFFFFF;
      tCursor++;
      count++;
      // STEP "typed value" syntax: KEYWORD(...) inside an arg list, e.g.
      // LENGTH_MEASURE(1.E-07).  The JS parser emits this as TWO adjacent
      // args (keyword-as-string, then the list) without requiring a comma.
      // Replicate: if the next token is LPAREN, continue consuming a list
      // arg immediately, without demanding a comma.
      if (tCursor < tokenCount && tokKind(tokenBufPtr, tCursor) == TOKEN_LPAREN) {
        const nestedIdx = parseListArg(tokenBufPtr, tokenCount);
        if (nestedIdx == 0xFFFFFFFF) return 0xFFFFFFFF;
        count++;
      }
      expectArg = false;
      continue;
    } else if (k == TOKEN_LPAREN) {
      const nestedIdx = parseListArg(tokenBufPtr, tokenCount);
      if (nestedIdx == 0xFFFFFFFF) return 0xFFFFFFFF;
    } else {
      lastErrCode = STEP_PARSE_ERR_UNEXPECTED_TOKEN;
      lastErrTokenIdx = tCursor;
      return 0xFFFFFFFF;
    }

    count++;
    expectArg = false;
  }

  patchArg0(listIdx, count);
  return listIdx;
}