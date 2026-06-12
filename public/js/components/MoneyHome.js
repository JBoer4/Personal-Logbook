import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation } from '../sync.js';
import { uuid, now, getMonthDates, getMonthLabel, formatCurrency, buildCategoryTree, flattenCategoryTree } from '../utils.js';

// Compute subtree targets: for each category, the sum of its own target plus all descendants' targets.
function buildSubtreeTargets(categories, catById) {
  const subtreeTargets = {};
  for (const cat of categories) subtreeTargets[cat.id] = cat.targetAmount || 0;
  for (const cat of categories) {
    if (!cat.parentId || !(cat.targetAmount > 0)) continue;
    let p = catById[cat.parentId];
    while (p) {
      subtreeTargets[p.id] = (subtreeTargets[p.id] || 0) + (cat.targetAmount || 0);
      p = p.parentId ? catById[p.parentId] : null;
    }
  }
  return subtreeTargets;
}

// Compute cumulative rollover from all months before currentMonthStart.
// Only accumulates for categories with rollover=1.
// Returns { [catId]: rolloverAmount }
function computeRollover(allTransactions, categories, catById, subtreeTargets, monthStart) {
  const rolloverByCat = {};
  for (const cat of categories) rolloverByCat[cat.id] = 0;

  const rolloverCats = categories.filter(c => c.rollover);
  if (rolloverCats.length === 0) return rolloverByCat;

  const past = allTransactions.filter(t => t.date < monthStart);
  if (past.length === 0) return rolloverByCat;

  // Find distinct month starts in past data
  const monthStarts = new Set();
  for (const t of past) {
    const d = new Date(t.date + 'T00:00:00');
    monthStarts.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
  }

  for (const ms of [...monthStarts].sort()) {
    const { start, end } = getMonthDates(new Date(ms + 'T00:00:00'));
    const monthTxns = past.filter(t => t.date >= start && t.date <= end);

    // Net per category for this past month (all transaction types)
    const net = {};
    for (const cat of categories) net[cat.id] = 0;
    for (const t of monthTxns) {
      if (t.categoryId && net[t.categoryId] !== undefined) net[t.categoryId] += t.amount;
    }

    // Rollup net to parents
    for (const [catId, amt] of Object.entries(net)) {
      if (amt === 0) continue;
      let cat = catById[catId];
      while (cat && cat.parentId) {
        net[cat.parentId] = (net[cat.parentId] || 0) + amt;
        cat = catById[cat.parentId];
      }
    }

    // Accumulate surplus/deficit for rollover-enabled categories only.
    // Use subtreeTargets so children's targets are included in the parent's balance.
    for (const cat of rolloverCats) {
      const balance = (subtreeTargets[cat.id] || 0) + (net[cat.id] || 0);
      rolloverByCat[cat.id] += balance;
    }
  }

  return rolloverByCat;
}

