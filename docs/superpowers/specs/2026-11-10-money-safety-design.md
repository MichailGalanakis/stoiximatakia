# Money safety fixes — design

Date: 10 November 2026. Status: design approved in conversation by the owner;
awaiting review of this written spec.

Sub-project 1 of 4 from the project review (1: money safety, 2: provider refunds
and status checks, 3: code restructuring, 4: CI/deploy/docs).

## Goal

Close the ways the euro wallet can lose company money or leave player money
locked forever. Everything runs against the sandbox provider only.

Success: each behaviour below is covered by an integration test that failed
before the change, the full suite passes, and the ledger stays balanced and
reconciled in every test.

## Decisions (owner, 10 November 2026)

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Withdrawal rule (€100 or 80% per request) | **Unchanged.** It stays per request until the client asks otherwise. |
| 2 | Lost chargeback with a pending withdrawal | Cancel the player's `requested` withdrawals, then recover. |
| 3 | Player left owing money | No withdrawals while a debt is outstanding; deposits and play stay allowed. Finance collects by hand. |
| 4 | Abandoned match against the platform | Loss after 30 minutes without a player move. |
| 5 | Tournament at its start time | Start automatically if the minimum field is reached, otherwise cancel with full refunds. |
| 6 | Abandoned euro table | Per-move clocks, as on DoD Games. **Separate sub-project (1b)**; not in this spec. |
| 7 | Pending deposits | Expire: card after 24 hours, RF after 10 days. |

## Out of scope

- Per-move clocks on euro tables (sub-project 1b; touches gameplay and frontend).
- Automatic debt collection from future deposits or winnings.
- Provider refunds, status checks (sub-project 2; unfinished work is on branch
  `wip/refunds-status-checks`, whose migration will be renumbered after this).
- Any frontend change. New response fields are additive.

## Current behaviour being fixed

- `resolveDispute(…, 'lost')` in `backend/src/wallet/finance-controls.ts` recovers
  only from `available:<user>`. A `requested` withdrawal keeps its hold in
  `withdrawal_pending:<user>` and can be approved afterwards, because
  `approveWithdrawal` only blocks while a dispute is `open`. The company can pay
  the chargeback and the withdrawal.
- `house_matches` with status `active` never end unless the player moves or
  forfeits; the stake and the locked share of `house_reserve` stay in
  `house_match:<id>`.
- `tournaments` with status `open` stay open after `starts_at`; tickets cannot be
  bought (`tournament_unavailable`) and are not refunded.
- `deposits` with status `pending` never change.

## Design

### 1. Lost chargeback recovers from pending withdrawals

In `resolveDispute` when the outcome is `lost`, in the same transaction and before
reading the available balance:

1. Lock the player's `withdrawal_requests` with status `requested` (`FOR UPDATE`,
   ordered by `created_at,id`).
2. Release each one with the existing release posting (`withdrawal_release`:
   `withdrawal_pending:<user>` → `available:<user>`), status `cancelled`,
   `review_note` = `Cancelled: chargeback <disputeId>`, `reviewed_by` = the resolver.
3. Then recover `min(dispute amount, available)` as today and record the rest as
   `shortfall_minor`.

Withdrawals already `processing` are not touched: the order is with the provider.
The release logic lives in `WalletStore.release` today; it moves to a function that
both `WalletStore` and `finance-controls.ts` can call (no behaviour change).

### 2. Chargeback debt blocks withdrawals until collected

Schema: `deposit_disputes.shortfall_recovered_minor bigint NOT NULL DEFAULT 0`,
with `0 <= shortfall_recovered_minor <= coalesce(shortfall_minor,0)`. The dispute
guard trigger is relaxed to allow exactly this column to increase on a `lost`
dispute. New ledger kind `chargeback_recovery`.

Debt of a player = `sum(shortfall_minor - shortfall_recovered_minor)` over their
`lost` disputes.

- `requestWithdrawal` and `approveWithdrawal` fail with `account_restricted` (403)
  while the debt is greater than zero (in addition to the existing open-dispute
  check). Deposits, tables, tournaments and platform matches are not restricted.
- New admin endpoint (finance role, audited as `dispute.recover`):
  `POST /wallet/v1/admin/disputes/:disputeId/recover {operationId, amountMinor}`.
  It posts `available:<user>` −amount → `external:company` +amount, adds the amount
  to `shortfall_recovered_minor`, and fails with `insufficient_funds` if the player
  does not hold the amount, or `invalid_amount` if it exceeds the remaining debt.
  Idempotent per `operationId` (the ledger `operation_key` is
  `chargeback_recovery:<operationId>`; a replay returns the dispute unchanged).
- `GET /wallet/v1/balance` adds `debtMinor`. `withdrawableMinor` is `0` while
  `debtMinor > 0`.
- Admin summary: `chargebackShortfallMinor` becomes the outstanding amount
  (shortfall minus recovered).

### 3. Abandoned platform match times out as a loss

- Setting `HOUSE_MATCH_TIMEOUT_MINUTES` (default 30, 1–1440).
- A match is abandoned when it is `active` and `house_games.updated_at` is older
  than the timeout. `updated_at` already changes on every committed player
  command, and bots always reply inside the same command, so it is the time of the
  player's last move (or the start).
