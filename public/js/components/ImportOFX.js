import { useState, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation } from '../sync.js';
import { api } from '../api.js';
import { uuid, now, formatCurrency, TRN_TRANSFER, isTransferTxn } from '../utils.js';

export function ImportOFX({ budgetId }) {
  const [parsed, setParsed] = useState(null);
  const [categories, setCategories] = useState([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setError(null);
    setParsed(null);

    try {
      const text = await file.text();
      const transactions = await api.importOFX(budgetId, text);
      if (transactions.length === 0) {
        setError('No transactions found in file');
        return;
      }

      const cats = await db.getCategories(budgetId);
      setCategories(cats);

      // Apply categorization rules client-side (first match wins, oldest rule first).
      // Rules only ever apply at import time — never retro-applied.
      const rules = await db.getMoneyRules(budgetId);
      rules.sort((a, b) => a.createdAt - b.createdAt);
      const withRules = transactions.map(t => {
        const haystack = `${t.payee || ''} ${t.memo || ''}`.toLowerCase();
        const rule = rules.find(r => r.match && haystack.includes(r.match.toLowerCase()));
        if (!rule) return t;
        return {
          ...t,
          categoryId: rule.categoryId || null,
          ruleId: rule.id,
          trntype: rule.markTransfer ? TRN_TRANSFER : t.trntype,
        };
      });

      setParsed(withRules);
    } catch (err) {
      setError('Failed to parse file: ' + err.message);
    }
  }

  async function importAll() {
    if (!parsed || importing) return;
    setImporting(true);
    setError(null);

    try {
      // Skip transactions already imported (banks resend overlapping
      // statements; FITID uniquely identifies a transaction within an account).
      // Legacy records have no account tag — treat those as matching any
      // account so old imports still dedup. Different accounts with a
      // coincidentally equal FITID are NOT considered duplicates.
      const existing = await db.getTransactions(budgetId);
      const existingByFitid = new Map();
      for (const e of existing) {
        if (!e.fitid) continue;
        if (!existingByFitid.has(e.fitid)) existingByFitid.set(e.fitid, []);
        existingByFitid.get(e.fitid).push(e);
      }
      const fresh = parsed.filter(t => {
        if (!t.fitid) return true;
        const matches = existingByFitid.get(t.fitid);
        if (!matches) return true;
        return !matches.some(e => !e.account || e.account === t.account);
      });
      const skipped = parsed.length - fresh.length;

      const ts = now();
      const records = fresh.map(t => ({
        id: uuid(),
        budgetId,
        categoryId: t.categoryId || null,
        date: t.date,
        amount: t.amount,
        payee: t.payee || '',
        memo: t.memo || '',
        fitid: t.fitid || '',
        trntype: t.trntype || '',
        account: t.account || '',
        ruleId: t.ruleId || '',
        createdAt: ts,
        updatedAt: ts,
      }));

      if (records.length > 0) {
        // Write locally (dirty); sync pushes them to the server.
        for (const r of records) {
          await db.putTransaction(r);
        }
        syncAfterMutation();
      }

      const ruleCount = records.filter(r => r.ruleId).length;
      setResult({ count: records.length, skipped, ruleCount });
    } catch (err) {
      setError('Import failed: ' + err.message);
    } finally {
      setImporting(false);
    }
  }

  if (result) {
    return html`
      <div class="import-view">
        <h2>Import Complete</h2>
        <div class="import-result">
          <p>${result.count} transactions imported${result.skipped > 0 ? `, ${result.skipped} skipped (already imported)` : ''}</p>
          ${result.ruleCount > 0 && html`<p class="import-result-rules">${result.ruleCount} auto-categorized by rules</p>`}
          <button class="btn" onClick=${() => navigate('/budget/' + budgetId + '/transactions')}>
            View Transactions
          </button>
          <button class="btn btn-secondary" onClick=${() => { setResult(null); setParsed(null); if (fileRef.current) fileRef.current.value = ''; }}>
            Import More
          </button>
        </div>
      </div>
    `;
  }

  const catById = Object.fromEntries(categories.map(c => [c.id, c]));

  return html`
    <div class="import-view">
      <h2>Import OFX</h2>
      <p class="subtitle">Upload a bank statement (.ofx or .qfx file)</p>

      <div class="import-file-wrap">
        <input type="file" accept=".ofx,.qfx" ref=${fileRef}
          onChange=${handleFile} class="import-file-input" />
      </div>

      ${error && html`<div class="import-error">${error}</div>`}

      ${parsed && html`
        <div class="import-preview-wrap">
          <h3>${parsed.length} transactions found</h3>
          <div class="import-preview">
            ${parsed.map((t, i) => html`
              <div class="import-row" key=${i}>
                <span class="import-date">${t.date || '—'}</span>
                <span class="import-payee">${t.payee || t.memo || '—'}</span>
                ${t.ruleId && html`
                  <span class="import-rule-note" title="categorized by rule">
                    ${isTransferTxn(t) ? 'transfer' : (catById[t.categoryId]?.name || 'categorized')}
                  </span>
                `}
                <span class="import-amount ${t.amount < 0 ? 'negative' : 'positive'}">
                  ${formatCurrency(t.amount)}
                </span>
              </div>
            `)}
          </div>
          <button class="btn import-btn" onClick=${importAll} disabled=${importing}>
            ${importing ? 'Importing...' : `Import All (${parsed.length})`}
          </button>
        </div>
      `}
    </div>
  `;
}
