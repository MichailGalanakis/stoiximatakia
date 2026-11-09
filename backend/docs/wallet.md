# Euro wallet

Updated 9 November 2026. First deliverable of the payment specification
("Σύστημα πληρωμών"): a PostgreSQL wallet engine with deposits and withdrawals,
running only against a **sandbox provider**. No real money can enter or leave:
real providers are connected only after the legal and regulatory approvals the
specification requires.

## Separation from demo credits

The owner chose two separate balances (9 November 2026). Euros live in their own
double-entry ledger (`wallet_accounts`, `ledger_transactions`, `ledger_entries`,
migration 010). The demo `credit_*` ledger is unchanged; no transaction can move
value between the two. New accounts start with €0; the 250 demo credits remain
demo only.

## Ledger invariants (enforced by the database)

- Every transaction has at least two entries summing to zero (deferred trigger).
- History is append-only; balances are a projection that must equal the sum of
  entries (deferred trigger), so a direct `UPDATE` of a balance is refused.
- Only `external:<provider>` accounts may go negative; every player, house and
  prize-pool account is non-negative, so an overdraft fails the transaction.
- Amounts are integer euro cents (`bigint`), never floating point.
- `postWallet` locks accounts in key order, so concurrent transfers serialize.

Accounts: `available:<user>`, `reserved:<user>` (stakes), `withdrawal_pending:<user>`,
`external:<provider>` (money held at a PSP; negative while it holds player funds),
`house_revenue` and `prize_pool:<id>`. The stake/settle kinds exist and are tested at
ledger level; wiring euro tables into the game platform is a later step.

## Deposit flow

1. `POST /wallet/v1/deposits {operationId, amountMinor}` creates a `pending` deposit
   and returns the provider's hosted-page `redirectUrl`. Card data never reaches us.
2. The provider calls `POST /wallet/v1/providers/:provider/webhook`.
3. Only a correctly signed event credits the wallet, once: events are stored by
   `(provider, event_id)`, and a deposit is final after its first success/failure.
   Amount or currency mismatches are recorded and ignored, leaving the deposit
   pending for finance review. A browser redirect never credits anything.

## Withdrawal flow

`requested → processing → paid`, or `requested → cancelled | rejected`, or
`processing → failed`. Transitions are enforced by a trigger.

1. `POST /wallet/v1/withdrawals {operationId, amountMinor}` checks eligibility,
   the minimum (default €10), the 24-hour request limit (cancelled requests don't
   count) and the available balance, then moves the amount to `withdrawal_pending`.
   The payout goes to the provider of the player's most recent successful deposit.
2. The player may cancel while `requested`.
3. Finance approves (`processing`, payout order sent) or rejects (funds returned).
4. The provider's `payout.succeeded` event pays out; `payout.failed` returns funds.

Not yet implemented: the withdrawal fee scale mentioned in the specification
("στα 200 ευρώ δεσμεύονται τα 49 με κλίμακα") is awaiting the owner's definition.

## Eligibility

Real-money operations require a `registered` account with a verified email or
phone. KYC, age and jurisdiction checks attach at `requireEligible` in
`wallet.store.ts` once a provider and legal basis exist.

## API

Player (session cookie; writes need the app `Origin` and `X-SkillBetting-Client: web-v1`):

| Method   | Path                                | Purpose                                            |
| -------- | ----------------------------------- | -------------------------------------------------- |
| GET      | `/wallet/v1/balance`                | available, reserved, pending withdrawal, total     |
| GET      | `/wallet/v1/transactions`           | latest 100 ledger entries on the player's accounts |
| GET/POST | `/wallet/v1/deposits`               | list / start a deposit                             |
| GET/POST | `/wallet/v1/withdrawals`            | list / request a withdrawal                        |
| POST     | `/wallet/v1/withdrawals/:id/cancel` | cancel a `requested` withdrawal                    |

Errors carry a `code`: `account_not_eligible`, `invalid_amount`, `insufficient_funds`,
`withdrawal_limit_reached`, `withdrawal_state_conflict`, `operation_conflict`, etc.
Writes are idempotent per `operationId`; replaying with different content is `409`.

Provider: `POST /wallet/v1/providers/:provider/webhook` (signature only, no session).

Admin (`Authorization: Bearer $WALLET_ADMIN_TOKEN`; disabled when unset):
`GET /wallet/v1/admin/summary` (liabilities, house revenue, provider positions,
ledger balance check), `GET /wallet/v1/admin/withdrawals?status=`,
`POST /wallet/v1/admin/withdrawals/:id/approve|reject {reviewer, note?}`.
A single shared token is a sandbox measure; role-based access is required before
real money.

## Sandbox provider

Enabled by `WALLET_SANDBOX_SECRET` (≥ 32 bytes). Webhooks carry
`X-Sandbox-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` and
are rejected outside a 5-minute window. Event body:

```json
{
  "id": "evt_1",
  "type": "deposit.succeeded",
  "paymentId": "<deposit or withdrawal id>",
  "providerReference": "sbx_dep_<id>",
  "amountMinor": 2000,
  "currency": "EUR"
}
```

Types: `deposit.succeeded`, `deposit.failed`, `payout.succeeded`, `payout.failed`.
`signSandboxEvent` in `src/wallet/payment-provider.ts` produces the header.

## Adding a real provider

Implement `PaymentProvider` (`createDeposit`, `createPayout`, `parseWebhook`) and
register it in `WalletStore`; add its `external:<id>` account in a migration. The
wallet engine does not change. Adapters must use our payment ID as their
idempotency key. The sandbox calls run inside the database transaction; a network
adapter should move the provider call outside it before going live.

## Configuration

`WALLET_SANDBOX_SECRET`, `WALLET_ADMIN_TOKEN`, `WALLET_MIN_DEPOSIT_MINOR` (500),
`WALLET_MAX_DEPOSIT_MINOR` (100000), `WALLET_MIN_WITHDRAWAL_MINOR` (1000),
`WALLET_WITHDRAWALS_PER_DAY` (3). The deployment compose file does not pass these
yet, so the wallet stays disabled on `dev.stoiximatakia.gr` until enabled on purpose.

## Next steps (specification order)

1. Euro stakes on tables/tournaments (prize pool accounts, settlement into
   `house_revenue`), and the player-vs-platform reserve model.
2. Refunds, disputes, corrections, reconciliation reports and an admin dashboard.
3. A licensed provider adapter, after legal approval.
