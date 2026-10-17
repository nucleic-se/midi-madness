import { createHash } from 'node:crypto';
export const sha256 = (bytes: Uint8Array): Uint8Array =>
  createHash('sha256').update(bytes).digest();
