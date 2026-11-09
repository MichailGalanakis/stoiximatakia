import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHttpAdapter } from '../src/bootstrap';

void it('ignores forwarded client addresses without a trusted proxy', async () => {
  const server = createHttpAdapter().getInstance();
  server.get('/test-ip', (request) => ({ ip: request.ip }));
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/test-ip',
      remoteAddress: '172.20.0.2',
      headers: { 'x-forwarded-for': '198.51.100.8' },
    });
    assert.deepEqual(response.json(), { ip: '172.20.0.2' });
  } finally {
    await server.close();
  }
});

void it('uses the client next to the single controlled proxy, not a spoofed earlier hop', async () => {
  const server = createHttpAdapter(1).getInstance();
  server.get('/test-ip', (request) => ({ ip: request.ip }));
  try {
    for (const chain of ['198.51.100.8', '203.0.113.11, 198.51.100.8']) {
      const response = await server.inject({
        method: 'GET',
        url: '/test-ip',
        remoteAddress: '172.20.0.2',
        headers: { 'x-forwarded-for': chain },
      });
      assert.deepEqual(response.json(), { ip: '198.51.100.8' });
    }
  } finally {
    await server.close();
  }
});
