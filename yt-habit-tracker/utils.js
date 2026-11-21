/**
 * utils.js — Shared helpers for YouTube Habit Tracker
 * ---------------------------------------------------
 * Imported as an ES module by background.js, popup.js, options.js and
 * classifier.js. Contains no Chrome API calls, so it is safe everywhere.
 */

/** The three time buckets, in display order. */
export const MODES = ['study', 'fun', 'idle'];

/** Labels, colours and badge letters for each bucket (used by popup + badge). */
export const MODE_META = {
  study: { label: 'Study', color: '#4f7cff', badge: 'S' },
  fun:   { label: 'Fun',   color: '#ff7a59', badge: 'F' },
  idle:  { label: 'Idle',  color: '#9aa4b2', badge: 'I' },
};

/** Left-pad a number to two digits: 7 -> "07". */
export const pad2 = (n) => String(n).padStart(2, '0');

/** Local-calendar day key for a timestamp, e.g. "2026-11-07". */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Timestamp (ms) of local midnight at the start of a day key. */
export function startOfDayTs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** Shift a day key by n days (n may be negative). Uses noon to dodge DST edges. */
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12, 0, 0, 0).getTime());
}

/** Timestamp of the next local hour boundary strictly after ts. */
export function startOfNextHour(ts) {
  const d = new Date(ts);
  d.setMinutes(60, 0, 0); // minute 60 rolls over to the next hour
  return d.getTime();
}

/** Timestamp of the next local midnight strictly after ts. */
export function startOfNextDay(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0); // hour 24 rolls over to the next day
  return d.getTime();
}

/** A zeroed {study, fun, idle} bucket. */
export function emptyBucket() {
  return { study: 0, fun: 0, idle: 0 };
}

/**
 * Shape of one stored day record (key "day:YYYY-MM-DD" in chrome.storage.local).
 *  totals   – milliseconds per mode for the whole day
 *  hours    – 24 buckets of milliseconds per mode (local hours 0..23)
 *  segments – ordered list of { start, end, mode, reason, videoId, title, channel, why }
 *  videos   – per video id: { title, channel, study, fun, idle, lastSeen }
 *  channels – per channel name: { study, fun, idle }
 */
export function newDay(key) {
  return {
    date: key,
    totals: emptyBucket(),
    hours: Array.from({ length: 24 }, () => emptyBucket()),
    segments: [],
    videos: {},
    channels: {},
  };
}

/** Repair/upgrade any stored day record into the canonical shape. */
export function normalizeDay(raw, key) {
  const day = newDay(key);
  if (!raw || typeof raw !== 'object') return day;
  for (const m of MODES) day.totals[m] = Number(raw.totals?.[m]) || 0;
  if (Array.isArray(raw.hours)) {
    raw.hours.slice(0, 24).forEach((h, i) => {
      for (const m of MODES) day.hours[i][m] = Number(h?.[m]) || 0;
    });
  }
  if (Array.isArray(raw.segments)) {
    day.segments = raw.segments.filter((s) => s && Number(s.end) > Number(s.start) && MODES.includes(s.mode));
  }
  if (raw.videos && typeof raw.videos === 'object') day.videos = raw.videos;
  if (raw.channels && typeof raw.channels === 'object') day.channels = raw.channels;
  return day;
}

/** 3,725,000 ms -> "1h 02m 05s"; 125,000 -> "2m 05s"; 9,000 -> "9s". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  if (m) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

/** Wall-clock time with seconds in the user's locale, e.g. "02:14:09 pm". */
export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "YYYY-MM-DD HH:MM:SS" in local time (used for CSV export). */
export function formatStamp(ts) {
  const d = new Date(ts);
  return `${dayKey(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Hour label "14:00". */
export function formatHourLabel(h) {
  return `${pad2(h)}:00`;
}

/** Hour range label "14:00–15:00". */
export function formatHourRange(h) {
  return `${pad2(h)}:00–${pad2((h + 1) % 24)}:00`;
}

/** Escape text for safe insertion into innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Case/space-insensitive comparison form of a name or keyword. */
export function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** De-duplicate a list of names (case-insensitive), dropping blanks, keeping first spelling. */
export function uniqueList(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const clean = String(item ?? '').trim();
    const norm = normalizeName(clean);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(clean);
  }
  return out;
}

/** Split text on commas AND newlines (for keyword lists). */
export function parseList(text) {
  return uniqueList(String(text ?? '').split(/[\n,]/));
}

/** Split text on newlines only (for channel names, which may contain commas). */
export function parseLines(text) {
  return uniqueList(String(text ?? '').split(/\n/));
}
