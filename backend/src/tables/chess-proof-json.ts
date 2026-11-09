import { createHash } from 'node:crypto';

const MAX_JSON_CHARS = 16_000_000;
export class CanonicalChessJsonError extends Error {
  constructor(readonly code: 'proof_resource' | 'proof_failed') {
    super(code);
    this.name = 'CanonicalChessJsonError';
  }
}
/** Strict JSON boundary: no getters, sparse arrays, cycles, prototypes or silent coercion. */
function canonicalJson(
  value: unknown,
  seen: Set<object>,
  depth: number,
): string {
  if (depth > 40) throw new CanonicalChessJsonError('proof_resource');
  let result: string;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    result = JSON.stringify(value);
  else if (typeof value === 'number' && Number.isFinite(value))
    result = JSON.stringify(value);
  else if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) throw new CanonicalChessJsonError('proof_failed');
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        throw new CanonicalChessJsonError('proof_failed');
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !('value' in d))
          throw new CanonicalChessJsonError('proof_failed');
        parts.push(canonicalJson(d.value, seen, depth + 1));
      }
      result = '[' + parts.join(',') + ']';
    } else {
      if (
        ![null, Object.prototype].includes(
          Object.getPrototypeOf(value) as object | null,
        ) ||
        Reflect.ownKeys(value).some((k) => typeof k !== 'string')
      )
        throw new CanonicalChessJsonError('proof_failed');
      result =
        '{' +
        Object.keys(descriptors)
          .sort()
          .map((key) => {
            const d = descriptors[key]!;
            if (!d.enumerable || !('value' in d))
              throw new CanonicalChessJsonError('proof_failed');
            return (
              JSON.stringify(key) +
              ':' +
              canonicalJson(d.value, seen, depth + 1)
            );
          })
          .join(',') +
        '}';
    }
    seen.delete(value);
  } else throw new CanonicalChessJsonError('proof_failed');
  if (result.length > MAX_JSON_CHARS)
    throw new CanonicalChessJsonError('proof_resource');
  return result;
}
export function canonicalChessJson(value: unknown): string {
  return canonicalJson(value, new Set<object>(), 0);
}
/** Cache/source binding only; a digest is never proof or player authority. */
export function chessSnapshotDigest(value: unknown): string {
  return createHash('sha256').update(canonicalChessJson(value)).digest('hex');
}
