<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Farmstead project guidance

Read `docs/PHASE_STATUS.md` and the seven Phase 0 documents before extending the platform. Use the existing isolated checkout; do not create worktrees unless requested. Run `npm run db:setup` and export `FARM_PYTHON=/workspace/.farmstead-venv/bin/python` before tests or development. See README.md for validation and startup commands.

Keep workbook originals immutable. Missing scientific data is unknown, not zero; imported references are unverified. Do not infer ingredient aliases, manufacture solver optima, relax nutrition constraints or call a numerical result safe for production. Preserve tenant RLS, restricted runtime credentials, immutable recipe/scenario versions, and separation between actual records and forecasts. Never seed unlabeled demonstration metrics or copy local credentials into tracked files. New tenant tables need RLS and tests with real owner-visible rows and an outsider.
