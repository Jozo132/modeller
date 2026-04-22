// kernel/step_lexer — native ISO 10303-21 (STEP) lexer
//
// Streaming tokenizer for STEP Part 21 text.  Matches the token output of
// the JS lexer in js/cad/StepImport.js so a parity test can verify them
// byte-for-byte on real corpus files.
//
// Design:
//   • Input text is copied into a linear-memory buffer via stepLexGetInputPtr()
//     and the JS side writes bytes directly, then calls stepLexRun(len).
//   • Tokens are emitted into a flat arena: 16 bytes per token.
//       offset+0  u8   kind       (TOKEN_* constant)
//       offset+1..7    padding
//       offset+8  u32  arg0       (entity id, or string-pool byte offset)
//       offset+12 u32  arg1       (string-pool byte length, or 0)
//   • String/keyword/number/enum payloads are byte-copied into a separate
//     u8 string pool; token.arg0 is the start offset, token.arg1 the length.
//   • Only ASCII-printable text is expected in practice; bytes are copied
//     verbatim so any UTF-8 in STRING tokens round-trips.
//
// The lexer is NOT streaming — it consumes one full buffer at a time.  For
// STEP files up to the configured MAX_INPUT size that is always acceptable.

// ---------- configuration ----------

/** Max STEP source size the lexer can process in one call (32 MB). */
const MAX_INPUT: u32 = 32 * 1024 * 1024;
/** Max number of tokens (bounded by source size; 16 MB of tokens = 1 M tokens). */
const MAX_TOKENS: u32 = 4 * 1024 * 1024;
/** Max bytes of string-pool payload (16 MB; keywords/strings/numbers copied here). */
const MAX_STRPOOL: u32 = 16 * 1024 * 1024;

/** Size of one token record in bytes. */
const TOKEN_STRIDE: u32 = 16;

// ---------- token kinds ----------

export const TOKEN_EOF: u8 = 0;
export const TOKEN_HASH_ID: u8 = 1;      // #N on the LHS of '='
export const TOKEN_HASH_REF: u8 = 2;     // #N anywhere else
export const TOKEN_KEYWORD: u8 = 3;      // TYPE_NAME or header keyword (UPPERCASE_)
export const TOKEN_NUMBER: u8 = 4;       // numeric literal (verbatim text)
export const TOKEN_STRING: u8 = 5;       // 'payload' (quotes stripped; '' escapes kept)
export const TOKEN_ENUM: u8 = 6;         // .IDENT. (dots stripped)
export const TOKEN_DOLLAR: u8 = 7;       // $
export const TOKEN_STAR: u8 = 8;         // *
export const TOKEN_LPAREN: u8 = 9;
export const TOKEN_RPAREN: u8 = 10;
export const TOKEN_COMMA: u8 = 11;
export const TOKEN_EQUALS: u8 = 12;
export const TOKEN_SEMICOLON: u8 = 13;

// ---------- error codes ----------

export const STEP_LEX_OK: i32 = 0;
export const STEP_LEX_ERR_BAD_CHAR: i32 = 1;
export const STEP_LEX_ERR_UNTERMINATED_STRING: i32 = 2;
export const STEP_LEX_ERR_INPUT_TOO_LARGE: i32 = 3;
export const STEP_LEX_ERR_TOKEN_OVERFLOW: i32 = 4;
export const STEP_LEX_ERR_STRPOOL_OVERFLOW: i32 = 5;

// ---------- arenas (linear memory, @unmanaged where possible) ----------

const inputBuf = new StaticArray<u8>(MAX_INPUT);
const tokenBuf = new StaticArray<u8>(MAX_TOKENS * TOKEN_STRIDE);
const strPool = new StaticArray<u8>(MAX_STRPOOL);

let tokenCount: u32 = 0;
let strPoolUsed: u32 = 0;
let lastErrOffset: u32 = 0;
let lastErrCode: i32 = STEP_LEX_OK;

// ---------- public exports (pointers) ----------

export function stepLexGetInputPtr(): usize {
  return changetype<usize>(inputBuf);
}
export function stepLexGetInputCapacity(): u32 { return MAX_INPUT; }

