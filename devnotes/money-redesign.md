# Money Budget Redesign — Design Decisions

Captured from design discussion 2026-07-04. Companion to `planned-changes.md` (time side).

## ✅ IMPLEMENTED 2026-07-04/05

All of v1 is built and verified in-browser against the Testing budget:
- Data layer: `money_plans` + `money_rules` tables/stores wired through server.js, db.js
  (DB_VERSION 6), sync.js; categories gained `nature`/`goalBalance`/`location`;
  transactions gained `account`/`ruleId`. Migration converted rollover categories → funds
  and seeded the current month's plan from `targetAmount`.
- MoneyHome: pipeline strip → Income/Planned/Free headline → Plan vs Actual →
  Funds (balances, goal progress, Adjust, checking floor) → spending breakdown.
- MoneyPlan (`/budget/:id/plan`): per-month editor, copy-from-previous-month
  (fills empty rows only).
- MoneyCategories: Flow/Fund toggle, goal balance + location for funds.
- Transactions: mark-as-transfer toggle, transfer/adjustment/auto badges, account tag,
  rules manager (+rule-from-transaction shortcut).
- ImportOFX: applies rules at import, account-aware fitid dedup, import preview shows
  rule effects.

Not yet exercised with real data: an actual OFX import with rules/accounts, and the CC
payoff flow — verify on the next real bank import.

## Why

The money side reuses the time-budget framework and it shows. Actual Budget was tried and
rejected for two reasons that define this design:

1. **Zero-based budgeting is too much upkeep and the wrong model.** Actual refuses to let
   money stay uncategorized/unassigned. The desired model is the opposite: *partial
   budgeting* — deliberately set aside what needs setting aside, and the rest is free money
   the app never nags about. Free money is a feature, not an error state.
2. **Goal shapes are too rigid.** Not everything is a monthly spending cap. Some categories
   are accumulating funds with balances that live across months and years.

## Core Concepts

### 1. Two natures of category

**Flow categories** — groceries, eating out, fun money. Live within the month, reset every
month. Optional `minAmount` / `maxAmount` per month (same shape as the time side's
`minHours`/`maxHours`):
- max only — "don't exceed" (most spending)
- min only — "put aside at least" (e.g. savings contribution)
- both — a range
- neither — just tracked/watched, appears in breakdowns but has no goal status

**Funds** — medical, car, emergency, gifts. Accumulate a **balance** over time:

> balance = manual adjustments + all transactions ever categorized to the fund

- A planned **monthly contribution** ("set aside €100/mo") smooths lumpy expenses
  (medical is high in January, low the rest of the year — the fund absorbs it).
- Optional **goal balance** ("€X,000 for a car", "€Y emergency floor"). When collected,
  spending from the fund is normal and expected.
