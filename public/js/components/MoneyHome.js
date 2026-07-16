import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation, useSyncRefresh } from '../sync.js';
import {
  uuid, now, today, getMonthDates, getMonthLabel, offsetMonthDate, formatCurrency,
  buildCategoryTree, flattenCategoryTree, rollUpToParents,
  TRN_TRANSFER, TRN_ADJUSTMENT, isTransferTxn, isRealTxn, isFund, isEarmarkedFund, computePlanned,
} from '../utils.js';

export function MoneyHome({ budgetId }) {
  const [budget, setBudget] = useState(null);
  const [categories, setCategories] = useState([]);
  const [allTransactions, setAllTransactions] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [allPlans, setAllPlans] = useState([]);
  const [monthOffset, setMonthOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferFrom, setTransferFrom] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferDate, setTransferDate] = useState(() => today());
  const [adjustingFundId, setAdjustingFundId] = useState(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const nameRef = useRef(null);

  const monthDate = offsetMonthDate(monthOffset);
  const { start: monthStart, end: monthEnd } = getMonthDates(monthDate);
  const monthLabel = getMonthLabel(monthDate);

  async function load() {
    const b = await db.getBudget(budgetId);
    setBudget(b);

    const cats = await db.getCategories(budgetId);
    cats.sort((a, b) => a.sortOrder - b.sortOrder);
    setCategories(cats);

    const allTxns = await db.getTransactions(budgetId);
    setAllTransactions(allTxns);
    const monthTxns = allTxns.filter(t => t.date >= monthStart && t.date <= monthEnd);
    setTransactions(monthTxns);

    const plans = await db.getMoneyPlans(budgetId);
    setAllPlans(plans);
    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); }, [budgetId, monthOffset]);
  useSyncRefresh(load);

  async function renameBudget(newName) {
    if (!budget || !newName.trim()) return;
    const updated = { ...budget, name: newName.trim(), updatedAt: now() };
    await db.putBudget(updated);
    setBudget(updated);
    setEditing(false);
    syncAfterMutation();
  }

  async function deleteBudget() {
    const ts = now();
    const cats = await db.getCategories(budgetId);
    const txns = await db.getTransactions(budgetId);
    const plans = await db.getMoneyPlans(budgetId);
    for (const t of txns) await db.deleteTransaction(t.id, ts);
    for (const c of cats) await db.deleteCategory(c.id, ts);
    for (const p of plans) await db.deleteMoneyPlan(p.id, ts);
    await db.deleteBudget(budgetId, ts);
    syncAfterMutation();
    navigate('/');
  }

  async function saveTransfer() {
    const amount = parseFloat(transferAmount);
    if (!amount || amount <= 0) return;
    if (transferFrom === transferTo) return;

    const fromCatId = transferFrom === '__unallocated__' ? null : transferFrom || null;
    const toCatId = transferTo === '__unallocated__' ? null : transferTo || null;

    const catById = Object.fromEntries(categories.map(c => [c.id, c]));
    const fromName = fromCatId ? (catById[fromCatId]?.name || 'Category') : 'Unallocated';
    const toName = toCatId ? (catById[toCatId]?.name || 'Category') : 'Unallocated';

    const transferId = uuid();
    const ts = now();
    const base = { budgetId, date: transferDate, trntype: TRN_TRANSFER, transferId, createdAt: ts, updatedAt: ts };

    await db.putTransaction({ ...base, id: uuid(), categoryId: fromCatId, amount: -amount, payee: 'Transfer', memo: `→ ${toName}` });
    await db.putTransaction({ ...base, id: uuid(), categoryId: toCatId, amount: +amount, payee: 'Transfer', memo: `← ${fromName}` });

    await syncAfterMutation();
    setShowTransfer(false);
    setTransferAmount('');
    load();
  }

  async function saveFundAdjustment(fundId, currentBalance) {
    const newBalance = parseFloat(adjustAmount);
    if (isNaN(newBalance)) return;
    const delta = newBalance - currentBalance;
    if (delta !== 0) {
      const ts = now();
      await db.putTransaction({
        id: uuid(),
        budgetId,
        categoryId: fundId,
        date: today(),
        amount: delta,
        payee: 'Balance adjustment',
        memo: '',
        fitid: '',
        trntype: TRN_ADJUSTMENT,
        createdAt: ts,
        updatedAt: ts,
      });
      await syncAfterMutation();
    }
    setAdjustingFundId(null);
    setAdjustAmount('');
    load();
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  const tree = buildCategoryTree(categories);
  const flat = flattenCategoryTree(tree);

  // Transaction buckets for this month.
  const monthTransfers = transactions.filter(isTransferTxn);
  const monthReal = transactions.filter(isRealTxn);

  // This month's plan rows
  const monthPlans = allPlans.filter(p => p.monthStart === monthStart);
  const hasPlan = monthPlans.length > 0;
  const planByCat = Object.fromEntries(monthPlans.map(p => [p.categoryId, p]));

  // Headline figures
  const income = monthReal.reduce((s, t) => t.amount > 0 ? s + t.amount : s, 0);
  const planned = computePlanned(monthPlans, catById);
  const free = income - planned;

  // Spending per category — real negative transactions, with parent rollup
  const direct = {};
  let uncategorizedSpending = 0;
  for (const cat of categories) direct[cat.id] = 0;
  for (const t of monthReal) {
    if (t.amount >= 0) continue;
    const amt = Math.abs(t.amount);
    if (t.categoryId && direct[t.categoryId] !== undefined) {
      direct[t.categoryId] += amt;
    } else {
      uncategorizedSpending += amt;
    }
  }
  const totals = rollUpToParents(direct, catById);
  const maxSpending = Math.max(...flat.map(({ cat }) => totals[cat.id] || 0), uncategorizedSpending, 1);
  const hasSpending = uncategorizedSpending > 0 || flat.some(({ cat }) => (totals[cat.id] || 0) > 0);

  // Flow categories with a min or max commitment this month (tree order)
  const flowRows = flat.filter(({ cat }) => {
    if (isFund(cat)) return false;
    const p = planByCat[cat.id];
    return p && (p.minAmount != null || p.maxAmount != null);
  });

  // Funds are timeless: balance = all plan contributions up to and including the
  // shown month + every transaction ever categorized to the fund (signed, all
  // types — expenses, refunds, transfer legs, and balance adjustments).
  const fundList = flat.filter(({ cat }) => isFund(cat));
  const fundBalances = {};
  const fundMonthActivity = {};
  for (const { cat } of fundList) { fundBalances[cat.id] = 0; fundMonthActivity[cat.id] = 0; }
  for (const p of allPlans) {
    if (fundBalances[p.categoryId] !== undefined && p.monthStart <= monthStart) {
      fundBalances[p.categoryId] += p.contribution || 0;
    }
  }
  for (const t of allTransactions) {
    if (fundBalances[t.categoryId] !== undefined) fundBalances[t.categoryId] += t.amount;
  }
  for (const t of transactions) {
    if (fundMonthActivity[t.categoryId] !== undefined) fundMonthActivity[t.categoryId] += t.amount;
  }
  const checkingFloor = fundList
    .filter(({ cat }) => isEarmarkedFund(cat))
    .reduce((s, { cat }) => s + (fundBalances[cat.id] || 0), 0);

  // Pipeline: uncategorized real transactions this month
  const uncatCount = monthReal.filter(t => !t.categoryId).length;

  // Deduplicate transfers by transferId for display
  const transferPairs = [];
  const seenTransferIds = new Set();
  for (const t of monthTransfers) {
    if (!t.transferId || seenTransferIds.has(t.transferId)) continue;
    seenTransferIds.add(t.transferId);
    const legs = monthTransfers.filter(x => x.transferId === t.transferId);
    const debit = legs.find(x => x.amount < 0);
    const credit = legs.find(x => x.amount > 0);
    if (debit && credit) {
      const fromName = debit.categoryId ? (catById[debit.categoryId]?.name || 'Category') : 'Unallocated';
      const toName = credit.categoryId ? (catById[credit.categoryId]?.name || 'Category') : 'Unallocated';
      transferPairs.push({ transferId: t.transferId, date: debit.date, fromName, toName, amount: credit.amount });
    }
  }

  const transferOptions = [
    html`<option value="__unallocated__">Unallocated</option>`,
    ...flat.map(({ cat, depth }) => html`<option value=${cat.id}>${'  '.repeat(depth)}${cat.name}</option>`)
  ];

  const isEmpty = transactions.length === 0 && !hasPlan;

  return html`
    <div class="budget-home">
      <div class="budget-title-row">
        ${editing ? html`
          <input class="budget-title-input" type="text" ref=${nameRef}
            value=${budget?.name || ''}
            onKeyDown=${(e) => { if (e.key === 'Enter') renameBudget(e.target.value); if (e.key === 'Escape') setEditing(false); }}
            onBlur=${(e) => renameBudget(e.target.value)} />
        ` : html`
          <h2 class="budget-title" onClick=${() => { setEditing(true); setTimeout(() => nameRef.current?.select(), 0); }}>
            ${budget?.name || 'Budget'}
          </h2>
        `}
        <button class="budget-delete-btn" onClick=${() => setConfirmDelete(true)}>Delete</button>
      </div>

      ${confirmDelete && html`
        <div class="confirm-bar">
          <span>Delete this budget and all its data?</span>
          <button class="btn btn-danger" onClick=${deleteBudget}>Yes, delete</button>
          <button class="btn btn-secondary" onClick=${() => setConfirmDelete(false)}>Cancel</button>
        </div>
      `}

      <div class="month-nav">
        <button class="nav-arrow" onClick=${() => setMonthOffset(m => m - 1)}>‹</button>
        <span class="month-label">${monthLabel}</span>
        <button class="nav-arrow" onClick=${() => setMonthOffset(m => m + 1)}>›</button>
      </div>

      ${isEmpty && html`
        <div class="empty-state">
          <p>No transactions or plan for this month</p>
          <button class="btn" onClick=${() => navigate('/budget/' + budgetId + '/import')}>Import OFX File</button>
          <button class="btn btn-secondary" onClick=${() => navigate('/budget/' + budgetId + '/plan')}>Set Up Plan</button>
        </div>
      `}

      ${!isEmpty && html`
        <div class="pipeline-strip">
          ${transactions.length === 0 ? html`
            <button class="pipeline-todo" onClick=${() => navigate('/budget/' + budgetId + '/import')}>
              No transactions — import
            </button>
          ` : html`
            <span class="pipeline-done">Imported ✓</span>
          `}
          ${hasPlan ? html`
            <button class="pipeline-done" onClick=${() => navigate('/budget/' + budgetId + '/plan')}>Plan ✓</button>
          ` : html`
            <button class="pipeline-todo" onClick=${() => navigate('/budget/' + budgetId + '/plan')}>
              No plan for ${monthLabel} — set one up
            </button>
          `}
          ${monthReal.length > 0 && (uncatCount > 0 ? html`
            <button class="pipeline-todo" onClick=${() => navigate('/budget/' + budgetId + '/transactions')}>
              ${uncatCount} uncategorized
            </button>
          ` : html`
            <span class="pipeline-done">Categorized ✓</span>
          `)}
        </div>

        ${hasPlan && html`
          <div class="money-headline">
            <div class="headline-item">
              <span class="headline-label">Income</span>
              <span class="headline-value">${formatCurrency(income)}</span>
            </div>
            <div class="headline-item">
              <span class="headline-label">Planned</span>
              <span class="headline-value">${formatCurrency(planned)}</span>
            </div>
            <div class="headline-item headline-hero">
              <span class="headline-label">Free</span>
              <span class="headline-value ${free >= 0 ? 'free-pos' : 'free-neg'}">${formatCurrency(free)}</span>
            </div>
          </div>
        `}

        ${flowRows.length > 0 && html`
          <div class="budget-vs-actual">
            <h3>Plan vs Actual</h3>
            ${flowRows.map(({ cat, depth }) => {
              const p = planByCat[cat.id];
              const min = p.minAmount;
              const max = p.maxAmount;
              const spent = totals[cat.id] || 0;
              // Goal-direction status: max = ceiling, min = floor, both = range
              let good;
              if (min != null && max != null) good = spent >= min && spent <= max;
              else if (max != null) good = spent <= max;
              else good = spent >= min;
              const bound = max ?? min;
              const boundLabel = (min != null && max != null)
                ? `${formatCurrency(min)}–${formatCurrency(max)}`
                : formatCurrency(bound);
              const barPct = Math.min((spent / Math.max(bound, 0.01)) * 100, 150);
              return html`
                <div class="bva-row" key=${cat.id}>
                  <div class="bva-label" style=${{ paddingLeft: `${depth * 1.2}rem` }}>
                    <span class="bva-dot" style=${{ background: cat.color }}></span>
                    <span class="bva-name">${cat.name}</span>
                  </div>
                  <div class="bva-bar-wrap">
                    <div class="bva-bar" style=${{ width: `${Math.min(barPct, 100)}%`, background: cat.color }}></div>
                    ${barPct > 100 && html`<div class="bva-bar-over" style=${{
                      width: `${barPct - 100}%`,
                      background: cat.color,
                      opacity: 0.4,
                    }}></div>`}
                  </div>
                  <div class="bva-nums ${good ? 'net-positive' : 'net-negative'}">
                    ${formatCurrency(spent)} / ${boundLabel}
                  </div>
                </div>
              `;
            })}
          </div>
        `}

        ${fundList.length > 0 && html`
          <div class="funds-section">
            <h3>Funds</h3>
            ${fundList.map(({ cat }) => {
              const bal = fundBalances[cat.id] || 0;
              const goal = cat.goalBalance;
              const contrib = planByCat[cat.id]?.contribution;
              const monthActivity = fundMonthActivity[cat.id] || 0;
              const goalPct = goal > 0 ? Math.min(Math.max(bal / goal, 0) * 100, 100) : 0;
              return html`
                <div class="fund-card" key=${cat.id}>
                  <div class="fund-card-head">
                    <span class="bva-dot" style=${{ background: cat.color }}></span>
                    <span class="fund-name">${cat.name}</span>
                    <span class="fund-location">${isEarmarkedFund(cat) ? 'earmarked' : 'savings'}</span>
                    <span class="fund-balance ${bal < 0 ? 'free-neg' : ''}">${formatCurrency(bal)}</span>
                    <button class="fund-adjust-btn"
                      onClick=${() => { setAdjustingFundId(cat.id); setAdjustAmount(bal.toFixed(2)); }}>
                      Adjust
                    </button>
                  </div>
                  ${adjustingFundId === cat.id && html`
                    <div class="fund-adjust-form">
                      <label class="fund-adjust-label">Set balance to $</label>
                      <input class="fund-adjust-input" type="number" step="0.01"
                        value=${adjustAmount} onInput=${(e) => setAdjustAmount(e.target.value)} />
                      <button class="btn btn-secondary" onClick=${() => { setAdjustingFundId(null); setAdjustAmount(''); }}>Cancel</button>
                      <button class="btn" onClick=${() => saveFundAdjustment(cat.id, bal)}>Save</button>
                    </div>
                  `}
                  ${goal > 0 && html`
                    <div class="fund-goal">
                      <div class="fund-goal-bar-wrap">
                        <div class="fund-goal-bar" style=${{ width: `${goalPct}%`, background: 'var(--teal)' }}></div>
                      </div>
                      <span class="fund-goal-label">${formatCurrency(bal)} of ${formatCurrency(goal)}</span>
                    </div>
                  `}
                  ${(contrib || monthActivity !== 0) && html`
                    <div class="fund-meta">
                      ${contrib ? html`<span>+${formatCurrency(contrib)}/mo planned</span>` : null}
                      ${monthActivity !== 0 ? html`<span>this month: ${monthActivity > 0 ? '+' : ''}${formatCurrency(monthActivity)}</span>` : null}
                    </div>
                  `}
                </div>
              `;
            })}
            ${checkingFloor > 0 && html`
              <div class="checking-floor">
                Checking floor: <strong>${formatCurrency(checkingFloor)}</strong>
                <span class="checking-floor-hint">keep at least this in checking</span>
              </div>
            `}
          </div>
        `}

        ${hasSpending && html`
          <div class="spending-chart">
            <h3>Spending by Category</h3>
            ${flat.map(({ cat, depth }) => {
              const spent = totals[cat.id] || 0;
              if (spent === 0) return null;
              const pct = (spent / maxSpending) * 100;
              return html`
                <div class="spending-row" key=${cat.id}>
                  <div class="spending-label" style=${{ paddingLeft: `${depth * 1.2}rem` }}>
                    <span class="spending-dot" style=${{ background: cat.color }}></span>
                    <span class="spending-name">${cat.name}</span>
                  </div>
                  <div class="spending-bar-wrap">
                    <div class="spending-bar" style=${{ width: `${pct}%`, background: cat.color }}></div>
                  </div>
                  <span class="spending-amount">${formatCurrency(spent)}</span>
                </div>
              `;
            })}
            ${uncategorizedSpending > 0 && html`
              <div class="spending-row">
                <div class="spending-label">
                  <span class="spending-dot" style=${{ background: '#555' }}></span>
                  <span class="spending-name">Uncategorized</span>
                </div>
                <div class="spending-bar-wrap">
                  <div class="spending-bar" style=${{ width: `${(uncategorizedSpending / maxSpending) * 100}%`, background: '#555' }}></div>
                </div>
                <span class="spending-amount">${formatCurrency(uncategorizedSpending)}</span>
              </div>
            `}
          </div>
        `}

        ${transferPairs.length > 0 && html`
          <div class="transfers-section">
            <h3>Transfers</h3>
            ${transferPairs.map(tp => html`
              <div class="transfer-row" key=${tp.transferId}>
                <span>${tp.date} — ${tp.fromName} → ${tp.toName}</span>
                <span>${formatCurrency(tp.amount)}</span>
              </div>
            `)}
          </div>
        `}
      `}

      <div class="budget-actions">
        <button class="btn" onClick=${() => navigate('/budget/' + budgetId + '/import')}>Import</button>
        <button class="btn btn-secondary" onClick=${() => navigate('/budget/' + budgetId + '/transactions')}>Transactions</button>
        <button class="btn btn-secondary" onClick=${() => navigate('/budget/' + budgetId + '/categories')}>Categories</button>
        <button class="btn btn-secondary" onClick=${() => navigate('/budget/' + budgetId + '/plan')}>Plan</button>
        <button class="btn btn-secondary" onClick=${() => setShowTransfer(v => !v)}>Transfer</button>
      </div>

      ${showTransfer && html`
        <div class="transfer-form">
          <div class="transfer-form-row">
            <div class="transfer-form-field">
              <label>From</label>
              <select value=${transferFrom} onChange=${e => setTransferFrom(e.target.value)}>
                <option value="">-- select --</option>
                ${transferOptions}
              </select>
            </div>
            <div class="transfer-form-field">
              <label>To</label>
              <select value=${transferTo} onChange=${e => setTransferTo(e.target.value)}>
                <option value="">-- select --</option>
                ${transferOptions}
              </select>
            </div>
          </div>
          <div class="transfer-form-row">
            <div class="transfer-form-field">
              <label>Amount</label>
              <input type="number" min="0.01" step="0.01" placeholder="0.00"
                value=${transferAmount}
                onInput=${e => setTransferAmount(e.target.value)} />
            </div>
            <div class="transfer-form-field">
              <label>Date</label>
              <input type="date" value=${transferDate}
                onInput=${e => setTransferDate(e.target.value)} />
            </div>
          </div>
          <div class="transfer-form-actions">
            <button class="btn btn-secondary" onClick=${() => setShowTransfer(false)}>Cancel</button>
            <button class="btn" onClick=${saveTransfer}>Save</button>
          </div>
        </div>
      `}
    </div>
  `;
}
