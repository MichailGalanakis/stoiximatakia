# SkillBetting server deployment

The native development workflow stays unchanged: backend `npm run db:local:start` and `npm run start:dev`, frontend `npm run dev`. Docker is optional on a developer machine. The server runs PostgreSQL, migrations, NestJS, Next.js, HTTPS and daily backups in containers; no host Node/npm/PostgreSQL/PM2/nginx installation is needed.

This is the working PoC: Xeri, Diloti, Koum Kan, Thanasis, Biriba and Tichu PvP are enabled. Chess stays disabled under its engine release hold. Existing preview-only computer play, chat, cash-provider flows, adjudication and paid-result correction workflows are not activated by deployment. The supplied frontend design remains the target.

## Stack and durable state

`compose.yml` is the production definition. Only Caddy publishes host ports **80/tcp, 443/tcp and 443/udp**. `/api/*` goes straight to NestJS with the prefix stripped, including websocket upgrades. Caddy overwrites forwarded client IPs; NestJS trusts exactly that one hop. Every other request goes to Next.js. Preview/reference/QA/settings paths are denied. Secure host-only cookies use the exact HTTPS `APP_ORIGIN`.

PostgreSQL is on an internal network with no published port. The runtime application role has data access, without schema/role administration; the one-shot migration uses a separate admin connection. PostgreSQL health and successful checksummed migrations gate backend readiness; frontend/edge startup then wait for their dependencies. App processes run as non-root with read-only roots, dropped capabilities, bounded memory/logs and ephemeral cache/temp directories. Caddy owns its certificate volumes and retains only its port-binding capability. Graceful shutdown and restart policies are configured.

Named volumes retain database data, TLS state and backups independently of release folders. Keep the Compose project name stable (`skillbetting` by default). **Do not run `docker compose down -v` on this project**: that explicitly deletes its persistent volumes. The disposable smoke script uses a separate uniquely named project and deletes only its own test volumes.

Official multi-architecture images were resolved on 2 November 2026 and pinned by tag **and index digest**: Node 24.22.2 bookworm-slim, PostgreSQL 17.11 bookworm and Caddy 2.11.7 alpine. Lockfiles fix application packages. Upgrade pins deliberately, rerun checks/build/smoke, and retain prior application image tags. Application rollback does not reverse a database migration.

## Deploy from Git

Both repositories contain the release sources and must remain siblings named `skillbetting-backend` and `skillbetting-frontend`. Update both clean checkouts before building:

```sh
git -C /path/to/skillbetting-backend pull --ff-only origin main
git -C /path/to/skillbetting-frontend pull --ff-only origin main
```

Record both resulting commit IDs for the release. The frontend includes its 68 pinned public assets and runtime manifest; **do not copy or force-add the ignored `reference/` capture to deploy**. Use the Docker build rather than the developer-only `npm run check`, whose visual-reference verification intentionally needs that local capture. The current backend contains migrations 001–009; the migration gate verifies existing checksums and applies only pending files.

For an existing deployment, inspect its services, database, settings and ports and take a verified backup before changing the topology. Preserve existing data and stable secrets. If the old application uses a host database or different volumes, arrange a validated database transfer into the container stack before cutover; do not start a new empty database in its place or regenerate keys. Continue with the server preparation and first-deployment/update instructions below for the actual host state.

## Alternative: prepare a source archive on the development machine

Both repositories must be sibling directories. Their Docker builds use only production inputs and pinned public assets. The frontend designer `reference/` stays on disk locally but is absent from bundles/images. Local QA helpers, databases, `.env` values, source archives, Git metadata and old build outputs are excluded.

Run the normal backend/frontend checks, then:

```sh
node deploy/bundle.mjs /private/tmp/skillbetting-release.tar.gz
```

The archive contains `skillbetting-release/skillbetting-backend`, `skillbetting-release/skillbetting-frontend` and a source SHA256 manifest. The archiver suppresses macOS AppleDouble/resource-fork metadata so Linux extraction contains only declared source files. It records the exact working snapshot and whether repositories are dirty; it does not pretend uncommitted work is a committed release. The command prints the archive hash without settings/secrets. Copy the archive through the authorized SSH connection, verify its hash, and extract into a new release folder. No registry/Git credentials are required on the server to build the supplied snapshot. Alternatively, supply both repository checkouts with the same sibling layout.

## Server preparation

