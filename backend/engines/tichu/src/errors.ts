import type { EngineError, ErrorCode } from './types.js';
export class TichuEngineError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'TichuEngineError';
    this.code = code;
  }
}
export function fail(code: ErrorCode, message: string): never {
  throw new TichuEngineError(code, message);
}
export function asError(error: unknown): EngineError {
  return error instanceof TichuEngineError
    ? { code: error.code, message: error.message }
    : {
        code: 'INVALID_STATE',
        message: error instanceof Error ? error.message : 'Invalid input.',
      };
}
export function object(
  value: unknown,
  code: ErrorCode = 'INVALID_ACTION',
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    fail(code, 'Expected a plain object.');
  return value as Record<string, unknown>;
}
export function keys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  code: ErrorCode = 'INVALID_ACTION',
): void {
  for (const key of Object.keys(o))
    if (!allowed.includes(key)) fail(code, `Unknown field: ${key}.`);
}
export function text(
  value: unknown,
  name: string,
  code: ErrorCode = 'INVALID_CONFIG',
  max = 256,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    fail(
      code,
      `${name} must be a nonblank string of at most ${max} characters without control characters.`,
    );
  return value;
}
export function uint(
  value: unknown,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
  code: ErrorCode = 'INVALID_ACTION',
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    fail(code, `${name} must be an integer between 0 and ${max}.`);
  return value;
}
