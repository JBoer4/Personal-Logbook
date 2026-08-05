// Thin fetch wrapper for server API.
// All data flows through /api/sync; the only other endpoints are for OFX import.

const BASE = '/api';

async function request(path, options = {}) {
  // Abort rather than hang when the server is asleep/unreachable —
  // sync must fail fast so the app settles into offline mode.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  importOFX: (budgetId, ofxText) => {
    return fetch(`${BASE}/budgets/${budgetId}/import-ofx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: ofxText,
    }).then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); });
  },
  sync: (payload) => request('/sync', { method: 'POST', body: payload }),
};
