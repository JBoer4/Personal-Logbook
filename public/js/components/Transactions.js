import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation, debouncedSync } from '../sync.js';
import {
  uuid, now, today, getMonthLabel, getMonthDates, offsetMonthDate, formatCurrency,
  TRN_TRANSFER, isTransferTxn, isAdjustmentTxn, isRealTxn,
} from '../utils.js';

export function Transactions({ budgetId }) {
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [rules, setRules] = useState([]);
  const [monthOffset, setMonthOffset] = useState(0);
  const [filter, setFilter] = useState('all'); // 'all', 'uncategorized', or a categoryId
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addPayee, setAddPayee] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [addDate, setAddDate] = useState(today());
  const [addCategory, setAddCategory] = useState('');
  const [showRules, setShowRules] = useState(false);
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [ruleMatch, setRuleMatch] = useState('');
  const [ruleCategory, setRuleCategory] = useState('');
  const [ruleMarkTransfer, setRuleMarkTransfer] = useState(false);

  const monthDate = offsetMonthDate(monthOffset);
  const { start: monthStart, end: monthEnd } = getMonthDates(monthDate);
  const monthLabel = getMonthLabel(monthDate);

  async function load() {
    const cats = await db.getCategories(budgetId);
    cats.sort((a, b) => a.sortOrder - b.sortOrder);
    setCategories(cats);

    const allTxns = await db.getTransactions(budgetId);
    const monthTxns = allTxns.filter(t => t.date >= monthStart && t.date <= monthEnd);
    monthTxns.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    setTransactions(monthTxns);

    const moneyRules = await db.getMoneyRules(budgetId);
    moneyRules.sort((a, b) => a.createdAt - b.createdAt);
    setRules(moneyRules);

    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); }, [budgetId, monthOffset]);

  async function setCategoryForTxn(txnId, categoryId) {
    const txn = transactions.find(t => t.id === txnId);
    if (!txn) return;
    const updated = { ...txn, categoryId: categoryId || null, updatedAt: now() };
    await db.putTransaction(updated);
    setTransactions(prev => prev.map(t => t.id === txnId ? updated : t));
    debouncedSync();
  }

  async function toggleTransfer(txnId) {
    const txn = transactions.find(t => t.id === txnId);
    if (!txn) return;
    const newType = isTransferTxn(txn) ? '' : TRN_TRANSFER;
    const updated = { ...txn, trntype: newType, updatedAt: now() };
    await db.putTransaction(updated);
    setTransactions(prev => prev.map(t => t.id === txnId ? updated : t));
    debouncedSync();
  }

  async function addTransaction() {
    const amount = parseFloat(addAmount);
    if (!addPayee.trim() || isNaN(amount)) return;
    const ts = now();
    const txn = {
      id: uuid(),
      budgetId,
      categoryId: addCategory || null,
      date: addDate,
      amount: -Math.abs(amount), // default to expense (negative)
      payee: addPayee.trim(),
      memo: '',
      fitid: '',
      trntype: 'MANUAL',
      createdAt: ts,
      updatedAt: ts,
    };
    await db.putTransaction(txn);
    setTransactions(prev => [txn, ...prev].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt));
    setShowAddForm(false);
    setAddPayee('');
    setAddAmount('');
    setAddDate(today());
    setAddCategory('');
    syncAfterMutation();
  }

  function openRuleForm(match = '', categoryId = '') {
    setRuleMatch(match);
    setRuleCategory(categoryId);
    setRuleMarkTransfer(false);
    setShowRules(true);
    setRuleFormOpen(true);
  }

  async function saveRule() {
    const match = ruleMatch.trim();
    if (!match || (!ruleCategory && !ruleMarkTransfer)) return;
    const ts = now();
    const rule = {
      id: uuid(),
      budgetId,
      match,
      categoryId: ruleCategory || null,
      markTransfer: ruleMarkTransfer ? 1 : 0,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.putMoneyRule(rule);
    setRules(prev => [...prev, rule].sort((a, b) => a.createdAt - b.createdAt));
    setRuleFormOpen(false);
    setRuleMatch('');
    setRuleCategory('');
    setRuleMarkTransfer(false);
    syncAfterMutation();
  }

  async function deleteRule(ruleId) {
    await db.deleteMoneyRule(ruleId, now());
    setRules(prev => prev.filter(r => r.id !== ruleId));
    syncAfterMutation();
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  // Filter transactions
  let filtered = transactions;
  if (filter === 'uncategorized') {
    filtered = transactions.filter(t => !t.categoryId);
  } else if (filter !== 'all') {
    filtered = transactions.filter(t => t.categoryId === filter);
  }

  // Summary — real income/spending only, excluding transfers and balance adjustments
  const summaryTxns = transactions.filter(isRealTxn);
  const totalExpense = summaryTxns.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const totalIncome = summaryTxns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const uncatCount = transactions.filter(t => !t.categoryId).length;

  const catMap = {};
  for (const c of categories) catMap[c.id] = c;

  return html`
    <div class="transactions-view">
      <h2>Transactions</h2>

      <div class="month-nav">
        <button class="nav-arrow" onClick=${() => setMonthOffset(m => m - 1)}>‹</button>
        <span class="month-label">${monthLabel}</span>
        <button class="nav-arrow" onClick=${() => setMonthOffset(m => m + 1)}>›</button>
      </div>

      <div class="txn-summary">
        <span class="txn-summary-item">Spent: ${formatCurrency(totalExpense)}</span>
        <span class="txn-summary-item">Income: ${formatCurrency(totalIncome)}</span>
        <span class="txn-summary-item">Net: ${formatCurrency(totalIncome + totalExpense)}</span>
      </div>

      <div class="txn-actions">
        <button class="btn" onClick=${() => navigate('/budget/' + budgetId + '/import')}>Import OFX</button>
        <button class="btn btn-secondary" onClick=${() => setShowAddForm(v => !v)}>
          ${showAddForm ? 'Cancel' : '+ Manual'}
        </button>
      </div>

      ${showAddForm && html`
        <div class="txn-add-form">
          <input class="txn-add-input" type="text" placeholder="Payee / description"
            value=${addPayee} onInput=${(e) => setAddPayee(e.target.value)} />
          <div class="txn-add-row">
            <input class="txn-add-input txn-add-amount" type="number" placeholder="Amount"
              step="0.01" min="0" value=${addAmount}
              onInput=${(e) => setAddAmount(e.target.value)} />
            <input class="txn-add-input txn-add-date" type="date" value=${addDate}
              onInput=${(e) => setAddDate(e.target.value)} />
          </div>
          <div class="txn-add-row">
            <select class="txn-cat-select txn-add-cat" value=${addCategory}
              onChange=${(e) => setAddCategory(e.target.value)}>
              <option value="">Uncategorized</option>
              ${categories.map(c => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
            </select>
            <button class="btn txn-add-save" onClick=${addTransaction}>Add</button>
          </div>
        </div>
      `}

      <div class="rules-section">
        <button class="rules-toggle" onClick=${() => setShowRules(v => !v)}>
          Rules (${rules.length}) <span class="rules-caret">${showRules ? '▾' : '▸'}</span>
        </button>
        ${showRules && html`
          <div class="rules-panel">
            ${rules.length === 0 && html`<p class="rules-empty">No rules yet</p>`}
            ${rules.map(r => html`
              <div class="rule-row" key=${r.id}>
                <span class="rule-match">"${r.match}"</span>
                <span class="rule-action">
                  ${[
                    r.categoryId ? `→ ${catMap[r.categoryId]?.name || 'category'}` : null,
                    r.markTransfer ? 'mark transfer' : null,
                  ].filter(Boolean).join(' + ')}
                </span>
                <button class="rule-delete" title="Delete rule" onClick=${() => deleteRule(r.id)}>✕</button>
              </div>
            `)}
            ${!ruleFormOpen ? html`
              <button class="btn btn-secondary rule-add-btn" onClick=${() => openRuleForm()}>
                + Add rule
              </button>
            ` : html`
              <div class="rule-add-form">
                <input class="txn-add-input" type="text" placeholder="Match text (e.g. ALBERT HEIJN)"
                  value=${ruleMatch} onInput=${(e) => setRuleMatch(e.target.value)} />
                <div class="txn-add-row">
                  <select class="txn-cat-select" value=${ruleCategory} onChange=${(e) => setRuleCategory(e.target.value)}>
                    <option value="">— none —</option>
                    ${categories.map(c => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
                  </select>
                </div>
                <label class="rule-transfer-check">
                  <input type="checkbox" checked=${ruleMarkTransfer}
                    onChange=${(e) => setRuleMarkTransfer(e.target.checked)} />
                  mark as transfer
                </label>
                <div class="txn-add-row">
                  <button class="btn btn-secondary" onClick=${() => setRuleFormOpen(false)}>Cancel</button>
                  <button class="btn txn-add-save" onClick=${saveRule}>Save</button>
                </div>
              </div>
            `}
          </div>
        `}
      </div>

      <div class="txn-filters">
        <button class="txn-filter ${filter === 'all' ? 'active' : ''}"
          onClick=${() => setFilter('all')}>All (${transactions.length})</button>
        <button class="txn-filter ${filter === 'uncategorized' ? 'active' : ''}"
          onClick=${() => setFilter('uncategorized')}>Uncat (${uncatCount})</button>
        ${categories.map(c => html`
          <button class="txn-filter ${filter === c.id ? 'active' : ''}" key=${c.id}
            onClick=${() => setFilter(c.id)}>
            <span class="txn-filter-dot" style=${{ background: c.color }}></span>
            ${c.name}
          </button>
        `)}
      </div>

      ${filtered.length === 0 && html`
        <div class="empty-state">
          ${transactions.length === 0
            ? html`<p>No transactions yet</p><button class="btn" onClick=${() => navigate('/budget/' + budgetId + '/import')}>Import OFX</button>`
            : html`<p>No transactions match this filter</p>`
          }
        </div>
      `}

      <div class="txn-list">
        ${filtered.map(txn => {
          const cat = txn.categoryId ? catMap[txn.categoryId] : null;
          const isTransfer = isTransferTxn(txn);
          const isAdjustment = isAdjustmentTxn(txn);
          return html`
            <div class="txn-row ${isTransfer ? 'txn-row-muted' : ''}" key=${txn.id}>
              <div class="txn-main">
                <span class="txn-date">${txn.date.slice(5)}</span>
                <span class="txn-payee">${txn.payee || txn.memo || '—'}</span>
                ${txn.ruleId && html`<span class="txn-badge txn-badge-auto" title="categorized by rule">auto</span>`}
                ${isTransfer && html`<span class="txn-badge txn-badge-transfer">transfer</span>`}
                ${isAdjustment && html`<span class="txn-badge txn-badge-adjustment">adjustment</span>`}
                ${txn.account && html`<span class="txn-account-tag">…${txn.account.slice(-4)}</span>`}
                <span class="txn-amount ${txn.amount < 0 ? 'negative' : 'positive'}">
                  ${formatCurrency(txn.amount)}
                </span>
              </div>
              <div class="txn-cat-row">
                <select class="txn-cat-select" value=${txn.categoryId || ''}
                  onChange=${(e) => setCategoryForTxn(txn.id, e.target.value)}>
                  <option value="">Uncategorized</option>
                  ${categories.map(c => html`
                    <option key=${c.id} value=${c.id}>${c.name}</option>
                  `)}
                </select>
                ${cat && html`<span class="txn-cat-dot" style=${{ background: cat.color }}></span>`}
                ${!isAdjustment && html`
                  <button class="txn-transfer-toggle ${isTransfer ? 'active' : ''}"
                    title=${isTransfer ? 'Unmark transfer' : 'Mark as transfer'}
                    onClick=${() => toggleTransfer(txn.id)}>⇄</button>
                `}
                <button class="txn-rule-btn" title="Add rule from this transaction"
                  onClick=${() => openRuleForm(txn.payee || '', txn.categoryId || '')}>+rule</button>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
