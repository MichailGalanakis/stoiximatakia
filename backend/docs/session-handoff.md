# SkillBetting browser review handoff

## Current chess/server release handoff — 2 November 2026

All seven human PvP games are enabled in the release. Chess uses only strict.2/schema 3 immutable proof artifacts; computer mode remains disabled. The owner kept exhaustive proof-before-acceptance and approved the complete frontend scope. Core path, storage/recovery and native acceptance are complete; fresh containers also pass full backup/restore, cold proof rechecking and resumed checkmate/settlement. The available direct SSH identity is still rejected. Publish/pull both updated `main` branches through the existing server-agent route; do not claim the live domain deployed from local checks.

Read the [current checkpoint](backend-progress.md), [release checkpoint](release-checkpoint.md), [server-agent instructions](../deploy/SERVER-AGENT.md), [runbook](../deploy/README.md) and [fresh chess container evidence](verification/deployment-2026-11-02/chess-container-checks.json). Final counts: 535 frontend, 109 backend unit/HTTP, 606 chess + 455 card engines, 176 PostgreSQL / 13 suites, separate19 strict artifact multiplayer cases and6 deployment contracts. Frontend build `aqYrOCHt0T_jC4cUjYRoc`; all187 runtime inputs equal the native-tested copy. Older reports keep their historical source scope.

Migration009 adds private proof work/chunks/check namespaces/manifests, match-event references and structural restore audit. Applied006/007/008 are unchanged. Preserve server data/settings/named volumes, back up before only pending migrations and verify public HTTPS/readiness plus a two-session chess result. Off-server encrypted backup configuration, physical devices/Safari, independent humans, native claim-control execution and pixel parity remain outside the local proof. No AI, clocks, pause/adjudication workflow or refund workaround was introduced.

### Retained current local chess review

The [native evidence](../../skillbetting-frontend/docs/verification/chess-strict-native-2026-11-02/README.md) retains the completed synthetic two-cookie-host journeys. Current owned frozen frontend/backend remain on3931/3932; the backend permits exactly the two QA loopback origins only in its ignored helper. Use `http://127.0.0.1:3931/api/qa/player` for White and `http://localhost:3931/api/qa/opponent` for Black. Both synthetic games are completed, all four tickets settled, both reservations zero; White247.20/Black249.20. These are private test credits, never deployment data.

Ignored `.local/qa-artifact-native.cjs`, `.local/artifact-native-state.json` and `.local/artifact-native-backend-path` bind the actual owned backend process/schema/copy; reinspect them before use. The corresponding frontend frozen copy is `/private/tmp/skillbetting-artifact-native-ss414iyr/frontend`. The owned private PostgreSQL cluster is located by `.local/chess-qa-pg-path`, socket under its directory, port55439, database `skillbetting_test`. Do not touch the original project development database or unrelated game fixtures. Native snapshots deliberately retain their own source manifests; the final API/engine/container checks cover later working-source refinements.

The obsolete inline strict.1 bootstrap-only fixture3930 and both owned old copies were removed. Full regression schemas and disposable Docker project51065/settings/volumes/test image tags were cleaned. Current artifact review is intentionally retained; when closing it, verify process cwd/metadata first, use its backend helper’s guarded SIGINT cleanup for only its schema, and stop/remove only this owned cluster once no current review uses it. Preserve permanent evidence, supplied source archives and ignored immutable designer references.

### Earlier local Tichu review

The [same Tichu evidence report](../../skillbetting-frontend/docs/verification/tichu-pvp-2026-11-02/README.md) retains its prior source-bound private-session/special-card/draw/Next/final checks and accounting audit. Its temporary local reviewer setup and balances are historical QA, never deployment data. Private local helper/env/process metadata remains ignored; do not copy it into releases or clean up unrelated services. Later release validation used separate disposable Docker projects and a temporary regression database only. Earlier sections below retain their own scope and do not supersede this current release handoff.

## Four approved corrections complete — 2 November 2026

Findings **1/4/5/6** from Claude's note are implemented and verified. Fishing/rummy overlays reset/restore the room scroll; last pre-start withdrawal cancels an empty waiting table atomically while occupied waiting tables remain; refresh failures clear on successful repair without erasing move errors/retries; expired platform sessions immediately show signed-out state and the existing sign-in dialog with visible feedback and same-table password return. Findings **2/3 are unchanged**. Browser setup additionally exposed missing two-player rummy reserve counts; the backend adapter now projects `[0,0]` for Koum Kan/Thanasis without changing engine state/rules or Biriba packets.

