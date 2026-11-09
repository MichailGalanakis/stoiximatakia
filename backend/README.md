# SkillBetting backend

NestJS backend for the SkillBetting team PoC. PostgreSQL persists accounts, sessions, the credit ledger, funded tables, private game state, replay and initial settlement. Xeri, Diloti, Koum Kan, Thanasis, Biriba, Tichu and human-only chess PvP are integrated; computer play remains disabled. Chess uses strict.2/schema3 checked proof artifacts with exhaustive proof-before-acceptance; see the [chess contract](docs/platform-api.md#chess-participant-actions--approved-2-november-2026). The initial Match prototype stays internal and separate from the durable Platform runtime.

For an overview, start with the [system map](docs/system-map.md), [API and use-case catalog](docs/api.md), [Platform API](docs/platform-api.md) and [current checkpoint](docs/backend-progress.md).

The working frontend has its own repository, [skillbetting-frontend](https://github.com/Distillogic/skillbetting-frontend), checked out locally at `/Users/tsal/Projects/skillbetting-frontend`. Keep both repositories as siblings. Its [fidelity guide](https://github.com/Distillogic/skillbetting-frontend/blob/main/docs/frontend-fidelity.md) defines the design targets; the immutable local `reference/` is ignored. Production runtime assets are tracked and builds do not need the reference capture.

The development deployment target is `https://dev.stoiximatakia.gr`. Start with the [server-agent handoff](deploy/SERVER-AGENT.md) and [deployment runbook](deploy/README.md), including [deployment from Git](deploy/README.md#deploy-from-git). The server stack runs the applications, PostgreSQL, HTTPS and backups in Docker; native local development stays unchanged. Pull both repositories before rebuilding and preserve existing server data/settings.

## Run locally

Use a supported Node.js release (Node 24 is selected in `.nvmrc`) and npm 11. The toolchain also supports Node 22.13+; the first increment was verified on Node 22.21.1 with npm 11.19.1.

```sh
nvm use
npm ci
cp .env.example .env
npm run start:dev
```

Or compile and run without the watcher:

```sh
npm run build
npm start
curl http://127.0.0.1:3000/health
```

The response is `{"status":"ok"}` with an `x-request-id` header. This checks process liveness; `/health/ready` separately checks the database and migration head. Stop with Ctrl+C; Nest shutdown hooks close the HTTP server.

Environment variables already set in the process take precedence over `.env`. Basic listener settings are:

| Variable    | Default     | Meaning                                                                  |
| ----------- | ----------- | ------------------------------------------------------------------------ |
| `HOST`      | `127.0.0.1` | Listening hostname/IP; use `0.0.0.0` when required by container hosting. |
| `PORT`      | `3000`      | Integer from 1 through 65535.                                            |
| `LOG_LEVEL` | `info`      | `debug`, `info`, `warn`, or `error`.                                     |

Invalid configuration prevents startup. Account/database/provider settings and stable private keys are documented in `.env.example` and the deployment runbook. Keep `TRUST_PROXY_HOPS=0` locally; the private container backend uses one controlled edge hop. `.env` is ignored by Git; keep credentials out of tracked files.

## Checks

```sh
npm run check
```

This runs strict type checking, ESLint, Prettier verification, all tests, and the production build. Individual commands:

| Command                | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `npm run typecheck`    | Check application and test TypeScript.                                   |
| `npm run lint`         | Lint with type-aware rules and no warnings.                              |
| `npm run format`       | Format source and documentation.                                         |
| `npm run format:check` | Verify formatting.                                                       |
| `npm run test:unit`    | Domain, application, and environment tests.                              |
| `npm run test:e2e`     | Exercise actual Nest/Fastify request handling through Fastify injection. |
| `npm test`             | All tests, with no external services.                                    |
| `npm run build`        | Emit application JavaScript to `dist/`, excluding tests.                 |

Tests compile to `.test-dist/` and run with Node's built-in test runner. Domain tests construct ordinary `Match` instances without Nest. Application tests also verify Nest dependency injection and concurrent repository saves. HTTP tests share the production adapter and configuration; fixture write routes exist only inside the test file. The application never imports `test/`.

## Implementation map

- `src/main.ts`, `src/bootstrap.ts`: startup, Fastify adapter, validation, logging, request IDs, and shutdown.
- `src/health/`: HTTP liveness and database/migration readiness.
- `src/credits/`, `src/tables/`: durable credits, multiplayer lifecycle, private card-game adapters and authenticated HTTP/websocket contracts.
- `src/matches/domain/`: framework-independent `Match` class and its rules.
- `src/matches/application/`: result-recording service and repository boundary.
- `test/support/`: isolated, version-checked in-memory repository for tests.
- `test/http.e2e-spec.ts`: HTTP behavior and a test-only controller demonstrating the Match use case.

NestJS 12 and Fastify 5 are pinned with the rest of the dependencies in `package-lock.json`. Fastify supplies request injection for HTTP tests and uses one consistent adapter throughout. TypeScript 6 is compatible with the selected linter. See the [Nest migration guide](https://docs.nestjs.com/migration-guide) for runtime compatibility and the [Node test runner documentation](https://nodejs.org/download/release/v22.17.0/docs/api/test.html) for the native test runner.

Read [the architectural decisions and next increment](docs/architecture.md) for the boundaries, limitations, and decisions that still need owner input.

## Registration development

Use Node 24 and a PostgreSQL installation with `initdb`, `pg_ctl`, `psql`, and `createdb` on PATH:

```sh
npm run db:local:start
npm run db:migrate
npm run build
npm start
```

The local helper creates an ignored `.local/` cluster, private Unix socket on port 55432, and separate development/test databases. It does not use or modify a system PostgreSQL cluster. Generated connection settings are loaded from `.local/database.env`; `.env` overrides them. The backend serves port 3000; set `APP_ORIGIN` to the exact frontend origin (default `http://127.0.0.1:3100`).

```sh
npm run check
npm run test:integration
npm run db:local:stop
```

For server deployment, follow the [container runbook](deploy/README.md); it applies pending immutable migrations 001–009. See [registration](docs/registration.md) for the API, storage, verification boundary, and test details. Password sign-in is connected; email/SMS delivery requires backend provider settings. Google and identity/KYC remain pending. See [contact verification](docs/contact-verification.md).

Automatic signup sign-in and temporary one-click Demo accounts are now implemented. Read [account sessions](docs/account-sessions.md) for endpoints, session expiry, non-deliverable generated contacts, and the distinction between sign-in and feature permissions. Apply `npm run db:migrate` before using the updated app.
