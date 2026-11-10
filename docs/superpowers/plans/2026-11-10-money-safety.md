# Money Safety Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the euro wallet from paying a chargeback twice and from leaving player or company money locked forever.

**Architecture:** One migration (017) adds the schema. Each behaviour is a small change in the store that already owns the data (`wallet`, `house`, `tournaments`), tested through a new shared integration harness. A new `maintenance` module orchestrates the three time-based clean-ups under an advisory lock.

**Tech Stack:** NestJS 12 + Fastify, PostgreSQL 16 (`pg`), `node:test`, TypeScript strict (`exactOptionalPropertyTypes`).

**Spec:** `docs/superpowers/specs/2026-11-10-money-safety-design.md`. Read it and `CLAUDE.md` (setup and commands) before any task.

## Global Constraints

- Sandbox provider only; no frontend change; new response fields are additive.
- Money is integer euro cents. Every balance change is one balanced `postWallet(...)`; never `UPDATE` a balance.
- One behaviour = one database transaction. Admin actions call `audit(...)` in that transaction.
- Migrations 001–016 are immutable. All schema changes go in `backend/migrations/017_money_safety.sql`.
- The withdrawal rule (€100 or 80% per request) is **not** changed.
- All paths below are relative to `backend/`. Run commands in `backend/` with the environment from `CLAUDE.md`.
- Each task ends green on: `npx tsc --noEmit -p tsconfig.json && npx eslint src test --max-warnings=0 && npx prettier --check src test`.
- One deviation from the spec: the maintenance service lives in its own `src/maintenance/` module (not in `wallet/`), because it needs the house and tournament stores, which already depend on the wallet module.

## Review Focus

1. Several `requested` withdrawals whose total exceeds the lost dispute: all are cancelled, only the dispute amount is recovered, the rest stays available (Task 2).
2. Recovery replayed with the same `operationId` but a different amount must be `operation_conflict`, not a second debit (Task 3).
3. A tournament reaching its start time with zero tickets is cancelled without a ledger posting or error (Task 5).
4. Two maintenance runs at the same moment: the second does nothing and nothing is settled twice (Task 7).
5. One item failing inside maintenance (e.g. a match settled between selection and lock) must not stop the remaining items (Tasks 4 and 7).

---

### Task 1: Migration 017 and the shared test harness

**Files:**
- Create: `migrations/017_money_safety.sql`
- Create: `test/support/wallet-harness.ts`
- Create: `test/money-safety.integration-spec.ts`
- Modify: `src/health/health-readiness.ts` (`REQUIRED_SCHEMA_MIGRATION = '017_money_safety.sql'`)
- Modify: `src/wallet/wallet-ledger.ts` (add `'chargeback_recovery'` to `LedgerKind`)

**Interfaces:**
- Produces (used by every later task), exported from `test/support/wallet-harness.ts`:

```ts
export interface Player { id: string; cookie: string; email: string }
export interface Harness {
  app: NestFastifyApplication;
  pool: Pool;                       // connected to the isolated schema
  wallet: WalletStore;
  rootToken: string;
  close(): Promise<void>;           // close app, drop schema
  player(o?: { verified?: boolean; phone?: string }): Promise<Player>;
  /** Verified player with a succeeded sandbox card deposit. */
  funded(amountMinor?: number): Promise<Player & { depositId: string }>;
  post(p: Player, path: string, payload: unknown): Promise<LightMyRequestResponse>;
  get(p: Player, path: string): Promise<LightMyRequestResponse>;
  /** Root admin. `path` is absolute if it starts with '/', else under /wallet/v1/admin/. */
  admin(method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown): Promise<LightMyRequestResponse>;
  /** Signed sandbox webhook; providerReference defaults to `sbx_dep_<paymentId>`. */
  webhook(type: string, paymentId: string, amountMinor: number, providerReference?: string): Promise<LightMyRequestResponse>;
  account(key: string): Promise<number>;      // balance_minor of a wallet account, 0 if absent
  /** Asserts sum(ledger_entries)=0 and every account equals its history. */
  assertLedgerSound(): Promise<void>;
}
export function createHarness(
  prefix: string,
  options?: { registry?: GameRuntimeRegistry; settings?: Partial<WalletSettings> },
): Promise<Harness>;
```