- Maintenance closes it as `lost`: appends a `house_game_events` row of new kind
  `timeout` (actor `system`), advances `house_games.revision`, and calls
  `settleHouseMatch(…, 'lost')` in one transaction. Same money movement as a
  forfeit.
- A player command racing the timeout is safe: both lock the `house_games` row;
  whichever commits second sees the new state (`match_ended` for the player, or the
  timeout no longer applies because `updated_at` moved).
- The match view adds `expiresAt` (ISO time) while the match is active.

### 4. Tournaments start or cancel at their start time

Maintenance takes each `open` tournament with `starts_at <= now()`:

- active tickets ≥ `min_players` → the existing `start` logic;
- otherwise → the existing `cancel` logic (full refunds).

Both run as actor `system` and are audited (`tournament.start` /
`tournament.cancel` with `automatic: true`). Manual start/cancel by finance keep
working. No change to payout.

### 5. Pending deposits expire

- `deposits.status` gains `expired`. Settings `WALLET_CARD_DEPOSIT_EXPIRY_HOURS`
  (default 24) and `WALLET_RF_DEPOSIT_EXPIRY_DAYS` (default 10). A provider with
  `manualPayouts` (bank RF) uses the RF limit; others use the card limit.
- Maintenance marks `pending` deposits older than their limit as `expired`.
- **Late card payment:** a verified `deposit.succeeded` event for an `expired`
  deposit with the exact amount and currency is credited normally (status becomes
  `succeeded`). Signature and amount already prove the payment; refusing it would
  strand the player's money. Any other event on an expired deposit is ignored as
  today.
- **Late RF payment:** as agreed, not credited automatically. The bank receipt is
  stored as `unmatched` with reason `deposit_expired` for finance.
- The deposit status guard allows `pending → succeeded|failed|expired` and
  `expired → succeeded`; nothing else.

### 6. Maintenance job

One `runMaintenance()` on a new `MaintenanceService` (module `wallet`), run every
`WALLET_MAINTENANCE_INTERVAL_SECONDS` (default 60; `0` disables) by the existing
`WalletJobs` timers, and callable from tests. It takes a transaction-scoped
advisory lock so only one app instance runs it at a time, then runs steps 3, 4 and
5 above, each item in its own transaction so one failure does not block the rest.
It returns counts `{houseMatchesTimedOut, tournamentsStarted, tournamentsCancelled,
depositsExpired}`. Admin endpoint `POST /wallet/v1/admin/maintenance` (finance)
runs it on demand and returns the counts.

The tournament and house-game logic stay in their own stores
(`TournamentStore.runDue(actor)`, `HouseGameStore.timeOutAbandoned(minutes)`);
`MaintenanceService` only orchestrates.

## Schema (one migration, `017_money_safety.sql`)

- `deposit_disputes.shortfall_recovered_minor` + check; relaxed dispute guard.
- `ledger_transactions.kind` adds `chargeback_recovery`.
- `house_game_events.kind` adds `timeout`.
- `deposits.status` adds `expired`; `wallet_guard_payment_status` updated for the
  transitions in section 5; the `(status = 'succeeded') = (transaction_id IS NOT
  NULL)` check is unchanged.
- `bank_receipts` needs no change (`reason` is free text).
- Readiness requires migration 017.

The migration must run inside the migrator's single transaction together with
earlier pending migrations (see migration 012 for the `SET CONSTRAINTS` pattern
when altering a table with queued deferred triggers).

## Error handling

New or reused error codes: `account_restricted` (debt), `invalid_amount`,
`insufficient_funds`, `dispute_not_found`, `match_ended`. No new failure can leave
a partial money movement: every step is one database transaction, and the ledger
triggers reject unbalanced or overdrawn postings.

## Testing

Integration tests against PostgreSQL, written first and seen to fail:

1. Lost dispute with a `requested` withdrawal: withdrawal becomes `cancelled`, the
   held amount is recovered, shortfall is only what is truly missing; a
   `processing` withdrawal is left alone.
2. Debt: withdrawal request and approval refused with `account_restricted`;
   deposit and tournament ticket still allowed; recovery reduces `debtMinor`;
   replay is idempotent; over-recovery and recovery beyond the balance refused;
   withdrawal allowed again at zero debt.
3. House match: not timed out before the limit; timed out as `lost` after it, with
   stake to `house_revenue` and reserve released; a move resets the clock;
   `expiresAt` reported.
4. Tournament: at `starts_at` with enough players → `running`, fees recognised;
   with too few → `cancelled`, all refunded; before `starts_at` untouched.
5. Deposits: card expires after 24h and a late signed success still credits once;
   RF expires after 10 days and a late receipt is `unmatched` (`deposit_expired`).
6. Maintenance: counts are correct, a second run does nothing, and the admin
   endpoint requires the finance role.
7. After every scenario: ledger sum is zero and every account equals its history.

Existing tests are updated only where a response gains a field (`debtMinor`,
`expiresAt`) or `chargebackShortfallMinor` changes meaning.

## Documentation

Update `backend/docs/wallet.md` (disputes, platform matches, tournaments, deposit
flow, configuration) and `backend/.env.example`.
