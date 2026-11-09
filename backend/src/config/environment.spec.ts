import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readEnvironment } from './environment';

void describe('readEnvironment', () => {
  void it('uses local development defaults', () => {
    assert.deepEqual(readEnvironment({}), {
      host: '127.0.0.1',
      port: 3000,
      logLevels: ['error', 'warn', 'log'],
      trustedProxyHops: 0,
    });
  });

  void it('accepts explicit configuration', () => {
    assert.deepEqual(
      readEnvironment({ HOST: '0.0.0.0', PORT: '8080', LOG_LEVEL: 'warn' }),
      {
        host: '0.0.0.0',
        port: 8080,
        logLevels: ['error', 'warn'],
        trustedProxyHops: 0,
      },
    );
  });

  void it('only trusts an explicitly configured single proxy hop', () => {
    assert.equal(
      readEnvironment({ TRUST_PROXY_HOPS: '1' }).trustedProxyHops,
      1,
    );
    for (const value of ['true', '2', '-1', '1,2', ' 1', ''])
      assert.throws(() => readEnvironment({ TRUST_PROXY_HOPS: value }), {
        message: 'TRUST_PROXY_HOPS must be 0 or 1',
      });
  });

  void it('rejects invalid ports without echoing supplied values', () => {
    for (const port of ['', '0', '65536', '-1', '1.5', ' 3000', 'secret']) {
      assert.throws(() => readEnvironment({ PORT: port }), {
        message: 'PORT must be an integer from 1 to 65535',
      });
    }
  });

  void it('rejects empty hosts and unsupported log levels', () => {
    assert.throws(() => readEnvironment({ HOST: ' ' }), /HOST/);
    for (const level of ['verbose', 'toString', '__proto__', 'constructor']) {
      assert.throws(() => readEnvironment({ LOG_LEVEL: level }), {
        message: 'LOG_LEVEL must be debug, info, warn, or error',
      });
    }
  });
});
