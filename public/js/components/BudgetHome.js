import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation } from '../sync.js';
import { uuid, now, getWeekStart, getWeekDates, toDateStr, formatRange, dayName, hoursForDate } from '../utils.js';

export function BudgetHome({ budgetId }) {
  const [budget, setBudget] = useState(null);
  const [categories, setCategories] = useState([]);
  const [events, setEvents] = useState([]);
  const [goalSnapshots, setGoalSnapshots] = useState([]); // silent per-week goal history
  const [allEventWeeks, setAllEventWeeks] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showCopyPicker, setShowCopyPicker] = useState(false);
  const nameRef = useRef(null);

  const weekStart = getWeekStart(new Date());
  weekStart.setDate(weekStart.getDate() + weekOffset * 7);
  const weekDates = getWeekDates(weekStart);
  const weekDateStrs = weekDates.map(toDateStr);

  async function load() {
    try {
      const b = await db.getBudget(budgetId);
      setBudget(b);

      const cats = await db.getCategories(budgetId);
      cats.sort((a, b) => a.sortOrder - b.sortOrder);
      setCategories(cats);

      const allSnapshots = await db.getOverrides(budgetId);
      setGoalSnapshots(allSnapshots);

      const allEvents = await db.getEvents(budgetId);
      const uniqueWeeks = [...new Set(allEvents.map(e =>
        toDateStr(getWeekStart(new Date(e.date + 'T00:00:00')))
      ))].sort().reverse();
      setAllEventWeeks(uniqueWeeks);

      setEvents(allEvents.filter(e => weekDateStrs.includes(e.date)));

      // Silently snapshot current week's goals so past weeks can be copied from later.
      // Only runs for the actual current week (not when browsing history).
      if (weekOffset === 0) {
        const currentWeekStr = toDateStr(getWeekStart(new Date()));
        const goalCats = cats.filter(c => c.minHours != null || c.maxHours != null);
        const alreadySnapshotted = allSnapshots.some(s => s.periodStart === currentWeekStr);
        if (goalCats.length > 0 && !alreadySnapshotted) {
          const ts = now();
          const newSnapshots = [];
          for (const cat of goalCats) {
            const snap = {
              id: uuid(), budgetId, categoryId: cat.id,
              periodStart: currentWeekStr, targetHours: 0,
              minHours: cat.minHours, maxHours: cat.maxHours,
              createdAt: ts, updatedAt: ts,
            };
            await db.putOverride(snap);
            newSnapshots.push(snap);
          }
          setGoalSnapshots([...allSnapshots, ...newSnapshots]);
          syncAfterMutation();
        }
      }
    } catch (e) {
      console.error('BudgetHome load failed:', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [budgetId, weekOffset]);

  if (loading) return html`<div class="loading">Loading...</div>`;

  const weekStartStr = toDateStr(weekStart);

  // Weeks that have a saved goal snapshot (can be meaningfully copied from)
  const snapshotWeeks = [...new Set(goalSnapshots.map(s => s.periodStart))];
  const copyableWeeks = [...new Set([...allEventWeeks, ...snapshotWeeks])]
    .filter(w => w !== weekStartStr)
    .sort()
    .reverse();

  async function copyFromWeek(sourceWeekStr) {
    const sourceSnaps = goalSnapshots.filter(s => s.periodStart === sourceWeekStr);
    const snapByCategory = Object.fromEntries(sourceSnaps.map(s => [s.categoryId, s]));

    const ts = now();
    const updatedCats = [];
    for (const cat of categories) {
      const snap = snapByCategory[cat.id];
      if (!snap) continue; // no goal history for this category in that week
      const updated = { ...cat, minHours: snap.minHours, maxHours: snap.maxHours, updatedAt: ts };
      await db.putCategory(updated);
      updatedCats.push(updated);
    }

    if (updatedCats.length > 0) {
      setCategories(prev => prev.map(c => {
        const u = updatedCats.find(u => u.id === c.id);
        return u || c;
      }));
    }

    setShowCopyPicker(false);
    syncAfterMutation();
  }

  // Build hours by (categoryId, date)
  const hoursByDayCat = {};
  for (const event of events) {
    const catIds = Array.isArray(event.categories) ? event.categories : [];
    for (const dateStr of weekDateStrs) {
      const h = hoursForDate(event, dateStr);
      if (h > 0) {
        for (const catId of catIds) {
          const key = `${catId}|${dateStr}`;
          hoursByDayCat[key] = (hoursByDayCat[key] || 0) + h;
        }
      }
    }
  }

  const catById = Object.fromEntries(categories.map(c => [c.id, c]));

  // Direct totals per category for the week (no rollup — used for timeline segments)
  const directTotals = {};
  for (const cat of categories) {
    directTotals[cat.id] = weekDateStrs.reduce((s, d) => s + (hoursByDayCat[`${cat.id}|${d}`] || 0), 0);
  }

  // Totals with parent rollup — child hours accumulate into ancestors
  const catTotals = { ...directTotals };
  for (const cat of categories) {
    const h = directTotals[cat.id];
    if (!h) continue;
    let c = cat;
    while (c && c.parentId) {
      catTotals[c.parentId] = (catTotals[c.parentId] || 0) + h;
      c = catById[c.parentId];
    }
  }

  const dayTotals = weekDateStrs.map(dateStr =>
    events.reduce((s, e) => s + hoursForDate(e, dateStr), 0)
  );
  const maxDay = Math.max(24, ...dayTotals);

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
    const ents = await db.getEntries(budgetId);
    const evts = await db.getEvents(budgetId);
    for (const e of evts) await db.deleteEvent(e.id, ts);
    for (const e of ents) await db.deleteEntry(e.id, ts);
    for (const c of cats) await db.deleteCategory(c.id, ts);
    await db.deleteBudget(budgetId, ts);
    syncAfterMutation();
    navigate('/');
  }

  const goalCats = categories.filter(c => c.minHours != null || c.maxHours != null);

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

      <div class="week-nav">
        <button class="nav-arrow" onClick=${() => setWeekOffset(w => w - 1)}>‹</button>
        <span class="week-range">${formatRange(weekDates[0], weekDates[6])}</span>
        <button class="nav-arrow" onClick=${() => setWeekOffset(w => w + 1)}>›</button>
      </div>

      <!-- Daily Timeline -->
      <div class="timeline">
        ${weekDates.map((date, i) => {
          const dateStr = weekDateStrs[i];
          return html`
            <div class="timeline-col" key=${dateStr}
              onClick=${() => navigate(`/budget/${budgetId}/log/${dateStr}`)}>
              <div class="timeline-label">${dayName(date)}</div>
              <div class="timeline-bar">
                ${categories.map(cat => {
                  const h = hoursByDayCat[`${cat.id}|${dateStr}`] || 0;
                  if (h === 0) return null;
                  const pct = (h / maxDay) * 100;
                  return html`<div class="timeline-segment" style=${{
                    background: cat.color,
                    height: `${pct}%`,
                  }} title="${cat.name}: ${h.toFixed(1)}h"></div>`;
                })}
              </div>
              <div class="timeline-total">${dayTotals[i].toFixed(1)}</div>
            </div>
          `;
        })}
      </div>

      <!-- Goal Progress -->
      <div class="budget-vs-actual">
        <h3>Goal Progress</h3>

        ${goalCats.length === 0 ? html`
          <div class="empty-state" style=${{ fontSize: '0.85rem', padding: '12px 0 4px' }}>
            No goals set — add a min or max to a category to track progress.
          </div>
          ${copyableWeeks.length > 0 && html`
            <div class="copy-from-wrap">
              <button class="copy-from-btn" onClick=${() => setShowCopyPicker(v => !v)}>
                Copy goals from a previous week ${showCopyPicker ? '▴' : '▾'}
              </button>
              ${showCopyPicker && html`
                <div class="copy-picker">
                  ${copyableWeeks.map(w => {
                    const startD = new Date(w + 'T00:00:00');
                    const endD = new Date(startD);
                    endD.setDate(endD.getDate() + 6);
                    return html`
                      <button class="copy-picker-week" key=${w} onClick=${() => copyFromWeek(w)}>
                        ${formatRange(startD, endD)}
                      </button>
                    `;
                  })}
                </div>
              `}
            </div>
          `}
        ` : goalCats.map(cat => {
          const actual = catTotals[cat.id] || 0;
          const hasMin = cat.minHours != null;
          const hasMax = cat.maxHours != null;
          const ref = hasMax ? cat.maxHours : cat.minHours;
          const pct = ref > 0 ? Math.min((actual / ref) * 100, 150) : (actual > 0 ? 150 : 0);
          const overMax = hasMax && actual > cat.maxHours;

          let onTrack;
          if (hasMin && hasMax) {
            onTrack = actual >= cat.minHours && actual <= cat.maxHours;
          } else if (hasMin) {
            onTrack = actual >= cat.minHours;
          } else {
            onTrack = actual <= cat.maxHours;
          }

          let goalText;
          if (hasMin && hasMax) {
            goalText = `${cat.minHours}–${cat.maxHours}h`;
          } else if (hasMin) {
            goalText = `${cat.minHours}h+`;
          } else {
            goalText = `${cat.maxHours}h`;
          }

          return html`
            <div class="bva-row" key=${cat.id}>
              <div class="bva-label">
                <span class="bva-dot" style=${{ background: cat.color }}></span>
                <span class="bva-name">${cat.name}</span>
              </div>
              <div class="bva-bar-wrap">
                <div class="bva-bar" style=${{
                  width: `${Math.min(pct, 100)}%`,
                  background: cat.color,
                }}></div>
                ${overMax && html`<div class="bva-bar-over" style=${{
                  width: `${pct - 100}%`,
                  background: cat.color,
                  opacity: 0.4,
                }}></div>`}
              </div>
              <div class="bva-nums" style=${{ color: onTrack ? '#10b981' : 'var(--danger)' }}>
                ${actual.toFixed(1)} / ${goalText}
              </div>
            </div>
          `;
        })}
      </div>

      <!-- Quick actions -->
      <div class="budget-actions">
        <button class="btn" onClick=${() => navigate(`/budget/${budgetId}/log`)}>Log Today</button>
        <button class="btn btn-secondary" onClick=${() => navigate(`/budget/${budgetId}/categories`)}>Categories</button>
        <button class="btn btn-secondary" onClick=${() => navigate(`/budget/${budgetId}/history`)}>History</button>
      </div>
    </div>
  `;
}
