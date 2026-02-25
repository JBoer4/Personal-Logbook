import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { getWeekStart, toDateStr, formatRange, calcHoursFromDatetimes } from '../utils.js';

export function History({ budgetId }) {
  const [categories, setCategories] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const cats = await db.getCategories(budgetId);
    cats.sort((a, b) => a.sortOrder - b.sortOrder);
    setCategories(cats);

    const allEvents = await db.getEvents(budgetId);
    setEntries(allEvents);
    setLoading(false);
  }

  useEffect(() => { load(); }, [budgetId]);

  if (loading) return html`<div class="loading">Loading...</div>`;

  // Group entries by week
  const weekMap = new Map();
  for (const e of entries) {
    const ws = toDateStr(getWeekStart(e.date + 'T00:00:00'));
    if (!weekMap.has(ws)) weekMap.set(ws, []);
    weekMap.get(ws).push(e);
  }

  // Sort weeks newest first
  const weeks = [...weekMap.keys()].sort().reverse();

  if (weeks.length === 0) {
    return html`<div class="history-view"><h2>History</h2><p class="empty-state">No logged time yet.</p></div>`;
  }

  return html`
    <div class="history-view">
      <h2>History</h2>
      <div class="history-list">
        ${weeks.map(weekStart => {
          const weekEntries = weekMap.get(weekStart);
          const endDate = new Date(weekStart + 'T00:00:00');
          endDate.setDate(endDate.getDate() + 6);

          // Calculate week offset from current week
          const currentWeekStart = getWeekStart(new Date());
          const diff = Math.round((new Date(weekStart + 'T00:00:00') - currentWeekStart) / (7 * 24 * 60 * 60 * 1000));

          return html`
            <button class="history-week" key=${weekStart}
              onClick=${() => navigate(`/budget/${budgetId}`)}>
              <div class="history-range">${formatRange(weekStart + 'T00:00:00', endDate)}</div>
              <div class="history-cats">
                ${categories.map(cat => {
                  const actual = weekEntries
                    .filter(e => (Array.isArray(e.categories) ? e.categories : []).includes(cat.id))
                    .reduce((s, e) => {
                      const h = e.startAt && e.endAt ? calcHoursFromDatetimes(e.startAt, e.endAt) || 0 : e.hours || 0;
                      return s + h;
                    }, 0);
                  if (actual === 0) return null;
                  return html`
                    <div class="history-cat-row" key=${cat.id}>
                      <span class="history-dot" style=${{ background: cat.color }}></span>
                      <span class="history-cat-name">${cat.name}</span>
                      <span class="history-cat-hours">${actual.toFixed(1)}h</span>
                    </div>
                  `;
                })}
              </div>
              <div class="history-total">
                Total: ${weekEntries.reduce((s, e) => {
                  const h = e.startAt && e.endAt ? calcHoursFromDatetimes(e.startAt, e.endAt) || 0 : e.hours || 0;
                  return s + h;
                }, 0).toFixed(1)}h
              </div>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}
