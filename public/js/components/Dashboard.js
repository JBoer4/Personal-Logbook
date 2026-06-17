import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation } from '../sync.js';
import { uuid, now, daysUntilReminder } from '../utils.js';

const DEFAULT_TIME_CATEGORIES = [
  { name: 'Sleep', color: '#6366f1', minHours: 49, maxHours: 63 },
  { name: 'Work', color: '#f59e0b', minHours: 35, maxHours: 45 },
  { name: 'Exercise', color: '#10b981', minHours: 5, maxHours: null },
  { name: 'Leisure', color: '#ec4899', minHours: null, maxHours: 20 },
];

const DEFAULT_MONEY_CATEGORIES = [
  { name: 'Housing', color: '#6366f1', targetAmount: 0 },
  { name: 'Groceries', color: '#10b981', targetAmount: 0 },
  { name: 'Transport', color: '#f59e0b', targetAmount: 0 },
  { name: 'Dining Out', color: '#ec4899', targetAmount: 0 },
  { name: 'Utilities', color: '#06b6d4', targetAmount: 0 },
  { name: 'Entertainment', color: '#8b5cf6', targetAmount: 0 },
  { name: 'Other', color: '#64748b', targetAmount: 0 },
];

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

export function Dashboard() {
  const [budgets, setBudgets] = useState([]);
  const [peopleCounts, setPeopleCounts] = useState({});
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showTypePicker, setShowTypePicker] = useState(false);

  async function load() {
    let list = await db.getBudgets();
    if (list.length === 0) {
      await seedBudget();
      list = await db.getBudgets();
    }
    setBudgets(list);

    const [people, notes] = await Promise.all([db.getPeople(), db.getAllPersonNotes()]);

    const counts = {};
    for (const p of people) {
      counts[p.budgetId] = (counts[p.budgetId] || 0) + 1;
    }
    setPeopleCounts(counts);

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

    setLoading(false);
  }

  useEffect(() => { load(); }, []);

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

  return html`
    <div class="dashboard">
      ${reminders.length > 0 && html`
        <div class="reminder-list">
          ${reminders.map(({ note, person, days }) => html`
            <button class="reminder-banner" key=${note.id}
              onClick=${() => navigate(`/budget/${person.budgetId}/person/${person.id}`)}>
              <span class="reminder-icon">${note.repeatYearly ? '🎂' : '🔔'}</span>
              <span class="reminder-text"><strong>${person.name}</strong> — ${note.text}</span>
              <span class="reminder-when">${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}</span>
            </button>
          `)}
        </div>
      `}
      <div class="card-grid">
        ${budgets.map(b => {
          const isPeople = b.type === 'people';
          const count = peopleCounts[b.id] || 0;
          return html`
            <button class="budget-card" key=${b.id} onClick=${() => navigate('/budget/' + b.id)}>
              <div class="card-icon">${isPeople ? '👥' : b.type === 'time' ? '⏱' : '$'}</div>
              <div class="card-name">${b.name}</div>
              <div class="card-type">${isPeople ? `${count} ${count === 1 ? 'person' : 'people'}` : b.periodType}</div>
            </button>
          `;
        })}
        <button class="budget-card add-card" onClick=${() => setShowTypePicker(true)}>
          <div class="card-icon">+</div>
          <div class="card-name">New</div>
        </button>
      </div>

      ${showTypePicker && html`
        <div class="type-picker-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setShowTypePicker(false); }}>
          <div class="type-picker">
            <h3>What do you want to add?</h3>
            <div class="type-picker-options">
              <button class="type-picker-btn" onClick=${() => createBudget('time')}>
                <div class="type-picker-icon">⏱</div>
                <div class="type-picker-label">Time</div>
                <div class="type-picker-desc">Track hours per week</div>
              </button>
              <button class="type-picker-btn" onClick=${() => createBudget('money')}>
                <div class="type-picker-icon">$</div>
                <div class="type-picker-label">Money</div>
                <div class="type-picker-desc">Track spending per month</div>
              </button>
              <button class="type-picker-btn" onClick=${() => createBudget('people')}>
                <div class="type-picker-icon">👥</div>
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
