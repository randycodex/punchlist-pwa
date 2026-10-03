import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export interface RecoveryObject {
  bucket: string;
  path: string;
  size: number;
  sha256: string;
}
export function objectDigest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Local rehearsal verifier only: never contacts a hosted service. */
export async function verifyRecoveryObjects(root: string, objects: RecoveryObject[]) {
  const base = resolve(root);
  const seen = new Set<string>();
  for (const object of objects) {
    const key = `${object.bucket}/${object.path}`;
    const target = resolve(base, key);
    if (!object.bucket || object.bucket.includes('/') || object.bucket.includes('\\') ||
        object.path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
        !target.startsWith(base + sep) || seen.has(key)) throw new Error(`Invalid recovery object key: ${key}`);
    seen.add(key);
    const bytes = await readFile(target);
    if (bytes.length !== object.size || objectDigest(bytes) !== object.sha256) {
      throw new Error(`Recovery object integrity mismatch: ${key}`);
    }
  }
  return objects.length;
}
