import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { useRoute, navigate } from './router.js';
import { startSyncLoop, onSyncStatus } from './sync.js';
import { db } from './db.js';
import { formatAge } from './utils.js';
import { Dashboard } from './components/Dashboard.js';
import { BudgetHome } from './components/BudgetHome.js';
import { DailyLog } from './components/DailyLog.js';
import { Categories } from './components/Categories.js';
import { History } from './components/History.js';
import { MoneyHome } from './components/MoneyHome.js';
import { MoneyCategories } from './components/MoneyCategories.js';
import { MoneyPlan } from './components/MoneyPlan.js';
import { Transactions } from './components/Transactions.js';
import { ImportOFX } from './components/ImportOFX.js';
import { People } from './components/People.js';
import { PersonDetail } from './components/PersonDetail.js';

// Wrapper that loads budget and routes to time or money component
function BudgetRouter({ budgetId, view: viewName }) {
  const [budget, setBudget] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    db.getBudget(budgetId).then(b => { setBudget(b); setLoading(false); });
  }, [budgetId]);

  if (loading) return html`<div class="loading">Loading...</div>`;
  if (!budget) return html`<div class="empty-state">Budget not found</div>`;

  const isMoney = budget.type === 'money';

  if (budget.type === 'people') {
    return html`<${People} budgetId=${budgetId} />`;
  }
  if (viewName === 'home') {
    return isMoney
      ? html`<${MoneyHome} budgetId=${budgetId} />`
      : html`<${BudgetHome} budgetId=${budgetId} />`;
  }
  if (viewName === 'categories') {
    return isMoney
      ? html`<${MoneyCategories} budgetId=${budgetId} />`
      : html`<${Categories} budgetId=${budgetId} />`;
  }
  if (viewName === 'plan') {
    return isMoney
      ? html`<${MoneyPlan} budgetId=${budgetId} />`
      : html`<div class="empty-state">Not available for this budget</div>`;
  }
  if (viewName === 'transactions') {
    return html`<${Transactions} budgetId=${budgetId} />`;
  }
  if (viewName === 'import') {
    return html`<${ImportOFX} budgetId=${budgetId} />`;
  }
  return null;
}

function App() {
  const { match } = useRoute();
  const [syncStatus, setSyncStatus] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [, setAgeTick] = useState(0);

  useEffect(() => {
    startSyncLoop();
    // Seed "last synced" from the previous session, then track live syncs.
    db.getMeta('lastSyncedWallClock').then(v => { if (v) setLastSyncedAt(prev => prev ?? v); });
    const ageTimer = setInterval(() => setAgeTick(t => t + 1), 60000);
    const unsub = onSyncStatus(status => {
      setSyncStatus(status);
      if (status === 'synced') {
        const ts = Date.now();
        setLastSyncedAt(ts);
        db.setMeta('lastSyncedWallClock', ts);
      }
    });
    return () => { clearInterval(ageTimer); unsub(); };
  }, []);

  // Route matching
  let params;
  let view;

  if ((params = match('/budget/:id/person/:personId'))) {
    view = html`<${PersonDetail} budgetId=${params.id} personId=${params.personId} />`;
  } else if ((params = match('/budget/:id/log/:date'))) {
    view = html`<${DailyLog} budgetId=${params.id} date=${params.date} />`;
  } else if ((params = match('/budget/:id/log'))) {
    view = html`<${DailyLog} budgetId=${params.id} />`;
  } else if ((params = match('/budget/:id/categories'))) {
    view = html`<${BudgetRouter} budgetId=${params.id} view="categories" />`;
  } else if ((params = match('/budget/:id/history'))) {
    view = html`<${History} budgetId=${params.id} />`;
  } else if ((params = match('/budget/:id/plan'))) {
    view = html`<${BudgetRouter} budgetId=${params.id} view="plan" />`;
  } else if ((params = match('/budget/:id/transactions'))) {
    view = html`<${BudgetRouter} budgetId=${params.id} view="transactions" />`;
  } else if ((params = match('/budget/:id/import'))) {
    view = html`<${BudgetRouter} budgetId=${params.id} view="import" />`;
  } else if ((params = match('/budget/:id'))) {
    view = html`<${BudgetRouter} budgetId=${params.id} view="home" />`;
  } else {
    view = html`<${Dashboard} />`;
  }

  const isHome = !match('/budget/:id') && !match('/budget/:id/log') &&
    !match('/budget/:id/log/:date') && !match('/budget/:id/categories') &&
    !match('/budget/:id/history') && !match('/budget/:id/transactions') &&
    !match('/budget/:id/import') && !match('/budget/:id/plan') &&
    !match('/budget/:id/person/:personId');

  // Extract budgetId for back navigation
  const budgetMatch = match('/budget/:id/log') || match('/budget/:id/log/:date') ||
    match('/budget/:id/categories') || match('/budget/:id/history') ||
    match('/budget/:id/transactions') || match('/budget/:id/import') ||
    match('/budget/:id/plan') || match('/budget/:id/person/:personId');

  return html`
    <div class="app-shell">
      <header class="app-header">
        ${!isHome && html`
          <button class="back-btn" onClick=${() => {
            if (budgetMatch) {
              navigate('/budget/' + budgetMatch.id);
            } else {
              navigate('/');
            }
          }}>←</button>
        `}
        <div class="header-spacer"></div>
        ${(() => {
          const age = lastSyncedAt ? Date.now() - lastSyncedAt : null;
          // Freshness is invisible until it isn't: show the age whenever
          // we're offline or the last successful sync is >5 min old.
          const stale = syncStatus === 'offline' || (age != null && age > 5 * 60000);
          const ageLabel = age != null ? formatAge(age) : 'never';
          return html`
            <div class="sync-wrap" title=${syncStatus === 'syncing' ? 'Syncing...'
              : syncStatus === 'offline' ? `Offline — last synced ${ageLabel === 'now' ? 'just now' : ageLabel + ' ago'}`
              : syncStatus === 'synced' ? 'Synced' : ''}>
              ${stale && html`<span class="sync-age">${ageLabel}</span>`}
              <div class="sync-indicator ${syncStatus}"></div>
            </div>
          `;
        })()}
      </header>
      <main class="app-main">
        ${view}
      </main>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
