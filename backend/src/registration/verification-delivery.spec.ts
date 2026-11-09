import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import {
  HttpVerificationDelivery,
  verificationConfig,
} from './verification-delivery';

afterEach(() => mock.restoreAll());
const config = {
  secret: 's'.repeat(64),
  resendKey: 'test-email-key',
  resendFrom: 'SkillBetting <onboarding@resend.dev>',
  sevenKey: 'test-sms-key',
  sevenSender: 'SkillBet',
};
const input = {
  channel: 'email' as const,
  destination: 'delivered@resend.dev',
  code: '123456',
  requestId: 'test-request',
};
const response = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body)));
void it('sends email with a stable idempotency key and the saved destination', async () => {
  const fetch = mock.method(globalThis, 'fetch', () =>
    response({ id: 'email-id' }),
  );
  await new HttpVerificationDelivery(config).send(input);
  const call = fetch.mock.calls[0]!;
  assert.equal(call.arguments[0], 'https://api.resend.com/emails');
  const options = call.arguments[1] as RequestInit;
  assert.equal(
    (options.headers as Record<string, string>)['Idempotency-Key'],
    'registration/test-request',
  );
  assert.ok(typeof options.body === 'string');
  const payload = JSON.parse(options.body) as { to: string[]; text: string };
  assert.deepEqual(payload.to, [input.destination]);
  assert.ok(payload.text.includes(input.code));
});
void it('checks the per-message seven result rather than treating every HTTP 200 as sent', async () => {
  const fetch = mock.method(globalThis, 'fetch', () =>
    response({ success: '100', debug: 'false', messages: [{ success: true }] }),
  );
  const delivery = new HttpVerificationDelivery(config);
  await delivery.send({
    ...input,
    channel: 'phone',
    destination: '+306912345678',
  });
  const options = fetch.mock.calls[0]!.arguments[1] as RequestInit;
  assert.ok(typeof options.body === 'string');
  const body = new URLSearchParams(options.body);
  assert.equal(body.get('to'), '+306912345678');
  assert.equal(body.get('foreign_id'), 'test-request');
  fetch.mock.mockImplementation(() =>
    response({
      success: '100',
      debug: 'false',
      messages: [{ success: false, text: 'private code' }],
    }),
  );
  await assert.rejects(delivery.send({ ...input, channel: 'phone' }), {
    message: 'delivery_failed',
  });
  fetch.mock.mockImplementation(() =>
    response({ success: '100', debug: 'true', messages: [{ success: true }] }),
  );
  await assert.rejects(delivery.send({ ...input, channel: 'phone' }));
});
void it('does not accept missing secrets or invalid sender configuration', () => {
  assert.throws(() => verificationConfig({ RESEND_API_KEY: 'test' }));
  assert.throws(() => verificationConfig({ SEVEN_SENDER: 'invalid sender' }));
  assert.throws(() => verificationConfig({ SEVEN_SENDER: 'SkillBetting' }), {
    message: 'SEVEN_SENDER must be 1–11 alphanumeric characters or 1–16 digits',
  });
  assert.equal(
    verificationConfig({ SEVEN_SENDER: 'SkillBet' }).sevenSender,
    'SkillBet',
  );
  assert.equal(
    new HttpVerificationDelivery({ ...config, sevenKey: undefined }).available(
      'phone',
    ),
    false,
  );
});
