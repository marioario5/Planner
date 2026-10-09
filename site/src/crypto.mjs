// Client-side AES-256-GCM decrypt of the locked page: PBKDF2-HMAC-SHA256 key derivation, a 16-byte salt, a 12-byte IV and a
// 128-bit GCM tag appended to the ciphertext, all stored as one base64 string (salt | iv | ciphertext+tag).
// The build (site/encrypt.mjs) produces exactly this layout. A wrong password and a damaged blob look the same: null.
// No Node-only APIs here, so the browser runs this file as-is (build.mjs inlines it, minus the `export`s).

export const PBKDF2_ITERATIONS = 600000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The decrypted text, or null if the password is wrong (or the blob is damaged). Never throws. */
export async function decryptBlob(secret, b64) {
  try {
    const raw = fromBase64(b64);
    const salt = raw.slice(0, SALT_BYTES);
    const iv = raw.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
    const data = raw.slice(SALT_BYTES + IV_BYTES);
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
