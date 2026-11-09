# Verification provider setup

Prepared 31 October 2026. The verification screen uses the email and normalized E.164 phone returned from the stored registration. Both destinations are read-only, including after session resume. No change-contact endpoint has been added. OTP delivery and code verification are implemented; see [the current contract](contact-verification.md). The variables below are consumed only by the backend.

No provider documents need to be supplied manually. Official references:

- [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email): server-side bearer authentication, sender/recipient, body, and accepted message ID.
- [Resend development sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain): `onboarding@resend.dev` can send to the address associated with the Resend account. Use that same address when registering for an inbox test. A verified sender domain is required to send to other users. Do not silently redirect a user's verification message to the developer inbox.
- [Resend test addresses](https://resend.com/docs/dashboard/emails/send-test-emails): event-simulation addresses such as `delivered@resend.dev` are useful for transport tests; they are not proof that a real user received or entered a code.
- [seven.io getting started](https://docs.seven.io/en/rest-api/first-steps) and [SMS endpoint](https://docs.seven.io/en/rest-api/endpoints/sms): server-side `X-Api-Key`, E.164 recipient, message text, optional sender. Check the provider's body-level success for the individual message, not only HTTP status. Sender format/country requirements must be respected.

## Local settings

Add the real values to `/Users/tsal/Projects/skillbetting-backend/.env`, which is ignored by Git. Keep both API keys on the backend. These are the variable names:

```dotenv
RESEND_API_KEY=replace-locally
RESEND_FROM="SkillBetting <onboarding@resend.dev>"
SEVEN_API_KEY=replace-locally
SEVEN_SENDER=SkillBet
OTP_SECRET=generated-server-secret
```

Do not paste keys into chat, commit them, put them in `NEXT_PUBLIC_*`, or return them to the browser. There is no recipient override setting: destinations must stay bound to the saved account. Automated tests use fake providers. When you open step 2 with live credentials configured, an initial email/SMS send is attempted automatically to your saved destinations.

Run `npm run verification:secret` once to generate a persistent signing key in the ignored backend `.env` without displaying it. Apply `npm run db:migrate`, then restart the backend. `OTP_SECRET` must remain stable across restarts and must be configured securely on Linux too.

Durable challenges, ten-minute expiry, five guesses, one-minute resend cooldowns, provider failure states, and code checking are now implemented. An accepted send is not verified ownership: the user must enter the code. General sign-in, identity checks, and game/wallet authorization stay separate.

## Local sender configuration correction — 31 October

A 12-character alphanumeric SMS sender prevented startup. Alphanumeric `SEVEN_SENDER` values must be 1–11 characters (numeric senders may be up to 16 digits). The local setting was corrected to `SkillBet`; API keys were preserved. Configuration validation now names the offending setting and limits. This fix changes no frontend view or styles.
