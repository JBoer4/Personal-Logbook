import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { syncAfterMutation } from '../sync.js';
import { uuid, now } from '../utils.js';

const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#e11d48', '#64748b'];

// Build an n-level tree from a flat category list.
// Orphaned children (parent deleted/missing) float to root.
function buildTree(cats) {
  const byId = {};
  const roots = [];
  for (const c of cats) byId[c.id] = { ...c, children: [] };
  for (const c of cats) {
    if (c.parentId && byId[c.parentId]) {
      byId[c.parentId].children.push(byId[c.id]);
    } else {
      roots.push(byId[c.id]);
    }
  }
  const sort = (nodes) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

// Flatten tree to pre-order list with depth + sibling info for rendering.
function flattenTree(nodes, depth = 0, result = []) {
  nodes.forEach((node, siblingIndex) => {
    result.push({ cat: node, depth, siblingIndex, siblingCount: nodes.length });
    flattenTree(node.children, depth + 1, result);
  });
  return result;
}

// All descendant IDs of a given category (to prevent reparenting cycles).
function getDescendantIds(id, allCats) {
  const children = allCats.filter(c => c.parentId === id);
  return children.flatMap(c => [c.id, ...getDescendantIds(c.id, allCats)]);
}

export function Categories({ budgetId }) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef(null);

  async function load() {
    const cats = await db.getCategories(budgetId);
    setCategories(cats);
    setLoading(false);
  }

  useEffect(() => { load(); }, [budgetId]);

  function scheduleSync() {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => syncAfterMutation(), 500);
  }

  async function updateCat(id, field, value) {
    const cat = categories.find(c => c.id === id);
    if (!cat) return;
    const updated = { ...cat, [field]: value, updatedAt: now() };
    await db.putCategory(updated);
    setCategories(prev => prev.map(c => c.id === id ? updated : c));
    scheduleSync();
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
      targetHours: 0,
      minHours: null,
      maxHours: null,
      sortOrder: siblings.length,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.putCategory(cat);
    setCategories(prev => [...prev, cat]);
    scheduleSync();
  }

  async function removeCat(id) {
    await db.deleteCategory(id, now());
    setCategories(prev => prev.filter(c => c.id !== id));
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
    scheduleSync();
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

  const tree = buildTree(categories);
  const flat = flattenTree(tree);

  return html`
    <div class="categories-view">
      <h2>Categories</h2>

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
                  placeholder=${depth === 0 ? 'Group name' : 'Category name'}
                  onInput=${(e) => updateCat(cat.id, 'name', e.target.value)} />
                <div class="cat-actions">
                  <button class="cat-move" title="Move up" onClick=${() => moveCat(cat.id, -1)} disabled=${siblingIndex === 0}>↑</button>
                  <button class="cat-move" title="Move down" onClick=${() => moveCat(cat.id, 1)} disabled=${siblingIndex === siblingCount - 1}>↓</button>
                  <button class="cat-add-child" title="Add child category" onClick=${() => addCategory(cat.id)}>+</button>
                  <button class="cat-delete" onClick=${() => removeCat(cat.id)}>×</button>
                </div>
              </div>
              <div class="cat-row-meta">
                <span class="cat-goal-label">Goal</span>
                <div class="cat-goal-wrap">
                  <input class="cat-goal-input" type="number"
                    value=${cat.minHours != null ? cat.minHours : ''}
                    placeholder="min"
                    min="0" max="168" step="0.5"
                    title="Minimum hours (hit at least this)"
                    onInput=${(e) => updateCat(cat.id, 'minHours', e.target.value !== '' ? parseFloat(e.target.value) : null)} />
                  <span class="cat-goal-sep">–</span>
                  <input class="cat-goal-input" type="number"
                    value=${cat.maxHours != null ? cat.maxHours : ''}
                    placeholder="max"
                    min="0" max="168" step="0.5"
                    title="Maximum hours (don't exceed this)"
                    onInput=${(e) => updateCat(cat.id, 'maxHours', e.target.value !== '' ? parseFloat(e.target.value) : null)} />
                  <span class="cat-hours-label">h</span>
                </div>
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