export function stepLexGetTokenBufPtr(): usize {
  return changetype<usize>(tokenBuf);
}
export function stepLexGetTokenCount(): u32 { return tokenCount; }
export function stepLexGetTokenStride(): u32 { return TOKEN_STRIDE; }

export function stepLexGetStringPoolPtr(): usize {
  return changetype<usize>(strPool);
}
export function stepLexGetStringPoolLen(): u32 { return strPoolUsed; }

export function stepLexGetErrorOffset(): u32 { return lastErrOffset; }
export function stepLexGetErrorCode(): i32 { return lastErrCode; }

export function stepLexReset(): void {
  tokenCount = 0;
  strPoolUsed = 0;
  lastErrOffset = 0;
  lastErrCode = STEP_LEX_OK;
}

// ---------- token emit helpers ----------

@inline
function writeU32LE(offset: u32, val: u32): void {
  unchecked(tokenBuf[offset]     = <u8>(val & 0xFF));
  unchecked(tokenBuf[offset + 1] = <u8>((val >> 8) & 0xFF));
  unchecked(tokenBuf[offset + 2] = <u8>((val >> 16) & 0xFF));
  unchecked(tokenBuf[offset + 3] = <u8>((val >> 24) & 0xFF));
}

@inline
function emitToken(kind: u8, arg0: u32, arg1: u32): bool {
  if (tokenCount >= MAX_TOKENS) {
    lastErrCode = STEP_LEX_ERR_TOKEN_OVERFLOW;
    return false;
  }
  const off = tokenCount * TOKEN_STRIDE;
  unchecked(tokenBuf[off] = kind);
  // padding 1..7 left as-is (irrelevant)
  writeU32LE(off + 8, arg0);
  writeU32LE(off + 12, arg1);
  tokenCount++;
  return true;
}

/** Copy [start,end) from inputBuf into strPool; returns the pool offset, or 0xFFFFFFFF on overflow. */
@inline
function internSlice(start: u32, end: u32): u32 {
  const len = end - start;
  if (strPoolUsed + len > MAX_STRPOOL) {
    lastErrCode = STEP_LEX_ERR_STRPOOL_OVERFLOW;
    return 0xFFFFFFFF;
  }
  const poolOff = strPoolUsed;
  for (let i: u32 = 0; i < len; i++) {
    unchecked(strPool[poolOff + i] = unchecked(inputBuf[start + i]));
  }
  strPoolUsed += len;
  return poolOff;
}

// ---------- character classification (branch-free inline) ----------

@inline
function isWhitespace(c: u8): bool {
  return c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D;
}
@inline
function isDigit(c: u8): bool { return c >= 0x30 && c <= 0x39; }
@inline
function isAlphaUpper(c: u8): bool { return c >= 0x41 && c <= 0x5A; }
@inline
function isAlpha(c: u8): bool {
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
}
@inline
function isKeywordCh(c: u8): bool {
  // STEP keywords are UPPERCASE_WITH_DIGITS (and '_').  Accept uppercase +
  // digits + underscore; we do not downcase in the lexer.
  return isAlphaUpper(c) || isDigit(c) || c == 0x5F /* _ */;
}
@inline
function isNumberStart(c: u8): bool {
  return isDigit(c) || c == 0x2B /* + */ || c == 0x2D /* - */ || c == 0x2E /* . */;
}
@inline
function isNumberBody(c: u8): bool {
  return isDigit(c) || c == 0x2B || c == 0x2D || c == 0x2E
      || c == 0x45 /* E */ || c == 0x65 /* e */;
}

// ---------- main lex entry ----------

/**
 * Tokenize inputBuf[0..inputLen).  Returns STEP_LEX_OK on success or an error
 * code; on error, stepLexGetErrorOffset() points at the byte that failed.
 *
 * Skips the HEADER section automatically so the emitted tokens begin at the
 * DATA; keyword — this matches what the JS importer processes.  The HEADER
 * keywords and their payloads are still tokenized (callers can ignore them).
 */