Copy the setup from `test/payment-methods.integration-spec.ts` (schema per file, migrations applied one transaction each, the provider overrides, `rawBody: true`). Default wallet settings: those in that file, including `rfIban`, with `withdrawalsPerDay: 10`; `options.settings` is spread over them. Default `funded` amount: 2000.

- [ ] **Step 1: Write the failing test** in `test/money-safety.integration-spec.ts`:

```ts
void describe('money safety', () => {
  let h: Harness;
  before(async () => { h = await createHarness('safety'); });
  after(() => h?.close());

  void it('provides the schema of migration 017', async () => {
    const p = await h.funded(2000);
    assert.equal(await h.account('available:' + p.id), 2000);
    await h.assertLedgerSound();
    const columns = await h.pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='deposit_disputes' AND column_name='shortfall_recovered_minor'",
    );
    assert.equal(columns.rowCount, 1);
    // 'expired' is accepted and may still become 'succeeded'; 'failed' stays final.
    const d = await h.post(p, '/wallet/v1/deposits', { operationId: randomUUID(), amountMinor: 1000 });
    const id = d.json<{ deposit: { id: string } }>().deposit.id;
    await h.pool.query("UPDATE deposits SET status='expired' WHERE id=$1", [id]);
    await assert.rejects(h.pool.query("UPDATE deposits SET status='pending' WHERE id=$1", [id]));
    await assert.rejects(
      h.pool.query("INSERT INTO house_game_events(match_id,revision,kind,actor) VALUES($1,2,'bogus','x')", [randomUUID()]),
    );
  });
});
```

- [ ] **Step 2: Run it and see it fail** (`node --test .test-dist/test/money-safety.integration-spec.js` after compiling): fails because the harness and migration do not exist.

- [ ] **Step 3: Write `migrations/017_money_safety.sql`:**
  - `ALTER TABLE deposit_disputes ADD COLUMN shortfall_recovered_minor bigint NOT NULL DEFAULT 0` with `CHECK (shortfall_recovered_minor >= 0 AND shortfall_recovered_minor <= coalesce(shortfall_minor,0))`.
  - `CREATE OR REPLACE FUNCTION deposit_dispute_guard()`: keep the identity and delete checks of migration 015; allow an update when `OLD.status = 'open'`, **or** when `OLD.status = 'lost'` and every column except `shortfall_recovered_minor` is unchanged and the new value is greater than the old; raise otherwise.
  - `ledger_transactions_kind_check`: drop and recreate with the full list from migration 015 plus `'chargeback_recovery'`.
  - `house_game_events`: drop and recreate its `kind` check as `('start','action','forfeit','timeout')` and its `(kind = 'action') = (action IS NOT NULL)` check unchanged.
  - `deposits`: drop and recreate the `status` check with `'expired'` added.
  - `CREATE OR REPLACE FUNCTION wallet_guard_payment_status()`: same as migration 010 except the deposits branch allows `pending → succeeded|failed|expired`, `expired → succeeded`, and raises for anything else (including a non-status update of a final deposit).
  - Constraint names: find them with `\d <table>` in psql after applying 001–016; PostgreSQL named the inline checks `<table>_<column>_check`.

- [ ] **Step 4: Write the harness, bump readiness, add the ledger kind.**

- [ ] **Step 5: Verify.** The new test passes; `node --test .test-dist/test/credit-migration.integration-spec.js .test-dist/test/production-readiness.integration-spec.js` passes (these run the real migrator in one transaction).

- [ ] **Step 6: Commit** — `Add migration 017 and a shared wallet test harness`.

---

### Task 2: A lost chargeback cancels requested withdrawals first

**Files:**
- Create: `src/wallet/withdrawal-release.ts`
- Modify: `src/wallet/wallet.store.ts` (`release` delegates to the new function)
- Modify: `src/wallet/finance-controls.ts` (`resolveDispute`)
- Test: `test/money-safety.integration-spec.ts`

**Interfaces:**
- Produces, in `src/wallet/withdrawal-release.ts`:

```ts
/** Posts withdrawal_release (pending → available) and finalises the request. */
export async function releaseWithdrawalHold(
  c: PoolClient,
  input: {
    id: string; userId: string; amountMinor: number;
    status: 'cancelled' | 'rejected' | 'failed';
    actorId?: string | undefined;                       // ledger actor (a user id)
    review?: { reviewer: string; note?: string | undefined } | undefined;
  },
): Promise<void>;
```

It contains exactly what `WalletStore.release` does today (same `operationKey` `withdrawal_release:<id>`, same `UPDATE`); `WalletStore.release` then calls it and re-selects the row it returns.

