// Thin fetch wrapper for server API.
// All data flows through /api/sync; the only other endpoints are for OFX import.

const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

export const api = {
  importOFX: (budgetId, ofxText) => {
    return fetch(`${BASE}/budgets/${budgetId}/import-ofx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: ofxText,
    }).then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); });
  },
  batchCreateTransactions: (budgetId, transactions) => request(`/budgets/${budgetId}/transactions/batch`, { method: 'POST', body: transactions }),
  sync: (payload) => request('/sync', { method: 'POST', body: payload }),
};