Validation: **490 frontend tests / 49 files, 69 backend unit/HTTP, 118 isolated database**, type checking/scoped lint/format/reference and isolated production build pass. Final frontend build **`t7wYBNE6A7eHy79YnVor5`**. Native mobile tests verify exact Xeri/Koum Kan/Thanasis rules scroll return, both-family passive outage recovery, real password sign-in returning to unchanged table/hands, visible expiry at 375×609, and empty-table refund/open-list/history/direct access. Normal legal API-assisted Xeri/Koum Kan results and desktop/tablet results pass. [Evidence and source/build limits](../../skillbetting-frontend/docs/verification/approved-fixes-2026-11-02/README.md). Move-error/retry preservation is covered by regression tests; physical touch/Safari/pixel parity are unverified. Parallel Tichu work is preserved, outside this native review. No migrations/engine versions, production accounts, commit/push/deployment changed. Owned disposable review processes/schema are cleaned up; older services remain.

Updated 2 November 2026. The successful native Thanasis close and two-player private-code verification are complete, following the newer-source four-game review. Both checks pass within the recorded scope; no runtime/UI change was needed. Preserve all uncommitted work. No commit, push or deployment occurred.

## Latest continuation — native close and private-code flow

Use the [current follow-up report](../../skillbetting-frontend/docs/verification/thanasis-private-close-2026-11-02/README.md), [source binding](../../skillbetting-frontend/docs/verification/thanasis-private-close-2026-11-02/source-manifest.json) and [checks](../../skillbetting-frontend/docs/verification/thanasis-private-close-2026-11-02/checks.json). Build **`9MMdOKvj0d2_SecWvhJAM`** has unchanged application inputs and passes its new production webpack/TypeScript build. Earlier full-suite counts retain their earlier run scope.

**Parallel Biriba work advanced the working repositories during this verification**, including shared rummy/catalog/selector files and backend registration. It was left untouched and remains outside this frozen build's proof. The source manifest records differences and newly observed files at close. Re-read current source/instructions before reviewing that increment; do not overwrite it with this older snapshot or apply these proofs to the later whole working tree.

Two independent in-app/Chrome sessions created a private Thanasis table, checked public-list exclusion/wrong-case rejection, used the correct code without payment/game authority, separately bought tickets and readied, received distinct private hands and restored them after reload. Normal legal play reached a close; the existing Hint selected A♣ and the native Close control accepted three disjoint groups of 4, 3 and 3. Both sessions showed/restored the first-deal 31–0 result. Independent physical-card/group checks, identical close retry and Next preserving scores/ply/balances pass. Later legal API play completed five deals at **68–4**, with Player A return **0.00** / balance **244.10**, Player B return **10.00** / balance **254.10**, both reserved zero. Exact terminal retry and both final browser/API views agree. No hand/seed/state was injected. This closes those two earlier native gaps for this build, not exhaustive failures/races, physical touch/Safari or pixel parity.

Frozen root: `/var/folders/d1/mf6r5ctd1zdbly2h7b8nhrp00000gn/T/skillbetting-thanasis-private-93ruojjz` (also `.local/thanasis-private-review-path`), separate `frontend`/`backend` directories. Backend **127.0.0.1:3014**, PID **32309**; frontend **[::1]:3114**, PID **32381** at final inspection. Reinspect PIDs before use. The report has exact restart commands. Its frozen backend `.local/qa-private-backend.cjs` uses only an owned `thanasis_private_` test schema with disabled providers and no automatic opponent participation. Entry for A: **http://[::1]:3114/api/qa/player**; for B: **http://[::1]:3114/api/qa/opponent** in a separate browser session. In one session those links replace its signed-in user. The completed private table `d3422a3d-50e2-4265-bb53-a5573f102d03` remains in both ticket histories. Restarting resets this disposable fixture. Temporary tabs closed and viewport overrides reset; all prior review services/evidence remain untouched. Never deploy this helper or substitute normal accounts. Discuss any frontend change before implementation; chess remains on hold.

## Earlier four-game regression review

Use the [current four-game review](../../skillbetting-frontend/docs/verification/thanasis-review-2026-11-02/README.md), [source manifest](../../skillbetting-frontend/docs/verification/thanasis-review-2026-11-02/source-manifest.json) and [checks](../../skillbetting-frontend/docs/verification/thanasis-review-2026-11-02/checks.json) for the newer source. Build **`POqm5SRc0nD-3JZxuYrFk`** passes 405 frontend, 55 backend unit/HTTP, 101 isolated database and 351 card-engine tests. All four games pass **36/36** native rules/Escape cycles at 1440×900, 1024×900 and exact 390×844, DPR 1. Xeri capture, Diloti declaration/restoration/capture, Koum Kan discard/meld previews and Thanasis draw/refusal/discard pass; all four completed results/retries are recorded. Later play used each synthetic player's legal API observations. Successful native Thanasis closing, two-human/private-code browser journeys, physical touch/Safari, exhaustive failure visuals and paired pixel comparison remain unverified.