- [ ] **Step 1: Write the failing tests:**

```ts
void it('a lost chargeback cancels requested withdrawals before recovering', async () => {
  const p = await h.funded(2000);
  const w = await h.post(p, '/wallet/v1/withdrawals', { operationId: randomUUID(), amountMinor: 1500 });
  assert.equal(w.statusCode, 201, w.body);
  const withdrawalId = w.json<{ withdrawal: { id: string } }>().withdrawal.id;
  await h.webhook('deposit.disputed', p.depositId, 2000);
  await h.webhook('dispute.lost', p.depositId, 2000);
  const row = await h.pool.query('SELECT status,review_note FROM withdrawal_requests WHERE id=$1', [withdrawalId]);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.match(row.rows[0].review_note, /^Cancelled: chargeback /);
  const dispute = await h.pool.query(
    'SELECT recovered_minor::int AS r, shortfall_minor::int AS s FROM deposit_disputes WHERE deposit_id=$1', [p.depositId]);
  assert.deepEqual(dispute.rows[0], { r: 2000, s: 0 });
  assert.equal(await h.account('available:' + p.id), 0);
  assert.equal(await h.account('withdrawal_pending:' + p.id), 0);
  const approve = await h.admin('POST', `withdrawals/${withdrawalId}/approve`, {});
  assert.equal(approve.statusCode, 409);
  await h.assertLedgerSound();
});

void it('leaves processing withdrawals alone and keeps money beyond the dispute', async () => {
  // Review focus 1. Two deposits of 2000; dispute only the first.
  const p = await h.funded(2000);
  // second deposit for the same player: POST /wallet/v1/deposits + h.webhook('deposit.succeeded', id, 2000)
  // withdrawals: A=1500 (approved → processing), B=1000 and C=1000 (requested)
  // lose the dispute on p.depositId (2000)
  // expect: A still 'processing' with 1500 in withdrawal_pending; B and C 'cancelled';
  //         recovered 2000, shortfall 0; available = 4000-1500-2000 = 500
});
```

Write the second test fully from its comments; assert each expected value listed.

- [ ] **Step 2: Run and see both fail** (first: status is `requested`, shortfall 1500).
- [ ] **Step 3: Implement.** Extract `releaseWithdrawalHold`. In `resolveDispute`, when `outcome === 'lost'` and before locking the available balance: select the user's `requested` withdrawals `ORDER BY created_at,id FOR UPDATE` and release each with status `cancelled`, `review: { reviewer: resolvedBy, note: 'Cancelled: chargeback ' + d.id }`.
- [ ] **Step 4: Run** the file and `finance-controls.integration-spec.js`; both pass.
- [ ] **Step 5: Commit** — `Cancel requested withdrawals when a chargeback is lost`.

---

### Task 3: Chargeback debt blocks withdrawals until finance collects it

**Files:**
- Modify: `src/wallet/finance-controls.ts` (new `playerDebt`, `recoverShortfall`; `disputeView` adds `shortfallRecoveredMinor`)
- Modify: `src/wallet/wallet.store.ts` (`requestWithdrawal`, `approveWithdrawal`, `balanceOf`, `summary`, new `recoverShortfall` method)
- Modify: `src/wallet/wallet.controller.ts`, `src/wallet/wallet.dto.ts` (`RecoverDto { operationId: uuid; amountMinor: int 1..100_000_000 }`)
- Test: `test/money-safety.integration-spec.ts`; update exact-balance assertions in `test/wallet.integration-spec.ts` (`debtMinor: 0`)

**Interfaces:**
- Produces in `finance-controls.ts`:

```ts
/** Sum of (shortfall_minor - shortfall_recovered_minor) over the user's lost disputes. */
export async function playerDebt(c: PoolClient, userId: string): Promise<number>;
export async function recoverShortfall(
  c: PoolClient, actor: AdminActor,
  input: { disputeId: string; operationId: string; amountMinor: number },
): Promise<{ dispute: ReturnType<typeof disputeView> }>;
```