- **Adjustable balance**: derived from transactions, but a manual adjustment ("set balance
  to €1,450") can be added anytime — used for the starting amount and to fix drift
  against the bank.
- **Location** (per fund): *earmarked* (money physically stays in checking) or *real*
  (a savings-account bucket at the bank). The math is identical; the distinction powers
  the **checking floor**: sum of earmarked fund balances = "keep at least this much in
  the account so anything can be handled without thinking." Medical and excess fun money
  are earmarks; emergency fund and long-term goals live in real savings buckets.

**Funds replace the `rollover` flag.** Rollover isn't a flag on a monthly category; it's
what funds *are*. Existing rollover-enabled categories migrate to funds.

### 2. Savings mirror (no savings account import)

The savings account is never imported or interfaced with. Funds with location *real* are a
manual mirror of the bank's buckets. Transfers to savings get categorized to a fund
(incrementing its balance); drift is fixed with a balance adjustment during review.

### 3. Monthly plans — copy from a previous month

- Targets do **not** live statically on the category anymore. Each month has its own plan
  (per-category min/max + fund contributions).
- No named templates (decided 2026-07-04: less friction without them). Setting up a month
  is an explicit, lightweight step: **copy any previous month's plan, then adjust**.
  Any month can deviate freely (September weirdness stays in September) without touching
  other months.
- Parallel to the time side's copy-from-previous-week — same mental model, and the schema
  should rhyme with `periodOverrides`.

### 4. Income and free money

Headline of the month once a plan is set:

> Income €3,200 · Planned €2,100 · **Free €1,100**

"Planned" = sum of flow maxes/mins committed + fund contributions. Free money is shown
positively — the whole point of partial budgeting.

### 5. Accounts-lite

- No per-account ledgers, balances, or reconciliation. Transactions carry a **source
  account tag** (from the import) for dedup and filtering only.
- **Credit card**: import both bank and CC statements. CC purchases are the truth
  (categorized individually). The monthly payoff on the bank statement is neutralized —
  marked as a transfer, not spending — so nothing double-counts. Detection can be
  suggested (payee/amount match) but confirmation is explicit.

### 6. Categorization rules — explicit only

Current per-row dropdown flow is fine; volume is low. Add **user-created rules**
("payee contains ALBERT HEIJN → Groceries") applied at import. Rules are always explicitly
created by the user — never silently learned — and imported transactions matched by a rule
should be visibly marked so they can be reviewed.

## The Monthly Ritual (drives the home screen)

The month is a four-step pipeline, and the money home should reflect where you are in it:

1. **Import** — upload OFX file(s) (bank + CC)
2. **Plan** — copy a previous month's plan, make adjustments (skippable if already done)
3. **Categorize** — triage the uncategorized queue (rules pre-handle the known payees)
4. **Review** — the results:
   - **"Where did it all go?"** — spending breakdown for the month
   - **"Did I stick to the plan?"** — per-category actual vs min/max with goal-direction
     coloring (a min-category exceeded is green, not red)
   - Fund health — balances vs goal balances, checking floor total

The home screen surfaces pipeline state ("no plan chosen for July", "7 uncategorized")
rather than assuming the ritual is done.

## Migration Notes

- `moneyCategories.targetAmount` → seeds the current month's plan rows (as maxAmount);
  monthly plan rows replace it as the live source of targets.
- `rollover: 1` categories → convert to funds (location: earmarked by default).
- Existing transactions untouched; `trntype: 'transfer'` mechanism reused for CC payoff
  neutralization.

## Resolved Mechanics (2026-07-04, implementation session)

- **Fund contributions are virtual for ALL funds** (earmarked and real). The monthly plan
  row's `contribution` accrues into the fund balance automatically for every month that
  has a plan. Real bank transfers to savings are neutralized (marked as transfer) exactly
  like the CC payoff — they are not categorized to the fund. Drift between plan and
  reality is fixed with a balance adjustment during review.
- **Fund balance** = Σ plan contributions (months with a plan, ≤ current) + manual
  adjustments + Σ transactions categorized to the fund (expenses negative, refunds
  positive, in-app transfer legs count). Adjustments are transactions with
  `trntype: 'ADJUSTMENT'` ("set balance to X" computes the delta); excluded from
  income/spending math.
- **Income** = positive transactions this month, excluding transfers and adjustments,
  regardless of category (uncategorized income counts — resolved by sign).
- **Planned** = Σ flow commitments (`maxAmount ?? minAmount` per flow category with a
  plan row) + Σ fund contributions. Free = Income − Planned.
- **Plan storage**: new `moneyPlans` store / `money_plans` table:
  `{id, budgetId, categoryId, monthStart (YYYY-MM-01), minAmount, maxAmount,
  contribution, deleted, createdAt, updatedAt}`. A month "has a plan" if ≥1 row exists.
  Min/max/contribution live ONLY here, per month — not on the category.
- **Category fields**: `nature` ('flow' | 'fund'), and for funds `goalBalance` (nullable)
  and `location` ('earmarked' | 'real'). `targetAmount` and `rollover` become legacy.
- **Rules**: `moneyRules` store / `money_rules` table:
  `{id, budgetId, match (case-insensitive substring vs payee+memo), categoryId (nullable),
  markTransfer (0/1), deleted, createdAt, updatedAt}`. Applied client-side at import;
  matched transactions carry `ruleId` so the UI can badge them as auto-categorized.
- **Account tag**: OFX parser extracts ACCTID; transactions get an `account` column.
  Import dedup key becomes account+fitid.
- **In-app transfers stay** — with funds virtual they're mainly for fund-to-fund moves.
  Spending math already excludes transfer legs; fund balances include them.
- Checking floor = Σ balances of earmarked funds, shown in the fund section.

## Open Questions (later)

- Does the spending breakdown need history context ("was this month normal?") in v1, or
  is that a later reporting layer? → later reporting layer.
- Auto-suggestion for CC payoff detection (payee/amount match) — v1 ships a manual
  "mark as transfer" toggle plus rules with `markTransfer`; smarter suggestion later.
