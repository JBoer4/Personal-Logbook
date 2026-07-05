import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { syncAfterMutation, debouncedSync } from '../sync.js';
import { uuid, now, buildCategoryTree, flattenCategoryTree, getDescendantIds, isFund, isEarmarkedFund } from '../utils.js';

const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#e11d48', '#64748b'];

export function MoneyCategories({ budgetId }) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const cats = await db.getCategories(budgetId);
    setCategories(cats);
    setLoading(false);
  }

  useEffect(() => { load(); }, [budgetId]);

  async function updateCat(id, field, value, immediate = false) {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    const updated = { ...cat, [field]: value, updatedAt: now() };
    await db.putCategory(updated);
    setCategories(prev => prev.map(c => c.id === id ? updated : c));
    if (immediate) {
      syncAfterMutation();
    } else {
      debouncedSync();
    }
  }

  async function addCategory(parentId = null) {
    const siblings = categories.filter(c => (c.parentId ?? null) === parentId);
    const ts = now();
    const cat = {
      id: uuid(),
      budgetId,
      parentId,
      name: '',
      color: PALETTE[categories.length % PALETTE.length],
      nature: 'flow',
      goalBalance: null,
      location: null,
      sortOrder: siblings.length,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.putCategory(cat);
    setCategories(prev => [...prev, cat]);
    debouncedSync();
  }

  async function removeCat(id) {
    const ts = now();
    const descendants = getDescendantIds(id, categories);
    for (const descId of descendants) {
      await db.deleteCategory(descId, ts);
    }
    await db.deleteCategory(id, ts);
    setCategories(prev => prev.filter(c => c.id !== id && !descendants.has(c.id)));
    syncAfterMutation();
  }

  async function moveCat(id, dir) {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    const siblings = categories
      .filter(c => (c.parentId ?? null) === (cat.parentId ?? null))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = siblings.findIndex(c => c.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= siblings.length) return;

    const ts = now();
    const swapWith = siblings[newIdx];
    const updA = { ...cat, sortOrder: swapWith.sortOrder, updatedAt: ts };
    const updB = { ...swapWith, sortOrder: cat.sortOrder, updatedAt: ts };
    await db.putCategory(updA);
    await db.putCategory(updB);
    setCategories(prev => prev.map(c => {
      if (c.id === cat.id) return updA;
      if (c.id === swapWith.id) return updB;
      return c;
    }));
    debouncedSync();
  }

  async function reparentCat(id, newParentId) {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    const newSiblings = categories.filter(c => (c.parentId ?? null) === newParentId && c.id !== id);
    const updated = { ...cat, parentId: newParentId, sortOrder: newSiblings.length, updatedAt: now() };
    await db.putCategory(updated);
    setCategories(prev => prev.map(c => c.id === id ? updated : c));
    syncAfterMutation();
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  const tree = buildCategoryTree(categories);
  const flat = flattenCategoryTree(tree);

  const flowCount = categories.filter(c => !isFund(c)).length;
  const fundCount = categories.filter(isFund).length;

  return html`
    <div class="categories-view">
      <h2>Spending Categories</h2>
      <p class="subtitle">${flowCount} flow · ${fundCount} funds</p>
      <p class="subtitle cat-plan-hint">Monthly targets and fund contributions are set in the Plan view.</p>

      <div class="cat-list">
        ${flat.map(({ cat, depth, siblingIndex, siblingCount }) => {
          const excluded = new Set([cat.id, ...getDescendantIds(cat.id, categories)]);
          const validParents = flat.filter(({ cat: c }) => !excluded.has(c.id));

          return html`
            <div class="cat-row" key=${cat.id} style="padding-left: ${depth * 1.5}rem">
              <div class="cat-row-main">
                <div class="cat-color-wrap">
                  <input type="color" class="cat-color" value=${cat.color}
                    onInput=${(e) => updateCat(cat.id, 'color', e.target.value)} />
                </div>
                <input class="cat-name-input" type="text" value=${cat.name}
                  placeholder=${depth === 0 ? 'Group name' : 'Subcategory name'}
                  onInput=${(e) => updateCat(cat.id, 'name', e.target.value)} />
                <div class="cat-nature-toggle">
                  <button
                    class=${`cat-nature-option ${!isFund(cat) ? 'active' : ''}`}
                    onClick=${() => updateCat(cat.id, 'nature', 'flow', true)}>Flow</button>
                  <button
                    class=${`cat-nature-option ${isFund(cat) ? 'active' : ''}`}
                    onClick=${() => updateCat(cat.id, 'nature', 'fund', true)}>Fund</button>
                </div>
                <div class="cat-actions">
                  <button class="cat-move" title="Move up" onClick=${() => moveCat(cat.id, -1)} disabled=${siblingIndex === 0}>↑</button>
                  <button class="cat-move" title="Move down" onClick=${() => moveCat(cat.id, 1)} disabled=${siblingIndex === siblingCount - 1}>↓</button>
                  <button class="cat-add-child" title="Add subcategory" onClick=${() => addCategory(cat.id)}>+sub</button>
                  <button class="cat-delete" onClick=${() => removeCat(cat.id)}>×</button>
                </div>
              </div>
              ${isFund(cat) && html`
                <div class="cat-row-meta cat-fund-meta">
                  <span class="cat-goal-label">Goal</span>
                  <div class="cat-goal-wrap">
                    <span class="cat-hours-label">$</span>
                    <input class="cat-goal-input cat-fund-goal-input" type="number" value=${cat.goalBalance ?? ''}
                      min="0" step="1" placeholder="none"
                      onInput=${(e) => updateCat(cat.id, 'goalBalance', e.target.value === '' ? null : (parseFloat(e.target.value) || 0))} />
                  </div>
                  <select class="cat-parent-select cat-fund-location-select"
                    value=${isEarmarkedFund(cat) ? 'earmarked' : 'real'}
                    onChange=${(e) => updateCat(cat.id, 'location', e.target.value, true)}>
                    <option value="earmarked">Earmarked (in checking)</option>
                    <option value="real">Real (savings bucket)</option>
                  </select>
                </div>
              `}
              <div class="cat-row-meta">
                <select class="cat-parent-select"
                  value=${cat.parentId ?? ''}
                  onChange=${(e) => reparentCat(cat.id, e.target.value || null)}>
                  <option value="">Top level</option>
                  ${validParents.map(({ cat: p, depth: d }) => html`
                    <option value=${p.id}>
                      ${'–'.repeat(d)} ${p.name || 'Unnamed'}
                    </option>
                  `)}
                </select>
              </div>
            </div>
          `;
        })}
      </div>

      <button class="btn btn-add" onClick=${() => addCategory(null)}>+ Add Group</button>
    </div>
  `;
}