- Endpoint: `POST /wallet/v1/admin/disputes/:disputeId/recover` (finance, HTTP 200), audit action `dispute.recover` with `{ amountMinor }`.
- Ledger: kind `chargeback_recovery`, `operationKey` `chargeback_recovery:<operationId>`, `referenceId` the dispute id, entries `available:<user>` −amount, `external:company` +amount.
- Idempotency: if a ledger transaction with that `operationKey` exists, return the dispute unchanged when its `reference_id` is this dispute and its `external:company` entry equals `amountMinor`; otherwise `operation_conflict` (409).
- Errors: `dispute_not_found` (404); `invalid_amount` (400) if the dispute is not `lost` or the amount exceeds the remaining shortfall; `insufficient_funds` (409) if available < amount.
- `GET /wallet/v1/balance` adds `debtMinor`; `withdrawableMinor` is `0` when `debtMinor > 0`.
- Summary `chargebackShortfallMinor` = sum of `shortfall_minor - shortfall_recovered_minor` over lost disputes.

- [ ] **Step 1: Write the failing test** `debt blocks withdrawals until finance recovers it`:
  1. `p = await h.funded(2000)`; withdraw 1500; approve; `h.webhook('payout.succeeded', withdrawalId, 1500, 'sbx_pay_' + withdrawalId)`. Available is 500.
  2. Open and lose the dispute through the provider webhooks. Expect dispute `recovered 500, shortfall 1500`; balance `debtMinor: 1500`, `withdrawableMinor: 0`.
  3. Second card deposit of 3000 succeeds (deposits still allowed). `POST /wallet/v1/withdrawals` 1000 → 403 `account_restricted`.
  4. As root: recover 5000 → 400 `invalid_amount`; recover 1000 with `operationId` X → 200, `shortfallRecoveredMinor: 1000`; same request again → same body, available unchanged at 2000; same X with amount 500 → 409 `operation_conflict` (Review focus 2).
  5. Recover the remaining 500 with a new id → balance `debtMinor: 0`, available 1500; withdrawal of 1000 → 201.
  6. `h.assertLedgerSound()`; summary `chargebackShortfallMinor` is 0 for this player's dispute (compare before/after rather than absolute).
  Also assert a player with `available < amount` gets `insufficient_funds`, and the audit log (`GET audit?limit=20`) contains `dispute.recover`.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement** the interfaces above. `approveWithdrawal` gets the same debt check as `requestWithdrawal` (both throw `account_restricted`, 403).
- [ ] **Step 4: Run** `money-safety`, `wallet`, `finance-controls`, `payment-methods` integration files; all pass.
- [ ] **Step 5: Commit** — `Block withdrawals while a chargeback debt is outstanding`.

---

### Task 4: Abandoned platform matches time out as a loss

**Files:**
- Modify: `src/wallet/wallet-settings.ts` (`houseMatchTimeoutMinutes?: number`; env `HOUSE_MATCH_TIMEOUT_MINUTES`, default 30, range 1–1440)
- Modify: `src/wallet/wallet.module.ts` (export `WALLET_SETTINGS`)
- Modify: `src/house/house.module.ts` (import `WalletModule`; export `HouseGameStore`)
- Modify: `src/house/house-game.store.ts`
- Test: `test/money-safety.integration-spec.ts`; add a `wallet-settings.spec.ts` case for the new setting

**Interfaces:**
- Produces on `HouseGameStore`:

```ts
/** Closes active matches idle longer than `minutes` as losses; returns how many. */
timeOutAbandoned(minutes?: number): Promise<number>;   // default: settings.houseMatchTimeoutMinutes ?? 30
```

