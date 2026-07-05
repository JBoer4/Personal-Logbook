import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { syncAfterMutation, debouncedSync } from '../sync.js';
import {
  uuid, now, getMonthLabel, monthStartOf, offsetMonthDate, formatCurrency,
  buildCategoryTree, flattenCategoryTree, isFund, computePlanned,
} from '../utils.js';

export function MoneyPlan({ budgetId }) {
  const [budget, setBudget] = useState(null);
  const [categories, setCategories] = useState([]);
  const [plans, setPlans] = useState([]); // all months, non-deleted
  const [monthOffset, setMonthOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [blankMode, setBlankMode] = useState(false); // editor opened without any rows yet
  const [showCopy, setShowCopy] = useState(false);

  const monthDate = offsetMonthDate(monthOffset);
  const monthStart = monthStartOf(monthDate);
  const monthLabel = getMonthLabel(monthDate);

  async function load() {
    const b = await db.getBudget(budgetId);
    setBudget(b);
    const cats = await db.getCategories(budgetId);
    cats.sort((a, b) => a.sortOrder - b.sortOrder);
    setCategories(cats);
    const all = await db.getMoneyPlans(budgetId);
    setPlans(all);
    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); }, [budgetId]);
  // Changing months resets transient UI state
  useEffect(() => { setBlankMode(false); setShowCopy(false); }, [monthOffset]);

  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  const monthPlans = plans.filter(p => p.monthStart === monthStart);
  const planByCat = Object.fromEntries(monthPlans.map(p => [p.categoryId, p]));
  const hasPlan = monthPlans.length > 0;

  // Months (other than the shown one) that have plan rows, newest first
  const sourceMonths = [];
  {
    const counts = {};
    for (const p of plans) {
      if (p.monthStart === monthStart) continue;
      counts[p.monthStart] = (counts[p.monthStart] || 0) + 1;
    }
    for (const ms of Object.keys(counts).sort().reverse()) {
      sourceMonths.push({
        monthStart: ms,
        count: counts[ms],
        label: getMonthLabel(new Date(ms + 'T00:00:00')),
      });
    }
  }

  // Write-through editing: create the row on first value, update after,
  // delete the row once every value is cleared.
  async function updateValue(cat, field, rawValue) {
    let value = null;
    if (rawValue !== '') {
      const parsed = parseFloat(rawValue);
      if (isNaN(parsed)) return; // never store NaN; ignore unparseable input
      value = parsed;
    }
    const existing = planByCat[cat.id];
    const ts = now();

    if (!existing) {
      if (value === null) return;
      const row = {
        id: uuid(),
        budgetId,
        categoryId: cat.id,
        monthStart,
        minAmount: null,
        maxAmount: null,
        contribution: null,
        [field]: value,
        createdAt: ts,
        updatedAt: ts,
      };
      await db.putMoneyPlan(row);
      setPlans(prev => [...prev, row]);
      debouncedSync();
      return;
    }

    const updated = { ...existing, [field]: value, updatedAt: ts };
    if (updated.minAmount == null && updated.maxAmount == null && updated.contribution == null) {
      await db.deleteMoneyPlan(existing.id, ts);
      setPlans(prev => prev.filter(p => p.id !== existing.id));
    } else {
      await db.putMoneyPlan(updated);
      setPlans(prev => prev.map(p => p.id === existing.id ? updated : p));
    }
    debouncedSync();
  }

  // Copy a month's rows into the shown month. Only fills categories that
  // don't already have a row here; existing rows are never overwritten.
  async function copyFrom(sourceMonthStart) {
    const ts = now();
    const existingCatIds = new Set(monthPlans.map(p => p.categoryId));
    const newRows = [];
    for (const src of plans) {
      if (src.monthStart !== sourceMonthStart) continue;
      if (existingCatIds.has(src.categoryId)) continue;
      if (!catById[src.categoryId]) continue; // skip rows for deleted categories
      const row = {
        id: uuid(),
        budgetId,
        categoryId: src.categoryId,
        monthStart,
        minAmount: src.minAmount ?? null,
        maxAmount: src.maxAmount ?? null,
        contribution: src.contribution ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
      await db.putMoneyPlan(row);
      newRows.push(row);
    }
    if (newRows.length > 0) {
      setPlans(prev => [...prev, ...newRows]);
      syncAfterMutation();
    }
    setShowCopy(false);
    setBlankMode(true); // stay in the editor even if nothing was copied
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  const tree = buildCategoryTree(categories);
  const flat = flattenCategoryTree(tree);
  const planned = computePlanned(monthPlans, catById);

  const copyList = sourceMonths.map(m => html`
    <button class="plan-copy-month" key=${m.monthStart} onClick=${() => copyFrom(m.monthStart)}>
      <span>${m.label}</span>
      <span class="plan-copy-count">${m.count} ${m.count === 1 ? 'row' : 'rows'}</span>
    </button>
  `);

  return html`
    <div class="plan-view">
      <h2>Plan${budget ? ` — ${budget.name}` : ''}</h2>

      <div class="month-nav">
        <button class="nav-arrow" onClick=${() => setMonthOffset(m => m - 1)}>‹</button>
        <span class="month-label">${monthLabel}</span>
        <button class="nav-arrow" onClick=${() => setMonthOffset(m => m + 1)}>›</button>
      </div>

      ${!hasPlan && !blankMode && html`
        <div class="empty-state">
          <p>No plan for ${monthLabel} yet</p>
          ${sourceMonths.length > 0 && html`
            <div class="plan-copy-list">
              <p class="plan-copy-title">Copy from a previous month</p>
              ${copyList}
            </div>
          `}
          <button class="btn ${sourceMonths.length > 0 ? 'btn-secondary' : ''}"
            onClick=${() => setBlankMode(true)}>Start blank</button>
        </div>
      `}

      ${(hasPlan || blankMode) && html`
        ${flat.length === 0 && html`
          <div class="empty-state"><p>No categories yet — add some first</p></div>
        `}

        <div class="plan-editor">
          ${flat.map(({ cat, depth }) => {
            const row = planByCat[cat.id];
            return html`
              <div class="plan-row" key=${cat.id} style=${{ paddingLeft: `${depth * 1.2}rem` }}>
                <div class="plan-row-label">
                  <span class="bva-dot" style=${{ background: cat.color }}></span>
                  <span class="plan-row-name">${cat.name || 'Unnamed'}</span>
                  ${isFund(cat) && cat.goalBalance != null && html`
                    <span class="plan-goal-hint">goal ${formatCurrency(cat.goalBalance)}</span>
                  `}
                </div>
                ${isFund(cat) ? html`
                  <div class="plan-inputs">
                    <label class="plan-input-wrap">
                      <span class="plan-input-label">/mo</span>
                      <input class="plan-input" type="number" min="0" step="0.01" placeholder="—"
                        value=${row?.contribution ?? ''}
                        onInput=${e => updateValue(cat, 'contribution', e.target.value)} />
                    </label>
                  </div>
                ` : html`
                  <div class="plan-inputs">
                    <label class="plan-input-wrap">
                      <span class="plan-input-label">min</span>
                      <input class="plan-input" type="number" min="0" step="0.01" placeholder="—"
                        value=${row?.minAmount ?? ''}
                        onInput=${e => updateValue(cat, 'minAmount', e.target.value)} />
                    </label>
                    <label class="plan-input-wrap">
                      <span class="plan-input-label">max</span>
                      <input class="plan-input" type="number" min="0" step="0.01" placeholder="—"
                        value=${row?.maxAmount ?? ''}
                        onInput=${e => updateValue(cat, 'maxAmount', e.target.value)} />
                    </label>
                  </div>
                `}
              </div>
            `;
          })}
        </div>

        <div class="plan-total">
          Planned total: <strong>${formatCurrency(planned)}</strong>
        </div>

        ${sourceMonths.length > 0 && html`
          <div class="plan-copy-section">
            <button class="btn btn-secondary" onClick=${() => setShowCopy(v => !v)}>
              Copy from another month
              <span class="plan-copy-subtitle">fills empty rows only</span>
            </button>
            ${showCopy && html`
              <div class="plan-copy-list">${copyList}</div>
            `}
          </div>
        `}
      `}
    </div>
  `;
}
