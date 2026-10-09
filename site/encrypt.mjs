// Build-time encryption (Node only). The layout matches site/src/crypto.mjs exactly.

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { IV_BYTES, PBKDF2_ITERATIONS, SALT_BYTES } from './src/crypto.mjs';

/** Encrypts `plaintext` with `password`. Returns base64 of salt | iv | ciphertext | 16-byte GCM tag. */
export function encryptBlob(password, plaintext) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([salt, iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}
