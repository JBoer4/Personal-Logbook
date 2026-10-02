// Self-check for plan-as-membership: which categories a month shows, and the
// running fund balance that keeps a funded category visible. Run: node test-members.mjs
import assert from 'node:assert';
import fs from 'node:fs';

// package.json is CJS (server.js uses require), so a plain .js import would be
// treated as CommonJS. utils.js has no imports of its own, so load it as a
// data-URL ES module instead of retyping the package as a module.
const src = fs.readFileSync(new URL('./public/js/utils.js', import.meta.url), 'utf8');
const { fundBalances, monthMembers } =
  await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const cats = [
  { id: 'groceries', name: 'Groceries', nature: 'flow', parentId: null },
  { id: 'living', name: 'Living', nature: 'flow', parentId: null },
  { id: 'everyday', name: 'Everyday', nature: 'flow', parentId: 'living' },
  { id: 'car', name: 'Car', nature: 'fund', parentId: null },
  { id: 'spent', name: 'Spent fund', nature: 'fund', parentId: null },
  { id: 'retired', name: 'Retired', nature: 'flow', parentId: null },
];

const plans = [
  { categoryId: 'groceries', monthStart: '2026-09-01', maxAmount: 400 },
  { categoryId: 'car', monthStart: '2026-08-01', contribution: 333 },
  { categoryId: 'car', monthStart: '2026-09-01', contribution: 333 },
  { categoryId: 'car', monthStart: '2026-10-01', contribution: 333 }, // future month
];

const txns = [
  { categoryId: 'everyday', amount: -20, date: '2026-09-04' },
  { categoryId: 'spent', amount: +50, date: '2026-08-02' },
  { categoryId: 'spent', amount: -50, date: '2026-08-20' }, // fully spent: nets to 0
  { categoryId: 'purged', amount: -75, date: '2026-09-06' }, // identity no longer exists
  { categoryId: 'retired', amount: -10, date: '2026-01-09' }, // only in a closed month
];

// --- fundBalances: contributions stop at the shown month, transactions all count
const sept = fundBalances(cats, plans, txns, '2026-09-01');
assert.equal(sept.car, 666, 'Aug + Sep contributions, not the future one');
assert.equal(sept.spent, 0, 'a fund spent back to zero holds nothing');
assert.equal(sept.groceries, undefined, 'flow categories get no balance');

// --- monthMembers: the plan is the membership list
const septPlans = plans.filter(p => p.monthStart === '2026-09-01');
const septTxns = txns.filter(t => t.date.startsWith('2026-09'));
const m = monthMembers(cats, septPlans, septTxns, sept);

assert.ok(m.has('groceries'), 'a plan row puts a category in the month');
assert.ok(m.has('everyday'), 'so does spending on it with no plan row');
assert.ok(m.has('living'), 'ancestors come along so the tree can nest');
assert.ok(m.has('car'), 'a fund holding money stays in the month');
assert.ok(!m.has('spent'), 'a fund at zero with no contribution drops out');
assert.ok(!m.has('retired'), 'last used in January, so not in September');
assert.ok(!m.has('purged'), 'a purged identity never becomes a member again');

// --- a closed month still resolves its own rows
const jan = monthMembers(cats, [], txns.filter(t => t.date.startsWith('2026-01')),
  fundBalances(cats, plans, txns, '2026-01-01'));
assert.ok(jan.has('retired'), 'January still shows what January spent');
assert.ok(!jan.has('groceries'), 'and not what September planned');

console.log('membership checks passed');
