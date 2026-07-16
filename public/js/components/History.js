import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { useSyncRefresh } from '../sync.js';
import { navigate } from '../router.js';
import { getWeekStart, getWeekDates, toDateStr, formatRange, hoursForDate, computeHoursByCat, buildCategoryTree, flattenCategoryTree } from '../utils.js';

export function History({ budgetId }) {
  const [categories, setCategories] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const cats = await db.getCategories(budgetId);
    setCategories(cats);

    const allEvents = await db.getEvents(budgetId);
    setEvents(allEvents);
    setLoading(false);
  }

  useEffect(() => { load(); }, [budgetId]);
  useSyncRefresh(load);

  if (loading) return html`<div class="loading">Loading...</div>`;

  // Weeks that have at least one event, newest first
  const weeks = [...new Set(events.map(e => toDateStr(getWeekStart(e.date + 'T00:00:00'))))]
    .sort()
    .reverse();

  if (weeks.length === 0) {
    return html`<div class="history-view"><h2>History</h2><p class="empty-state">No logged time yet.</p></div>`;
  }

  const flatCats = flattenCategoryTree(buildCategoryTree(categories));

  return html`
    <div class="history-view">
      <h2>History</h2>
      <div class="history-list">
        ${weeks.map(weekStart => {
          const weekDates = getWeekDates(new Date(weekStart + 'T00:00:00')).map(toDateStr);
          const endDate = new Date(weekStart + 'T00:00:00');
          endDate.setDate(endDate.getDate() + 6);

          // Same attention-hours math as BudgetHome: per-day clipping for
          // cross-midnight events, parent rollup included.
          const hoursByCat = computeHoursByCat(events, weekDates, categories);
          const weekTotal = events.reduce(
            (s, e) => s + weekDates.reduce((ds, d) => ds + hoursForDate(e, d), 0), 0);
          const maxHours = Math.max(...flatCats.map(({ cat }) => hoursByCat[cat.id] || 0), 1);

          return html`
            <button class="history-week" key=${weekStart}
              onClick=${() => navigate(`/budget/${budgetId}`)}>
              <div class="history-range">${formatRange(weekStart + 'T00:00:00', endDate)}</div>
              <div class="history-cats">
                ${flatCats.map(({ cat }) => {
                  const actual = hoursByCat[cat.id] || 0;
                  if (actual === 0) return null;
                  return html`
                    <div class="history-cat-row" key=${cat.id}>
                      <span class="history-dot" style=${{ background: cat.color }}></span>
                      <span class="history-cat-name">${cat.name}</span>
                      <div class="history-bar-wrap">
                        <div class="history-bar" style=${{ width: `${(actual / maxHours) * 100}%`, background: cat.color }}></div>
                      </div>
                      <span class="history-cat-hours">${actual.toFixed(1)}h</span>
                    </div>
                  `;
                })}
              </div>
              <div class="history-total">
                Total: ${weekTotal.toFixed(1)}h
              </div>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}
