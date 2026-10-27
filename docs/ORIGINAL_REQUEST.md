# Farm Management & Feed Formulation Platform

Comprehensive Codex development blueprint

We're going to build a commercial-grade agricultural management web application, not simply convert your Excel spreadsheets into online calculators.

The platform will serve poultry farmers, catfish farmers, feed mill operators, farm managers, agricultural consultants, and agribusiness owners. It will combine feed formulation, production forecasting, inventory management, farm economics, recordkeeping, and decision support in one system.

I've examined your three uploaded spreadsheets:

| Spreadsheet             | What it contributes to the platform                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Feed Formula Calculator | Nutrient requirements, raw-material composition, ingredient inclusion limits, broiler starter and finisher formulas, and feed costs |
| Layers Feed Projection  | Weekly feed consumption, bird population, mortality, cost per kilogram, and flock projections                                       |
| Layers Egg Production   | Monthly mortality, laying percentages, expected egg output, cracked eggs, trays, and remaining stock                                |

One important discovery: your feed formulation workbook already includes broiler starter and finisher formulations. That gives us a foundation for the broiler module. What we need to add is the complete broiler production lifecycle: stocking, daily growth, feeding, FCR, mortality, medication records, harvesting, and profitability.

Your feed workbook also includes nutrient reference tables and inclusion limits for other poultry and livestock categories, making it possible to design an extensible formulation engine rather than hard-code the system exclusively for chickens.

## 1. What the website should look like