Use a supported Linux host with Docker Engine and the Compose plugin. Compose **2.24.4 or newer** is needed by the optional smoke override. Start with at least **4 GB RAM** if building Next.js on the server; inspect actual service/build usage before increasing traffic. Allow SSH administratively and HTTP/HTTPS publicly. Point the DNS A record, and any AAAA record, for `dev.stoiximatakia.gr` to the intended host. Ensure ports 80/443 are available; do not replace another service without inspecting it. Docker pulls and certificate issuance need outbound connectivity.

Suggested layout:

```text
/opt/skillbetting/
  shared/production.env          # private, stable across releases
  releases/<release-id>/
    skillbetting-backend/
    skillbetting-frontend/
  current -> releases/<release-id>
```

The host needs Docker and normal administrative shell/SSH tools. Use the [official Docker installation guide](https://docs.docker.com/engine/install/ubuntu/) for Ubuntu, or the matching official guide for its actual distribution. Do not assume the server is empty or install a second proxy/runtime blindly.

## First deployment

From the backend release folder, create the shared settings directory privately, export its absolute path and initialize once:

```sh
export SKILLBETTING_ENV_FILE=/opt/skillbetting/shared/production.env
./deploy/manage.sh init dev.stoiximatakia.gr
./deploy/manage.sh check
./deploy/manage.sh up
```

The initializer runs in a pinned Node container, writes owner-only settings and refuses to overwrite an existing file. It generates distinct database admin/application passwords and stable OTP/private-table keys; it never prints them. Persist and securely back up this file separately. Changing the env password of an existing database volume does not rotate its database roles, and changing table/OTP keys invalidates existing codes. Never regenerate keys during an update.

`up` builds only missing release images, validates Caddy, starts the private database, backs up an existing schema, applies immutable migrations, and recreates/waits for application/edge/backup services. It does not recreate PostgreSQL on an app update. It uses no synthetic QA login, seeded game state or temporary account fixture. Daily backups start once migrations finish. Email/SMS delivery stays disabled until real provider keys and verified sender settings are placed in the private env file. Existing non-deliverable placeholder protections remain enforced.

Verify the public HTTPS certificate and page, `https://dev.stoiximatakia.gr/health`, and `https://dev.stoiximatakia.gr/api/health/ready`. Confirm all seven human PvP launchers, disabled computer play, account restore, a private chess table between independent browser sessions, reload/resume and results before announcing the server ready. A passing internal healthcheck alone does not prove public DNS, TLS or browser behavior.

## Updates and rollback

Keep the private env file and named volumes. Extract the next source into a new sibling release pair. From the new backend release folder:

```sh
export SKILLBETTING_ENV_FILE=/opt/skillbetting/shared/production.env
./deploy/manage.sh release poc-20261102-r2
```

Use a new image tag. The command refuses an already existing tag, builds before replacement, takes a verified pre-migration backup, runs migrations and waits for readiness. Only after success does it persist the new tag in the private env file. Retain the old source/config and image tags. The PoC has one application replica; updates can briefly interrupt requests, and durable state/retries provide recovery. This is not a zero-downtime deployment claim.

For an application defect with a compatible schema, use the prior release's source/config folder and `./deploy/manage.sh rollback PREVIOUS_TAG`. This reuses existing application images and reloads that folder's edge/backup configuration, keeping database/schema/history intact. Review schema compatibility first. A failed migration remains transactionally rolled back; do not edit an applied migration or use credit refunds to conceal a rules defect.

Ordinary application release uses `--no-recreate` for PostgreSQL, even when a new release folder changes its init-script bind path. Database image upgrades are a separate maintenance operation: export and restore-check a current backup, stop app/edge/backup traffic, review/pin the new supported image and deliberately recreate only PostgreSQL before checking migrations/readiness and restarting apps. Do not reuse an old data volume across a PostgreSQL major-version upgrade; use a supported dump/restore or PostgreSQL upgrade procedure with a separate validated volume.

`status`, `logs [service]` and `stop` inspect or stop this stack. Logs are bounded. Do not print `docker compose config` or container environments into shared chats because resolved configuration contains secrets; `manage.sh check` validates through a private pipe and emits only its summary.

## Backups and recovery

The backup worker creates a compressed custom-format dump daily and on startup, verifies its archive structure, and keeps the most recent **14 successful dumps**. Retention happens only after a new dump succeeds. The database and backup volumes are separate, but both are on the same server: an encrypted off-server copy is still necessary for host-loss recovery. No off-server destination was supplied, so one is not silently invented or claimed configured.

```sh
./deploy/manage.sh backup
./deploy/manage.sh export-backup PRINTED_DUMP_NAME /private/path/skillbetting.dump
./deploy/manage.sh restore-check /private/path/skillbetting.dump
```

Exports are private and refuse an existing destination. Dumps contain account/session/game data; keep them outside web roots/releases and copy them encrypted to the intended off-server destination. `restore-check` restores the complete archive into a uniquely created temporary database, checks credit projections/journal balance plus the chess proof-storage structural audit when present, and drops only that temporary database. This SQL audit is not mathematical authority; the pinned worker independently checks saved proof bytes before gameplay resumes. Use trusted dumps only.

Actual database replacement is separate and requires the explicit `./deploy/manage.sh restore FILE --replace-current-database` flag. Select compatible application images first. The command automatically restore-checks the archive, takes a fresh current backup, stops public/app/backup traffic, reconstructs and reconciles another fresh database, then renames the old database aside and the validated one into place. The old database is retained with connections disabled for recovery; remove it only after the restored deployment is accepted. It restores application grants, reapplies pending immutable migrations and starts/waits for services. An archive/restore failure cannot delete the current database before validation; a cutover failure leaves traffic stopped and the prior database available for inspection. No refund or false successful-recovery result is invented.

## Disposable container verification

```sh
node --test deploy/verify.test.mjs
./deploy/smoke.sh
```

The six configuration/archive tests run without a daemon: secret generation/overwrite refusal, private networking/ports, migration ordering, credential/origin tampering and isolated smoke topology. Full smoke needs a running daemon. It builds both images, uses a unique empty PostgreSQL volume and generated settings, publishes no host ports and uses Caddy's internal CA at the reserved `skillbetting.test` hostname. The test client trusts that CA explicitly; TLS verification is not disabled.

Full smoke checks production route isolation, HTTPS/Secure cookies, private-code access, direct websocket proxying, card action/settlement retries and exact balances. It then starts strict.2 chess with three checked artifacts, verifies application-role proof immutability, backs up and physically restores the database, cold-rechecks every old artifact, resumes to checkmate and verifies exact settlement/retry. Only its hard-coded reserved Compose fixture may create the two synthetic resume sessions; no application QA endpoint is added. Only that disposable stack receives synthetic account/funded-game writes. Cleanup removes its own containers/volumes/image tags/settings. `KEEP_SMOKE=1` retains a failed fixture for inspection; remove only that printed project after use.

## Validation and deployment limits

Current seven-game verification also passes on **Linux arm64 Docker**: both release images, strict chess artifacts, actual-role immutability, full backup/restore, cold proof verification and resumed checkmate/settlement. [Current evidence](../docs/verification/deployment-2026-11-02/chess-container-checks.json) records the exact scope and exported image-config digests. It does not claim a runtime container metadata snapshot or remote deployment. The earlier six-game baseline follows.

Local **Linux/arm64 Docker** execution passes: both production images build; HTTPS with an explicitly trusted test CA, host-only Secure cookies, private hands/codes, direct websocket upgrade, disabled-game refusal without funding, legal action/settlement retries, backup/full restore and resumed application writes all pass. Additional actual probes confirm application DDL/migration-history writes fail with `42501`, a corrupt dump leaves current data unchanged, staged database renames commit atomically with the prior database retained, and a changed release bootstrap bind does not recreate PostgreSQL. The actual production Caddyfile validates. The five daemon-free configuration/tampering tests also pass. [Container evidence](../docs/verification/deployment-2026-11-02/container-checks.json) records image IDs and exact scope.

The user selected preparation for a server agent. No remote deployment, public ACME certificate, live-domain browser verification or different-architecture runtime is claimed. [SERVER-AGENT.md](SERVER-AGENT.md) is the operator handoff. The parent session owns final whole-repository checks and the durable source bundle/hash; the server agent must complete public DNS/TLS/application verification before announcing availability.

Primary references: [Compose dependency health/completion gates](https://docs.docker.com/compose/how-tos/startup-order/), [Compose service settings](https://docs.docker.com/reference/compose-file/services/), [Caddy prefix-stripping proxy](https://caddyserver.com/docs/caddyfile/directives/handle_path), [PostgreSQL archive restore](https://www.postgresql.org/docs/17/app-pgrestore.html), official [Node](https://hub.docker.com/_/node), [PostgreSQL](https://hub.docker.com/_/postgres) and [Caddy](https://hub.docker.com/_/caddy) images.
