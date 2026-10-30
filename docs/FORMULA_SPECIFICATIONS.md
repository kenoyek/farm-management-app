# Formula specifications — model version 1

Use decimal arithmetic for money/quantities; round monetary display to 2 places, never round intermediate forecasts. Counts in actual records are nonnegative integers. Rates are explicit fractions in [0,1]. Reject NaN/infinite, invalid dates, negative prices, zero denominators and incompatible units. Tolerances: inclusion 1e-6 percentage point; nutrient comparisons 1e-7 in declared unit; solver feasibility 1e-7 after rescaling. Unknown is null, never coerced to zero.

## Feed
For percentage p_i, x_i=p_i/100. Require Σp_i=100 before valid results. Nutrient n=Σx_i*n_i; if any positively included ingredient lacks n_i, n is unknown and compliance is unknown/fail to release. Price/kg=Σx_i*c_i, batch cost=price/kg*batch kg, bag cost=price/kg*bag kg, ingredient kg=x_i*batch kg. Complete dry matter contributions rather than reproduce missing source formulas. Prices are historical snapshots, not live quotations. Compare each known result to explicitly defined min/max; do not infer min/max from the scalar workbook table.

LP: min cᵀx, Σx=1; l≤x≤u; nutrient minima/maxima; stock-derived upper bound stockkg/batchkg; fixed amounts are equality bounds. Verify species, stage, nutrient basis, required laboratory/verification status and all constraint data before solving. Use HiGHS, preserve input/model/solver versions, status and primal residuals. Infeasible is not an optimum; no automatic safety relaxation. Binding constraints are solver-evidence only. Approved immutable recipe version requires a nutritionist decision and audit.

## Layers feed
For each week opening B, ration g, price P, mortality m: feed=B*g*7/1000 kg; expected deaths=B*m; closing=B-deaths; cost=feed*P; next opening=closing. Baseline week1: 500*10*7/1000=35kg; 2.5 expected deaths; 497.5 closing; ₦10080. Feed uses opening-stock approximation; an alternative daily survival model must have a separate version. Do not silently replace the baseline. Full-cycle forecasts require supplied stage-specific ration schedules.

## Eggs
Period gross eggs=opening hens*lay fraction*days (legacy opening-stock approximation). Cracked=gross*crack fraction; saleable=gross-cracked; tray equivalents=saleable/tray size. For actual integer eggs: complete trays=floor(saleable/size), remainder=saleable % size. Expected mortality=opening*m; closing=opening-deaths. New monthly periods use actual calendar dates including leap years; legacy scenario explicitly uses 28 days. Actual hen-day%=100*eggs/sum daily live hens (not month-end hens*days). Revenue=saleable eggs*price/egg, or explicit tray/remainder pricing; not both. Source first-month examples are recorded in WORKBOOK_ANALYSIS.md.

## Broilers
ADG=(final average weight-initial average weight)/elapsed days. Biomass=count*average kg. FCR=feed kg/live-weight gain kg; identify cohort, deaths/culls, partial harvest biomass and time window, reject nonpositive gain. Revenue=live kg*price/kg or birds*price/bird; processed yield is separate. Cost includes chicks, feed actually consumed, medication, allocated labour/utilities and harvest/processing. Cost/bird and break-even price use saleable count/biomass. Gross margin=revenue-attributable costs; not cash collected.

## Catfish
Biomass=estimated live count*sample average grams/1000; daily feed=biomass*feed-rate-percent/100; SGR=100*(ln(final g)-ln(initial g))/days, strictly positive weights/days. Survival estimates and sample dates/sizes must be visible. Transfers debit/credit in one transaction. Separate harvest product yields and processing costs. Feeding rate and water-quality limits must be species/system-specific approved inputs, not invented constants.

## Inventory and finance
Inventory balance=Σsigned canonical-unit movements, with distinct locations/lots and unique source-event idempotency keys. Receiving transfers money to inventory assets, not automatically consumed-feed expense. Issue to production recognizes cost through an explicit valuation policy (weighted-average first release), retaining historical prices. Balanced journal debits=credits; revenue, receivable and cash collection are distinct postings. Sales/stock movements use one transaction; reject negative stock under concurrency via locks. Forecasts never post operational ledger events. Saved scenario versions are immutable, comparisons vary assumptions only.


## Broiler planning — daily linear targets v1

A placed batch's original count/weight/date anchor its immutable plan. Feed days cover ages [placement age, harvest age), and the harvest date is placement date + the supplied age difference. Interpolate weight linearly between the original placement weight and explicitly supplied/cited age targets, including a harvest-age point; never infer a universal strain curve. Daily feed = expected opening birds × stated ration g/day / 1000; expected deaths = opening birds × stated daily mortality fraction; closing = opening − deaths. Carry Decimal(precision 40) values without display rounding between days. Missing rations/mortality/prices are unknown, not zero; unknown mortality makes later population-dependent outputs unknown. Monetary outputs round to four places, weights/kg to six and expected counts to eight for reports. Feed and chick costs are separate forecast components. Gross live value uses one explicit basis: closing birds × price/bird, or closing birds × target g /1000 × price/live kg. No FCR, total cost, processed yield, margin or cash is inferred. Guide temperatures are user-supplied paired bounds, not automatic scientific thresholds.