[Agriculture Dashboard Design by Venkatesan Annasamy on Dribbble](https://images.openai.com/static-rsc-4/bQRrmd61PdBNY2UGniBTzaGeWYsbHk685RjD7RpjAd2cAWiLfzaF-CM3vPJIoWRErhLq63M62sQB7MkWCPjELQFq6poekmvLr8Z6zdPyXuT08xTfApYFBJP6Wl90OAF1QQH2jmgLgW6XVaowFunHC2hYTjwKzKwHAkIU3m7Mx8I?purpose=inline)

Farm command centre

Production statistics, financial KPIs and flock performance

[AFOS - Feed Formulation Software](https://images.openai.com/static-rsc-4/AcKdhUiCSmsCP1Dugt6gYlsBD4a-029roytwwBIGJkxqzrg9qaoAITF2Z9Nfni98uzkC8Ls0vpLxVqw1OZegdU_R7zbSSnbWehcMDr9u6vxrHYaXSTK8OyEaDloFlbk2EMm1qgXKHDawgSAGkdRSINxUjSHFGolIOR3xjIi-tc4?purpose=inline)

Feed formulation studio

Ingredient selection, nutrient compliance and cost optimization

[KukuFlow - Poultry ERP](https://images.openai.com/static-rsc-4/Zbs8yRCP_D-NniX9PdMjNePDDAD05UQVDciU_2yKI88jUd70W7ANdYSsv2Kh3yaQcdmCFuU_fSoQlxA4PRo9Xr94JCQ5X6-TD7v8THZPIU-cy846IhlZ2K8cXt8asAy3JhQUxLbnByOo4bM_poiCAEqAilT63W1tup9JuEeJAWA?purpose=inline)

Layers production analytics

Egg collection, laying performance and production forecasting

[Agrinovo | End-to-End Monitoring & Control Platform for Agriculture & Aquaculture](https://images.openai.com/static-rsc-4/qi4yISc07PWY4-NFT8z3xUuPxWOM0zb7-6oWGy4SH0Yynh7iD8lMLqf7ev4TiaLo5UA6He81gGlLVZR9iIEFbHbeFB9UCsTgzZT3vVWWMID9uz7sQTYGVQDRBNJPqojUoMobDJ8KEnfGy9lz5HA3rmf4B_qGuNlhejYzbvgDlVY?purpose=inline)

Catfish farm management

Pond monitoring, biomass, feed scheduling and harvest forecasting

These are design references, not existing screens of our application. The finished website should use a consistent agricultural visual identity, responsive interfaces, meaningful charts, and spreadsheet-like editing where farmers need it.

## 2. Critical improvements identified from your spreadsheets

Before creating the Codex instructions, there are some important details we must preserve and improve.

Feed formulation: Your existing model calculates metabolizable energy, crude protein, dry matter, calcium, phosphorus, methionine, lysine, and ingredient costs. It also contains nutrient requirements for different production stages.

We should enhance this with least-cost feed optimization, so the application can find the cheapest suitable combination of ingredients while respecting nutritional and inclusion constraints. This is a recognized approach in poultry nutrition and feed formulation.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.fao.org\&sz=32)

FAO+1



Layer feed projection: Your spreadsheet models 24 weeks, beginning with 500 birds. It calculates feed intake from the number of birds, daily ration, and seven days of feeding. We will preserve this logic while adding configurable schedules, actual consumption, stock reconciliation, and forecasts through the entire laying cycle.

Layer egg production: Your workbook has an 18-month projection with 1,418 opening birds, a 45% initial laying rate, predominantly 80% thereafter, and changing mortality and cracked-egg assumptions. It converts saleable eggs into crates of 30.

We should improve it with daily production records, egg grades, multiple tray sizes, monthly calendar-day accuracy, actual-versus-projected reporting, and revenue forecasting.

Data quality: Some source ingredient costs are zero or missing, and some nutrient entries appear inconsistent. Rather than silently trusting every figure, the application should import the reference data, flag suspicious entries, and require review before those values are used to optimize a real feed batch.

This distinction is important: a mathematically valid feed formula is not automatically nutritionally safe. The application must verify appropriate nutrient requirements, ingredient quality, processing restrictions, and stage-specific limits, with qualified nutritionist review before manufacturing.

## 3. Master Codex development prompt

The following is designed for Codex to implement the project in phases, with functional modules, a proper database, production-ready calculations, and test coverage.

# MASTER DEVELOPMENT PROMPT — AGRICULTURAL FARM MANAGEMENT & FEED OPTIMIZATION PLATFORM

## 1. Project Mission

Act as a senior agricultural systems architect, poultry production specialist, aquaculture management specialist, animal nutrition software engineer, full-stack developer, database architect, and SaaS product designer.

Build a comprehensive, production-ready, multi-tenant agricultural management web application.

The application must transform the three supplied Excel workbooks into an integrated, professional platform, while significantly expanding their capabilities.

The original workbooks are:

1. `Feed Formula Calculator.xlsx`
2. `Layers Feed Projection.xlsx`
3. `Layers Egg Production.xlsx`

Treat these workbooks as reference material and calculation baselines, not as unquestionable scientific standards.

The application must support:

- Layer poultry production
- Broiler poultry production
- Catfish farming
- Feed formulation and feed milling
- Raw-material management
- Production forecasting
- Farm inventory
- Production cost accounting
- Sales and profitability
- Farm health and operational records
- Reporting and analytics
- Multiple farms and production units
- Commercial SaaS subscriptions and tenant management

Create a real operational platform with persistent records, not a mock-up, static dashboard, or collection of disconnected calculators.

## 2. Product Vision

The platform should answer important agricultural business questions:

- How much feed will my birds consume this week?
- How much money will I spend feeding 500, 1,000, or 10,000 layers?
- How many bags of feed will I need before my next purchase?
- How many eggs should my layers produce?
- What is my actual hen-day production percentage?
- How much revenue and profit can I generate from egg sales?
- How much will it cost to raise 1,000 broilers to market weight?
- What is the average weight of my birds?
- What is my feed conversion ratio?
- When should I sell my broilers?
- How much feed does my catfish pond require?
- What is the estimated biomass of fish in each pond?
- What will be the expected harvest weight and profit?
- What is the cheapest feed formulation that meets nutritional requirements?
- How does changing maize or soybean prices affect feed costs?
- Should I produce my feed or purchase commercial feed?
- Which farm, flock, pond, or production cycle is most profitable?

All major calculators must support saving, comparing, forecasting, and exporting results.

## 3. Technology Architecture

Use a modern, maintainable technology stack.

Recommended stack:

Frontend:

- Next.js with App Router
- TypeScript in strict mode
- Tailwind CSS
- shadcn/ui
- Recharts
- TanStack Table
- React Hook Form
- Zod
- Accessible component patterns
- Responsive, mobile-first layouts

Backend:

- Supabase PostgreSQL
- Supabase Authentication
- Supabase Storage
- Row-Level Security
- Server-side APIs and domain services
- Background jobs for reporting, scheduled calculations, and notifications

Optimization:

- Python FastAPI microservice where appropriate
- SciPy HiGHS linear programming solver
- Versioned optimization requests and results
- Strict server-side input validation

Testing:

- Vitest
- React Testing Library
- Playwright
- Python pytest for optimization services
- PostgreSQL integration tests
- Database security and tenant-isolation tests

Infrastructure:

- GitHub Actions CI/CD
- Docker for optional services
- Deployment suitable for Vercel or Cloudflare-compatible infrastructure, depending on the selected architecture
- Independently deployable optimization service
- Environment-variable-based secrets management
- Error monitoring and audit logging

Do not introduce microservices unnecessarily. Keep routine calculations in shared, testable TypeScript domain packages. Use the optimization service for mathematical problems that benefit from specialized solvers.

## 4. Multi-Tenant Architecture

Design the platform for multiple independent customers.

A customer may operate one or more farms.

A farm may have:

- Multiple poultry houses
- Multiple layer flocks
- Multiple broiler batches
- Multiple fish ponds
- Feed storage facilities
- Feed mixing equipment
- Warehouses
- Sales and distribution operations

User roles:

1. Platform Super Admin
2. Farm Owner
3. Farm Administrator
4. Farm Manager
5. Poultry Supervisor
6. Aquaculture Supervisor
7. Feed Nutritionist
8. Inventory Officer
9. Sales/Accounts Officer
10. Farm Worker
11. Read-only Auditor

Use server-enforced, fine-grained permissions.

Every tenant-owned record must be scoped to the correct organization.

Apply and test Row-Level Security to prevent users of one organization from accessing another organization's information.

## 5. Application Navigation

Create the following main navigation structure:

### Overview

- Dashboard
- Production Summary
- Financial Summary
- Alerts and Notifications

### Feed Management

- Feed Formulation Studio
- Ingredient Nutrient Database
- Nutritional Requirements
- Feed Formula Library
- Least-Cost Optimizer
- Feed Cost Calculator
- Feed Production
- Feed Quality Control
- Feed Requirements Forecast
- Feed Mixing Instructions

### Layers Management

- Layer Flocks
- Rearing and Feed Projection
- Egg Production
- Egg Collection
- Egg Grading
- Mortality Records
- Feed Consumption
- Egg Inventory
- Production Forecasts
- Layer Performance Reports

### Broiler Management

- Broiler Batches
- Brooding Management
- Growth Tracking
- Weight Sampling
- Feed Scheduling
- Feed Conversion Ratio
- Mortality and Culling
- Health Records
- Harvest Planning
- Broiler Sales
- Profitability Analysis

### Catfish Management

- Pond Management
- Fish Stocking
- Feeding Schedules
- Biomass Estimator
- Growth Monitoring
- Water Quality
- Mortality Records
- Grading and Transfers
- Harvest Forecasting
- Fish Sales
- Profitability Analysis

### Farm Operations

- Health and Veterinary Records
- Medication and Vaccination Schedules
- Daily Farm Activities
- Staff Assignments
- Equipment and Maintenance
- Biosecurity Records
- Farm Tasks

### Inventory and Procurement

- Raw Materials
- Finished Feed
- Egg Stock
- Livestock Stock
- Supplies and Medicines
- Purchase Orders
- Suppliers
- Stock Movements
- Reorder Alerts

### Finance

- Expenses
- Revenue
- Invoices and Receipts
- Payments
- Cost per Production Unit
- Profit and Loss
- Budgeting
- Cash Flow
- Forecasting

### Analytics

- Performance Dashboard
- Feed Efficiency
- Production Comparisons
- Financial Analytics
- Actual vs Forecast
- Custom Reports
- Spreadsheet and PDF Exports

### Administration

- Farm Settings
- Staff and Permissions
- Nutritional Reference Data
- Integrations
- Subscription and Billing
- Audit Logs

## 6. Feed Formulation Engine — Highest Priority

Replicate and improve the functional capabilities of `Feed Formula Calculator.xlsx`.

The workbook contains the following logical sections:

- Dietary Needs
- Ingredient Level
- Nutritional Intake
- Broiler Starter
- Broiler Finisher

Preserve their business meaning.

### 6.1 Feed Categories

Support poultry formulas for:

- Chick starter
- Pullet starter
- Pullet grower
- Pre-layer
- Layer mash
- Layer breeder
- Broiler pre-starter
- Broiler starter
- Broiler grower
- Broiler finisher

Support catfish formulas for configurable growth stages, including:

- Fry
- Fingerlings
- Juveniles
- Grow-out
- Broodstock

Use species-specific nutrient definitions and constraints.

Do not assume that poultry nutrient requirements or digestibility measurements apply to fish.

### 6.2 Ingredient Database

Store and manage ingredients such as:

- Maize
- Sorghum
- Wheat bran
- Maize bran
- Rice bran
- Maize germ
- Groundnut cake
- Soybean meal
- Full-fat soybean
- Palm kernel cake
- Cottonseed meal
- Sunflower meal
- Fishmeal
- Blood meal
- Brewer's spent grain
- Cassava meal
- Limestone
- Oyster shell
- Bone meal
- Dicalcium phosphate
- Salt
- Methionine
- Lysine
- Vitamin and mineral premixes
- Broiler concentrates
- Layer concentrates
- Fish feed additives

Allow administrators to add new ingredients.

Each ingredient must include:

- Name
- Category
- Description
- Energy value and energy system
- Crude protein
- Crude fat
- Crude fibre
- Dry matter
- Moisture
- Ash
- Calcium
- Total phosphorus
- Available phosphorus, where supported
- Methionine
- Lysine
- Other supported amino acids
- Fibre fractions where applicable
- Supplier
- Unit purchase price
- Purchase unit and conversion to kg
- Current inventory
- Source of nutrient information
- Laboratory analysis date
- Last verification date
- Quality and processing notes
- Species-specific restrictions

Missing nutrient data must remain missing, not silently become zero.

For fish feed, support digestible protein, digestible energy, and relevant amino-acid specifications when reliable reference data exist.

### 6.3 Formulation Calculator

Allow the farmer to select:

- Animal type
- Production stage
- Nutritional requirement profile
- Available ingredients
- Ingredient inclusion percentages
- Minimum inclusion limits
- Maximum inclusion limits
- Batch weight
- Ingredient purchase prices

Calculate the nutritional composition of the resulting feed.

For each nutrient:

`Nutrient contribution = Ingredient inclusion fraction × Ingredient nutrient concentration`

`Final nutrient concentration = Sum of ingredient nutrient contributions`

For energy:

`Final energy (kcal/kg) = Sum of inclusion fraction × ingredient energy (kcal/kg)`

For cost:

`Feed cost per kg = Sum of inclusion fraction × ingredient price per kg`

`Batch cost = Feed cost per kg × Batch weight`

Support batch conversions for 25 kg, 50 kg, 100 kg, 500 kg, 1,000 kg, and custom weights.

### 6.4 Nutritional Validation

Compare the calculated formula against its selected nutritional specification.

Use a visible comparison table:

| Nutrient      | Actual     | Minimum | Maximum | Status    |
| ------------- | ---------- | ------- | ------- | --------- |
| Crude Protein | Calculated | Target  | Limit   | Pass/Fail |
| Energy        | Calculated | Target  | Limit   | Pass/Fail |
| Calcium       | Calculated | Target  | Limit   | Pass/Fail |
| Phosphorus    | Calculated | Target  | Limit   | Pass/Fail |
| Lysine        | Calculated | Target  | Limit   | Pass/Fail |
| Methionine    | Calculated | Target  | Limit   | Pass/Fail |

Also validate:

- Total inclusion equals 100%
- Ingredient limits are respected
- Prices and nutritional data are available
- Required data are not stale or unverified
- Species-specific restrictions
- Units and nutrient bases are compatible
- Physical and processing constraints, where applicable

Invalid formulas must not be labeled as nutritionally compliant.

Support draft, pending-review, approved, and rejected statuses.

### 6.5 Least-Cost Feed Optimization

Implement an actual linear programming engine.

Objective:

Minimize:

`Total feed cost = Sum(ingredient inclusion × ingredient cost)`

Subject to:

- Sum of inclusion fractions = 1
- Nutrient minimum constraints
- Nutrient maximum constraints
- Minimum ingredient inclusion
- Maximum ingredient inclusion
- Ingredient availability
- Required fixed inclusions
- Species and stage restrictions
- Compatible nutrient units and reference bases

Provide:

- Lowest-cost solution
- Ingredient percentages
- Quantity for selected batch size
- Feed cost per kg
- Cost per 25 kg and 50 kg bag
- Nutritional composition
- Compliance results
- Difference from manually formulated feed
- Solver status
- Binding constraints where supported

If no feasible formulation exists, report infeasibility and explain relevant conflicting constraints.

Never fabricate an optimal formula.

Never automatically relax nutritional safety requirements.

Allow users to save a scenario and compare alternative price assumptions.

### 6.6 Formula Library

Users can:

- Save formulas
- Clone formulas
- Compare versions
- Approve formulas
- Export mixing sheets
- View cost history
- Archive obsolete formulas
- Assign formulas to flocks or ponds

Maintain immutable versions for every approved feed recipe.

## 7. Layer Feed Projection Module

Reproduce the logic from `Layers Feed Projection.xlsx`.

The sample workbook includes:

- Week number
- Daily feed ration in grams per bird
- Opening stock
- Weekly feed consumption in kilograms
- Feed cost per kilogram
- Total weekly feed cost
- Weekly mortality rate
- Expected mortality
- Closing stock

Use the following baseline formulas.

`Weekly feed (kg) = Opening birds × Daily ration (g) × 7 / 1000`

`Expected mortality = Opening birds × Weekly mortality rate`

`Closing birds = Opening birds - Mortality`

`Weekly feed cost = Weekly feed (kg) × Price per kg`

For operational records, use whole-number bird counts.

For forecasts, preserve expected decimal values internally where useful, but explain and consistently round projected bird counts for display.

Allow configurable starting stock, age, expected mortality, daily ration, and feed price.

Support:

- 24-week projections
- Full rearing-cycle projections
- Full laying-cycle projections
- Custom projection periods
- Daily, weekly, and monthly views
- Stage-based feed transitions
- Farm-specific feed schedules
- Actual consumption records
- Feed wastage
- Feed stock requirements
- Feed price changes
- Batch feed procurement plans

Present the information in an editable table similar to Excel, with calculated fields updating immediately.

Charts:

- Feed consumption by week
- Cumulative feed usage
- Feed cost by week
- Projected flock population
- Planned vs actual feed consumption

## 8. Layer Egg Production Module

Use `Layers Egg Production.xlsx` as the starting calculation model.

It contains an 18-month egg production forecast.

Implement:

- Opening stock
- Mortality rate
- Mortality quantity
- Closing stock
- Laying percentage
- Gross eggs
- Cracked eggs
- Saleable eggs
- Trays/crates
- Egg revenue
- Feed expenses
- Operational expenses
- Estimated profit

Use:

`Hen-day production % = Eggs produced / (Live hens × number of days) × 100`

When live bird numbers change within the reporting period, use the sum of daily live-hen counts as the denominator.

For forecasts:

`Projected eggs = Expected average live hens × Laying rate × Days in period`

`Cracked eggs = Gross eggs × Expected cracked egg rate`

`Saleable eggs = Gross eggs - Cracked eggs - Other unsaleable eggs`

`Egg trays = Saleable eggs / Eggs per tray`

Default to 30 eggs per tray, but allow other package sizes.

Use actual calendar days rather than assuming every month contains 28 or 30 days.

### 8.1 Daily Egg Collection

Create a daily data entry page for:

- Collection date
- Flock
- Production house
- Morning eggs
- Afternoon eggs
- Evening eggs
- Total eggs
- Cracked eggs
- Dirty eggs
- Rejected eggs
- Saleable eggs
- Egg grades
- Egg weights
- Notes

Support bulk entry, mobile forms, and CSV import.

### 8.2 Layer Analytics

Calculate:

- Hen-day egg production
- Hen-housed egg production
- Eggs per surviving hen
- Eggs per hen housed
- Peak production percentage
- Egg mass
- Average egg weight
- Feed consumption per dozen eggs
- Feed consumption per kg egg mass
- Mortality percentage
- Production persistency
- Cracked-egg percentage
- Cost per egg
- Cost per tray
- Gross margin per tray

Present actual vs target production curves.

Support breed/strain-specific performance profiles imported from verified breeder documentation.

## 9. Broiler Production Management Module

Create a complete broiler lifecycle management system.

This must be a major application module, not a small calculator.

### 9.1 Broiler Batch Registration

Record:

- Batch name and identifier
- Farm
- Poultry house
- Breed or strain
- Hatch date
- Placement date
- Starting age
- Number of chicks stocked
- Cost per chick
- Supplier
- Initial average weight
- Expected production duration
- Target market weight
- Target selling price
- Expected mortality
- Feed program
- Planned harvest date

### 9.2 Growth Projection

Allow users to configure age-based growth targets.

Forecast:

- Average body weight
- Daily weight gain
- Weekly weight gain
- Total flock biomass
- Feed intake
- Cumulative feed intake
- Expected mortality
- Expected harvest weight

Provide breed-specific growth curves with documented, editable sources.

Do not hard-code a universal growth curve for all broilers.

### 9.3 Broiler Feeding Program

Support:

- Pre-starter
- Starter
- Grower
- Finisher

For each stage, define:

- Start age
- End age
- Feed type
- Daily feed allowance
- Expected feed intake
- Feed price
- Total quantity
- Expected cost

Link stage feed to the feed formulation library.

### 9.4 Feed Conversion Ratio

Calculate:

`FCR = Feed consumed (kg) / Live weight gain (kg)`

Make reporting definitions explicit.

Separate biological or sampled weight-gain FCR from saleable-liveweight-based economic feed conversion.

Track:

- Target FCR
- Actual FCR
- Cumulative FCR
- Feed consumed per bird
- Growth rate
- Average daily gain
- Mortality-adjusted performance

Use clearly defined methods for accounting for deceased and culled birds.

### 9.5 Performance Monitoring

Create daily and weekly records for:

- Feed issued
- Feed consumed
- Water consumed
- Mortality
- Culls
- Weights
- Temperature
- Humidity
- Litter condition
- Health observations
- Medications and veterinary treatments
- Personnel notes

### 9.6 Broiler Harvest Planning

Estimate:

- Birds available for sale
- Expected average weight
- Expected live biomass
- Expected sales revenue
- Feed costs
- Chick costs
- Medication costs
- Labour
- Transport
- Processing costs
- Other expenses
- Total production costs
- Cost per bird
- Cost per kilogram live weight
- Expected gross profit
- Break-even selling price

Allow both live-bird sales and processed-meat sales, with separately defined dressing yields.

### 9.7 Scenario Simulator

Examples:

- What happens if feed prices increase by 15%?
- What happens if mortality increases?
- What happens if market price decreases?
- Is harvesting at 35 days or 42 days more profitable?
- Should a farmer sell by bird or by kilogram?

Show scenario assumptions and side-by-side financial results.

## 10. Catfish Farm Management

Build a dedicated aquaculture management module.

### 10.1 Pond Registry

Support:

- Earthen ponds
- Concrete ponds
- Tarpaulin ponds
- Tanks
- Other configurable systems

Fields:

- Pond identifier
- Location
- Dimensions
- Surface area
- Estimated volume
- Water source
- Production system
- Stocking capacity
- Operational status

### 10.2 Fish Stocking

Record:

- Species
- Stocking date
- Fingerling count
- Initial average weight
- Supplier
- Cost per fish
- Total stocking cost
- Pond assignment
- Expected survival
- Expected harvest date

Initially focus on African catfish production, particularly *Clarias gariepinus*.

Keep the data model extensible.

### 10.3 Biomass Calculator

Use:

`Estimated biomass (kg) = Estimated live fish count × Average fish weight (g) / 1000`

Use representative sampling and configurable survival estimates.

Clearly label biomass estimates when based on sampling rather than complete measurements.

### 10.4 Fish Feeding Calculator

Use:

`Daily feed quantity (kg) = Estimated biomass (kg) × Feeding rate (%) / 100`

Provide configurable feeding schedules based on:

- Fish size
- Growth stage
- Water temperature
- Water quality
- Appetite observations
- Feed characteristics
- Production conditions

Do not treat a generic feeding table as universally correct.

### 10.5 Fish Growth Monitoring

Record:

- Sampling date
- Sample size
- Average weight
- Weight distribution
- Estimated fish population
- Estimated biomass
- Feed consumed
- Mortality
- Average daily gain
- Specific growth rate
- Feed conversion ratio

Specific growth rate:

`SGR (%/day) = 100 × (ln(final weight) - ln(initial weight)) / days`

### 10.6 Pond Water Quality

Record and chart:

- Dissolved oxygen
- Temperature
- pH
- Ammonia
- Nitrite
- Alkalinity
- Water transparency, where applicable
- Water exchange
- Aeration activity

Use species- and system-specific configurable alert thresholds.

Warn when measurements require immediate human assessment.

### 10.7 Fish Inventory and Movements

Support:

- Pond transfers
- Fish grading
- Mortality adjustments
- Partial harvests
- Complete harvests
- Fish sales
- Stock reconciliation

Prevent double-counting fish transferred between ponds.

### 10.8 Harvest Economics

Calculate:

- Expected live fish count
- Expected biomass
- Saleable biomass
- Feed costs
- Fingerling costs
- Water and energy costs
- Labour
- Treatment costs
- Total costs
- Expected revenue
- Cost per kilogram
- Break-even price
- Gross margin

Include live fish, fresh processed fish, and smoked fish as separate sales products with explicit yields and processing costs.

## 11. Shared Farm Inventory

Implement a proper inventory ledger.

Categories include:

- Feed ingredients
- Finished feed
- Poultry stock
- Fish stock
- Eggs
- Veterinary supplies
- Equipment
- Packaging materials

Support:

- Purchasing
- Receiving
- Stock issuance
- Transfers
- Adjustments
- Stock returns
- Inventory counts
- Reorder levels
- Supplier tracking
- Batch and lot identification
- Expiration dates where relevant

All stock movements must have:

- Timestamp
- Quantity
- Unit
- Source
- Destination
- Reference transaction
- Staff member
- Audit history

Avoid double-counting inventory when creating financial expenses or moving stock between warehouses.

## 12. Farm Financial Management

Each production cycle must have a financial ledger.

Track:

- Livestock or fingerling purchases
- Raw materials
- Commercial feed
- Medication
- Vaccination
- Labour
- Electricity
- Fuel
- Water
- Repairs
- Transport
- Rent
- Equipment
- Sales
- Receivables
- Payables
- Other costs

Financial dashboards must show:

- Total revenue
- Total operating costs
- Feed cost
- Cost of production
- Gross margin
- Operating profit
- Outstanding receivables
- Cash inflows
- Cash outflows
- Working capital requirements
- Break-even price

Distinguish revenue, cash collections, expenses, inventory purchases, and cost of goods sold.

Support configurable cost allocation between shared operations.

Default currency should be Nigerian Naira (NGN), with configurable currency and locale settings for international customers.

Use precise decimal arithmetic for financial calculations and maintain historical transaction prices.

## 13. Forecasting and Simulation Engine

Build a centralized forecasting system.

Inputs must be versioned and editable.

Include:

- Base case
- Optimistic case
- Pessimistic case
- Custom case

Variables include:

- Feed prices
- Ingredient prices
- Mortality
- Growth rates
- Laying rates
- Feed consumption
- Sales prices
- Production duration
- Energy costs
- Other operating costs

Show:

- Projected profit
- Projected cash requirements
- Expected feed purchasing schedule
- Break-even analysis
- Production outcomes
- Risk sensitivity

Forecasts must remain separate from actual operational records.

Recalculating a forecast must not overwrite historical transactions.

## 14. Reporting and Dashboards

Provide dashboards at:

- Organization level
- Farm level
- Poultry house level
- Flock level
- Broiler batch level
- Pond level
- Production-cycle level

KPIs should include:

- Active birds
- Active fish
- Current estimated fish biomass
- Eggs produced today
- Egg trays produced this month
- Poultry mortality rate
- Fish mortality rate
- Feed used today
- Feed inventory
- Average body weight
- Feed conversion ratio
- Current production expenses
- Sales revenue
- Profitability

Create interactive visualizations for production and finances.

Allow filtering by farm, batch, date range, animal type, and production cycle.

Enable exports to PDF, Excel, and CSV.

## 15. Alerts and Task Management

Implement actionable alerts for:

- Low feed inventory
- Expiring inventory
- Unusual mortality
- Feed consumption anomalies
- Poor FCR
- Poor egg production
- Production deviations
- Water quality concerns
- Upcoming harvest
- Feed procurement
- Equipment maintenance
- Scheduled veterinary activities

Support in-app notifications and a notification architecture that can later support email, SMS, WhatsApp, and push notifications.

Do not present automated alerts as veterinary diagnoses.

## 16. Spreadsheet Import and Migration

Build an import process that recognizes the original three supplied Excel files.

Do not require the farmer to manually copy every cell.

Implement:

1. Workbook inspection
2. Sheet identification
3. Column mapping
4. Formula and calculation mapping
5. Nutritional data extraction
6. Data type normalization
7. Unit normalization
8. Error detection
9. Preview before import
10. User confirmation
11. Import transaction
12. Import audit report

Store both the original imported data and normalized records.

For the formulation workbook, support nutritional requirements, ingredient inclusion limits, raw-material nutrient composition, and recipe data.

For projections, allow users to save an existing Excel scenario as a baseline.

Flag:

- Blank prices
- Zero prices of unknown meaning
- Invalid nutrient concentrations
- Ambiguous percentage formats
- Mixed decimal separators
- Questionable nutrient values
- Unrecognized ingredient aliases
- Circular or unsupported formulas
- Inconsistent quantities

Never silently invent missing scientific reference values.

## 17. Data Model

Design a normalized relational database.

Expected entities include:

- organizations
- subscriptions
- organization_users
- roles
- role_permissions
- farms
- farm_units
- poultry_houses
- flocks
- broiler_batches
- poultry_daily_records
- poultry_weight_samples
- egg_collections
- egg_grades
- fish_ponds
- fish_stocking_batches
- fish_sampling_records
- pond_water_quality
- fish_stock_movements
- mortality_records
- species
- production_stages
- nutrient_definitions
- nutrient_requirement_profiles
- ingredients
- ingredient_nutrient_profiles
- ingredient_prices
- ingredient_restrictions
- feed_formulas
- feed_formula_versions
- feed_formula_ingredients
- feed_formula_nutrient_results
- formulation_optimization_runs
- feed_batches
- warehouses
- inventory_items
- inventory_lots
- inventory_movements
- suppliers
- purchase_orders
- purchase_order_items
- customers
- sales
- sale_items
- expenses
- payments
- financial_ledger_entries
- forecasts
- forecast_scenarios
- health_records
- treatment_records
- farm_tasks
- notifications
- import_jobs
- import_validation_issues
- audit_logs

Add other entities where necessary.

Include appropriate constraints, foreign keys, indexes, timestamps, organization ownership, and historical snapshots.

Use fixed-point decimals for financial values and quantities where needed.

## 18. User Experience Requirements

Design for farmers with different technology skill levels.

The application must be professional without being complicated.

Features:

- Responsive desktop, tablet, and mobile layouts
- Clean sidebar navigation
- Easy-to-read dashboard
- Fast data entry
- Spreadsheet-style editors
- Bulk editing
- Searchable ingredient selection
- Clear validation messages
- Inline calculated totals
- Autosaved drafts
- Confirmation for destructive actions
- Print-ready reports
- Accessible contrast and controls
- Loading and empty states
- Meaningful error recovery

Use a modern agricultural brand aesthetic featuring forest green, warm neutrals, and restrained gold accents.

Provide light and dark modes.

Prioritize quick workflows for farm workers entering daily production information on mobile devices.

## 19. Commercial SaaS Features

The system must support future commercialization.

Prepare subscription plans such as:

- Free
- Starter
- Professional
- Enterprise

Potential plan limits:

- Number of farms
- Number of users
- Number of active flocks
- Number of ponds
- Optimization runs
- Historical reports
- Data exports
- Advanced analytics

Keep these limits configuration-driven.

Do not integrate live payment collection until authorized.

Support future subscription billing without requiring a database redesign.

## 20. Security and Reliability

Requirements:

- Secure authentication
- Server-side authorization
- Strong Row-Level Security
- Tenant isolation
- Input validation
- Audit logs
- Safe file uploads
- Idempotent stock movements
- Transactional inventory updates
- Idempotent financial posting
- No hard-coded secrets
- Rate limiting where necessary
- Backups and recovery planning
- Clear handling of concurrent edits
- Structured error logs

Maintain data integrity when several staff members work on the same farm simultaneously.

## 21. Testing and Scientific Accuracy

Treat calculations as critical business logic.

Build automated tests for:

- Feed formula nutrient contributions
- Ingredient percentage totals
- Feed costs
- Batch scaling
- Solver feasibility
- Solver optimality within tolerance
- Solver infeasibility
- Weekly layer feed projections
- Layer mortality
- Egg production
- Egg tray conversions
- Daily vs monthly egg calculations
- Broiler weight gain
- Broiler FCR
- Broiler production costs
- Fish biomass
- Catfish feeding allowance
- Specific growth rate
- Harvest economics
- Inventory valuation
- Financial reporting
- Tenant isolation

Where practical, create reference tests using verified examples from the uploaded spreadsheets.

A calculation should be deterministic, reproducible, and traceable to its input data and model version.

## 22. Implementation Phases

Implement the system in controlled phases.

### Phase 0 — Analysis and Architecture

- Examine the uploaded Excel workbooks
- Inventory every useful worksheet and calculation
- Map workbook fields into the data model
- Identify data inconsistencies
- Write a full product requirements document
- Design the database
- Create the implementation plan
- Define scientific validation requirements
- Establish the project structure

### Phase 1 — Core Platform

- Authentication
- Multi-tenant organization management
- Farm registration
- Role-based access
- Farm setup
- Dashboard foundation
- Design system
- Initial database migrations

### Phase 2 — Feed Formulation

- Ingredient database
- Nutrient requirements
- Formula editor
- Nutrient calculations
- Cost calculations
- Formula validation
- Recipe saving
- Batch scaling
- Spreadsheet data import

### Phase 3 — Feed Optimization

- Least-cost solver
- Nutrient constraints
- Inclusion limits
- Feasibility checks
- Price comparisons
- Formula versioning
- Mixing reports

### Phase 4 — Layers

- Layer flock management
- Rearing and feed projections
- Daily egg collections
- Egg production forecasting
- Egg inventory
- Layer analytics
- Cost tracking

### Phase 5 — Broilers

- Batch management
- Growth monitoring
- Weight sampling
- Feed projections
- FCR
- Health records
- Harvest forecasting
- Profitability

### Phase 6 — Catfish

- Pond management
- Stocking records
- Biomass estimates
- Feeding programs
- Growth monitoring
- Water quality
- Harvest planning
- Profitability

### Phase 7 — Integrated Operations

- Inventory
- Procurement
- Production costing
- Sales
- Finance
- Notifications
- Tasks

### Phase 8 — Advanced Analytics

- Scenario forecasting
- Cross-farm comparison
- Management reports
- Advanced exports
- Performance benchmarking

### Phase 9 — SaaS Readiness

- Subscriptions
- Plan entitlements
- Platform administration
- Security audit
- Load testing
- Production monitoring
- Deployment documentation

## 23. Mandatory Development Workflow

Follow these rules:

1. Inspect the existing repository before making implementation decisions.
2. Preserve existing functioning code.
3. Create architecture and database documentation first.
4. Build in the phase order above.
5. Use production-quality TypeScript and maintainable service boundaries.
6. Never build only decorative pages with fake metrics.
7. All dashboards must use real database records or explicitly labeled demonstration data.
8. Implement genuine calculations, not hard-coded results.
9. Use transactional database operations for stock and financial records.
10. Add automated tests for each module.
11. Apply security checks throughout development.
12. Keep migrations reversible where feasible and use safe deployment procedures.
13. Validate nutrition-related calculations against trusted references and the approved input profiles.
14. Record assumptions and source references.
15. Never automatically overwrite historical farm records.
16. Provide clear phase completion reports.
17. Run relevant tests, linting, and builds before declaring a phase complete.
18. Do not claim any feature is production-ready until its acceptance criteria pass.

## 24. Definition of Success

The completed platform must allow a farmer to:

1. Register a farm.
2. Create a layer flock, broiler batch, or catfish pond.
3. Select or formulate animal feed.
4. Determine feed costs and quantities.
5. Forecast production.
6. Record daily farm activity.
7. Track feed, stock, and inventory.
8. Record sales and operational expenses.
9. Measure production efficiency.
10. Forecast profitability.
11. Generate professional reports.
12. Compare performance across production cycles.

A new farm must be able to complete an entire production cycle within the platform without relying on an external spreadsheet.

## 25. Immediate Codex Assignment

Begin with Phase 0.

Inspect all three attached Excel workbooks in detail.

Create:

- `docs/PRODUCT_REQUIREMENTS.md`
- `docs/WORKBOOK_ANALYSIS.md`
- `docs/FORMULA_SPECIFICATIONS.md`
- `docs/DATABASE_ARCHITECTURE.md`
- `docs/IMPLEMENTATION_ROADMAP.md`
- `docs/SCIENTIFIC_DATA_VALIDATION.md`
- `docs/TEST_STRATEGY.md`

Pay particular attention to the existing feed formulation workbook, which already contains broiler starter and finisher calculations.

Identify every meaningful calculation, numerical assumption, nutrient specification, input, and expected output.

Describe the correct formulas and where changes are required.

Then initialize the project and implement Phase 1 as an operational foundation.

At the completion of Phase 1, provide:

- Implemented features
- Database changes
- Screens completed
- Tests executed
- Outstanding limitations
- Next phase implementation priorities

Continue toward the complete product through the defined phases, implementing and verifying working features rather than stopping at design documentation.

The ultimate objective is to create a reliable, commercially viable agricultural management SaaS platform suitable for Nigerian farmers and scalable to international agricultural businesses.

## 4. Recommended development priorities

Although the full platform is comprehensive, I recommend prioritizing the features that immediately improve a farmer's productivity.

First: Feed Formulation Studio

Build this to a professional standard, including nutrient calculations, ingredient prices, batch formulation, and least-cost optimization. Feed is a major production cost, so improvements here can deliver immediate value.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.poultryhub.org\&sz=32)

Poultry Hub Australia



Second: Layers and Broilers

Implement feed projections, egg production, growth monitoring, FCR, mortality, sales, and production profitability.

Third: Catfish Management

Introduce biomass calculations, feeding schedules, pond management, water quality, and harvest economics.

Fourth: Integrated Farm Accounting and SaaS

Connect production data to inventory, procurement, financial statements, reporting, and commercial subscriptions.

## 5. How to start with Codex

Create a new GitHub repository for this project and provide Codex with the master prompt above alongside the three original Excel files. The spreadsheet files are essential because the prompt describes their logic, but Codex needs the actual workbooks to extract and test the calculations.

I would also make the first release usable by a real farmer before introducing subscriptions or AI features. The core selling point should be accurate agricultural calculations, reliable farm records, and demonstrable savings.

One final consideration: because this combines your agricultural expertise with software engineering, the long-term opportunity is more than a farming calculator. It could become a Nigerian agribusiness operations platform used by individual farmers, commercial poultry farms, catfish farms, feed mills, and agricultural consultants.

The master prompt establishes that foundation.&#x20;