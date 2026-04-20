export function arrayBufferToBase64(bufferLike) {
  const bytes = bufferLike instanceof Uint8Array
    ? bufferLike
    : new Uint8Array(bufferLike);

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }

  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(base64, 'base64');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}