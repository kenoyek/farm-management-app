# Product requirements

## Scope and users
Farmstead is an NGN-first multi-tenant farm operations platform for owners, managers, workers, nutritionists, inventory officers and auditors. The supplied request is preserved in ORIGINAL_REQUEST.md. Source spreadsheets are evidence, not approved nutrition guidance.

## Delivery contract
Phase 0 produces a reproducible seven-sheet workbook audit, formula specifications, database design, scientific review gates and test plan. Phase 1 delivers registration/sign-in/out, durable sessions, organization creation and switching, membership-based authorization, farm registration, real database dashboard, audit history, responsive forest-green design and accessible empty/error states. No invented farm activity is presented as real.

Subsequent phases deliver feed data/import, formulation, constrained optimization, layers, broilers, catfish, transactional inventory and finance, analytics and SaaS entitlements in order. Each must pass its own acceptance criteria; the existence of a route does not establish completion.

## Required workflows
1. Register an individual identity; create an organization with owner membership atomically.
2. Create one or more farms with location, currency and timezone. Only authorized organization members can read/write them.
3. Record production units, daily whole-animal stock events, feed use and sales without overwriting history.
4. Import source documents with preview, issues, provenance and explicit confirmation; retain raw data and approved normalized versions separately.
5. Save feed recipes, compute missing-aware nutrient/cost results, compare specifications, and require nutrition review before production.
6. Optimize only verified, compatible data using real linear programming; preserve constraints and solver provenance.
7. Save separate forecasts and actual records; export traceable reports.

## Acceptance and nonfunctional requirements
Authentication failures reveal no account details. Sessions use random opaque tokens hashed at rest, HttpOnly SameSite cookies and expiry; writes require same-origin checks. Database access must enforce organization membership and roles through RLS in addition to API checks. Never trust a client-supplied organization ID alone. Unauthorized object access yields no data. Audit entries are transactionally paired with mutations. Concurrent stock/financial postings require unique idempotency keys and locked balance checks.

Default locale en-NG, NGN, Africa/Lagos; settings are configurable. Fixed-point decimal money; explicit units, as-fed/dry-matter and energy/phosphorus bases. Accessible keyboard forms, narrow-screen navigation, no external font dependency, explicit loading/error/empty states. Dark mode follows user choice. Payment collection is outside current authorization.

## Release gates
A commercially deployable release additionally needs verified nutrition profiles, tenant-isolation integration tests, independent security review, monitoring, backup/restore drill, load limits, operational support and all end-to-end production-cycle workflows. A local development foundation is not that release.
