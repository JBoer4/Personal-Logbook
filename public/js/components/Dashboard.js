import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation, useSyncRefresh } from '../sync.js';
import {
  uuid, now, today, daysUntilReminder,
  getWeekStart, getWeekDates, toDateStr, hoursForDate, unionHoursForDate, computeHoursByCat,
  offsetMonthDate, getMonthDates, isRealTxn, MS_PER_DAY,
} from '../utils.js';

const DEFAULT_TIME_CATEGORIES = [
  { name: 'Sleep', color: '#7f8dff', minHours: 49, maxHours: 63 },
  { name: 'Work', color: '#f0a742', minHours: 35, maxHours: 45 },
  { name: 'Exercise', color: '#43c59e', minHours: 5, maxHours: null },
  { name: 'Leisure', color: '#e5709b', minHours: null, maxHours: 20 },
];

const DEFAULT_MONEY_CATEGORIES = [
  { name: 'Housing', color: '#7f8dff', targetAmount: 0 },
  { name: 'Groceries', color: '#43c59e', targetAmount: 0 },
  { name: 'Transport', color: '#f0a742', targetAmount: 0 },
  { name: 'Dining Out', color: '#e5709b', targetAmount: 0 },
  { name: 'Utilities', color: '#5cc8de', targetAmount: 0 },
  { name: 'Entertainment', color: '#9d8cff', targetAmount: 0 },
  { name: 'Other', color: '#8b8e9c', targetAmount: 0 },
];

