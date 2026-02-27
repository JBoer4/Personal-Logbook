import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { syncAfterMutation } from '../sync.js';
import { navigate } from '../router.js';
import {
  uuid, now, today, toDateStr, parseDate, formatShort, dayName,
  parseDuration, formatDuration, calcHoursFromDatetimes, hoursForDate,
  buildCategoryTree, flattenCategoryTree, computeHoursByCat,
} from '../utils.js';

function sortEvents(events) {
  const open = events.filter(e => e.startAt && !e.endAt);
  const timed = [...events.filter(e => e.startAt && e.endAt)].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const manual = events.filter(e => !e.startAt);
  return [...open, ...timed, ...manual];
}

// Compute end datetime accounting for midnight crossover
function buildEndAt(date, startTime, endTime) {
  if (!endTime) return null;
  if (!startTime || endTime >= startTime) return `${date}T${endTime}`;
  const nd = parseDate(date);
  nd.setDate(nd.getDate() + 1);
  return `${toDateStr(nd)}T${endTime}`;
}

const EMPTY_FORM = { id: null, categoryIds: [], description: '', startTime: '', endTime: '', durationStr: '' };

export function DailyLog({ budgetId, date: dateProp }) {
  const currentDate = dateProp || today();
  const [categories, setCategories] = useState([]);
  const [flatCats, setFlatCats] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);

  async function load() {
    try {
      const cats = await db.getCategories(budgetId);
      setCategories(cats);
      setFlatCats(flattenCategoryTree(buildCategoryTree(cats)));
      const allEvents = await db.getEvents(budgetId);
      const prevD = parseDate(currentDate);
      prevD.setDate(prevD.getDate() - 1);
      const prevDate = toDateStr(prevD);
      setEvents(allEvents.filter(e => {
        if (e.date === currentDate) return true;
        // Include cross-midnight events from the previous day that spill into today
        if (e.date === prevDate && e.startAt && e.endAt) {
          return hoursForDate(e, currentDate) > 0;
        }
        return false;
      }));
    } catch (e) {
      console.error('DailyLog load failed:', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [budgetId, currentDate]);

  function prevDay() {
    const d = parseDate(currentDate);
    d.setDate(d.getDate() - 1);
    navigate(`/budget/${budgetId}/log/${toDateStr(d)}`);
  }

  function nextDay() {
    const d = parseDate(currentDate);
    d.setDate(d.getDate() + 1);
    navigate(`/budget/${budgetId}/log/${toDateStr(d)}`);
  }

  function openNewForm() {
    setForm({ ...EMPTY_FORM });
  }

  function openEditForm(event) {
    setForm({
      id: event.id,
      categoryIds: Array.isArray(event.categories) ? [...event.categories] : [],
      description: event.description || '',
      startTime: event.startAt ? event.startAt.slice(11, 16) : '',
      endTime: event.endAt ? event.endAt.slice(11, 16) : '',
      durationStr: event.hours != null ? formatDuration(event.hours) : '',
    });
  }

  function toggleCategory(catId) {
    setForm(f => ({
      ...f,
      categoryIds: f.categoryIds.includes(catId)
        ? f.categoryIds.filter(id => id !== catId)
        : [...f.categoryIds, catId],
    }));
  }

  function handleTimeChange(field, value) {
    setForm(f => {
      const updated = { ...f, [field]: value };
      const start = field === 'startTime' ? value : f.startTime;
      const end = field === 'endTime' ? value : f.endTime;
      if (start && end) {
        const startAt = `${currentDate}T${start}`;
        const endAt = buildEndAt(currentDate, start, end);
        const h = calcHoursFromDatetimes(startAt, endAt);
        if (h !== null) updated.durationStr = formatDuration(h);
      }
      return updated;
    });
  }

  async function saveEvent() {
    if (!form) return;
    if (form.categoryIds.length === 0) {
      alert('Select at least one category.');
      return;
    }

    const startAt = form.startTime ? `${currentDate}T${form.startTime}` : null;
    const endAt = startAt ? buildEndAt(currentDate, form.startTime, form.endTime) : null;

    let hours = null;
    if (startAt && endAt) {
      hours = calcHoursFromDatetimes(startAt, endAt);
    } else if (form.durationStr) {
      hours = parseDuration(form.durationStr);
    }

    const ts = now();
    const existing = form.id ? events.find(e => e.id === form.id) : null;
    const event = {
      id: form.id || uuid(),
      budgetId,
      date: currentDate,
      startAt,
      endAt,
      hours,
      description: form.description.trim() || null,
      categories: form.categoryIds,
      createdAt: existing ? existing.createdAt : ts,
      updatedAt: ts,
    };

    await db.putEvent(event);
    if (form.id) {
      setEvents(prev => prev.map(e => e.id === form.id ? event : e));
    } else {
      setEvents(prev => [...prev, event]);
    }
    setForm(null);
    syncAfterMutation();
  }

  async function stopEvent(id) {
    const event = events.find(e => e.id === id);
    if (!event) return;
    const d = new Date();
    const endTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const startTime = event.startAt ? event.startAt.slice(11, 16) : '';
    const endAt = buildEndAt(currentDate, startTime, endTime);
    const hours = calcHoursFromDatetimes(event.startAt, endAt);
    const updated = { ...event, endAt, hours, updatedAt: now() };
    await db.putEvent(updated);
    setEvents(prev => prev.map(e => e.id === id ? updated : e));
    syncAfterMutation();
  }

  async function removeEvent(id) {
    await db.deleteEvent(id, now());
    setEvents(prev => prev.filter(e => e.id !== id));
    syncAfterMutation();
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  const dateObj = parseDate(currentDate);
  const isToday = currentDate === today();
  const sorted = sortEvents(events);
  const dayTotal = events.reduce((s, e) => s + hoursForDate(e, currentDate), 0);

  // Per-category hours for today with parent rollup — for the breakdown bars
  const hoursByCat = computeHoursByCat(events, [currentDate], categories);
  const shownCats = flatCats.filter(({ cat }) => (hoursByCat[cat.id] || 0) > 0);
  const maxCatHours = shownCats.reduce((m, { cat }) => Math.max(m, hoursByCat[cat.id] || 0), 0);

  // Warning: computed hours from form times
  let formComputedHours = null;
  if (form && form.startTime && form.endTime) {
    const startAt = `${currentDate}T${form.startTime}`;
    const endAt = buildEndAt(currentDate, form.startTime, form.endTime);
    formComputedHours = calcHoursFromDatetimes(startAt, endAt);
  }

  return html`
    <div class="daily-log">
      <div class="date-nav">
        <button class="nav-arrow" onClick=${prevDay}>‹</button>
        <div class="date-display">
          <span class="date-day">${dayName(dateObj)}</span>
          <span class="date-full">${formatShort(dateObj)}${isToday ? ' (today)' : ''}</span>
        </div>
        <button class="nav-arrow" onClick=${nextDay}>›</button>
      </div>

      <p class="day-total">${dayTotal.toFixed(1)}h logged</p>

      ${!form && html`
        <button class="btn btn-add event-add-btn" onClick=${openNewForm}>+ New Event</button>
      `}

      ${form && html`
        <div class="event-form">
          <div class="event-form-cats">
            ${flatCats.map(({ cat, depth }) => html`
              <label class="event-cat-option" key=${cat.id} style="padding-left: ${depth * 0.75}rem">
                <input type="checkbox"
                  checked=${form.categoryIds.includes(cat.id)}
                  onChange=${() => toggleCategory(cat.id)} />
                <span class="event-cat-dot" style=${{ background: cat.color }}></span>
                <span>${cat.name || 'Unnamed'}</span>
              </label>
            `)}
          </div>

          <div class="event-form-fields">
            <input class="event-form-desc" type="text" placeholder="Description (optional)"
              value=${form.description}
              onInput=${(e) => setForm(f => ({ ...f, description: e.target.value }))} />

            <div class="event-form-times">
              <label>Start</label>
              <input type="time" value=${form.startTime}
                onInput=${(e) => handleTimeChange('startTime', e.target.value)} />
              <label>End</label>
              <input type="time" value=${form.endTime}
                onInput=${(e) => handleTimeChange('endTime', e.target.value)} />
            </div>

            <div class="event-form-duration">
              <input type="text" placeholder="Duration (e.g. 1h30m)"
                value=${form.durationStr}
                onInput=${(e) => setForm(f => ({ ...f, durationStr: e.target.value }))} />
              ${formComputedHours !== null && formComputedHours > 12 && html`
                <span class="duration-warn">${formComputedHours.toFixed(1)}h — looks right?</span>
              `}
            </div>

            <div class="event-form-actions">
              <button class="btn" onClick=${saveEvent}>Save</button>
              <button class="btn btn-secondary" onClick=${() => setForm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      `}

      <div class="event-list">
        ${sorted.map(event => {
          const catIds = Array.isArray(event.categories) ? event.categories : [];
          const eventCats = catIds.map(id => categories.find(c => c.id === id)).filter(Boolean);
          const isOpen = event.startAt && !event.endAt;

          let timeLabel = '';
          const crossDay = event.date !== currentDate;
          if (event.startAt && event.endAt) {
            const h = hoursForDate(event, currentDate);
            if (crossDay) {
              timeLabel = `↩ until ${event.endAt.slice(11, 16)} (${h.toFixed(1)}h)`;
            } else {
              const sh = event.startAt.slice(11, 16);
              const eh = event.endAt.slice(11, 16);
              timeLabel = `${sh}–${eh} (${h.toFixed(1)}h)`;
            }
          } else if (event.startAt) {
            timeLabel = `started ${event.startAt.slice(11, 16)}, ongoing`;
          } else if (event.hours != null) {
            timeLabel = `${event.hours.toFixed(1)}h`;
          }

          return html`
            <div class="event-row ${isOpen ? 'event-open' : ''}" key=${event.id}
              onClick=${() => !form && openEditForm(event)}>
              <div class="event-cats">
                ${eventCats.map(c => html`
                  <span class="event-cat-dot" key=${c.id} style=${{ background: c.color }} title=${c.name}></span>
                `)}
              </div>
              <div class="event-body">
                ${event.description && html`<span class="event-desc">${event.description}</span>`}
                <span class="event-time">${timeLabel}</span>
              </div>
              <div class="event-actions" onClick=${(e) => e.stopPropagation()}>
                ${isOpen && html`
                  <button class="event-stop" onClick=${() => stopEvent(event.id)}>Stop</button>
                `}
                <button class="event-delete" onClick=${() => removeEvent(event.id)}>×</button>
              </div>
            </div>
          `;
        })}
      </div>

      ${events.length === 0 && !form && html`
        <p class="empty-state">No events logged yet.</p>
      `}

      ${shownCats.length > 0 && html`
        <div class="day-breakdown">
          <div class="day-breakdown-title">Breakdown</div>
          ${shownCats.map(({ cat, depth }) => {
            const h = hoursByCat[cat.id] || 0;
            const pct = maxCatHours > 0 ? (h / maxCatHours) * 100 : 0;
            return html`
              <div class="db-row" key=${cat.id}>
                <div class="db-label" style=${{ paddingLeft: `${depth * 0.75}rem` }}>
                  <span class="db-dot" style=${{ background: cat.color }}></span>
                  <span class="db-name">${cat.name || 'Unnamed'}</span>
                </div>
                <div class="db-bar-wrap">
                  <div class="db-bar" style=${{ width: `${pct}%`, background: cat.color }}></div>
                </div>
                <div class="db-hours">${h.toFixed(1)}h</div>
              </div>
            `;
          })}
        </div>
      `}
    </div>
  `;
}
