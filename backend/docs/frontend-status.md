# Frontend status location

Last updated: 30 October 2026.

The canonical handoff is maintained in the separate `skillbetting-frontend` repository:

- Local: `/Users/tsal/Projects/skillbetting-frontend/docs/frontend-status.md`
- Repository: [frontend status and handoff](https://github.com/Distillogic/skillbetting-frontend/blob/main/docs/frontend-status.md)

The repository has been cloned to `/Users/tsal/Projects/skillbetting-frontend`, and the user has added that folder to this Codex project. The immutable reference, checksum manifest, fidelity guide, root agent instructions, preview instructions, and checksum verifier are present there. All 128 files match their 132 recorded URL/checksum entries.

The original capture stays locally in the frontend checkout at `reference/stoiximatakia/public/`; the verified duplicate was removed from this backend repository. The frontend `reference/` directory is Git-ignored and has been removed from published commit history. New checkouts need a separate copy for the current build/comparison workflow. The frontend now has Next.js 16.4.3, React 19.3.1, and TypeScript 6.0.3, with the first header/navigation component, registration dialog now connected to pending-account signup, and a preview on port 3100. Production-build header comparisons passed at desktop, tablet, and mobile sizes, and `/api/health` was verified through the frontend proxy. Full lobby migration, business-feature integration, and deployment remain pending. The header structure/migration approach has been reviewed in the frontend repository; no header rework was implemented by that review. The user chooses when that rework or another component begins. The remaining roadmap includes the lobby hero/carousel, and future designer additions use scoped design baselines. The static designer source has not changed yet. See the canonical handoff for current commands and evidence.

The development domain remains `https://dev.stoiximatakia.gr`. No server was started during the transfer. Keep future frontend status updates in the frontend repository, and actual backend contracts in this repository's `docs/api.md`.