export function stepLexRun(inputLen: u32): i32 {
  tokenCount = 0;
  strPoolUsed = 0;
  lastErrOffset = 0;
  lastErrCode = STEP_LEX_OK;

  if (inputLen > MAX_INPUT) {
    lastErrCode = STEP_LEX_ERR_INPUT_TOO_LARGE;
    return lastErrCode;
  }

  let i: u32 = 0;
  while (i < inputLen) {
    const c = unchecked(inputBuf[i]);

    // ---- whitespace ----
    if (isWhitespace(c)) { i++; continue; }

    // ---- single-char punctuation ----
    if (c == 0x28 /* ( */) { if (!emitToken(TOKEN_LPAREN, 0, 0)) { lastErrOffset = i; return lastErrCode; } i++; continue; }
    if (c == 0x29 /* ) */) { if (!emitToken(TOKEN_RPAREN, 0, 0)) { lastErrOffset = i; return lastErrCode; } i++; continue; }
    if (c == 0x2C /* , */) { if (!emitToken(TOKEN_COMMA, 0, 0)) { lastErrOffset = i; return lastErrCode; } i++; continue; }
    if (c == 0x3D /* = */) { if (!emitToken(TOKEN_EQUALS, 0, 0)) { lastErrOffset = i; return lastErrCode; } i++; continue; }
    if (c == 0x3B /* ; */) { if (!emitToken(TOKEN_SEMICOLON, 0, 0)) { lastErrOffset = i; return lastErrCode; } i++; continue; }
    if (c == 0x24 /* $ */) { if (!emitToken(TOKEN_DOLLAR, 0, 0)) { lastErrOffset = i; return lastErrCode; } i++; continue; }
    if (c == 0x2A /* * */) { if (!emitToken(TOKEN_STAR, 0, 0)) { lastErrOffset = i; return lastErrCode; } i++; continue; }

    // ---- comment /* ... */ ----
    if (c == 0x2F /* / */ && i + 1 < inputLen && unchecked(inputBuf[i + 1]) == 0x2A /* * */) {
      i += 2;
      while (i + 1 < inputLen) {
        if (unchecked(inputBuf[i]) == 0x2A /* * */ && unchecked(inputBuf[i + 1]) == 0x2F /* / */) {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // ---- #N — entity id or reference ----
    if (c == 0x23 /* # */) {
      const start = i;
      i++;
      if (i >= inputLen || !isDigit(unchecked(inputBuf[i]))) {
        lastErrCode = STEP_LEX_ERR_BAD_CHAR;
        lastErrOffset = start;
        return lastErrCode;
      }
      let id: u32 = 0;
      while (i < inputLen && isDigit(unchecked(inputBuf[i]))) {
        id = id * 10 + (<u32>(unchecked(inputBuf[i])) - 0x30);
        i++;
      }
      // Look ahead for '=' (skipping whitespace) to decide HASH_ID vs HASH_REF
      let k = i;
      while (k < inputLen && isWhitespace(unchecked(inputBuf[k]))) k++;
      const isDefinition = (k < inputLen && unchecked(inputBuf[k]) == 0x3D /* = */);
      const kind = isDefinition ? TOKEN_HASH_ID : TOKEN_HASH_REF;
      if (!emitToken(kind, id, 0)) { lastErrOffset = start; return lastErrCode; }
      continue;
    }

    // ---- 'string' ----
    if (c == 0x27 /* ' */) {
      const quoteStart = i;
      i++; // skip opening '
      const contentStart = i;
      while (i < inputLen) {
        const ch = unchecked(inputBuf[i]);
        if (ch == 0x27 /* ' */) {
          // STEP escape: '' inside a string literal
          if (i + 1 < inputLen && unchecked(inputBuf[i + 1]) == 0x27) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      if (i >= inputLen) {
        lastErrCode = STEP_LEX_ERR_UNTERMINATED_STRING;
        lastErrOffset = quoteStart;
        return lastErrCode;
      }
      const contentEnd = i;
      i++; // skip closing '
      const poolOff = internSlice(contentStart, contentEnd);
      if (poolOff == 0xFFFFFFFF) { lastErrOffset = quoteStart; return lastErrCode; }
      if (!emitToken(TOKEN_STRING, poolOff, contentEnd - contentStart)) {
        lastErrOffset = quoteStart;
        return lastErrCode;
      }
      continue;
    }

    // ---- .ENUM. ----
    if (c == 0x2E /* . */) {
      // Could be: .ENUM. (if next char is an uppercase letter) OR the start
      // of a number like .5 — distinguish by peeking.
      if (i + 1 < inputLen) {
        const next = unchecked(inputBuf[i + 1]);
        if (isAlphaUpper(next) || next == 0x54 /* T */ || next == 0x46 /* F */) {
          const dotStart = i;
          i++; // skip leading .
          const identStart = i;
          while (i < inputLen && (isAlphaUpper(unchecked(inputBuf[i])) || isDigit(unchecked(inputBuf[i])) || unchecked(inputBuf[i]) == 0x5F)) {
            i++;
          }
          const identEnd = i;
          if (i >= inputLen || unchecked(inputBuf[i]) != 0x2E /* . */) {
            lastErrCode = STEP_LEX_ERR_BAD_CHAR;
            lastErrOffset = dotStart;
            return lastErrCode;
          }
          i++; // skip trailing .
          const poolOff = internSlice(identStart, identEnd);
          if (poolOff == 0xFFFFFFFF) { lastErrOffset = dotStart; return lastErrCode; }
          if (!emitToken(TOKEN_ENUM, poolOff, identEnd - identStart)) {
            lastErrOffset = dotStart;
            return lastErrCode;
          }
          continue;
        }
      }
      // Fall through to number parsing (.5, .125 etc.)
    }

    // ---- keyword (TYPE_NAME) ----
    if (isAlphaUpper(c)) {
      const start = i;
      while (i < inputLen) {
        const cc = unchecked(inputBuf[i]);
        if (isKeywordCh(cc)) { i++; continue; }
        // Accept hyphen inside a keyword if followed by alpha/digit.  This
        // is needed for the STEP footer "END-ISO-10303-21" which is a
        // single marker token, not an expression with a minus sign.
        if (cc == 0x2D /* - */ && i + 1 < inputLen) {
          const nn = unchecked(inputBuf[i + 1]);
          if (isAlphaUpper(nn) || isDigit(nn)) { i++; continue; }
        }
        break;
      }
      const end = i;
      const poolOff = internSlice(start, end);
      if (poolOff == 0xFFFFFFFF) { lastErrOffset = start; return lastErrCode; }
      if (!emitToken(TOKEN_KEYWORD, poolOff, end - start)) {
        lastErrOffset = start;
        return lastErrCode;
      }
      continue;
    }

    // ---- number ----
    if (isNumberStart(c)) {
      const start = i;
      // Consume sign
      if (c == 0x2B || c == 0x2D) i++;
      // Consume digits and at most one '.'; then optional exponent.
      let sawDot: bool = false;
      let sawDigit: bool = false;
      while (i < inputLen) {
        const cc = unchecked(inputBuf[i]);
        if (isDigit(cc)) { sawDigit = true; i++; continue; }
        if (cc == 0x2E /* . */ && !sawDot) { sawDot = true; i++; continue; }
        break;
      }
      // Exponent: E/e [+-]? digits
      if (i < inputLen) {
        const cc = unchecked(inputBuf[i]);
        if (cc == 0x45 /* E */ || cc == 0x65 /* e */) {
          i++;
          if (i < inputLen) {
            const s = unchecked(inputBuf[i]);
            if (s == 0x2B || s == 0x2D) i++;
          }
          while (i < inputLen && isDigit(unchecked(inputBuf[i]))) { sawDigit = true; i++; }
        }
      }
      if (!sawDigit) {
        lastErrCode = STEP_LEX_ERR_BAD_CHAR;
        lastErrOffset = start;
        return lastErrCode;
      }
      const end = i;
      const poolOff = internSlice(start, end);
      if (poolOff == 0xFFFFFFFF) { lastErrOffset = start; return lastErrCode; }
      if (!emitToken(TOKEN_NUMBER, poolOff, end - start)) {
        lastErrOffset = start;
        return lastErrCode;
      }
      continue;
    }

    // ---- unknown byte ----
    lastErrCode = STEP_LEX_ERR_BAD_CHAR;
    lastErrOffset = i;
    return lastErrCode;
  }

  // Emit terminating EOF token for callers that want a sentinel.
  emitToken(TOKEN_EOF, 0, 0);
  return STEP_LEX_OK;
}
