# Test strategy

Use Vitest for deterministic domain, validation and DB integration tests; Playwright for real browser flows. Tests use separate development test identities/organizations and delete only records they created. No production database tests. CI provisions PostgreSQL and runs migrations, lint, types, tests and production build.

## Foundation acceptance
Register/sign in/out; wrong credentials, duplicate identity, malformed body, missing session, expired/revoked session and foreign Origin. Secure opaque session handling; membership check on all writes. Create organization/farm, reload persistence, organization switching and empty dashboard. Actual runtime farm_app role: outsider selects see no records, forged inserts and parent links fail, auditor cannot write, owners cannot mutate another org; transaction-local context never leaks through pooling. Atomic owner membership/audit creation; API errors do not expose SQL/passwords. Browser covers keyboard inputs and narrow-screen navigation.

## Domain matrix
Feed weighted contributions, percentages 0/100/invalid totals, null nutrients for positively used ingredients, missing/zero price review, batch and bag scaling, inclusion constraints, stale/incompatible basis. Match starter/finisher energy/CP/cost; explicitly do not accept the spreadsheet's incomplete methionine/dry-matter totals as truth. Optimization: analytically known optimum, bounds/fixed inclusion/availability, infeasibility, null data rejection, recomputed residuals.

Layers: first week 35kg/₦10080/497.5 closing; full 24-week cached totals within stored precision; first egg period 17866.8 gross/592.5822 trays; full 18-period totals; zero stock, mortality extremes, leap-year February, tray remainders, daily hen-days. Broilers: cohort weight gain/partial harvest/mortality denominators, FCR invalid gain, explicit yields. Fish: biomass/feeding/SGR, invalid weights/days, paired transfer reconciliation. Inventory/finance: unit conversions, concurrent no-negative-stock, idempotent events, balanced journals, reversal, historical prices, purchases vs expense vs cash. Imports: all seven sheets, hash/source coordinates, ambiguous comma ranges, aliases, missing data, oversized/corrupt upload and unsupported formulas; never evaluate source formulas. Exports neutralize spreadsheet injection and preserve permissions.

## Release evidence
Record commands and exact pass/fail/skipped counts per phase in PHASE_STATUS.md. A successful build is not an end-to-end test; zero tests is not acceptance. Nutrition approval, production load, disaster recovery and independent security review remain separate gates. Tests may demonstrate local readiness without claiming a commercial release.
