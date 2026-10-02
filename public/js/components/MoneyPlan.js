import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { urlMonthOffset } from '../router.js';
import { syncAfterMutation, debouncedSync, useSyncRefresh } from '../sync.js';
import {
  uuid, now, getMonthLabel, monthStartOf, offsetMonthDate, formatCurrency,
  buildCategoryTree, flattenCategoryTree, getDescendantIds, isFund, isEarmarkedFund,
  computePlanned, fundBalances, monthMembers,
} from '../utils.js';

const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#e11d48', '#64748b'];

// The plan for a month IS its category list — there is no global category screen.
// Rows here are the month's members: everything with a plan row, plus funds that
// still hold money. Dropping a row retires the category from this month without
// touching the identity every closed month still renders with.
export function MoneyPlan({ budgetId }) {
  const [budget, setBudget] = useState(null);
  const [categories, setCategories] = useState([]); // live identities, all months
  const [plans, setPlans] = useState([]); // all months, non-deleted
  const [transactions, setTransactions] = useState([]); // all, for fund balances
  const [monthOffset, setMonthOffset] = useState(urlMonthOffset);
  const [loading, setLoading] = useState(true);
  const [blankMode, setBlankMode] = useState(false); // editor opened without any rows yet
  const [showCopy, setShowCopy] = useState(false);
  const [addName, setAddName] = useState('');

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
    setTransactions(await db.getTransactions(budgetId));
    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); }, [budgetId]);
  useSyncRefresh(load);
  // Changing months resets transient UI state
  useEffect(() => { setBlankMode(false); setShowCopy(false); setAddName(''); }, [monthOffset]);

  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  const monthPlans = plans.filter(p => p.monthStart === monthStart);
  const planByCat = Object.fromEntries(monthPlans.map(p => [p.categoryId, p]));
  const hasPlan = monthPlans.length > 0;

  const balances = fundBalances(categories, plans, transactions, monthStart);
  const members = monthMembers(categories, monthPlans, [], balances);

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

  // Write-through editing: create the plan row on first value, update after.
  // Clearing a value leaves the row in place — membership is dropped explicitly
  // with ×, so "no target" and "not in my budget" stay separate statements.
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
    await db.putMoneyPlan(updated);
    setPlans(prev => prev.map(p => p.id === existing.id ? updated : p));
    debouncedSync();
  }

  // Category identity — shared across every month that uses it, so renaming here
  // fixes the label in closed months too.
  async function updateCat(id, field, value, immediate = false) {
    const cat = catById[id];
    if (!cat) return;
    const updated = { ...cat, [field]: value, updatedAt: now() };
    await db.putCategory(updated);
    setCategories(prev => prev.map(c => c.id === id ? updated : c));
    if (immediate) syncAfterMutation(); else debouncedSync();
  }

  // Adding by name revives the identity when one matches, so a category dropped
  // in March and wanted again in June keeps its history and its fund balance.
  async function addRow(rawName) {
    const name = rawName.trim();
    const ts = now();
    let cat = name
      ? categories.find(c => c.name.trim().toLowerCase() === name.toLowerCase())
      : null;

    if (cat && planByCat[cat.id]) { setAddName(''); return; } // already in this month

    if (!cat) {
      cat = {
        id: uuid(),
        budgetId,
        parentId: null,
        name,
        color: PALETTE[categories.length % PALETTE.length],
        nature: 'flow',
        goalBalance: null,
        location: null,
        sortOrder: categories.length,
        createdAt: ts,
        updatedAt: ts,
      };
      await db.putCategory(cat);
      setCategories(prev => [...prev, cat]);
    }

    const row = {
      id: uuid(),
      budgetId,
      categoryId: cat.id,
      monthStart,
      minAmount: null,
      maxAmount: null,
      contribution: null,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.putMoneyPlan(row);
    setPlans(prev => [...prev, row]);
    setAddName('');
    setBlankMode(true);
    syncAfterMutation();
  }

  // Retire from this month: the plan row goes, the identity stays. A fund holding
  // money keeps its row regardless — that balance still has to be accounted for.
  async function removeRow(catId) {
    const existing = planByCat[catId];
    if (!existing) return;
    await db.deleteMoneyPlan(existing.id, now());
    setPlans(prev => prev.filter(p => p.id !== existing.id));
    syncAfterMutation();
  }

  async function moveCat(id, dir) {
    const cat = catById[id];
    if (!cat) return;
    const siblings = categories
      .filter(c => (c.parentId ?? null) === (cat.parentId ?? null) && members.has(c.id))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = siblings.findIndex(c => c.id === id);
    const swapWith = siblings[idx + dir];
    if (!swapWith) return;

    const ts = now();
    const updA = { ...cat, sortOrder: swapWith.sortOrder, updatedAt: ts };
    const updB = { ...swapWith, sortOrder: cat.sortOrder, updatedAt: ts };
    await db.putCategory(updA);
    await db.putCategory(updB);
    setCategories(prev => prev.map(c => {
      if (c.id === updA.id) return updA;
      if (c.id === updB.id) return updB;
      return c;
    }));
    debouncedSync();
  }

  // Copy a month's rows into the shown month. Only fills categories that do not
  // already have a row here; existing rows are never overwritten. This is how a
  // month gets its category list — cloning a plan clones its categories.
  async function copyFrom(sourceMonthStart) {
    const ts = now();
    const existingCatIds = new Set(monthPlans.map(p => p.categoryId));
    const newRows = [];
    for (const src of plans) {
      if (src.monthStart !== sourceMonthStart) continue;
      if (existingCatIds.has(src.categoryId)) continue;
      if (!catById[src.categoryId]) continue; // skip rows for purged categories
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

  const memberCats = categories.filter(c => members.has(c.id));
  const flat = flattenCategoryTree(buildCategoryTree(memberCats));
  const planned = computePlanned(monthPlans, catById);
  // Everything the budget knows that is not in this month — offered as typeahead
  // suggestions only, never as a list to wade through.
  const dormant = categories.filter(c => !members.has(c.id) && c.name.trim());

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

      ${!hasPlan && !blankMode && flat.length === 0 && html`
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

      ${(hasPlan || blankMode || flat.length > 0) && html`
        <div class="cat-list plan-editor">
          ${flat.map(({ cat, depth, siblingIndex, siblingCount }) => {
            const row = planByCat[cat.id];
            const fund = isFund(cat);
            const bal = balances[cat.id] || 0;
            const excluded = new Set([cat.id, ...getDescendantIds(cat.id, memberCats)]);
            const validParents = flat.filter(({ cat: c }) => !excluded.has(c.id));

            return html`
              <div class="cat-row" key=${cat.id} style=${{ marginLeft: `${depth * 1.2}rem` }}>
                <div class="cat-row-main">
                  <div class="cat-color-wrap">
                    <input type="color" class="cat-color" value=${cat.color}
                      onInput=${(e) => updateCat(cat.id, 'color', e.target.value)} />
                  </div>
                  <input class="cat-name-input" type="text" value=${cat.name}
                    placeholder="Category name"
                    onInput=${(e) => updateCat(cat.id, 'name', e.target.value)} />
                  <div class="cat-nature-toggle">
                    <button class=${`cat-nature-option ${!fund ? 'active' : ''}`}
                      onClick=${() => updateCat(cat.id, 'nature', 'flow', true)}>Flow</button>
                    <button class=${`cat-nature-option ${fund ? 'active' : ''}`}
                      onClick=${() => updateCat(cat.id, 'nature', 'fund', true)}>Fund</button>
                  </div>
                  <div class="cat-actions">
                    <button class="cat-move" title="Move up" onClick=${() => moveCat(cat.id, -1)} disabled=${siblingIndex === 0}>↑</button>
                    <button class="cat-move" title="Move down" onClick=${() => moveCat(cat.id, 1)} disabled=${siblingIndex === siblingCount - 1}>↓</button>
                    <button class="cat-delete" title=${`Remove from ${monthLabel}`}
                      onClick=${() => removeRow(cat.id)} disabled=${!row}>×</button>
                  </div>
                </div>

                <div class="cat-row-meta">
                  ${fund ? html`
                    <div class="plan-inputs">
                      <label class="plan-input-wrap">
                        <span class="plan-input-label">/mo</span>
                        <input class="plan-input" type="number" min="0" step="0.01" placeholder="—"
                          value=${row?.contribution ?? ''}
                          onInput=${e => updateValue(cat, 'contribution', e.target.value)} />
                      </label>
                      <label class="plan-input-wrap">
                        <span class="plan-input-label">goal</span>
                        <input class="plan-input" type="number" min="0" step="1" placeholder="none"
                          value=${cat.goalBalance ?? ''}
                          onInput=${(e) => updateCat(cat.id, 'goalBalance', e.target.value === '' ? null : (parseFloat(e.target.value) || 0))} />
                      </label>
                      <span class="plan-goal-hint">balance ${formatCurrency(bal)}</span>
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
                      ${!row && html`<span class="plan-goal-hint">not in ${monthLabel}</span>`}
                    </div>
                  `}
                </div>

                <div class="cat-row-meta">
                  ${fund && html`
                    <select class="cat-parent-select cat-fund-location-select"
                      value=${isEarmarkedFund(cat) ? 'earmarked' : 'real'}
                      onChange=${(e) => updateCat(cat.id, 'location', e.target.value, true)}>
                      <option value="earmarked">Earmarked (in checking)</option>
                      <option value="real">Real (savings bucket)</option>
                    </select>
                  `}
                  ${validParents.length > 0 && html`
                    <select class="cat-parent-select"
                      value=${cat.parentId ?? ''}
                      onChange=${(e) => updateCat(cat.id, 'parentId', e.target.value || null, true)}>
                      <option value="">Top level</option>
                      ${validParents.map(({ cat: p, depth: d }) => html`
                        <option value=${p.id}>${'–'.repeat(d)} ${p.name || 'Unnamed'}</option>
                      `)}
                    </select>
                  `}
                </div>
              </div>
            `;
          })}
        </div>

        <form class="plan-add-row" onSubmit=${(e) => { e.preventDefault(); addRow(addName); }}>
          <input class="cat-name-input" type="text" list="plan-dormant-cats"
            placeholder="Add a category…" value=${addName}
            onInput=${(e) => setAddName(e.target.value)} />
          <datalist id="plan-dormant-cats">
            ${dormant.map(c => html`<option key=${c.id} value=${c.name}></option>`)}
          </datalist>
          <button class="btn btn-secondary" type="submit">+ Add</button>
        </form>

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
