# Server-agent handoff — dev.stoiximatakia.gr

Deploy the supplied working PoC to **https://dev.stoiximatakia.gr**. The owner authorized deployment and selected this server-agent handoff because this machine's available SSH key was rejected. The known terminal alias is `distillogic_server` → `kostas@167.233.218.132`; the domain's A record matched that address during preparation. Recheck DNS, host identity and existing services before changes.

All seven games have working human PvP: Xeri, Diloti, Koum Kan, Thanasis, Biriba, Tichu and chess. Chess is explicitly approved and enabled only through strict.2/schema 3 proof artifacts; computer play stays disabled. Production refuses funding for any unregistered engine. Do not replace chess with its default/analysis adapter, relax its exhaustive proof requirement, add payment providers or redesign the supplied frontend. This is the team PoC with the existing credit model, not an activation of cash payments.

Owner-authorized update, 2 November 2026: new registered accounts now persist email as verified during signup while Resend domain verification is pending. This backend-only override needs an application rebuild/release, with no migration or new setting. Phone verification remains active; existing accounts and Demo placeholders keep their stored flags. The bypass has no automatic expiry and must be removed explicitly when email verification is restored. Do not infer actual inbox ownership or add any other verification bypass. See [registration](../docs/registration.md).

Current release checks pass: 535 frontend, 109 backend unit/HTTP, 606 chess + 455 card engines, 176 isolated PostgreSQL / 13 suites and a separate 19-case strict artifact multiplayer run. Fresh Linux arm64 containers pass actual chess proof creation, application-role proof immutability, full backup/restore, cold mathematical rechecking of all saved artifacts, resumed checkmate and exact settlement retries. See [chess container evidence](../docs/verification/deployment-2026-11-02/chess-container-checks.json). Public DNS/TLS/server acceptance is still yours; this chat could publish through GitHub but the latest direct SSH probe was rejected.

## Inputs and host boundary

Use both repositories' updated `main` branches, keeping `skillbetting-backend` and `skillbetting-frontend` as siblings. Pull both with `--ff-only` and record both commit IDs; see [deploy from Git](README.md#deploy-from-git). The frontend's 68 pinned runtime public files are tracked, so its production build does not need `reference/stoiximatakia/capture-manifest.json` or any other reference capture. There are nine backend migrations, with only pending migrations applied. Migration 009 adds chess proof storage/audit/event references and is required by readiness. Never rewrite applied 006/007/008 or regenerate existing secrets. The older frontend commit `1e443543` predates these deployment inputs.

The source archive plus SHA256 sidecar is an alternative transport. It contains both applications and `release-manifest.json`, including dirty-state metadata if made from an uncommitted snapshot. No settings, account data, local test helpers, reference capture or prebuilt local outputs are included. Do not copy a developer database or `.local` directory to the server.

The host needs Docker Engine, Docker Compose and ordinary shell/SSH tools. All application processes, PostgreSQL, migrations, HTTPS and scheduled backups run inside containers. Do not install host Node/npm/PostgreSQL/PM2/nginx for this stack. Keep native development unchanged.

Inspect existing containers, persistent volumes, disk/RAM and ports 80/443 first. Never replace another application/proxy or delete an existing database volume blindly. If those ports are already owned, reconcile the existing deployment topology before starting this stack. The [full runbook](README.md) covers network, TLS, update, rollback and restore constraints.

## First release

Use the updated sibling Git checkouts, or verify and extract the alternative archive into a new directory, for example `/opt/skillbetting/releases/RELEASE_ID/`. If upgrading the older live backend, back up and preserve its database and stable settings before changing services; a host-database transfer requires validation before cutover. Create `/opt/skillbetting/shared/` privately for persistent settings. From the backend directory:

```sh
export SKILLBETTING_ENV_FILE=/opt/skillbetting/shared/production.env
./deploy/manage.sh init dev.stoiximatakia.gr
./deploy/manage.sh check
./deploy/smoke.sh
./deploy/manage.sh up
```

Create the shared directory before `init`. If its settings already exist, **skip init and preserve them**. The initializer refuses overwrites and generates secrets inside a pinned Node container without printing values. Provider delivery defaults to disabled. The smoke test uses only an isolated disposable Docker project and reserved test hostname; it must not be repointed at the public app. The stack publishes only HTTP/HTTPS at the edge, with PostgreSQL and both application services private.

## Accept the deployment

- Confirm valid public HTTPS and the expected page at `https://dev.stoiximatakia.gr`.
- Confirm `/health` and `/api/health/ready` return 200; the latter must report database/migration readiness.
- Confirm `/preview/full-ui`, `/api/qa/player`, `/reference/` and settings/Git paths are unavailable.
- Confirm all seven human PvP games and disabled computer mode. Check chess with two players, fixed White/Black seats, reload/resume and a final result; confirm schema 3 / strict.2 on its game response. Use independent browser sessions for account restoration and a private table check; public health alone is insufficient.
- Confirm all running services are healthy and the first database backup exists. Arrange an encrypted off-server copy; the built-in backup volume alone does not protect against host loss.

Keep the settings, named volumes, prior release source/config and application image tags. Do not use `docker compose down -v`. Application updates use `manage.sh release NEW_TAG`; rollback and database restoration are distinct, documented operations. Restore reconstruction validates before cutover and retains the previous database. A failed deployment must be reported with its actual state, without deleting history or inventing refunds.

Remaining non-blocking PoC work is documented in the repository checkpoint: physical touch/Safari and broader human/visual QA, browser websocket-client migration, animations/chat/computer play, external payments and authorized paid-result correction workflows. Chess has completed its strict proof-backed release acceptance; its native claim-control execution, independent-human/physical-device/Safari checks and pixel parity retain the limits in the current checkpoint. These remaining checks are not silently advertised as completed.
