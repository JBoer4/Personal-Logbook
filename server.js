const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3000;
const DB_DIR = path.join(__dirname, 'server-data');
const DB_PATH = path.join(DB_DIR, 'budget.db');

app.use(express.json({ limit: '5mb' }));
app.use(express.text({ limit: '5mb', type: 'text/plain' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Database setup ---

fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'time',
    periodType TEXT NOT NULL DEFAULT 'weekly',
    periodStartDay INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    budgetId TEXT NOT NULL,
    parentId TEXT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#888888',
    targetHours REAL NOT NULL DEFAULT 0,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (budgetId) REFERENCES budgets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    budgetId TEXT NOT NULL,
    categoryId TEXT NOT NULL,
    date TEXT NOT NULL,
    hours REAL NOT NULL DEFAULT 0,
    startTime TEXT,
    endTime TEXT,
    note TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (budgetId) REFERENCES budgets(id) ON DELETE CASCADE,
    FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS period_overrides (
    id TEXT PRIMARY KEY,
    budgetId TEXT NOT NULL,
    categoryId TEXT NOT NULL,
    periodStart TEXT NOT NULL,
    targetHours REAL NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (budgetId) REFERENCES budgets(id) ON DELETE CASCADE,
    FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_categories_budget ON categories(budgetId);
  CREATE INDEX IF NOT EXISTS idx_entries_budget ON entries(budgetId);
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
  CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(categoryId);
  CREATE INDEX IF NOT EXISTS idx_period_overrides_budget ON period_overrides(budgetId);

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    budgetId TEXT NOT NULL,
    categoryId TEXT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    payee TEXT,
    memo TEXT,
    fitid TEXT,
    trntype TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (budgetId) REFERENCES budgets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_budget ON transactions(budgetId);
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(categoryId);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    budgetId TEXT NOT NULL,
    date TEXT NOT NULL,
    startAt TEXT,
    endAt TEXT,
    hours REAL,
    description TEXT,
    categories TEXT NOT NULL DEFAULT '[]',
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (budgetId) REFERENCES budgets(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_events_budget ON events(budgetId);
  CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    budgetId TEXT,
    name TEXT NOT NULL,
    tag TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS person_notes (
    id TEXT PRIMARY KEY,
    personId TEXT NOT NULL,
    text TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    expiresAt TEXT,
    remindOn TEXT,
    repeatYearly INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (personId) REFERENCES people(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_person_notes_person ON person_notes(personId);
`);

// Add a column to an existing table if missing. Returns true when added.
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.find(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

for (const table of ['budgets', 'categories', 'entries', 'period_overrides']) {
  addColumnIfMissing(table, 'deleted', 'INTEGER NOT NULL DEFAULT 0');
}
addColumnIfMissing('categories', 'parentId', 'TEXT');
addColumnIfMissing('categories', 'minHours', 'REAL');
addColumnIfMissing('categories', 'maxHours', 'REAL');
addColumnIfMissing('period_overrides', 'minHours', 'REAL');
addColumnIfMissing('period_overrides', 'maxHours', 'REAL');
addColumnIfMissing('categories', 'rollover', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('transactions', 'transferId', 'TEXT');
addColumnIfMissing('person_notes', 'expiresAt', 'TEXT');
addColumnIfMissing('person_notes', 'remindOn', 'TEXT');
addColumnIfMissing('person_notes', 'repeatYearly', 'INTEGER NOT NULL DEFAULT 0');

// Migrate: targetAmount replaces targetHours for money budgets
if (addColumnIfMissing('categories', 'targetAmount', 'REAL')) {
  db.exec(`UPDATE categories SET targetAmount = targetHours
    WHERE budgetId IN (SELECT id FROM budgets WHERE type = 'money')`);
}

// Migrate: people belong to a people-list (budgets row with type 'people').
// Adds the column and adopts any orphan people into a default list.
{
  addColumnIfMissing('people', 'budgetId', 'TEXT');
  const orphans = db.prepare('SELECT COUNT(*) c FROM people WHERE budgetId IS NULL AND deleted = 0').get().c;
  if (orphans > 0) {
    const ts = Date.now();
    let list = db.prepare("SELECT id FROM budgets WHERE type = 'people' AND deleted = 0 ORDER BY createdAt LIMIT 1").get();
    if (!list) {
      list = { id: require('crypto').randomUUID() };
      db.prepare('INSERT INTO budgets (id, name, type, periodType, periodStartDay, deleted, createdAt, updatedAt) VALUES (?, ?, ?, ?, 0, 0, ?, ?)')
        .run(list.id, 'People', 'people', 'none', ts, ts);
    }
    db.prepare('UPDATE people SET budgetId = ?, updatedAt = ? WHERE budgetId IS NULL AND deleted = 0').run(list.id, ts);
  }
}

// --- Event category serialization ---
// categories is stored as JSON string in SQLite, but sent/received as an array over HTTP

function serializeEvent(row) {
  return { ...row, categories: typeof row.categories === 'string' ? row.categories : JSON.stringify(row.categories || []) };
}

function deserializeEvent(row) {
  if (!row) return row;
  try {
    return { ...row, categories: typeof row.categories === 'string' ? JSON.parse(row.categories) : (row.categories || []) };
  } catch {
    return { ...row, categories: [] };
  }
}

// --- Helper: upsert by id (updatedAt wins) ---

function upsertRow(table, row, columns) {
  const setClauses = columns.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(`
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${setClauses}
    WHERE excluded.updatedAt > ${table}.updatedAt
  `);
  stmt.run(...columns.map(c => row[c] ?? null));
}

// --- Table column lists (used by the sync endpoint and OFX batch import) ---
// All client/server data flow goes through /api/sync; there are no per-record
// REST endpoints. Mutations happen in IndexedDB on the client and sync over.

const BUDGET_COLS = ['id', 'name', 'type', 'periodType', 'periodStartDay', 'deleted', 'createdAt', 'updatedAt'];
const CATEGORY_COLS = ['id', 'budgetId', 'parentId', 'name', 'color', 'targetHours', 'targetAmount', 'minHours', 'maxHours', 'sortOrder', 'rollover', 'deleted', 'createdAt', 'updatedAt'];
const ENTRY_COLS = ['id', 'budgetId', 'categoryId', 'date', 'hours', 'startTime', 'endTime', 'note', 'deleted', 'createdAt', 'updatedAt'];
const EVENT_COLS = ['id', 'budgetId', 'date', 'startAt', 'endAt', 'hours', 'description', 'categories', 'deleted', 'createdAt', 'updatedAt'];
const TRANSACTION_COLS = ['id', 'budgetId', 'categoryId', 'date', 'amount', 'payee', 'memo', 'fitid', 'trntype', 'transferId', 'deleted', 'createdAt', 'updatedAt'];
const OVERRIDE_COLS = ['id', 'budgetId', 'categoryId', 'periodStart', 'targetHours', 'minHours', 'maxHours', 'deleted', 'createdAt', 'updatedAt'];
const PEOPLE_COLS = ['id', 'budgetId', 'name', 'tag', 'deleted', 'createdAt', 'updatedAt'];
const PERSON_NOTE_COLS = ['id', 'personId', 'text', 'pinned', 'expiresAt', 'remindOn', 'repeatYearly', 'deleted', 'createdAt', 'updatedAt'];

// --- OFX Import ---

function parseOFX(ofxText) {
  const transactions = [];
  // Match each STMTTRN block
  const trnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match;
  while ((match = trnRegex.exec(ofxText)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i'));
      return m ? m[1].trim() : null;
    };
    const dtposted = get('DTPOSTED');
    let date = null;
    if (dtposted) {
      // YYYYMMDD... → YYYY-MM-DD
      date = `${dtposted.slice(0, 4)}-${dtposted.slice(4, 6)}-${dtposted.slice(6, 8)}`;
    }
    const amount = parseFloat(get('TRNAMT')) || 0;
    transactions.push({
      fitid: get('FITID'),
      date,
      amount,
      trntype: get('TRNTYPE'),
      payee: get('NAME'),
      memo: get('MEMO'),
    });
  }
  return transactions;
}

app.post('/api/budgets/:id/import-ofx', (req, res) => {
  try {
    const ofxText = typeof req.body === 'string' ? req.body : '';
    if (!ofxText) return res.status(400).json({ error: 'Empty OFX body' });
    const parsed = parseOFX(ofxText);
    res.json(parsed);
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse OFX: ' + e.message });
  }
});

// --- Batch Import ---

app.post('/api/budgets/:id/transactions/batch', (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
  const batchInsert = db.transaction(() => {
    for (const item of items) {
      const row = { deleted: 0, ...item, budgetId: req.params.id };
      upsertRow('transactions', row, TRANSACTION_COLS);
    }
  });
  batchInsert();
  res.json({ imported: items.length });
});

// --- Sync endpoint ---
// Returns ALL records changed since lastSyncAt, including soft-deleted ones.
// This is how deletions propagate to other devices.

app.post('/api/sync', (req, res) => {
  const { lastSyncAt = 0, budgets: cBudgets = [], categories: cCategories = [], entries: cEntries = [], events: cEvents = [], periodOverrides: cOverrides = [], transactions: cTransactions = [], people: cPeople = [], personNotes: cPersonNotes = [] } = req.body;
  const now = Date.now();

  const syncTransaction = db.transaction(() => {
    // Upsert client records (including soft-deleted ones)
    for (const r of cBudgets) upsertRow('budgets', { deleted: 0, ...r }, BUDGET_COLS);
    for (const r of cCategories) upsertRow('categories', { targetHours: 0, deleted: 0, rollover: 0, ...r }, CATEGORY_COLS);
    for (const r of cEntries) upsertRow('entries', { deleted: 0, ...r }, ENTRY_COLS);
    for (const r of cEvents) upsertRow('events', serializeEvent({ deleted: 0, ...r }), EVENT_COLS);
    for (const r of cOverrides) upsertRow('period_overrides', { targetHours: 0, deleted: 0, ...r }, OVERRIDE_COLS);
    for (const r of cTransactions) upsertRow('transactions', { deleted: 0, ...r }, TRANSACTION_COLS);
    // People before notes: person_notes has an FK to people
    for (const r of cPeople) upsertRow('people', { budgetId: null, tag: null, deleted: 0, ...r }, PEOPLE_COLS);
    for (const r of cPersonNotes) upsertRow('person_notes', { pinned: 0, expiresAt: null, remindOn: null, repeatYearly: 0, deleted: 0, ...r }, PERSON_NOTE_COLS);

    // Return ALL server records changed since lastSyncAt (including deleted)
    const sBudgets = db.prepare('SELECT * FROM budgets WHERE updatedAt > ?').all(lastSyncAt);
    const sCategories = db.prepare('SELECT * FROM categories WHERE updatedAt > ?').all(lastSyncAt);
    const sEntries = db.prepare('SELECT * FROM entries WHERE updatedAt > ?').all(lastSyncAt);
    const sEvents = db.prepare('SELECT * FROM events WHERE updatedAt > ?').all(lastSyncAt).map(deserializeEvent);
    const sOverrides = db.prepare('SELECT * FROM period_overrides WHERE updatedAt > ?').all(lastSyncAt);
    const sTransactions = db.prepare('SELECT * FROM transactions WHERE updatedAt > ?').all(lastSyncAt);
    const sPeople = db.prepare('SELECT * FROM people WHERE updatedAt > ?').all(lastSyncAt);
    const sPersonNotes = db.prepare('SELECT * FROM person_notes WHERE updatedAt > ?').all(lastSyncAt);

    return { budgets: sBudgets, categories: sCategories, entries: sEntries, events: sEvents, periodOverrides: sOverrides, transactions: sTransactions, people: sPeople, personNotes: sPersonNotes, syncedAt: now };
  });

  res.json(syncTransaction());
});

// --- SPA fallback ---

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start server ---

const server = https.createServer({
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
  key: fs.readFileSync(path.join(__dirname, 'key.pem'))
}, app);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Budget app running at https://localhost:${PORT}`);
});
