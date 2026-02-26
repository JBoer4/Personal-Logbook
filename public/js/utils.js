// Week math and date formatting utilities

export function uuid() {
  return crypto.randomUUID();
}

export function now() {
  return Date.now();
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

// Calculate hours from HH:MM start/end
export function calcHours(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60; // crosses midnight
  return Math.round(diff / 60 * 100) / 100;
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
  return Math.round(diff / 3600000 * 100) / 100;
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
    return Math.round((effectiveEnd - effectiveStart) / 3600000 * 100) / 100;
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

  return union / 3600000 + manualHours;
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

export function formatCurrency(amount) {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function parseOFXDate(dtposted) {
  if (!dtposted || dtposted.length < 8) return null;
  return `${dtposted.slice(0, 4)}-${dtposted.slice(4, 6)}-${dtposted.slice(6, 8)}`;
}
