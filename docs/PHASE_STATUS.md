# Delivery status — 27 October 2026

## Phase 0: completed

All three original workbooks and all seven worksheets were inspected. The seven requested documents are present, together with the original request, immutable source files, a JSON cell audit, full Markdown cell inventory and a repeatable inspection script. Every populated cell, formula, cached result and source hash is retained. Starter/finisher formula defects, suspicious values, missing data, percentage/range conventions, aliases, source forecast assumptions and unit changes are documented. Scientific sources are proposed for expert review, not represented as already verified.

## Phase 1: operational development foundation

Implemented registration/sign-in/sign-out; salted scrypt passwords; opaque, hashed, expiring database sessions; same-origin write checks; baseline process-local authentication throttling; organizations with atomic protected owner membership; organization switching; farms; server-enforced roles; existing-account team access/role changes/removal; editable organization name/currency/timezone; audit history; and a responsive light/dark interface with keyboard-focused dialogs.

Screens: account registration/sign-in, organization onboarding, overview, farm directory/registration, team/settings, and the functional domain screens below. Overview statistics are calculated from the active organization's saved production records, never invented metrics. No demonstration farm is seeded.

Database changes: eight migrations add identity/session tables, organization/membership/farm/audit tables, reference/import/recipe/optimizer tables, forecast/production tables, guarded team functions, scientific context/inclusion constraints and separated runtime privileges. `farm_server` cannot directly query tenant tables and is neither superuser nor BYPASSRLS. `farm_app` enforces membership and write-role policies with transaction-local actor context. Composite tenant-parent keys prevent cross-tenant assignments. Local PostgreSQL data/credentials are retained under ignored `.local/`; pending migrations and startup are repeatable.

Stack choice: Next.js App Router, strict TypeScript, PostgreSQL, Zod, Decimal.js, Recharts and a Python/SciPy HiGHS worker. Custom local identity supports development without external accounts. Supabase Authentication/Storage and the recommended UI/table/form libraries are not configured; this deviation and the managed-auth deployment boundary are documented. Production identity security is not certified by the local tests.

## Functional extensions, not declarations of completed later phases

| Phase | Implemented and exercised | Still outstanding |
|---|---|---|
|2 · feed|Preview/confirm the supplied three workbooks; preserve full raw audits; import 32 unverified ingredients; add source references with nullable nutrient fields, species/stages/bases and price dates; reviewed profiles; spreadsheet-style formula editor; missing-aware nutrient/cost/bag/batch calculations; save/clone immutable recipe snapshots; status gates and CSV mixing sheets|Arbitrary uploaded workbook mapping, normalized requirement/restriction migration, approved catalog reconciliation, expanded nutrients/aliases, price/version editing and autosaved drafts|
|3 · optimization|Real HiGHS objective/constraints; bounds/fixed inclusions, immutable reviewed bounds, optional stock-derived caps, independent feasibility checks, binding constraints in stored API results; run snapshots; infeasibility and source-review gates|Manufacturing/stock reservations, full reference-data freshness policies, profile-level mandatory ingredients/processing constraints, richer conflict diagnostics, mixing PDF/Excel and complete scenario comparisons|
|4 · layers|Editable weekly ration/mortality/price schedules; 24-week feed baseline; 18-period egg baseline; calendar vs 28-day models; saved scenario versions/comparison/chart/CSV; flocks and actual daily feed/mortality/whole egg/cracked records; tray/remainder display|Physical egg stock ledger, egg grades/sales, daily hen-day reporting and actual-versus-forecast reconciliation, corrections, full-cycle approved schedules|
|5 · broilers|Stock a batch; chronological daily feed/mortality and representative weight samples; live stock/biomass estimate/ADG; FCR only when measurable without missing lost-biomass adjustments|Brooding schedules, health/medication, culls/partial harvests, losses-aware FCR, sale products/yields, production costing and profitability scenarios|
|6 · catfish|Stock a pond batch; feed/mortality/weight samples; biomass/SGR; optional temperature/pH/oxygen/ammonia observations; CSV|Pond dimensions/system registry, grading/transfers/harvests, feeding-rate scheduling UI, reviewed water-quality alerts, dedicated digestible nutrient formulation and economics|
|7–9 · integrated/SaaS|Architecture, acceptance plan and a CI workflow file|Inventory/procurement/financial ledgers, sales/cash/receivables, health/tasks/alerts, advanced reports/PDF/Excel, billing/entitlements/admin, monitoring/load/security/backup release work|

Only assigned nutritionists can register reviewed profiles or approve eligible formula versions. Imported workbook values are **not** approved; production-quality profiles require qualified review and current product/lab/price evidence. Catfish formulation explicitly refuses poultry assumptions. Available-stock blanks describe an unconstrained planning scenario, not a manufacturing inventory reservation. Current feed prices/results are NGN; changing organization currency does not convert historical prices.

Production records are append-only and chronological, one record per unit/day, with whole-animal counts and serialized mortality validation. Corrections, missing-date reconciliation, transfers and partial harvests need explicit later workflows; no automatic historical overwrites occur. Feed logs must be complete before treating FCR as representative. Biomass is sampling-based and labeled as estimated. Forecasts never post stock or financial events.

## Validation evidence

- `npm test`: 37 tests passed; source recipe/cost/missing-data checks, real optimal/bounded/infeasible HiGHS runs, stock/reviewed limits, 24-week/18-period source regressions, calendar/leap-year handling, biomass/SGR/FCR, identity/session/origin/input checks and actual PostgreSQL tenant/role/immutability/concurrency tests.
- `python -m pytest tests/python -q`: 3 tests passed; worker protocol rejects malformed/nonfinite inputs and reports genuine solver status/version.
- Playwright Chromium: one end-to-end workflow passed: account → organization → farm → workbook preview/import → new nullable reference → calculate/save recipe → save forecast → stock layer unit → daily eggs/feed → settings → real dashboard → mobile navigation → logout. Fixture data is removed afterward.
- Strict types, ESLint and a production build passed. The reproducible install script was run in the current environment; database setup and runtime-role checks passed after dependency reinstallation. Production-mode browser verification is included in final validation.
- Production npm dependency audit reported zero known vulnerabilities. This is not a security audit.
- The GitHub Actions workflow was authored, but has not run remotely. No deployed website, published cloud snapshot, managed Supabase instance, scientific certification or commercial readiness is claimed.

## Next priorities

1. Finish Phase 2 migration/review workflows, including stage-specific ingredient restrictions and scientist-reviewed requirement/ingredient catalogs. Complete the approval and mixing-sheet workflow against those catalogs.
2. Expand optimizer request provenance, processing constraints and inventory-backed availability before feed manufacturing support.
3. Complete layer production/inventory/sales reconciliation, then the remaining broiler and catfish lifecycle workflows in phase order.
4. Implement transactional, idempotent stock and balanced financial ledgers before reporting profitability. Add reporting/export and SaaS modules afterward.
5. Before public deployment: managed-auth/recovery strategy, distributed throttling, secure uploads, monitoring, backups/restore drills, penetration/tenant-isolation review, load testing and real-farm acceptance. Do not enable payment collection without authorization.
