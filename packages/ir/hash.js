// packages/ir/hash.js — Stable content hash over canonical CBREP bytes
//
// Uses a fast non-cryptographic hash (FNV-1a 64-bit, split into two 32-bit
// halves for JS) to produce a deterministic hex string suitable for cache
// keying. The hash is computed over the raw CBREP ArrayBuffer bytes.
//
// For cache purposes, collision resistance of FNV-1a is sufficient.
// If cryptographic strength is needed in the future, this can be swapped
// for SHA-256 without changing the cache interface.

/**
 * Compute a stable hex hash of an ArrayBuffer using FNV-1a (64-bit).
 *
 * @param {ArrayBuffer} buf
 * @returns {string} 16-char lowercase hex string
 */
export function hashCbrep(buf) {
  const bytes = new Uint8Array(buf);

  // FNV-1a 64-bit, computed as two 32-bit halves
  // FNV offset basis: 0xcbf29ce484222325
  let h0 = 0x811c9dc5; // lower 32 bits of basis
  let h1 = 0xcbf29ce4; // upper 32 bits of basis

  // FNV prime: 0x00000100000001B3
  // In 32-bit halves: hi=0x01000000, lo=0x000001B3
  // For multiplication we use the property:
  //   (h1:h0) * (p1:p0) ≈ (h1*p0 + h0*p1):h0*p0  (mod 2^64)
  const p0 = 0x000001B3;
  const p1 = 0x01000000;

  for (let i = 0; i < bytes.length; i++) {
    // XOR with byte
    h0 ^= bytes[i];

    // Multiply by FNV prime (64-bit multiply in 32-bit parts)
    const tmp0 = Math.imul(h0, p0);
    const tmp1 = Math.imul(h1, p0) + Math.imul(h0, p1);
    h0 = tmp0 >>> 0;
    h1 = (tmp1 + ((tmp0 / 0x100000000) | 0)) >>> 0;
  }

  // Format as 16-char hex (big-endian display for readability)
  return h1.toString(16).padStart(8, '0') + h0.toString(16).padStart(8, '0');
}
