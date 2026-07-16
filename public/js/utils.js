// Week math and date formatting utilities

export const MS_PER_HOUR = 3600000;
export const MS_PER_DAY = 86400000;

export function uuid() {
  return crypto.randomUUID();
}

export function now() {
  return Date.now();
}

// Compact age for the sync indicator: "3m", "2h", "5d"
export function formatAge(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Get Sunday-based week start for a given date
export function getWeekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday = 0
  return d;
}

// Get array of 7 Date objects for the week containing `date`
export function getWeekDates(date = new Date()) {
  const start = getWeekStart(date);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

// Format Date to YYYY-MM-DD
export function toDateStr(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parse YYYY-MM-DD to Date (local timezone)
export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Short day names
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayName(date) {
  return DAYS[new Date(date).getDay()];
}

export function formatShort(date) {
  const d = new Date(date);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function formatRange(startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (s.getMonth() === e.getMonth()) {
    return `${MONTHS[s.getMonth()]} ${s.getDate()}–${e.getDate()}`;
  }
  return `${formatShort(s)} – ${formatShort(e)}`;
}

// Parse natural duration strings: "30m", "1h", "1h30m", "90m", "1.5" → hours
export function parseDuration(str) {
  if (!str) return null;
  str = str.trim();
  const hmMatch = str.match(/^(\d+(?:\.\d+)?)h(?:(\d+)m)?$/i);
  if (hmMatch) return parseFloat(hmMatch[1]) + (hmMatch[2] ? parseInt(hmMatch[2]) / 60 : 0);
  const mMatch = str.match(/^(\d+(?:\.\d+)?)m$/i);
  if (mMatch) return parseFloat(mMatch[1]) / 60;
  const numMatch = str.match(/^(\d+(?:\.\d+)?|\.\d+)$/);
  if (numMatch) return parseFloat(numMatch[1]);
  return null;
}

// Format hours number to human string: 1.5 → "1h30m"
export function formatDuration(hours) {
  if (!hours || hours <= 0) return '';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

// Compute hours between two local datetime strings (YYYY-MM-DDTHH:MM)
export function calcHoursFromDatetimes(startAt, endAt) {
  if (!startAt || !endAt) return null;
  const diff = new Date(endAt) - new Date(startAt);
  if (diff < 0) return null;
  return Math.round(diff / MS_PER_HOUR * 100) / 100;
}

// Hours an event contributes to a specific date YYYY-MM-DD (handles midnight crossover)
export function hoursForDate(event, date) {
  const { startAt, endAt, hours: manualHours, date: eventDate } = event;
  if (startAt && endAt) {
    const start = new Date(startAt);
    const end = new Date(endAt);
    const dayStart = new Date(date + 'T00:00');
    const dayEnd = new Date(date + 'T00:00');
    dayEnd.setDate(dayEnd.getDate() + 1);
    const effectiveStart = start < dayStart ? dayStart : start;
    const effectiveEnd = end > dayEnd ? dayEnd : end;
    if (effectiveStart >= effectiveEnd) return 0;
    return Math.round((effectiveEnd - effectiveStart) / MS_PER_HOUR * 100) / 100;
  }
  // Open event: not yet complete, no hours to attribute
  if (startAt && !endAt) return 0;
  // Manual hours: attributed entirely to event's date
  if (eventDate === date) return manualHours || 0;
  return 0;
}

// Union-of-intervals for actual clock time covered on a given date.
// Timed events are merged (overlapping spans count once); manual-hours events
// (no startAt/endAt) are added directly since they have no clock position to merge.
export function unionHoursForDate(events, date) {
  const dayStart = new Date(date + 'T00:00').getTime();
  const dayEndMs = new Date(date + 'T00:00');
  dayEndMs.setDate(dayEndMs.getDate() + 1);
  const dayEnd = dayEndMs.getTime();

  const intervals = [];
  let manualHours = 0;

  for (const event of events) {
    if (event.startAt && event.endAt) {
      const s = Math.max(new Date(event.startAt).getTime(), dayStart);
      const e = Math.min(new Date(event.endAt).getTime(), dayEnd);
      if (s < e) intervals.push([s, e]);
    } else if (!event.startAt && event.date === date) {
      manualHours += event.hours || 0;
    }
  }

  intervals.sort((a, b) => a[0] - b[0]);

  let union = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of intervals) {
    if (curStart === null) {
      curStart = s; curEnd = e;
    } else if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      union += curEnd - curStart;
      curStart = s; curEnd = e;
    }
  }
  if (curStart !== null) union += curEnd - curStart;

  return union / MS_PER_HOUR + manualHours;
}

export function today() {
  return toDateStr(new Date());
}

// --- Month utilities ---

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function getMonthStart(date = new Date()) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function getMonthEnd(date = new Date()) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function getMonthLabel(date = new Date()) {
  const d = new Date(date);
  return `${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
}

export function getMonthDates(date = new Date()) {
  const start = getMonthStart(date);
  const end = getMonthEnd(date);
  return { start: toDateStr(start), end: toDateStr(end) };
}

// First day of the month containing `date`, as 'YYYY-MM-01' (local time).
export function monthStartOf(date = new Date()) {
  return toDateStr(getMonthStart(date));
}

// The month being viewed given a nav offset from the current month.
// Pinned to day 1 before setMonth so offsets never skip a month
// (on Jan 31, setMonth(+1) would otherwise land in March).
export function offsetMonthDate(monthOffset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + monthOffset);
  return d;
}

// --- Money budget helpers ---

// trntype sentinels: 'transfer' legs and balance adjustments are bookkeeping,
// not real income/spending, and every income/spending computation must skip both.
export const TRN_TRANSFER = 'transfer';
export const TRN_ADJUSTMENT = 'ADJUSTMENT';

export function isTransferTxn(t) { return t.trntype === TRN_TRANSFER; }
export function isAdjustmentTxn(t) { return t.trntype === TRN_ADJUSTMENT; }
export function isRealTxn(t) { return !isTransferTxn(t) && !isAdjustmentTxn(t); }

// Category natures: unset defaults to 'flow'.
export function isFund(cat) { return cat.nature === 'fund'; }

// Fund location: unset defaults to 'earmarked' (kept in checking).
export function isEarmarkedFund(cat) { return cat.location !== 'real'; }

// Planned = sum of per-category commitments in a month's plan rows.
// Flow rows commit maxAmount ?? minAmount; fund rows commit their contribution.
// No parent rollup — plans are per-category commitments.
export function computePlanned(monthPlans, catById) {
  let planned = 0;
  for (const p of monthPlans) {
    const cat = catById[p.categoryId];
    if (!cat) continue;
    if (isFund(cat)) planned += p.contribution || 0;
    else planned += p.maxAmount ?? p.minAmount ?? 0;
  }
  return planned;
}

export function formatCurrency(amount) {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

// --- People utilities ---

// Person.tag holds a comma-separated tag list ("friend, gym")
export function parseTags(tagStr) {
  return (tagStr || '').split(',').map(t => t.trim()).filter(Boolean);
}

// A note is expired once its expiresAt date has passed (visible through that day)
export function isNoteExpired(note, todayStr = today()) {
  return !!note.expiresAt && note.expiresAt < todayStr;
}

// Days from today until a reminder fires; repeatYearly uses the next occurrence
// of the month/day. Negative = already passed (non-repeating only).
export function daysUntilReminder(remindOn, repeatYearly) {
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  let target = parseDate(remindOn);
  if (repeatYearly) {
    target = new Date(todayDate.getFullYear(), target.getMonth(), target.getDate());
    if (target < todayDate) {
      target = new Date(todayDate.getFullYear() + 1, target.getMonth(), target.getDate());
    }
  }
  return Math.round((target - todayDate) / MS_PER_DAY);
}

// --- Category tree utilities ---

// Build an n-level tree from a flat category list.
// Orphaned children (parent deleted/missing) float to root.
export function buildCategoryTree(cats) {
  const byId = {};
  const roots = [];
  for (const c of cats) byId[c.id] = { ...c, children: [] };
  for (const c of cats) {
    if (c.parentId && byId[c.parentId]) {
      byId[c.parentId].children.push(byId[c.id]);
    } else {
      roots.push(byId[c.id]);
    }
  }
  const sort = (nodes) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

// Flatten tree to pre-order list with depth + sibling info for rendering.
export function flattenCategoryTree(nodes, depth = 0, result = []) {
  nodes.forEach((node, siblingIndex) => {
    result.push({ cat: node, depth, siblingIndex, siblingCount: nodes.length });
    flattenCategoryTree(node.children, depth + 1, result);
  });
  return result;
}

// All descendant IDs of a category (e.g. for subtree deletes, reparent cycle checks).
export function getDescendantIds(catId, allCats) {
  const result = new Set();
  const queue = [catId];
  while (queue.length) {
    const id = queue.shift();
    for (const c of allCats) {
      if (c.parentId === id && !result.has(c.id)) { result.add(c.id); queue.push(c.id); }
    }
  }
  return result;
}

// Add each category's amount to all its ancestors. Returns a new map; the
// input map's entries are the direct (per-category) amounts.
export function rollUpToParents(direct, catById) {
  const totals = { ...direct };
  for (const [catId, amount] of Object.entries(direct)) {
    if (!amount) continue;
    let cat = catById[catId];
    while (cat && cat.parentId) {
      totals[cat.parentId] = (totals[cat.parentId] || 0) + amount;
      cat = catById[cat.parentId];
    }
  }
  return totals;
}

// Compute attention hours per category across given dates, with parent rollup.
// Returns { [categoryId]: totalHours }
export function computeHoursByCat(events, dates, categories) {
  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  const direct = {};
  for (const event of events) {
    const catIds = Array.isArray(event.categories) ? event.categories : [];
    for (const dateStr of dates) {
      const h = hoursForDate(event, dateStr);
      if (h > 0) {
        for (const catId of catIds) {
          direct[catId] = (direct[catId] || 0) + h;
        }
      }
    }
  }
  return rollUpToParents(direct, catById);
}
