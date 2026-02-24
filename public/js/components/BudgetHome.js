import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation } from '../sync.js';
import { now, getWeekStart, getWeekDates, toDateStr, formatRange, dayName, hoursForDate } from '../utils.js';

export function BudgetHome({ budgetId }) {
  const [budget, setBudget] = useState(null);
  const [categories, setCategories] = useState([]);
  const [events, setEvents] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

      const allEvents = await db.getEvents(budgetId);
      setEvents(allEvents.filter(e => weekDateStrs.includes(e.date)));
    } catch (e) {
      console.error('BudgetHome load failed:', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [budgetId, weekOffset]);

  if (loading) return html`<div class="loading">Loading...</div>`;

  // Build hours by (categoryId, date) — full duration counts per category (intentional double-counting)
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

  // Per-category weekly totals
  const catTotals = {};
  for (const cat of categories) {
    catTotals[cat.id] = weekDateStrs.reduce((s, d) => s + (hoursByDayCat[`${cat.id}|${d}`] || 0), 0);
  }

  const totalTarget = categories.reduce((s, c) => s + (c.targetHours || 0), 0);
  // Total logged = actual elapsed hours (each event counted once, not per-category)
  const totalLogged = events.reduce((s, e) => s + weekDateStrs.reduce((sum, d) => sum + hoursForDate(e, d), 0), 0);

  // Day totals for bar scaling: sum of actual event hours per day
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
    // Soft-delete locally: events, entries, categories, then budget
    const cats = await db.getCategories(budgetId);
    const ents = await db.getEntries(budgetId);
    const evts = await db.getEvents(budgetId);
    for (const e of evts) await db.deleteEvent(e.id, ts);
    for (const e of ents) await db.deleteEntry(e.id, ts);
    for (const c of cats) await db.deleteCategory(c.id, ts);
    await db.deleteBudget(budgetId, ts);
    // Sync propagates the soft deletes to server and other devices
    syncAfterMutation();
    navigate('/');
  }

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

      <!-- Budget vs Actual -->
      <div class="budget-vs-actual">
        <h3>Budget vs Actual</h3>
        ${categories.map(cat => {
          const actual = catTotals[cat.id] || 0;
          const target = cat.targetHours || 0;
          const pct = target > 0 ? Math.min((actual / target) * 100, 150) : 0;
          const over = target > 0 && actual > target;
          return html`
            <div class="bva-row" key=${cat.id}>
              <div class="bva-label">
                <span class="bva-dot" style=${{ background: cat.color }}></span>
                <span class="bva-name">${cat.name}</span>
              </div>
              <div class="bva-bar-wrap">
                <div class="bva-bar ${over ? 'over' : ''}" style=${{
                  width: `${Math.min(pct, 100)}%`,
                  background: cat.color,
                }}></div>
                ${over && html`<div class="bva-bar-over" style=${{
                  width: `${pct - 100}%`,
                  background: cat.color,
                  opacity: 0.4,
                }}></div>`}
              </div>
              <div class="bva-nums">${actual.toFixed(1)} / ${target}h</div>
            </div>
          `;
        })}
        <div class="bva-row bva-total">
          <div class="bva-label"><span class="bva-name">Total</span></div>
          <div class="bva-bar-wrap">
            <div class="bva-bar" style=${{
              width: `${totalTarget > 0 ? Math.min((totalLogged / totalTarget) * 100, 100) : 0}%`,
              background: '#64748b',
            }}></div>
          </div>
          <div class="bva-nums">${totalLogged.toFixed(1)} / ${totalTarget}h</div>
        </div>
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
