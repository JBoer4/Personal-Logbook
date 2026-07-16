// IndexedDB schema, CRUD, dirty tracking
// Uses soft deletes (deleted flag) so deletions propagate via sync.

const DB_NAME = 'budget-app';
const DB_VERSION = 7;
const STORES = ['budgets', 'categories', 'entries', 'periodOverrides', 'transactions', 'events', 'people', 'personNotes', 'moneyPlans', 'moneyRules', 'dayNotes', 'meta'];

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // Clean up old v1 store
      if (e.oldVersion < 2) {
        if (db.objectStoreNames.contains('kv')) db.deleteObjectStore('kv');
      }
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
          if (name === 'categories') store.createIndex('budgetId', 'budgetId');
          if (name === 'entries') {
            store.createIndex('budgetId', 'budgetId');
            store.createIndex('date', 'date');
            store.createIndex('categoryId', 'categoryId');
          }
          if (name === 'periodOverrides') store.createIndex('budgetId', 'budgetId');
          if (name === 'transactions') {
            store.createIndex('budgetId', 'budgetId');
            store.createIndex('date', 'date');
            store.createIndex('categoryId', 'categoryId');
          }
          if (name === 'events') {
            store.createIndex('budgetId', 'budgetId');
            store.createIndex('date', 'date');
          }
          if (name === 'personNotes') store.createIndex('personId', 'personId');
          if (name === 'moneyPlans') store.createIndex('budgetId', 'budgetId');
          if (name === 'moneyRules') store.createIndex('budgetId', 'budgetId');
          if (name === 'dayNotes') {
            store.createIndex('budgetId', 'budgetId');
            store.createIndex('date', 'date');
          }
        }
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      // Don't block version upgrades from other tabs after a deploy
      dbInstance.onversionchange = () => { dbInstance.close(); dbInstance = null; };
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode = 'readonly') {
  const db = await openDB();
  const t = db.transaction(storeName, mode);
  return t.objectStore(storeName);
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Generic CRUD ---

// Get all non-deleted records
async function getAll(storeName) {
  const store = await tx(storeName);
  const all = await promisify(store.getAll());
  return all.filter(r => !r.deleted);
}

// Get all records including deleted (for sync/dirty tracking)
async function getAllRaw(storeName) {
  const store = await tx(storeName);
  return promisify(store.getAll());
}

async function getById(storeName, id) {
  const store = await tx(storeName);
  const r = await promisify(store.get(id));
  return (r && !r.deleted) ? r : undefined;
}

// Get non-deleted records by index
async function getAllByIndex(storeName, indexName, value) {
  const store = await tx(storeName);
  const index = store.index(indexName);
  const all = await promisify(index.getAll(value));
  return all.filter(r => !r.deleted);
}

async function put(storeName, record) {
  const store = await tx(storeName, 'readwrite');
  return promisify(store.put({ ...record, _dirty: 1 }));
}

// Returns true when the write actually changed the stored record, so sync
// can tell whether a pull brought anything this device hadn't seen.
// updatedAt is the LWW clock — same updatedAt means same content.
async function putClean(storeName, record) {
  const store = await tx(storeName, 'readwrite');
  const existing = await promisify(store.get(record.id));
  await promisify(store.put({ ...record, _dirty: 0 }));
  return !existing || existing.updatedAt !== record.updatedAt;
}

// Soft delete: mark as deleted + dirty, with new updatedAt
async function softDelete(storeName, id, updatedAt) {
  const store = await tx(storeName, 'readwrite');
  const existing = await promisify(store.get(id));
  if (!existing) return;
  return promisify(store.put({ ...existing, deleted: 1, updatedAt, _dirty: 1 }));
}

// --- Meta (lastSyncAt, etc) ---

async function getMeta(key) {
  const store = await tx('meta');
  const row = await promisify(store.get(key));
  return row ? row.value : null;
}

async function setMeta(key, value) {
  const store = await tx('meta', 'readwrite');
  return promisify(store.put({ key, value }));
}

// --- Dirty records ---

async function getDirty(storeName) {
  const all = await getAllRaw(storeName);
  return all.filter(r => r._dirty);
}

// Strip _dirty before sending to server
function cleanRecord(r) {
  const { _dirty, ...rest } = r;
  return rest;
}

// --- Public API ---

export const db = {
  // Budgets
  getBudgets: () => getAll('budgets'),
  getBudget: (id) => getById('budgets', id),
  putBudget: (record) => put('budgets', record),
  putBudgetClean: (record) => putClean('budgets', record),
  deleteBudget: (id, ts) => softDelete('budgets', id, ts),

  // Categories
  getCategories: (budgetId) => getAllByIndex('categories', 'budgetId', budgetId),
  putCategory: (record) => put('categories', record),
  putCategoryClean: (record) => putClean('categories', record),
  deleteCategory: (id, ts) => softDelete('categories', id, ts),

  // Entries (legacy model — kept so old data still syncs)
  getEntries: (budgetId) => getAllByIndex('entries', 'budgetId', budgetId),
  putEntryClean: (record) => putClean('entries', record),
  deleteEntry: (id, ts) => softDelete('entries', id, ts),

  // Period Overrides
  getOverrides: (budgetId) => getAllByIndex('periodOverrides', 'budgetId', budgetId),
  putOverride: (record) => put('periodOverrides', record),
  putOverrideClean: (record) => putClean('periodOverrides', record),
  deleteOverride: (id, ts) => softDelete('periodOverrides', id, ts),

  // Transactions
  getTransactions: (budgetId) => getAllByIndex('transactions', 'budgetId', budgetId),
  putTransaction: (record) => put('transactions', record),
  putTransactionClean: (record) => putClean('transactions', record),
  deleteTransaction: (id, ts) => softDelete('transactions', id, ts),

  // Events
  getEvents: (budgetId) => getAllByIndex('events', 'budgetId', budgetId),
  putEvent: (record) => put('events', record),
  putEventClean: (record) => putClean('events', record),
  deleteEvent: (id, ts) => softDelete('events', id, ts),

  // People
  getPeople: () => getAll('people'),
  getPerson: (id) => getById('people', id),
  putPerson: (record) => put('people', record),
  putPersonClean: (record) => putClean('people', record),
  deletePerson: (id, ts) => softDelete('people', id, ts),

  // Person Notes
  getPersonNotes: (personId) => getAllByIndex('personNotes', 'personId', personId),
  getAllPersonNotes: () => getAll('personNotes'),
  putPersonNote: (record) => put('personNotes', record),
  putPersonNoteClean: (record) => putClean('personNotes', record),
  deletePersonNote: (id, ts) => softDelete('personNotes', id, ts),

  // Money Plans
  getMoneyPlans: (budgetId) => getAllByIndex('moneyPlans', 'budgetId', budgetId),
  putMoneyPlan: (record) => put('moneyPlans', record),
  putMoneyPlanClean: (record) => putClean('moneyPlans', record),
  deleteMoneyPlan: (id, ts) => softDelete('moneyPlans', id, ts),

  // Money Rules
  getMoneyRules: (budgetId) => getAllByIndex('moneyRules', 'budgetId', budgetId),
  putMoneyRule: (record) => put('moneyRules', record),
  putMoneyRuleClean: (record) => putClean('moneyRules', record),
  deleteMoneyRule: (id, ts) => softDelete('moneyRules', id, ts),

  // Day Notes (free-text entries in the daily log feed)
  getDayNotes: (budgetId) => getAllByIndex('dayNotes', 'budgetId', budgetId),
  putDayNote: (record) => put('dayNotes', record),
  putDayNoteClean: (record) => putClean('dayNotes', record),
  deleteDayNote: (id, ts) => softDelete('dayNotes', id, ts),

  // Meta
  getMeta,
  setMeta,

  // Dirty
  getDirtyBudgets: () => getDirty('budgets'),
  getDirtyCategories: () => getDirty('categories'),
  getDirtyEntries: () => getDirty('entries'),
  getDirtyOverrides: () => getDirty('periodOverrides'),
  getDirtyTransactions: () => getDirty('transactions'),
  getDirtyEvents: () => getDirty('events'),
  getDirtyPeople: () => getDirty('people'),
  getDirtyPersonNotes: () => getDirty('personNotes'),
  getDirtyMoneyPlans: () => getDirty('moneyPlans'),
  getDirtyMoneyRules: () => getDirty('moneyRules'),
  getDirtyDayNotes: () => getDirty('dayNotes'),
  cleanRecord,
};
