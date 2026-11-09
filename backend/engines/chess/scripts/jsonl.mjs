#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { dispatch } from './request.mjs';

// One request per line, one response per line. Logs never contaminate stdout.
// This is a local development pipe, not an authenticated public server.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let result;
  try {
    if (line.length > 16_000_000)
      throw new Error('Request exceeds the 16-million-character bound.');
    result = dispatch(JSON.parse(line));
  } catch (error) {
    result = {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Malformed request.',
      },
    };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
