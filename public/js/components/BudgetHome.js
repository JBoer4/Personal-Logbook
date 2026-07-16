import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation, useSyncRefresh } from '../sync.js';
import { uuid, now, getWeekStart, getWeekDates, toDateStr, formatRange, formatShort, dayName, hoursForDate, unionHoursForDate, computeHoursByCat, buildCategoryTree, flattenCategoryTree, MS_PER_DAY } from '../utils.js';

const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function BudgetHome({ budgetId }) {
  const [budget, setBudget] = useState(null);
  const [categories, setCategories] = useState([]);
  const [events, setEvents] = useState([]);
  const [goalSnapshots, setGoalSnapshots] = useState([]); // silent per-week goal history
  const [allEventWeeks, setAllEventWeeks] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState(null);
  const [daysWithHours, setDaysWithHours] = useState(() => new Set());
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

      // Set of every date (across all history) that has any logged hours — powers the streak.
      const candidateDates = new Set();
      for (const e of allEvents) {
        if (e.date) candidateDates.add(e.date);
        if (e.startAt) candidateDates.add(toDateStr(new Date(e.startAt)));
        if (e.endAt) candidateDates.add(toDateStr(new Date(e.endAt)));
      }
      const withHours = new Set();
      for (const d of candidateDates) {
        if (unionHoursForDate(allEvents, d) > 0) withHours.add(d);
      }
      setDaysWithHours(withHours);

      setEvents(allEvents.filter(e => {
        if (weekDateStrs.includes(e.date)) return true;
        // Include cross-week events (e.g. sleep spanning Sat night → Sun morning)
        if (e.startAt && e.endAt) {
          return weekDateStrs.some(d => hoursForDate(e, d) > 0);
        }
        return false;
      }));

      // Silently snapshot current week's goals so past weeks can be copied from later.
      // Only runs for the actual current week (not when browsing history).
      if (weekOffset === 0) {
        const currentWeekStr = toDateStr(getWeekStart(new Date()));
        const goalCats = cats.filter(c => c.minHours != null || c.maxHours != null);
        const alreadySnapshotted = allSnapshots.some(s => s.periodStart === currentWeekStr);
        if (goalCats.length > 0 && !alreadySnapshotted) {
          const ts = now();
          const newSnapshots = goalCats.map(cat => ({
            id: uuid(), budgetId, categoryId: cat.id,
            periodStart: currentWeekStr,
            minHours: cat.minHours, maxHours: cat.maxHours,
            createdAt: ts, updatedAt: ts,
          }));
          await Promise.all(newSnapshots.map(s => db.putOverride(s)));
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
  useSyncRefresh(load);

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
    const updatedCats = categories
      .filter(cat => snapByCategory[cat.id])
      .map(cat => {
        const snap = snapByCategory[cat.id];
        return { ...cat, minHours: snap.minHours, maxHours: snap.maxHours, updatedAt: ts };
      });
    await Promise.all(updatedCats.map(c => db.putCategory(c)));

    if (updatedCats.length > 0) {
      setCategories(prev => prev.map(c => {
        const u = updatedCats.find(u => u.id === c.id);
        return u || c;
      }));
    }

    setShowCopyPicker(false);
    syncAfterMutation();
  }

  const catById = useMemo(
    () => Object.fromEntries(categories.map(c => [c.id, c])),
    [categories]
  );

  // Weekly totals with parent rollup (for goal progress)
  const catTotals = useMemo(
    () => computeHoursByCat(events, weekDateStrs, categories),
    [events, weekDateStrs, categories]
  );

  const dayTotals = useMemo(
    () => weekDateStrs.map(dateStr => unionHoursForDate(events, dateStr)),
    [events, weekDateStrs]
  );

  // Per-day category hours WITH parent rollup, one map per weekday (for the bycat bars).
  const dayRollups = useMemo(
    () => weekDateStrs.map(dateStr => computeHoursByCat(events, [dateStr], categories)),
    [events, weekDateStrs, categories]
  );

  // Clock-positioned events per day for the timeline strip
  const clockEventsByDay = useMemo(() => {
    const result = {};
    for (const dateStr of weekDateStrs) {
      const dayStart = new Date(dateStr + 'T00:00').getTime();
      const dayEnd = dayStart + MS_PER_DAY;
      const placed = [];
      for (const event of events
        .filter(e => e.startAt && e.endAt)
        .map(e => ({
          event: e,
          startMs: Math.max(new Date(e.startAt).getTime(), dayStart),
          endMs: Math.min(new Date(e.endAt).getTime(), dayEnd),
        }))
        .filter(({ startMs, endMs }) => startMs < endMs)
        .sort((a, b) => a.startMs - b.startMs)
      ) {
        const lane0Busy = placed.some(p => p.lane === 0 && p.startMs < event.endMs && p.endMs > event.startMs);
        placed.push({ ...event, lane: lane0Busy ? 1 : 0 });
      }
      // Break each event into segments at overlap boundaries so the split is
      // only applied during the actual concurrent window, not the whole event.
      const segments = [];
      for (const p of placed) {
        const boundaries = new Set([p.startMs, p.endMs]);
        for (const other of placed) {
          if (other === p) continue;
          if (other.startMs < p.endMs && other.endMs > p.startMs) {
            if (other.startMs > p.startMs) boundaries.add(other.startMs);
            if (other.endMs < p.endMs) boundaries.add(other.endMs);
          }
        }
        const sorted = [...boundaries].sort((a, b) => a - b);
        for (let i = 0; i < sorted.length - 1; i++) {
          const segStart = sorted[i];
          const segEnd = sorted[i + 1];
          const mid = (segStart + segEnd) / 2;
          const split = placed.some(o => o !== p && o.startMs <= mid && o.endMs >= mid);
          segments.push({ event: p.event, startMs: segStart, endMs: segEnd, lane: p.lane, split });
        }
      }
      result[dateStr] = segments;
    }
    return result;
  }, [events, weekDateStrs]);

  async function renameBudget(newName) {
    if (!budget || !newName.trim()) return;
    const updated = { ...budget, name: newName.trim(), updatedAt: now() };
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
    const ovrs = await db.getOverrides(budgetId);
    for (const e of evts) await db.deleteEvent(e.id, ts);
    for (const e of ents) await db.deleteEntry(e.id, ts);
    for (const o of ovrs) await db.deleteOverride(o.id, ts);
    for (const c of cats) await db.deleteCategory(c.id, ts);
    await db.deleteBudget(budgetId, ts);
    syncAfterMutation();
    navigate('/');
  }

  const goalCats = categories.filter(c => c.minHours != null || c.maxHours != null);

  // Selected day: user pick if it's in the visible week, else today (if visible), else week start.
  const todayStr = toDateStr(new Date());
  const defaultSel = weekDateStrs.includes(todayStr) ? todayStr : weekDateStrs[0];
  const selDate = (selectedDate && weekDateStrs.includes(selectedDate)) ? selectedDate : defaultSel;
  const selIndex = weekDateStrs.indexOf(selDate);
  const selDateObj = weekDates[selIndex];
  const selTotal = dayTotals[selIndex] || 0;

  // Chips for the selected day — every category with hours (incl. rolled-up parents), tree order.
  const selDayRollup = computeHoursByCat(events, [selDate], categories);
  const treeOrder = flattenCategoryTree(buildCategoryTree(categories));
  const selDayChips = treeOrder
    .map(({ cat }) => ({ cat, hours: selDayRollup[cat.id] || 0 }))
    .filter(x => x.hours > 0);

  // Streak: consecutive days with any logged hours, anchored at today or (if today empty) yesterday.
  const streak = (() => {
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!daysWithHours.has(toDateStr(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
      if (!daysWithHours.has(toDateStr(cursor))) return 0;
    }
    let count = 0;
    while (daysWithHours.has(toDateStr(cursor))) {
      count++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  })();

  // Goal helpers shared by the header pill and the bycat rows.
  function goalInfo(cat) {
    const actual = catTotals[cat.id] || 0;
    const hasMin = cat.minHours != null;
    const hasMax = cat.maxHours != null;
    let onTrack;
    if (hasMin && hasMax) onTrack = actual >= cat.minHours && actual <= cat.maxHours;
    else if (hasMin) onTrack = actual >= cat.minHours;
    else onTrack = actual <= cat.maxHours;
    let goalText;
    if (hasMin && hasMax) goalText = `${cat.minHours}–${cat.maxHours}h`;
    else if (hasMin) goalText = `${cat.minHours}h+`;
    else goalText = `${cat.maxHours}h`;
    return { actual, onTrack, goalText };
  }

  const onTrackCount = goalCats.filter(cat => goalInfo(cat).onTrack).length;

  // Bycat rows: goal categories, or (if none set) fall back to the busiest 4 categories.
  const usingFallback = goalCats.length === 0;
  const fallbackCats = [...categories]
    .filter(c => (catTotals[c.id] || 0) > 0)
    .sort((a, b) => (catTotals[b.id] || 0) - (catTotals[a.id] || 0))
    .slice(0, 4);
  const bycatRows = usingFallback ? fallbackCats : goalCats;

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

      <!-- Weekly ribbon -->
      <div class="ribbon">
        <div class="ribbon-axis">
          <span style=${{ top: '-3px' }}>12a</span>
          <span style=${{ top: '40px' }}>6a</span>
          <span style=${{ top: '83px' }}>12p</span>
          <span style=${{ top: '126px' }}>6p</span>
          <span style=${{ bottom: '-3px' }}>12a</span>
        </div>
        <div class="ribbon-cols">
          ${weekDates.map((date, i) => {
            const dateStr = weekDateStrs[i];
            const isSel = dateStr === selDate;
            return html`
              <div class="ribbon-col" key=${dateStr} onClick=${() => setSelectedDate(dateStr)}>
                <div class="ribbon-track${isSel ? ' sel' : ''}">
                  ${clockEventsByDay[dateStr].map(({ event, startMs, endMs, lane, split }) => {
                    const dayStart = new Date(dateStr + 'T00:00').getTime();
                    const topPct = (startMs - dayStart) / MS_PER_DAY * 100;
                    const heightPct = (endMs - startMs) / MS_PER_DAY * 100;
                    const catIds = Array.isArray(event.categories) ? event.categories : [];
                    const color = catIds.length > 0 ? (catById[catIds[0]]?.color || '#888') : '#888';
                    return html`<div class="ribbon-block" key=${`${event.id}|${startMs}`} style=${{
                      top: `${topPct}%`,
                      height: `${heightPct}%`,
                      left: split && lane === 1 ? '50%' : '2px',
                      right: split && lane === 0 ? '50%' : '2px',
                      background: color,
                    }}></div>`;
                  })}
                </div>
                <span class="ribbon-day${isSel ? ' sel' : ''}">${dayName(date)[0]}</span>
                <span class="ribbon-total">${dayTotals[i].toFixed(1)}</span>
              </div>
            `;
          })}
        </div>
      </div>

      <!-- Selected day detail -->
      <div class="day-detail">
        <div class="day-detail-head">
          <div class="day-detail-title">
            <span class="day-detail-name">${DAY_NAMES_FULL[selDateObj.getDay()]}</span>
            <span class="day-detail-date">${formatShort(selDateObj)}</span>
          </div>
          <span class="day-detail-total">${selTotal.toFixed(1)}h</span>
        </div>
        ${selDayChips.length === 0 ? html`
          <button class="day-empty-btn" onClick=${() => navigate(`/budget/${budgetId}/log/${selDate}`)}>
            Nothing logged — block time on ${DAY_NAMES_FULL[selDateObj.getDay()]} →
          </button>
        ` : html`
          <div class="day-chips">
            ${selDayChips.map(({ cat, hours }) => html`
              <span class="day-chip" key=${cat.id}>
                <span class="day-chip-dot" style=${{ background: cat.color }}></span>
                ${cat.name} <b>${hours.toFixed(1)}h</b>
              </span>
            `)}
          </div>
          <button class="day-open-btn" onClick=${() => navigate(`/budget/${budgetId}/log/${selDate}`)}>
            Open day →
          </button>
        `}
      </div>

      <!-- By category -->
      <div class="bycat">
        <div class="bycat-head">
          <div class="bycat-title">By category</div>
          <div class="bycat-pills">
            ${goalCats.length > 0 && html`<span class="pill-green">${onTrackCount}/${goalCats.length} on track</span>`}
            ${streak >= 2 && html`<span class="pill-green">${streak}-day streak</span>`}
          </div>
        </div>
        <div class="bycat-letters">
          ${weekDates.map((date, i) => html`<span key=${i}>${dayName(date)[0]}</span>`)}
        </div>
        ${bycatRows.map(cat => {
          const maxForCat = Math.max(0, ...dayRollups.map(r => r[cat.id] || 0));
          let label, numColor;
          if (usingFallback) {
            label = `${(catTotals[cat.id] || 0).toFixed(1)}h`;
            numColor = 'var(--text-dim)';
          } else {
            const { actual, onTrack, goalText } = goalInfo(cat);
            label = `${actual.toFixed(1)} / ${goalText}`;
            numColor = onTrack ? 'var(--green)' : 'var(--amber-text)';
          }
          return html`
            <div class="bycat-row" key=${cat.id}>
              <div class="bycat-row-head">
                <span class="bycat-dot" style=${{ background: cat.color }}></span>
                <span class="bycat-name">${cat.name}</span>
                <span class="bycat-num" style=${{ color: numColor }}>${label}</span>
              </div>
              <div class="bycat-bars">
                ${weekDates.map((date, i) => {
                  const v = dayRollups[i][cat.id] || 0;
                  const pct = maxForCat > 0 ? (v / maxForCat) * 100 : 0;
                  return html`<div class="bycat-barcell" key=${i}>
                    <div class="bycat-bar" style=${{
                      height: `${pct}%`,
                      background: cat.color,
                      opacity: i === selIndex ? 1 : 0.45,
                    }}></div>
                  </div>`;
                })}
              </div>
            </div>
          `;
        })}

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
