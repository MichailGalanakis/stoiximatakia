# PoC release checkpoint — 2 November 2026

The owner authorized the complete application at **https://dev.stoiximatakia.gr**, with native development retained and containers for the server application/database/TLS/backups. The chosen deployment route is the existing server agent: GitHub publication works, while the latest direct SSH identity is rejected. Local acceptance below does not claim public deployment.

## Release contents

| Capability                            | Current release                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Human PvP                             | Xeri, Diloti, Koum Kan, Thanasis, Biriba, Tichu and chess                                                                                |
| Chess                                 | Approved frontend; only strict.2/schema 3 artifact runtime registered; exhaustive proof required before every board position is accepted |
| Accounts/credits                      | Existing signup/Demo/password/session/profile; one durable credit ledger and authoritative initial settlement                            |
| Database                              | Checksummed migrations 001–009; applied 006/007/008 unchanged; readiness requires 009                                                    |
| Computer/chat/cash/result corrections | Remain disabled or unimplemented; no new authority is inferred                                                                           |

Chess keeps fixed colours, full SAN, legal promotion/draw controls, resume and confirmed platform forfeit. Proof workers retain fair exhaustive search and verify immutable streamed artifacts; stopping an optimization or exhausting resources never permits an unresolved move, result or refund. No game clock, new pause/adjudication phase or abandonment deadline was introduced. The earlier default/inline chess profiles remain unregistered. See the [implemented contract](platform-api.md#chess-participant-actions--approved-2-november-2026).

## Validation

| Check                | Result                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend             | **535/535 / 52 files**, types, reference/assets and production build `aqYrOCHt0T_jC4cUjYRoc`; 187 runtime inputs equal the native-tested QA copy                                        |
| Backend/engines      | **109 unit/HTTP + 606 chess + 455 card engines**, types/lint/format/production compile                                                                                                  |
| PostgreSQL           | **176/176 / 13 suites**, plus **19/19 strict artifact multiplayer cases**; zero failures/cancellations/skips in the final runs                                                          |
| Proof storage        | 7,224-node/44,352-edge cyclic proof, corruption/missing/duplicate/unreachable rejection, real dump/restore/cold check, bounded probe fallback and interruption/resume                   |
| Containers           | Both seven-game images build on Linux arm64; trusted test HTTPS/Secure cookies, private views/native websocket, no public QA routes, strict artifacts and actual-role immutability pass |
| Recovery             | Actual backup/full restore/atomic retained-old-database cutover; all old artifacts mathematically rechecked; resumed checkmate and exact payment/retry pass                             |
| Deployment contracts | 6 configuration/archive/secret/topology checks pass                                                                                                                                     |

[Current container evidence](verification/deployment-2026-11-02/chess-container-checks.json) records the fresh seven-game run; [native chess evidence](../../skillbetting-frontend/docs/verification/chess-strict-native-2026-11-02/README.md) records one Brave browser/two cookie-host sessions, promotions, history/reload, draw/forfeit/results and 390px results. Native draw-claim execution, independent humans, physical touch/Safari, exhaustive error visuals and pixel parity remain unverified; engine/API/UI tests cover claims. Earlier reports keep their historical source/build scope.

## Deployment

Pull both updated `main` branches with `--ff-only`, record both commit IDs and follow the [server-agent handoff](../deploy/SERVER-AGENT.md) and [runbook](../deploy/README.md). Keep repositories as siblings; the frontend's 68 tracked runtime assets remove deployment dependence on the ignored designer capture. Preserve existing database data, named volumes and stable private settings. Back up before applying only pending migrations; never reset volumes or edit applied migrations to repair a release.

Verify public HTTPS, `/health`, `/api/health/ready`, all seven human launchers, disabled computer mode and a two-session chess result before announcing availability. Configure an encrypted off-server backup destination; the same-server backup volume alone does not cover host loss. Browser gameplay uses authenticated HTTP/polling repair; migration to a new browser websocket client is separate. No production provider delivery, gameplay or payout is implied by local verification.
