import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { syncAfterMutation, useSyncRefresh } from '../sync.js';
import { navigate } from '../router.js';
import {
  uuid, now, today, toDateStr, parseDate, formatShort, dayName,
  parseDuration, formatDuration, calcHoursFromDatetimes, hoursForDate,
  buildCategoryTree, flattenCategoryTree, computeHoursByCat,
} from '../utils.js';

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Icons (paths copied verbatim from the design mockup)
const IconClock = html`<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v4.8l3 1.8"/></svg>`;
const IconNote = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1-4 9-9 3 3-9 9-4 1z"/><path d="M13.5 6.5l3 3"/></svg>`;
const IconPlus = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

// Current wall-clock time as HH:MM
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Compute end datetime accounting for midnight crossover
function buildEndAt(date, startTime, endTime) {
  if (!endTime) return null;
  if (!startTime || endTime >= startTime) return `${date}T${endTime}`;
  const nd = parseDate(date);
  nd.setDate(nd.getDate() + 1);
  return `${toDateStr(nd)}T${endTime}`;
}

// Merge events + day-notes into a single ordered feed:
// ongoing events first, then items by clock time, then manual/untimed items last.
function buildFeed(events, notes, currentDate) {
  const items = [
    ...events.map(e => ({ kind: 'event', data: e })),
    ...notes.map(n => ({ kind: 'note', data: n })),
  ];
  const rank = (it) => {
    if (it.kind === 'event') {
      const e = it.data;
      if (e.startAt && !e.endAt) return 0;   // ongoing
      if (e.startAt) return 1;               // timed
      return 2;                              // manual hours
    }
    return it.data.at ? 1 : 2;               // note: timed vs untimed
  };
  const timeKey = (it) => {
    if (it.kind === 'event') {
      const e = it.data;
      if (!e.startAt) return '';
      if (e.date !== currentDate) return '00:00'; // cross-midnight spill: started before today
      return e.startAt.slice(11, 16);
    }
    return it.data.at || '';
  };
  return items.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ta = timeKey(a), tb = timeKey(b);
    if (ta !== tb) return ta.localeCompare(tb);
    if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1; // events before notes
    return 0;
  });
}

const EMPTY_FORM = { id: null, categoryIds: [], description: '', startTime: '', endTime: '', durationStr: '' };

