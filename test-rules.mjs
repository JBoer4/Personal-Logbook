// Self-check for the shared rule matcher. Run: node test-rules.mjs
import assert from 'node:assert';
import fs from 'node:fs';

// package.json is CJS (server.js uses require), so a plain .js import would be
// treated as CommonJS. utils.js has no imports of its own, so load it as a
// data-URL ES module instead of retyping the package as a module.
const src = fs.readFileSync(new URL('./public/js/utils.js', import.meta.url), 'utf8');
const { applyRules, TRN_TRANSFER, isTransferTxn } =
  await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const rules = [
  { id: 'r1', match: 'ALBERT HEIJN', categoryId: 'groceries', markTransfer: 0, createdAt: 1 },
  { id: 'r2', match: 'PAYMENT THANK YOU', categoryId: null, markTransfer: 1, createdAt: 2 },
  { id: 'r3', match: 'heijn', categoryId: 'other', markTransfer: 0, createdAt: 3 },
];

// No match -> same object back, untouched.
const plain = { payee: 'SHELL', memo: '', categoryId: null, trntype: 'DEBIT' };
assert.strictEqual(applyRules(plain, rules), plain);

// Case-insensitive match across payee+memo, sets category and ruleId.
const g = applyRules({ payee: 'albert heijn 1234', memo: '', trntype: 'DEBIT' }, rules);
assert.strictEqual(g.categoryId, 'groceries');
assert.strictEqual(g.ruleId, 'r1');
assert.strictEqual(g.trntype, 'DEBIT', 'non-transfer rule must not touch trntype');

// First match wins by rule order, not specificity: r1 beats r3.
assert.strictEqual(applyRules({ payee: 'ALBERT HEIJN', memo: '' }, rules).ruleId, 'r1');

// markTransfer rule flips trntype and clears category.
const t = applyRules({ payee: 'PAYMENT THANK YOU', memo: '', categoryId: 'x', trntype: 'CREDIT' }, rules);
assert.ok(isTransferTxn(t));
assert.strictEqual(t.trntype, TRN_TRANSFER);
assert.strictEqual(t.categoryId, null);

// Matches on memo too, not just payee.
assert.strictEqual(applyRules({ payee: '', memo: 'ALBERT HEIJN' }, rules).ruleId, 'r1');

// Empty match string must never match everything.
assert.strictEqual(applyRules({ payee: 'X', memo: '' }, [{ id: 'bad', match: '', createdAt: 1 }]).ruleId, undefined);

console.log('rule matcher: all checks passed');