Current isolated entry: **http://[::1]:3112/api/qa/player?game=thanasis**; other selectors use `xeri`, `diloti`, `koumkan`. All four matches are complete; synthetic balance 246.40, reserved zero. Review root: `/var/folders/d1/mf6r5ctd1zdbly2h7b8nhrp00000gn/T/skillbetting-thanasis-review-JLhZGp` (also `.local/thanasis-review-path`). Frontend/backend are separate subdirectories with their own generated outputs; unchanged dependencies/reference are linked to the working repositories. Backend listens on **127.0.0.1:3012**, PID **27576**; frontend on **[::1]:3112**, PID **27830** at close. Reinspect before using PIDs. The report has exact restart commands. Helper `.local/qa-review-backend.cjs` lives in the frozen backend copy, uses only its own `thanasis_review_` test schema and disabled providers; restarting creates fresh accounts/data. Never substitute normal accounts or deploy it.

All reviewed working runtime inputs matched this copy at close. Next's generated production `next-env.d.ts` differs only by `.next/types` versus working `.next/dev/types`; the working file was not changed. Card-engine sources, platform store, immutable migrations and references remain unchanged. Existing 3006/3106 and 3010/3110 services were left untouched. The earlier three-game build and evidence below remain historical and are not the latest source. Read current instructions, preserve the frontend-first approach and discuss each new runtime/UI change before implementation. Chess remains on its separate integration hold.

## Read first

Read backend [AGENTS](../AGENTS.md), [checkpoint](backend-progress.md), [platform API](platform-api.md), [table decisions](multiplayer-tables.md) and [credits](credits.md). Explicitly read the sibling frontend's [AGENTS](../../skillbetting-frontend/AGENTS.md), [fidelity](../../skillbetting-frontend/docs/frontend-fidelity.md), [baselines](../../skillbetting-frontend/docs/frontend-design-baselines.md) and [status](../../skillbetting-frontend/docs/frontend-status.md).

The earlier [three-game browser report](../../skillbetting-frontend/docs/verification/three-game-browser-2026-11-02/README.md), [source manifest](../../skillbetting-frontend/docs/verification/three-game-browser-2026-11-02/source-manifest.json) and [checks](../../skillbetting-frontend/docs/verification/three-game-browser-2026-11-02/checks.json) remain authoritative for that earlier build. Older Xeri/Diloti/Koum Kan evidence retains its actual build scope.

## Earlier verified three-game snapshot

Final reviewed production build: **`r2a3e3XE96HeuRJN915Kz`**, backend destination **`http://127.0.0.1:3006`**. Supported in-app browser access works; DPR 1, Greek language. Browser binary/version was not exposed.

- Owner-approved rules Escape behavior is implemented in the shared fishing and rummy rooms. Rules close before the outer dialog's native close request. Ordinary Escape exit remains. Two permanent tests cover native cancel, reopened rules, keyboard prevention and no move. Both assertions failed before their respective fixes.
- Final native checks: **25/25 repeated rules/Escape cycles**, at 1440×900, 1024×900 and 390×844: Diloti 9, Xeri 8, Koum Kan 8. Nine final room screenshots have exact viewport dimensions, loaded fonts, no incomplete room images and no horizontal room overflow. Diloti normal exit/resume preserved the same hand and 244.10 balance.
- Fresh snapshot checks: **381 frontend tests / 42 files**, one worker, unchanged timeouts; TypeScript, scoped format/whitespace and isolated production webpack build pass. **98 isolated PostgreSQL integration tests** pass from a separate backend build copy, including the three completed/cancelled/racing discovery regressions and existing real-engine matches/settlement. Reference: **128 files / 132 URL records** unchanged; migrations **006/007/008** match the earlier manifest.
- Original-build browser observations cover Koum Kan draws/melds/extensions/Joker reading and replacement/restrictions/round/Next deal/result, Xeri capture and Diloti declaration/ownership/capture, restoration and normal results. Later rounds used each synthetic player's legal API moves; these were not wholly manual matches. The final build also rendered normal Diloti 67–28 / 10.00 return and Xeri 141–164 / 0 return, with identical terminal retries.
- Existing finished-table filtering was present when work resumed and was preserved. Browser showed zero open tables after Diloti completed while its completed ticket remained available. Tests cover direct links and completed/cancelled/racing cases.