export function MoneyHome({ budgetId }) {
  const [budget, setBudget] = useState(null);
  const [categories, setCategories] = useState([]);
  const [allTransactions, setAllTransactions] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [monthOffset, setMonthOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferFrom, setTransferFrom] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferDate, setTransferDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const nameRef = useRef(null);

  const monthDate = new Date();
  monthDate.setMonth(monthDate.getMonth() + monthOffset);
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
    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); }, [budgetId, monthOffset]);

  async function renameBudget(newName) {
    if (!budget || !newName.trim()) return;
    const updated = { ...budget, name: newName.trim(), updatedAt: now() };
    delete updated._dirty;
    await db.putBudget(updated);
    setBudget(updated);
    setEditing(false);
    syncAfterMutation();
  }

  async function deleteBudget() {
    const ts = now();
    const cats = await db.getCategories(budgetId);
    const txns = await db.getTransactions(budgetId);
    for (const t of txns) await db.deleteTransaction(t.id, ts);
    for (const c of cats) await db.deleteCategory(c.id, ts);
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
    const base = { budgetId, date: transferDate, trntype: 'transfer', transferId, createdAt: ts, updatedAt: ts };

    await db.putTransaction({ ...base, id: uuid(), categoryId: fromCatId, amount: -amount, payee: 'Transfer', memo: `→ ${toName}` });
    await db.putTransaction({ ...base, id: uuid(), categoryId: toCatId, amount: +amount, payee: 'Transfer', memo: `← ${fromName}` });

    await syncAfterMutation();
    setShowTransfer(false);
    setTransferAmount('');
    load();
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  const subtreeTargets = buildSubtreeTargets(categories, catById);

  // Split into real vs transfer transactions for this month
  const monthTransfers = transactions.filter(t => t.trntype === 'transfer');
  const monthReal = transactions.filter(t => t.trntype !== 'transfer');

  // Spending by category bar chart — real negative transactions only
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

  const totals = { ...direct };
  for (const [catId, spent] of Object.entries(direct)) {
    if (spent === 0) continue;
    let cat = catById[catId];
    while (cat && cat.parentId) {
      totals[cat.parentId] = (totals[cat.parentId] || 0) + spent;
      cat = catById[cat.parentId];
    }
  }

  const tree = buildCategoryTree(categories);
  const flat = flattenCategoryTree(tree);
  const maxSpending = Math.max(...flat.map(({ cat }) => totals[cat.id] || 0), uncategorizedSpending, 1);

  // Per-category net for this month (real + transfer legs)
  const categoryNet = {};
  for (const cat of categories) categoryNet[cat.id] = 0;
  for (const t of [...monthReal, ...monthTransfers]) {
    if (t.categoryId && categoryNet[t.categoryId] !== undefined) {
      categoryNet[t.categoryId] += t.amount;
    }
  }

  // Rollup categoryNet to parents
  const categoryNetRolled = { ...categoryNet };
  for (const [catId, amt] of Object.entries(categoryNet)) {
    if (amt === 0) continue;
    let cat = catById[catId];
    while (cat && cat.parentId) {
      categoryNetRolled[cat.parentId] = (categoryNetRolled[cat.parentId] || 0) + amt;
      cat = catById[cat.parentId];
    }
  }

  // Rollover from past months (only for rollover-enabled categories, using subtree targets)
  const rolloverByCat = computeRollover(allTransactions, categories, catById, subtreeTargets, monthStart);

  // Effective balance per category = subtree targets + rollover + current month net (rolled up)
  const effectiveBalance = {};
  for (const cat of categories) {
    effectiveBalance[cat.id] = (subtreeTargets[cat.id] || 0) + (rolloverByCat[cat.id] || 0) + (categoryNetRolled[cat.id] || 0);
  }

  // Unallocated = sum of ALL transactions (real + transfers) with no categoryId
  const unallocated = transactions.reduce((s, t) => t.categoryId ? s : s + t.amount, 0);

  // Net position = sum of top-level effective balances + unallocated
  const netPosition = categories
    .filter(c => !c.parentId)
    .reduce((s, c) => s + (effectiveBalance[c.id] || 0), 0) + unallocated;

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

  const uncatCount = monthReal.filter(t => t.amount < 0 && !t.categoryId).length;

  const transferOptions = [
    html`<option value="__unallocated__">Unallocated</option>`,
    ...flat.map(({ cat, depth }) => html`<option value=${cat.id}>${'  '.repeat(depth)}${cat.name}</option>`)
  ];

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

      ${transactions.length === 0 && html`
        <div class="empty-state">
          <p>No transactions this month</p>
          <button class="btn" onClick=${() => navigate('/budget/' + budgetId + '/import')}>Import OFX File</button>
        </div>
      `}

      ${transactions.length > 0 && html`
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

        <div class="budget-vs-actual">
          <h3>Balances</h3>
          ${flat.map(({ cat, depth }) => {
            if (cat.parentId) return null;
            const bal = effectiveBalance[cat.id] || 0;
            const spent = totals[cat.id] || 0;
            const subTarget = subtreeTargets[cat.id] || 0;
            const hasTarget = subTarget > 0;
            const over = bal < 0;
            const barPct = hasTarget
              ? Math.min((spent / Math.max(subTarget, 1)) * 100, 150)
              : Math.min((spent / Math.max(spent, 1)) * 100, 100);
            return html`
              <div class="bva-row" key=${cat.id}>
                <div class="bva-label" style=${{ paddingLeft: `${depth * 1.2}rem` }}>
                  <span class="bva-dot" style=${{ background: cat.color }}></span>
                  <span class="bva-name">${cat.name}</span>
                </div>
                <div class="bva-bar-wrap">
                  <div class="bva-bar ${over ? 'over' : ''}" style=${{
                    width: `${Math.min(barPct, 100)}%`,
                    background: cat.color,
                  }}></div>
                  ${barPct > 100 && html`<div class="bva-bar-over" style=${{
                    width: `${barPct - 100}%`,
                    background: cat.color,
                    opacity: 0.4,
                  }}></div>`}
                </div>
                <div class="bva-nums ${over ? 'net-negative' : 'net-positive'}">
                  ${hasTarget
                    ? html`${formatCurrency(spent)} / ${formatCurrency(bal)}`
                    : html`${formatCurrency(bal)}`}
                </div>
              </div>
            `;
          })}

          ${unallocated !== 0 && html`
            <div class="bva-row bva-unallocated">
              <div class="bva-label">
                <span class="bva-dot" style=${{ background: '#555' }}></span>
                <span class="bva-name">Unallocated</span>
              </div>
              <div class="bva-bar-wrap"></div>
              <div class="bva-nums ${unallocated < 0 ? 'net-negative' : 'net-positive'}">
                ${formatCurrency(unallocated)}
              </div>
            </div>
          `}

          <div class="bva-row bva-total">
            <div class="bva-label"><span class="bva-name">Net Position</span></div>
            <div class="bva-bar-wrap"></div>
            <div class="bva-nums ${netPosition < 0 ? 'net-negative' : 'net-positive'}">
              ${netPosition >= 0 ? '+' : ''}${formatCurrency(netPosition)}
            </div>
          </div>
        </div>

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

      ${uncatCount > 0 && html`
        <div class="uncat-notice">
          ${uncatCount} uncategorized transaction${uncatCount !== 1 ? 's' : ''}
        </div>
      `}

      <div class="budget-actions">
        <button class="btn" onClick=${() => navigate('/budget/' + budgetId + '/import')}>Import</button>
        <button class="btn btn-secondary" onClick=${() => navigate('/budget/' + budgetId + '/transactions')}>Transactions</button>
        <button class="btn btn-secondary" onClick=${() => navigate('/budget/' + budgetId + '/categories')}>Categories</button>
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
