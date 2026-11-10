# stoiximatakia

Backend for stoiximatakia.gr / skillbetting (NestJS + Fastify + PostgreSQL) in
`backend/`. The frontend lives in another repository; **never change frontend
behaviour or add UI without the owner's explicit agreement.** The `index.html`,
`css/`, `js/` at the repo root are an unused placeholder.

Read `backend/AGENTS.md` for the owner's standing instructions. Specs and plans are
in `docs/superpowers/`. The payments system is documented in `backend/docs/wallet.md`.

## Rules that must not be broken

- Real money runs **only against the sandbox provider**. Do not add a real provider
  or enable anything in deployment without the owner's decision.
- Euro money is integer cents (`bigint`). Every balance change is a balanced
  `postWallet(...)` call (`backend/src/wallet/wallet-ledger.ts`); never update a
  balance directly. Demo credits (`credit_*` tables) and euros never mix.
- One business action = one database transaction. Admin actions write
  `audit(...)` in the same transaction (`backend/src/wallet/admin.ts`).
- Applied migrations (`backend/migrations/001`–latest on `main`) are immutable:
  the migrator checks their sha256. Add a new numbered file instead, and bump
  `REQUIRED_SCHEMA_MIGRATION` in `backend/src/health/health-readiness.ts`.
- The production migrator runs all pending migrations in **one transaction**. A
  migration that alters `wallet_accounts` must start with
  `SET CONSTRAINTS wallet_account_reconciled IMMEDIATE; SET CONSTRAINTS wallet_account_reconciled DEFERRED;`
  (see migration 012).
- Commit in small focused commits. Files use LF line endings.

## Setup (once per container)

```bash
cd backend && npm ci --ignore-scripts --engine-strict=false && npm run build:engines
```

```bash
su postgres -s /bin/bash -c "mkdir -p ~/pgtest && ([ -f ~/pgtest/data/PG_VERSION ] || /usr/lib/postgresql/16/bin/initdb -D ~/pgtest/data -A trust --encoding=UTF8 --no-locale >/dev/null); /usr/lib/postgresql/16/bin/pg_ctl -D ~/pgtest/data -l ~/pgtest/log -o \"-h 127.0.0.1 -p 55432 -k /var/lib/postgresql/pgtest\" -w start"; psql -h 127.0.0.1 -p 55432 -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='skillbetting_test'" | grep -q 1 || psql -h 127.0.0.1 -p 55432 -U postgres -c "CREATE DATABASE skillbetting_test"
```

Postgres stops when the container sleeps; rerun the second command if tests fail
with `ECONNREFUSED 127.0.0.1:55432`.

## Commands (run in `backend/`)

```bash
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/skillbetting_test DATABASE_URL=postgres://postgres@127.0.0.1:55432/skillbetting_test
```

- Compile tests: `npx tsc -p tsconfig.test.json`
- One integration file: `node --test .test-dist/test/<name>.integration-spec.js`
- Unit + e2e: `node --test ".test-dist/src/**/*.spec.js" ".test-dist/test/**/*.e2e-spec.js"`
- All integration (≈3 min): `node --test --test-concurrency=2 ".test-dist/test/**/*.integration-spec.js"`
- Before finishing: `npx tsc --noEmit -p tsconfig.json && npx eslint src test --max-warnings=0 && npx prettier --check src test`
  (fix formatting with `npx prettier --write <files>`).

`chess-proof-storage.integration-spec` is heavy and can be cancelled by the runner
under load; rerun it alone before treating it as a failure.

## Code map (`backend/src`)

- `wallet/` euro ledger, deposits, withdrawals, providers (`payment-provider.ts`),
  admin roles/audit, corrections, disputes, reconciliation (`finance-controls.ts`),
  jurisdictions, background jobs.
- `tables/` multiplayer tables and match lifecycle; `table-ledger.ts` routes table
  money to the credit or euro ledger.
- `house/` games against platform bots; money in `wallet/house-matches.ts`.
- `tournaments/` tournament tickets, pools and payouts.
- `registration/` accounts and sessions.

Integration tests create an isolated PostgreSQL schema per file and apply all
migrations; new wallet tests use `backend/test/support/wallet-harness.ts`.