**The repositories advanced in parallel during review**, including newer Thanasis changes in shared frontend files and backend registration/tests. Those changes were left untouched. The report's `workingTreeDifferencesAtClose` records the observed differences. The Escape fix remains in the newer shared rummy room, but the 381/98 counts and browser proof certify the frozen reviewed snapshot, not the later whole working tree. Read current source/instructions before further work; do not overwrite later changes or silently label them verified by this report.

## Earlier isolated three-game review — retained

- Entry: **[Koum Kan](http://[::1]:3106/api/qa/player)**; append `?game=xeri` or `?game=diloti` for the other selector. One active table still applies. Current active synthetic Koum Kan table: `5df7671f-2fc2-4728-9580-e28d25a6d1f0`; current account balance 242.30. Earlier final Diloti/Xeri tables remain in tickets while the helper lives.
- Frontend: **[::1]:3106**, owned PID **18020** at final inspection; directory `/var/folders/d1/mf6r5ctd1zdbly2h7b8nhrp00000gn/T/skillbetting-browser-verified-AbCnX9` (also backend `.local/browser-review-build-path`). The production copy retains 167 hashed frontend inputs and 125 compiled artifacts.
- Backend: **127.0.0.1:3006**, owned PID **14741** at final inspection; `.local/qa-koumkan-backend.cjs`, started before the later source changes. It uses only `QA_Player`/`QA_Opponent`, its own `_test` schema, disabled provider delivery and an opponent acting from its own legal observation. It is disposable QA, not computer-mode activation.
- Frozen backend source/test copy: `/var/folders/d1/mf6r5ctd1zdbly2h7b8nhrp00000gn/T/skillbetting-backend-review-jIZhQD` (also `.local/browser-review-backend-path`). Its compiled tests passed all 98 cases. The exact helper code is preserved in this copy's `.local/`; no settings or credentials were copied there.

These PIDs are snapshots, never restart commands. Reinspect listeners, commands and working directories before stopping only an owned review process. Leave other agents' fixtures and normal development data alone. Ports 3000/3100 were not started or stopped by this review. PostgreSQL uses the existing project cluster/private Unix socket; never delete `.local/postgres`.

## Restore the earlier three-game copy if needed

Check existing services first. Graceful SIGTERM of the owned QA helper removes only its own schema; restarting creates fresh accounts/data, so old review cookies/tables do not survive. Abrupt shutdown may leave a schema; verify ownership before any cleanup.

From the backend root, ensure the existing database is available:

```sh
npm run db:local:start
```

Restart the verified backend from its frozen copy, using the original ignored database settings:

```sh
cd /var/folders/d1/mf6r5ctd1zdbly2h7b8nhrp00000gn/T/skillbetting-backend-review-jIZhQD
node --env-file-if-exists=/Users/tsal/Projects/skillbetting-backend/.local/database.env .local/qa-koumkan-backend.cjs
```

Restart the verified frontend in another continuing service:

```sh
cd /var/folders/d1/mf6r5ctd1zdbly2h7b8nhrp00000gn/T/skillbetting-browser-verified-AbCnX9
BACKEND_URL=http://127.0.0.1:3006 npm run start -- --hostname ::1 --port 3106
```

Keep the backend destination IPv4 and browser origin exactly `http://[::1]:3106`. If dependencies were removed, restore the unchanged lockfile dependencies in the original repositories; copies link to their `node_modules`. Helpers depend on compiled engines/tests. Never substitute a production-account backend for synthetic review.

Preserve these frozen copies while this review is useful. If a temporary copy is removed, a build from the now-newer working tree has a new identity and needs its own verification; it cannot be labelled as this old reviewed build. The old pre-shutdown temporary builds and logs are gone. Their screenshots/checkpoints remain historical, not freshly recertified.

## Evidence limits and next work

The earlier repeated-Escape failure and wrong-sized resize captures remain excluded/diagnostic evidence. The final keydown correction passed the fresh audit; no failure was cleared by a screenshot tolerance or source change. The earlier disk-window tests/builds were superseded by fresh checks. A generated test file disappeared during one root run; the independent backend copy passed all 98 cases.

No paired pixel-parity certificate, physical touch/Safari proof, independent two-human/private-code/seat-purchase browser flow or exhaustive native error/stale-state sweep is claimed. Full flight/audio/payout animation, a reconstructed visible log after remount and frontend websocket client/upgrade wiring remain PoC gaps. Backend history and native websocket tests remain durable and separate.

Continue only the next user-selected task. Preserve the frontend-first approach and discuss each new frontend increment before implementation. This report does not activate another game or clear chess's separate rules/release hold. Keep all uncommitted work, ignored frontend `reference/`, backend `.local/`, supplied archives, immutable migrations and unrelated historical evidence. Do not reset, clean, switch branches or force-add ignored references.