// --- Inline icons (SVG paths copied from the Refined Dark mockup) ---
const TimeIcon = () => html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v4.8l3 1.8"/></svg>`;
const MoneyIcon = () => html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18"/><circle cx="16.5" cy="14.5" r="1.1" fill="currentColor" stroke="none"/></svg>`;
const PeopleIcon = () => html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.6 19c0-3 2.5-5 5.4-5s5.4 2 5.4 5"/><circle cx="17" cy="9" r="2.4" opacity=".55"/></svg>`;
const PlusIcon = () => html`<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

const TONE_COLOR = {
  green: 'var(--green)',
  amber: 'var(--amber-text)',
  pink: 'var(--pink)',
  dim: 'var(--text-dim)',
};

function iconFor(type) {
  if (type === 'money') return MoneyIcon();
  if (type === 'people') return PeopleIcon();
  return TimeIcon();
}

function fmtHHMM(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function seedBudget() {
  const ts = now();
  const budget = {
    id: uuid(),
    name: 'Weekly Time Budget',
    type: 'time',
    periodType: 'weekly',
    periodStartDay: 0,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.putBudget(budget);

  for (let i = 0; i < DEFAULT_TIME_CATEGORIES.length; i++) {
    const cat = DEFAULT_TIME_CATEGORIES[i];
    await db.putCategory({
      id: uuid(),
      budgetId: budget.id,
      name: cat.name,
      color: cat.color,
      minHours: cat.minHours ?? null,
      maxHours: cat.maxHours ?? null,
      sortOrder: i,
      createdAt: ts,
      updatedAt: ts,
    });
  }
  syncAfterMutation();
  return budget;
}

// Compute the "Your day so far" hero for the first time budget.
async function computeHero(timeBudget) {
  const cats = await db.getCategories(timeBudget.id);
  const catById = Object.fromEntries(cats.map(c => [c.id, c]));
  const evs = await db.getEvents(timeBudget.id);

  const todayStr = today();
  const dayStart = new Date(todayStr + 'T00:00').getTime();
  const nowMs = Date.now();
  const nowFrac = Math.min(Math.max((nowMs - dayStart) / MS_PER_DAY, 0), 1);

  let loggedH = 0;
  for (const e of evs) loggedH += hoursForDate(e, todayStr);

  // Clock-timed blocks clipped to [00:00 today, now] (includes yesterday's spill-over)
  const blocks = [];
  const intervals = [];
  for (const e of evs) {
    if (!e.startAt || !e.endAt) continue;
    const s = Math.max(new Date(e.startAt).getTime(), dayStart);
    const en = Math.min(new Date(e.endAt).getTime(), nowMs);
    if (s >= en) continue;
    const catIds = Array.isArray(e.categories) ? e.categories : [];
    const color = catIds.length ? (catById[catIds[0]]?.color || '#888') : '#888';
    blocks.push({ left: (s - dayStart) / MS_PER_DAY * 100, width: (en - s) / MS_PER_DAY * 100, color });
    intervals.push([s, en]);
  }

  // Merge covered intervals, then find uncovered stretches >= 30 min within [00:00, now]
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of intervals) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  // Only unlogged stretches this long count as gaps — short breaks
  // (bathroom, a quick meal) are never logged and shouldn't nag.
  const GAP = 2 * 60 * 60000;
  let gapCount = 0;
  let cursor = dayStart;
  for (const [s, e] of merged) {
    if (s - cursor >= GAP) gapCount++;
    cursor = Math.max(cursor, e);
  }
  if (nowMs - cursor >= GAP) gapCount++;

  let lastEnd = null;
  for (const [, e] of merged) {
    const capped = Math.min(e, nowMs);
    if (lastEnd === null || capped > lastEnd) lastEnd = capped;
  }

  return {
    budgetId: timeBudget.id,
    loggedH,
    blocks,
    nowPct: nowFrac * 100,
    gapCount,
    lastLoggedLabel: lastEnd !== null ? fmtHHMM(lastEnd) : null,
  };
}

async function computeStatuses(list, counts, due) {
  const statuses = {};
  for (const b of list) {
    if (b.type === 'time') {
      const cats = await db.getCategories(b.id);
      const evs = await db.getEvents(b.id);
      const weekDates = getWeekDates(getWeekStart(new Date())).map(toDateStr);
      const weekEvents = evs.filter(e =>
        weekDates.includes(e.date) ||
        (e.startAt && e.endAt && weekDates.some(d => hoursForDate(e, d) > 0))
      );
      const goalCats = cats.filter(c => c.minHours != null || c.maxHours != null);
      const totals = computeHoursByCat(weekEvents, weekDates, cats);
      const over = goalCats.find(c => c.maxHours != null && (totals[c.id] || 0) > c.maxHours);
      if (over) {
        statuses[b.id] = { text: `Over on ${over.name}`, tone: 'amber' };
      } else if (goalCats.length) {
        statuses[b.id] = { text: 'On track', tone: 'green' };
      } else {
        let wk = 0;
        for (const d of weekDates) wk += unionHoursForDate(weekEvents, d);
        statuses[b.id] = { text: `${wk.toFixed(1)}h this week`, tone: 'dim' };
      }
    } else if (b.type === 'money') {
      const txns = await db.getTransactions(b.id);
      const plans = await db.getMoneyPlans(b.id);
      const { start, end } = getMonthDates(offsetMonthDate(0));
      const monthReal = txns.filter(t => isRealTxn(t) && t.date >= start && t.date <= end);
      const monthPlans = plans.filter(p => p.monthStart === start);
      const uncat = monthReal.filter(t => !t.categoryId).length;
      if (uncat > 0 || monthPlans.length === 0) {
        statuses[b.id] = { text: 'Review due', tone: 'amber' };
      } else {
        statuses[b.id] = { text: 'Up to date', tone: 'green' };
      }
    } else if (b.type === 'people') {
      const count = counts[b.id] || 0;
      const rem = due.filter(d => d.person.budgetId === b.id).length;
      if (rem > 0) {
        statuses[b.id] = { text: `${rem} reminder${rem > 1 ? 's' : ''}`, tone: 'pink' };
      } else {
        statuses[b.id] = { text: `${count} ${count === 1 ? 'person' : 'people'}`, tone: 'dim' };
      }
    }
  }
  return statuses;
}

export function Dashboard() {
  const [budgets, setBudgets] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [hero, setHero] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showTypePicker, setShowTypePicker] = useState(false);

  async function load() {
    let list = await db.getBudgets();
    if (list.length === 0) {
      await seedBudget();
      list = await db.getBudgets();
    }
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    setBudgets(list);

    const [people, notes] = await Promise.all([db.getPeople(), db.getAllPersonNotes()]);

    const counts = {};
    for (const p of people) {
      counts[p.budgetId] = (counts[p.budgetId] || 0) + 1;
    }

    // Reminder notes due within the next week
    const personById = Object.fromEntries(people.map(p => [p.id, p]));
    const due = [];
    for (const n of notes) {
      if (!n.remindOn || !personById[n.personId]) continue;
      const days = daysUntilReminder(n.remindOn, n.repeatYearly);
      if (days >= 0 && days <= 7) {
        due.push({ note: n, person: personById[n.personId], days });
      }
    }
    due.sort((a, b) => a.days - b.days);
    setReminders(due);

    setStatuses(await computeStatuses(list, counts, due));

    const timeBudget = list.find(b => b.type === 'time');
    setHero(timeBudget ? await computeHero(timeBudget) : null);

    setLoading(false);
  }

  useEffect(() => { load(); }, []);
  useSyncRefresh(load);

  async function createBudget(type) {
    const ts = now();
    const isMoney = type === 'money';
    const budget = {
      id: uuid(),
      name: type === 'people' ? 'People' : isMoney ? 'Monthly Money Budget' : 'New Budget',
      type,
      periodType: type === 'people' ? 'none' : isMoney ? 'monthly' : 'weekly',
      periodStartDay: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.putBudget(budget);

    if (isMoney) {
      for (let i = 0; i < DEFAULT_MONEY_CATEGORIES.length; i++) {
        const cat = DEFAULT_MONEY_CATEGORIES[i];
        await db.putCategory({
          id: uuid(),
          budgetId: budget.id,
          name: cat.name,
          color: cat.color,
          targetAmount: cat.targetAmount,
          sortOrder: i,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }

    syncAfterMutation();
    setShowTypePicker(false);
    navigate('/budget/' + budget.id);
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  const dateLine = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return html`
    <div class="home">
      <div class="home-head">
        <div class="home-date">${dateLine}</div>
        <div class="home-title">Today</div>
      </div>

      ${reminders.length > 0 && html`
        <div class="reminder-list">
          ${reminders.map(({ note, person, days }) => html`
            <button class="reminder-banner" key=${note.id}
              onClick=${() => navigate(`/budget/${person.budgetId}/person/${person.id}`)}>
              <span class="reminder-dot ${note.repeatYearly ? 'birthday' : ''}"></span>
              <span class="reminder-text"><strong>${person.name}</strong> · ${note.text}</span>
              <span class="reminder-when">${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}</span>
            </button>
          `)}
        </div>
      `}

      ${hero && html`
        <div class="home-hero">
          <div class="hero-head">
            <span class="hero-label">Your day so far</span>
            <span class="hero-logged"><b>${hero.loggedH.toFixed(1)}h</b> logged</span>
          </div>
          <div class="hero-strip">
            ${hero.blocks.map((b, i) => html`
              <div class="hero-block" key=${i}
                style=${{ left: `${b.left}%`, width: `${b.width}%`, background: b.color }}></div>
            `)}
            <div class="hero-now" style=${{ left: `${hero.nowPct}%` }}></div>
          </div>
          <div class="hero-axis">
            <span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>now</span>
          </div>
          <div class="hero-foot">
            ${hero.gapCount > 0
              ? html`<span class="hero-gaps"><span class="gap-dot"></span>${hero.gapCount} gap${hero.gapCount > 1 ? 's' : ''}</span>`
              : html`<span class="hero-nogaps">✓ no gaps</span>`}
            ${hero.lastLoggedLabel && html`<span class="hero-last">last logged ${hero.lastLoggedLabel}</span>`}
            <button class="hero-log-btn" onClick=${() => navigate(`/budget/${hero.budgetId}/log`)}>Log now</button>
          </div>
        </div>
      `}

      <div class="home-tiles">
        ${budgets.map(b => {
          const st = statuses[b.id];
          return html`
            <button class="home-tile" key=${b.id} onClick=${() => navigate('/budget/' + b.id)}>
              <div class="tile-badge ${b.type}">${iconFor(b.type)}</div>
              <div class="tile-name">${b.name}</div>
              ${st && html`<div class="tile-status" style=${{ color: TONE_COLOR[st.tone] }}>${st.text}</div>`}
            </button>
          `;
        })}
        <button class="home-tile add-tile" onClick=${() => setShowTypePicker(true)}>
          ${PlusIcon()}
          <span class="add-tile-label">Add tracker</span>
        </button>
      </div>

      ${showTypePicker && html`
        <div class="type-picker-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setShowTypePicker(false); }}>
          <div class="type-picker">
            <h3>What do you want to add?</h3>
            <div class="type-picker-options">
              <button class="type-picker-btn" onClick=${() => createBudget('time')}>
                <div class="tile-badge time">${TimeIcon()}</div>
                <div class="type-picker-label">Time</div>
                <div class="type-picker-desc">Track hours per week</div>
              </button>
              <button class="type-picker-btn" onClick=${() => createBudget('money')}>
                <div class="tile-badge money">${MoneyIcon()}</div>
                <div class="type-picker-label">Money</div>
                <div class="type-picker-desc">Track spending per month</div>
              </button>
              <button class="type-picker-btn" onClick=${() => createBudget('people')}>
                <div class="tile-badge people">${PeopleIcon()}</div>
                <div class="type-picker-label">People</div>
                <div class="type-picker-desc">Quick notes about people</div>
              </button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}