- `HouseGameView.match` is unchanged; `HouseGameView.game` adds `expiresAt: string | null` (`updated_at` + timeout while the match is `active`, else `null`). `view` therefore needs `updated_at`; pass it from every caller (after a write use the row's new `updated_at` via `RETURNING updated_at`).
- Each match is closed in its own transaction: lock `house_games` row `FOR UPDATE`, re-check that the match is still `active` and still idle, insert `house_game_events(match_id, revision+1, 'timeout', 'system')`, `UPDATE house_games SET revision=…, updated_at=now()`, then `settleHouseMatch(c, id, 'lost')`. An error on one match is caught and that match skipped (Review focus 5).

- [ ] **Step 1: Write the failing test** in a second `describe` block that builds its own harness with a registry containing `new XeriGameRuntime()` and seeds the reserve (`h.admin('POST','house/capital',{operationId, direction:'in', amountMinor:10_000})`):
  1. `p = await h.funded(2000)`; start a match via `POST /house/v1/matches {operationId, gameId:'xeri', offerId:'stake-5-prize-8'}`; response `game.expiresAt` is within 30 min ± 5 s of now.
  2. `store.timeOutAbandoned(30)` → 0; match still `active`.
  3. `store.timeOutAbandoned(0)` → 1; match `lost`; `house_match:<id>` balance 0; available 1500; the last `house_game_events` row has kind `timeout`; `GET /house/v1/matches/:id` shows `expiresAt: null`.
  4. `store.timeOutAbandoned(0)` again → 0. A player action on the match → 409 `match_ended`.
  5. `h.assertLedgerSound()`.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `money-safety`, `house-games`, `house-matches` integration files and the unit tests; all pass.
- [ ] **Step 5: Commit** — `Time out abandoned platform matches as losses`.

---

### Task 5: Tournaments start or cancel at their start time

**Files:**
- Modify: `src/tournaments/tournament.store.ts`
- Test: `test/money-safety.integration-spec.ts`

**Interfaces:**
- Produces on `TournamentStore`:

```ts
/** For each open tournament with starts_at <= now(): start if min_players reached, else cancel. */
runDue(actor: AdminActor): Promise<{ started: number; cancelled: number }>;
```

It selects the due ids, then calls the existing `start(id, actor)` / `cancel(id, actor)` per tournament; a `WalletError` from one tournament is caught and skipped. The audit details of `tournament.start` and `tournament.cancel` gain `automatic: actor.name === 'system'`.

- [ ] **Step 1: Write the failing test.** Create three tournaments through the admin endpoint (`minPlayers: 2`, fee 90, contribution 500, shares `[10000]`): T1 with two funded buyers, T2 with one buyer, T3 with none (Review focus 3), plus T4 with two buyers left in the future. Backdate T1–T3: `UPDATE tournaments SET starts_at=now()-interval '1 minute' WHERE id=ANY($1)`. Then:
  - `runDue({ name: 'system', role: 'admin' })` → `{ started: 1, cancelled: 2 }`.
  - T1 `running`, `tournament_fees:<T1>` 0 and house revenue +180; T2 `cancelled`, its buyer back at 2000 with ticket `refunded`; T3 `cancelled`; T4 still `open`.
  - A second `runDue` → `{ started: 0, cancelled: 0 }`.
  - Audit log has `tournament.start` and `tournament.cancel` by actor `system` with `details.automatic === true`.
  - `h.assertLedgerSound()`.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `money-safety` and `tournaments` integration files; both pass.
- [ ] **Step 5: Commit** — `Start or cancel tournaments automatically at their start time`.

---

### Task 6: Pending deposits expire

**Files:**
- Modify: `src/wallet/wallet-settings.ts` (`cardDepositExpiryHours?: number` env `WALLET_CARD_DEPOSIT_EXPIRY_HOURS` default 24, 1–720; `rfDepositExpiryDays?: number` env `WALLET_RF_DEPOSIT_EXPIRY_DAYS` default 10, 1–90)
- Modify: `src/wallet/wallet.store.ts` (`DepositRow.status` adds `'expired'`; `applyDepositEvent`; `importBankReceipts`; new `expireDeposits`)
- Test: `test/money-safety.integration-spec.ts`; `wallet-settings.spec.ts`

**Interfaces:**
- Produces on `WalletStore`:

```ts
/** Marks pending deposits older than their provider's limit as expired; returns how many. */
expireDeposits(): Promise<number>;
```

A deposit uses the RF limit when its provider is registered with `manualPayouts`, else the card limit. One `UPDATE … WHERE status='pending' AND created_at < …` per limit.
- `applyDepositEvent`: an `expired` deposit is handled like `pending` **only** for `deposit.succeeded` with matching amount and currency; every other event on it returns `{ status: 'ignored', reason: 'final' }`.
- `importBankReceipts`: an `expired` deposit gives reason `deposit_expired` (checked before `deposit_final`).

- [ ] **Step 1: Write the failing test:**
  1. Card: start deposits D1 and D2 (1000 each) for one player; backdate D1 `created_at` by 25 hours and D2 by 23 hours with SQL. `expireDeposits()` → 1; D1 `expired`, D2 `pending`.
  2. `h.webhook('deposit.failed', D1, 1000)` → `{ status: 'ignored', reason: 'final' }`; `h.webhook('deposit.succeeded', D1, 999)` → ignored; `h.webhook('deposit.succeeded', D1, 1000)` → `processed`, D1 `succeeded`, available +1000; the same event id again → `duplicate`; a new success event → ignored `final`.
  3. RF: start an `rf_bank` deposit R (2500); backdate by 11 days; `expireDeposits()` → 1. Import a matching receipt → `{ status: 'unmatched', reason: 'deposit_expired' }`; available unchanged.
  4. `h.assertLedgerSound()`.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `money-safety`, `wallet`, `payment-methods` integration files and unit tests; all pass.
- [ ] **Step 5: Commit** — `Expire stale pending deposits`.

---

### Task 7: Maintenance job, admin trigger and documentation

**Files:**
- Create: `src/maintenance/maintenance.service.ts`, `src/maintenance/maintenance.controller.ts`, `src/maintenance/maintenance.module.ts`
- Modify: `src/app.module.ts` (import `MaintenanceModule`)
- Modify: `src/wallet/wallet.store.ts` (new `withAdvisoryLock`)
- Modify: `src/wallet/wallet-settings.ts` (`maintenanceIntervalSeconds?: number` env `WALLET_MAINTENANCE_INTERVAL_SECONDS` default 60, `0` disables, max 3600)
- Modify: `src/tournaments/tournament.module.ts` if `TournamentStore` is not exported (it is today)
- Modify: `docs/wallet.md`, `.env.example`
- Test: `test/money-safety.integration-spec.ts`

**Interfaces:**
- Consumes: `HouseGameStore.timeOutAbandoned()` (Task 4), `TournamentStore.runDue(actor)` (Task 5), `WalletStore.expireDeposits()` (Task 6), `WalletStore.authorizeAdmin(header, 'finance')`.
- Produces:

```ts
// wallet.store.ts — holds pg_try_advisory_xact_lock(key) on one connection while `run` executes; null if not acquired.
withAdvisoryLock<T>(key: number, run: () => Promise<T>): Promise<T | null>;

// maintenance.service.ts
export interface MaintenanceCounts {
  houseMatchesTimedOut: number; tournamentsStarted: number;
  tournamentsCancelled: number; depositsExpired: number;
}
@Injectable() export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  /** Null when another instance holds the lock (key 824613093). */
  run(): Promise<MaintenanceCounts | null>;
}
```

`run` executes the three steps in the order house matches, tournaments, deposits; each step is wrapped so that a thrown error counts as 0 for that step and the others still run. The timer follows `WalletJobs.every` (unref'd, errors swallowed) and is started only when the interval is non-zero and `WalletStore.hasProviders()`.
- Endpoint: `POST /wallet/v1/admin/maintenance` (finance role, HTTP 200) → `{ counts: MaintenanceCounts | null }`.

- [ ] **Step 1: Write the failing test** (in the `describe` that has the Xeri registry). The idle time of a platform match cannot be backdated in a test (the `house_games` guard forbids it), so the match timeout itself stays covered by Task 4; here one freshly started match must be left untouched. Set up: one active platform match, one due under-filled tournament and one stale card deposit as in Tasks 5–6. Then:
  - `POST maintenance` as root → `counts` equals `{ houseMatchesTimedOut: 0, tournamentsStarted: 0, tournamentsCancelled: 1, depositsExpired: 1 }`, and the match is still `active`.
  - Again → all zeros.
  - With a viewer token (create via `POST admins {name:'viewer-m', role:'viewer'}`) → 403.
  - Review focus 4: `Promise.all([service.run(), service.run()])` with a new due tournament → exactly one result is non-null and it reports `tournamentsCancelled: 1`; the tournament has a single `tournament.cancel` audit row.
  - Review focus 5: make the house step throw (`mock.method(houseStore, 'timeOutAbandoned', () => Promise.reject(new Error('x')))` from `node:test`) with a due tournament pending → the run still reports `tournamentsCancelled: 1` and `houseMatchesTimedOut: 0`.
- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update `docs/wallet.md`** (disputes: cancelled withdrawals, debt and recovery endpoint; platform matches: timeout and `expiresAt`; tournaments: automatic start/cancel; deposit flow: expiry and late payments; configuration: the five new variables; a short "Maintenance" section) **and `.env.example`**. Run `npx prettier --write docs/wallet.md`.
- [ ] **Step 5: Run everything:** type-check, lint, format check, unit + e2e, and the whole integration suite (`node --test --test-concurrency=2 ".test-dist/test/**/*.integration-spec.js"`). All pass.
- [ ] **Step 6: Commit** — `Run maintenance on a schedule and on demand; document money safety`.
