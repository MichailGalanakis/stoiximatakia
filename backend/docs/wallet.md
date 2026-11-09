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
`house_revenue` and `prize_pool:<table>`.

## Euro tables

Migration 011 adds `game_tables.currency` (`credits` default, or `EUR`), frozen at
creation. Euro tables run the existing table lifecycle unchanged, but every money
movement goes to this ledger instead of the credit ledger (`src/tables/table-ledger.ts`):

| Step                       | Credit table | Euro table (`ledger_transactions.kind`)                                 |
| -------------------------- | ------------ | ----------------------------------------------------------------------- |
| Seat claimed               | `reserve`    | `stake_reserve`: available → reserved (fee + contribution)              |
| Seat released before start | `release`    | `stake_release`: reserved → available                                   |
| Match starts               | `start`      | `stake_commit`: reserved → `prize_pool:<table>` + `house_revenue` (fee) |
| Result                     | `settle`     | `settle`: prize pool → winners (or contributions back on a draw)        |
| Cancel/void before play    | `settle`     | `settle`: prize pool and fees back to every player                      |

Prices are the same numbers as credit tables (fee €0.90, contribution
€1/€5/€15/€30). Joining a euro table needs a registered account with a verified
contact and enough euros; credits can never pay for a euro seat, nor euros for a
credit seat. The database settlement check (`match_reconciled`) now verifies euro
settlements against `ledger_entries`, and each `match_settlements` row points to
exactly one ledger. Lobby lists default to `currency=credits`, so the current
frontend never shows a euro table; `GET /multiplayer/v1/tables?gameId=…&currency=EUR`
lists euro tables, and create accepts `"currency": "EUR"`.

## Player-vs-platform matches

Migration 012 adds the financial engine for matches against the platform, where
the company pays a fixed prize (seeded offer `stake-5-prize-8`: stake €5, prize €8).
Game wiring (a bot opponent and its result) is not built yet: computer play is
still disabled on the platform, so this is a server-side service with no player
endpoint.

- **Company reserve** (`house_reserve`) is company capital, funded only through
  audited admin capital moves from `external:company` (`house_capital_movements`).
  It is separate from player balances and from `house_revenue`.
- **Start** (`WalletStore.startHouseMatch`, kind `house_stake`): in one transaction,
  the player's stake and the rest of the prize (prize − stake) from the reserve are
  locked in `house_match:<id>`. If the free reserve cannot cover it, the match is
  refused (`house_reserve_insufficient`). Every accepted match is therefore fully
  funded, however many players win at the same time. One active match per player.
- **Settle** (`WalletStore.settleHouseMatch`, kind `house_settle`, exactly once):
  `won`: the player receives the prize (€8). `lost`: the stake goes to `house_revenue`
  and the locked €3 returns to the reserve. `void`: the stake returns to the player
  and the €3 to the reserve. Only the server's authoritative game result may call it.
- Offer prices are immutable once published (only `active` can change); a match
  stores its own stake/prize snapshot.

Admin: `POST /wallet/v1/admin/house/capital {operationId, direction: in|out,
amountMinor, reviewer, note?}` (idempotent per `operationId`; `out` cannot exceed the
free reserve) and `GET /wallet/v1/admin/house/matches?status=`. The summary reports
`house.reserveMinor`, `house.exposureMinor` (locked for active matches) and
`house.activeMatches`.

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
   count), the available balance and the withdrawal share (below), then moves the
   amount to `withdrawal_pending`.
   The payout goes to the provider of the player's most recent successful deposit.
2. The player may cancel while `requested`.
3. Finance approves (`processing`, payout order sent) or rejects (funds returned).
4. The provider's `payout.succeeded` event pays out; `payout.failed` returns funds.

### Withdrawal share (owner rule, 9 November 2026)

A single request may take at most `min(available, max(€100, 80% × available))`,
rounded down to the cent. Up to €100 the whole balance can be withdrawn; from
€100 to €125 the cap stays at €100; above €125 it is 80% (€150 → €120,
€200 → €160). It is computed on the available balance at request time; the rest
stays in the wallet and can be requested later, within the daily request limit.
Nothing is charged: the retained amount remains the player's. `GET /balance`
returns the current cap as `withdrawableMinor`; a larger request fails with
`withdrawal_share_exceeded`. Floor and share are configurable. Have this rule
reviewed legally: some regimes require players to withdraw their own balance freely.

## Eligibility

Real-money operations require a `registered` account with a verified email or
phone. KYC, age and jurisdiction checks attach at `requireEligible` in
`wallet.store.ts` once a provider and legal basis exist.

## API

Player (session cookie; writes need the app `Origin` and `X-SkillBetting-Client: web-v1`):

| Method   | Path                                | Purpose                                            |
| -------- | ----------------------------------- | -------------------------------------------------- |
| GET      | `/wallet/v1/balance`                | balances, total and current `withdrawableMinor`    |
| GET      | `/wallet/v1/transactions`           | latest 100 ledger entries on the player's accounts |
| GET/POST | `/wallet/v1/deposits`               | list / start a deposit                             |
| GET/POST | `/wallet/v1/withdrawals`            | list / request a withdrawal                        |
| POST     | `/wallet/v1/withdrawals/:id/cancel` | cancel a `requested` withdrawal                    |

Errors carry a `code`: `account_not_eligible`, `invalid_amount`, `insufficient_funds`,
`withdrawal_limit_reached`, `withdrawal_share_exceeded`, `withdrawal_state_conflict`,
`operation_conflict`, etc.
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
`WALLET_WITHDRAWALS_PER_DAY` (3), `WALLET_WITHDRAWAL_FLOOR_MINOR` (10000),
`WALLET_WITHDRAWAL_SHARE_BPS` (8000 = 80%). The deployment compose file does not pass these
yet, so the wallet stays disabled on `dev.stoiximatakia.gr` until enabled on purpose.

## Next steps (specification order)

1. Wire player-vs-platform matches to a server-side bot game (owner to choose games
   and offers; computer play is currently disabled) and add multi-table tournaments.
2. Refunds, disputes, corrections, reconciliation reports and an admin dashboard.
3. Frontend: euro wallet screen and euro lobby (needs the owner's agreement first).
4. A licensed provider adapter, after legal approval.