export function DailyLog({ budgetId, date: dateProp }) {
  const currentDate = dateProp || today();
  const [categories, setCategories] = useState([]);
  const [flatCats, setFlatCats] = useState([]);
  const [events, setEvents] = useState([]);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [noteForm, setNoteForm] = useState(null);

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
      const allNotes = await db.getDayNotes(budgetId);
      setNotes(allNotes.filter(n => n.date === currentDate));
    } catch (e) {
      console.error('DailyLog load failed:', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [budgetId, currentDate]);
  useSyncRefresh(load);

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

  // --- Event form ---

  function openNewForm() {
    setNoteForm(null);
    setForm({ ...EMPTY_FORM });
  }

  function openEditForm(event) {
    setNoteForm(null);
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
    const endTime = nowHHMM();
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

  // --- Day notes ---

  function openNewNote() {
    setForm(null);
    setNoteForm({ id: null, at: nowHHMM(), text: '' });
  }

  function openEditNote(note) {
    setForm(null);
    setNoteForm({ id: note.id, at: note.at || '', text: note.text || '' });
  }

  async function saveNote() {
    if (!noteForm) return;
    const text = noteForm.text.trim();
    if (!text) { setNoteForm(null); return; }
    const ts = now();
    const existing = noteForm.id ? notes.find(n => n.id === noteForm.id) : null;
    const record = {
      id: noteForm.id || uuid(),
      budgetId,
      date: currentDate,
      at: noteForm.at || null,
      text,
      createdAt: existing ? existing.createdAt : ts,
      updatedAt: ts,
    };
    await db.putDayNote(record);
    if (noteForm.id) {
      setNotes(prev => prev.map(n => n.id === record.id ? record : n));
    } else {
      setNotes(prev => [...prev, record]);
    }
    setNoteForm(null);
    syncAfterMutation();
  }

  async function removeNote(id) {
    await db.deleteDayNote(id, now());
    setNotes(prev => prev.filter(n => n.id !== id));
    setNoteForm(null);
    syncAfterMutation();
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  const dateObj = parseDate(currentDate);
  const isToday = currentDate === today();
  const feed = buildFeed(events, notes, currentDate);
  const formOpen = !!form || !!noteForm;
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
          <span class="date-day">${DAYS_FULL[dateObj.getDay()]}</span>
          <span class="date-full">${formatShort(dateObj)}${isToday ? ' · today' : ''}</span>
        </div>
        <button class="nav-arrow" onClick=${nextDay}>›</button>
      </div>

      <p class="day-total"><strong>${dayTotal.toFixed(1)}h</strong> logged</p>

      <div class="add-row">
        <button class="add-time" onClick=${openNewForm}>${IconPlus}Time</button>
        <button class="add-note" onClick=${openNewNote}>Note</button>
        <button class="add-more" title="More trackers coming">+</button>
      </div>

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

      ${noteForm && html`
        <div class="note-form">
          <div class="note-form-top">
            <input class="note-form-time" type="time" value=${noteForm.at}
              onInput=${(e) => setNoteForm(f => ({ ...f, at: e.target.value }))} />
          </div>
          <textarea class="note-form-text" rows="2" placeholder="What's on your mind?"
            value=${noteForm.text}
            onInput=${(e) => setNoteForm(f => ({ ...f, text: e.target.value }))}></textarea>
          <div class="note-form-actions">
            <button class="btn" onClick=${saveNote}>Save</button>
            <button class="btn btn-secondary" onClick=${() => setNoteForm(null)}>Cancel</button>
            ${noteForm.id && html`
              <button class="note-form-delete" onClick=${() => removeNote(noteForm.id)}>Delete</button>
            `}
          </div>
        </div>
      `}

      <div class="feed">
        ${feed.map(item => item.kind === 'event'
          ? renderEventCard(item.data)
          : renderNoteCard(item.data))}
      </div>

      ${feed.length === 0 && !formOpen && html`
        <p class="empty-state">Nothing logged yet.</p>
      `}

      ${feed.length > 0 && html`
        <div class="feed-hint">Mood · food · energy — future trackers drop into this same feed</div>
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

  function renderEventCard(event) {
    const catIds = Array.isArray(event.categories) ? event.categories : [];
    const eventCats = catIds.map(id => categories.find(c => c.id === id)).filter(Boolean);
    const isOpen = event.startAt && !event.endAt;
    const badgeColor = eventCats[0] ? eventCats[0].color : '#7f8dff';
    const title = event.description || eventCats.map(c => c.name || 'Unnamed').join(', ') || 'Event';

    let timeLabel = '';
    const crossDay = event.date !== currentDate;
    if (event.startAt && event.endAt) {
      const h = hoursForDate(event, currentDate);
      if (crossDay) {
        timeLabel = `↩ until ${event.endAt.slice(11, 16)} · ${h.toFixed(1)}h`;
      } else {
        timeLabel = `${event.startAt.slice(11, 16)}–${event.endAt.slice(11, 16)} · ${h.toFixed(1)}h`;
      }
    } else if (event.startAt) {
      timeLabel = `ongoing · started ${event.startAt.slice(11, 16)}`;
    } else if (event.hours != null) {
      timeLabel = `${event.hours.toFixed(1)}h`;
    }

    return html`
      <div class="feed-card ${isOpen ? 'feed-ongoing' : ''}" key=${event.id}
        onClick=${() => !formOpen && openEditForm(event)}>
        <div class="feed-badge" style=${{ background: badgeColor + '26', color: badgeColor }}>${IconClock}</div>
        <div class="feed-body">
          <div class="feed-title">
            <span class="feed-title-text">${title}</span>
            ${eventCats.length > 1 && html`
              <span class="feed-dots">
                ${eventCats.map(c => html`
                  <span class="feed-dot" key=${c.id} style=${{ background: c.color }} title=${c.name}></span>
                `)}
              </span>
            `}
          </div>
          <div class="feed-sub">${timeLabel}</div>
        </div>
        <div class="feed-card-actions" onClick=${(e) => e.stopPropagation()}>
          ${isOpen && html`
            <button class="feed-stop" onClick=${() => stopEvent(event.id)}>Stop</button>
          `}
          <button class="feed-delete" onClick=${() => removeEvent(event.id)}>×</button>
        </div>
      </div>
    `;
  }

  function renderNoteCard(note) {
    return html`
      <div class="feed-card feed-note" key=${note.id}
        onClick=${() => !formOpen && openEditNote(note)}>
        <div class="feed-badge feed-badge-note">${IconNote}</div>
        <div class="feed-body">
          <div class="feed-title"><span class="feed-title-text">${note.text}</span></div>
          <div class="feed-sub">Note${note.at ? ` · ${note.at}` : ''}</div>
        </div>
      </div>
    `;
  }
}
