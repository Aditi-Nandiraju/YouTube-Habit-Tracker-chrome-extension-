/**
 * background.js — Manifest V3 service worker for YouTube Habit Tracker
 * =====================================================================
 *
 * HOW TIME IS COUNTED (and why it survives MV3 service-worker restarts)
 * --------------------------------------------------------------------
 * A MV3 service worker can be killed at any moment, so we never "count ticks"
 * in memory. Instead we keep ONE open "current segment" — { mode, start,
 * lastTick, video… } — persisted in chrome.storage.local. Every time anything
 * happens (a 5-second heartbeat from a YouTube tab, a play/pause event, an
 * idle-state change, a 30-second chrome.alarms tick, the popup opening) we:
 *
 *   1. credit (now − lastTick) milliseconds to the segment's mode, split
 *      precisely at hour and midnight boundaries, and set lastTick = now;
 *   2. work out what the user is doing *now* (Study / Fun / Idle / nothing);
 *   3. if that differs from the open segment, close it — appending an entry
 *      with exact start/end timestamps to today's log — and open a new one.
 *
 * Because credit is Date.now() deltas, the totals are accurate to the
 * millisecond no matter how often the worker sleeps. If no event at all
 * arrives for > 90 s (browser closed, laptop asleep), the segment is closed
 * at its last confirmed moment instead of inventing time.
 *
 * WHAT COUNTS AS WHAT
 * -------------------
 *  STUDY / FUN : a YouTube video is playing in a visible tab of the focused
 *                window (or Picture-in-Picture) and the computer is active.
 *                Which one is decided by classifier.js.
 *  IDLE        : at least one YouTube tab is open, but: the video is paused
 *                or ended, the tab is hidden/minimised, the window is not
 *                focused, you're just browsing (no video), or chrome.idle
 *                reports the computer as idle/locked.
 *  (nothing)   : no YouTube tab open — nothing is counted.
 */

import { buildEffectiveSettings } from './config.js';
import { classifyVideo } from './classifier.js';
import { MODE_META, MODES, dayKey, startOfNextHour, startOfNextDay, normalizeDay } from './utils.js';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */
const HEARTBEAT_FRESH_MS = 15_000;      // a "playing" report older than this is not trusted
const MAX_GAP_MS = 90_000;              // no event for longer than this = tracking interrupted
const MIN_SEGMENT_MS = 1_000;           // segments shorter than 1 s are not written to the log
const MERGE_GAP_MS = 2_000;             // identical back-to-back segments within 2 s are merged
const MAX_SEGMENTS_PER_DAY = 5_000;     // safety cap on log size per day
const REINJECT_AFTER_MS = 180_000;      // re-inject content.js into tabs silent this long
const ALARM_NAME = 'yt-habit-tick';
const ALARM_PERIOD_MIN = 0.5;           // 30 s (Chrome 120+; older versions clamp to 1 min)
const YT_URL_PATTERNS = ['https://www.youtube.com/*', 'https://m.youtube.com/*'];
const DAY_CACHE_LIMIT = 4;

/* ------------------------------------------------------------------ */
/* In-memory state (rebuilt from storage whenever the worker wakes)     */
/* ------------------------------------------------------------------ */
let settings = null;          // effective settings (config.js defaults + saved options)
let rt = null;                // runtime: { tabs, idleState, idleSince, current, lastPruneDay }
const dayCache = new Map();   // dayKey -> day record
const dirtyDays = new Set();  // day keys modified since last persist()
let popupPorts = 0;           // number of open popups (opening the popup steals page focus)
let lastBadge = '';
const injectAttempted = new Set();

function freshRuntime() {
  return { tabs: {}, idleState: 'active', idleSince: null, current: null, lastPruneDay: null };
}

/* ------------------------------------------------------------------ */
/* Serial task queue — every state mutation runs one at a time, so      */
/* concurrent messages can never interleave their storage reads/writes. */
/* ------------------------------------------------------------------ */
let chain = Promise.resolve();
function serialize(task) {
  const run = chain.then(task);
  chain = run.catch((err) => console.error('[YT Habit] task failed:', err));
  return run;
}

/* ------------------------------------------------------------------ */
/* Loading & persisting                                                 */
/* ------------------------------------------------------------------ */
async function ensureLoaded() {
  if (!settings) {
    const { settings: stored } = await chrome.storage.local.get('settings');
    settings = buildEffectiveSettings(stored);
  }
  if (!rt) {
    const { runtime } = await chrome.storage.local.get('runtime');
    rt = runtime && typeof runtime === 'object' ? { ...freshRuntime(), ...runtime } : freshRuntime();
    if (!rt.tabs || typeof rt.tabs !== 'object') rt.tabs = {};
    if (!runtime) await refreshIdleState();
  }
}

async function refreshIdleState() {
  try {
    const state = await chrome.idle.queryState(settings.idleThresholdSec);
    if (state !== rt.idleState) {
      rt.idleState = state;
      rt.idleSince = state === 'active' ? null : Date.now();
    }
  } catch (err) {
    console.warn('[YT Habit] idle.queryState failed', err);
  }
}

async function getDay(key) {
  if (dayCache.has(key)) return dayCache.get(key);
  const storageKey = `day:${key}`;
  const res = await chrome.storage.local.get(storageKey);
  const day = normalizeDay(res[storageKey], key);
  dayCache.set(key, day);
  return day;
}

async function persist() {
  const out = { runtime: rt };
  for (const key of dirtyDays) {
    const day = dayCache.get(key);
    if (day) out[`day:${key}`] = day;
  }
  dirtyDays.clear();
  await chrome.storage.local.set(out);

  // Keep the in-memory cache small (today + yesterday are all we normally touch).
  if (dayCache.size > DAY_CACHE_LIMIT) {
    const keep = new Set([dayKey(), dayKey(Date.now() - 86_400_000)]);
    for (const key of [...dayCache.keys()]) if (!keep.has(key)) dayCache.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Time accounting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Add (sign = +1) or remove (sign = −1) the interval [from, to) for a context
 * { mode, videoId, title, channel } to the day totals, hourly buckets,
 * per-video and per-channel stats — split exactly at local hour boundaries
 * (which also handles midnight).
 */
async function credit(from, to, ctx, sign = 1) {
  if (!ctx || !MODES.includes(ctx.mode) || !(to > from)) return;
  let t = from;
  while (t < to) {
    const next = Math.min(to, startOfNextHour(t));
    const ms = (next - t) * sign;
    const day = await getDay(dayKey(t));
    const hour = new Date(t).getHours();

    day.totals[ctx.mode] = Math.max(0, day.totals[ctx.mode] + ms);
    day.hours[hour][ctx.mode] = Math.max(0, day.hours[hour][ctx.mode] + ms);

    if (ctx.videoId) {
      const v = day.videos[ctx.videoId] || (day.videos[ctx.videoId] = { title: '', channel: '', study: 0, fun: 0, idle: 0, lastSeen: 0 });
      if (ctx.title) v.title = ctx.title;
      if (ctx.channel) v.channel = ctx.channel;
      v[ctx.mode] = Math.max(0, (v[ctx.mode] || 0) + ms);
      v.lastSeen = Math.max(v.lastSeen || 0, next);
    }
    if (ctx.channel) {
      const c = day.channels[ctx.channel] || (day.channels[ctx.channel] = { study: 0, fun: 0, idle: 0 });
      c[ctx.mode] = Math.max(0, (c[ctx.mode] || 0) + ms);
    }
    dirtyDays.add(day.date);
    t = next;
  }
}

/** Two segments describe the same activity (so they can be merged). */
function sameKind(a, b) {
  return a.mode === b.mode && (a.videoId || '') === (b.videoId || '') && (a.reason || '') === (b.reason || '');
}

/** Identity of an activity state; a change of key closes the open segment. */
function stateKey(s) {
  return `${s.mode}|${s.videoId || ''}|${s.reason || ''}`;
}

/** The log entry stored for a segment. */
function segmentFrom(cur, start, end) {
  return {
    start,
    end,
    mode: cur.mode,
    reason: cur.reason || '',
    videoId: cur.videoId || null,
    title: cur.title || '',
    channel: cur.channel || '',
    why: cur.why || '',
  };
}

/** Append a finished segment to the day log(s), splitting at midnight. */
async function pushSegment(seg) {
  let s = seg.start;
  while (s < seg.end) {
    const e = Math.min(seg.end, startOfNextDay(s));
    const piece = { ...seg, start: s, end: e };
    const day = await getDay(dayKey(s));
    const last = day.segments[day.segments.length - 1];
    if (last && sameKind(last, piece) && piece.start >= last.start && piece.start - last.end <= MERGE_GAP_MS) {
      last.end = Math.max(last.end, piece.end);
      if (piece.title) last.title = piece.title;
      if (piece.channel) last.channel = piece.channel;
      if (piece.why) last.why = piece.why;
    } else if (piece.end - piece.start >= MIN_SEGMENT_MS) {
      day.segments.push(piece);
      if (day.segments.length > MAX_SEGMENTS_PER_DAY) {
        day.segments.splice(0, day.segments.length - MAX_SEGMENTS_PER_DAY);
      }
    }
    dirtyDays.add(day.date);
    s = e;
  }
}

/** Close the open segment at `end` and write it to the log. */
async function closeCurrent(end) {
  const cur = rt.current;
  if (!cur) return;
  await pushSegment(segmentFrom(cur, cur.start, Math.max(cur.start, end)));
  rt.current = null;
}

/* ------------------------------------------------------------------ */
/* Deciding what the user is doing right now                            */
/* ------------------------------------------------------------------ */

/** Most relevant tab to describe idle time: visible > focused > most recent report. */
function pickMostRelevant(reports) {
  return [...reports].sort((a, b) =>
    (Number(b.visible) - Number(a.visible)) ||
    (Number(b.focused) - Number(a.focused)) ||
    (Number(b.hasVideo) - Number(a.hasVideo)) ||
    (b.ts - a.ts)
  )[0] || null;
}

/** Human-readable reason a tab is idle. */
function describeIdle(r) {
  if (!r) return 'YouTube open';
  if (!r.visible) return r.playing ? 'Playing in a hidden / minimised tab' : 'YouTube tab in background';
  if (!r.hasVideo) return 'Browsing YouTube (no video playing)';
  if (r.ended) return 'Video ended';
  if (!r.playing) return 'Video paused';
  if (!r.focused) return 'Browser window not focused';
  return 'Waiting for player status';
}

function idleTarget(reason, r) {
  return {
    mode: 'idle',
    reason,
    videoId: r?.hasVideo ? (r.videoId || null) : null,
    title: r?.hasVideo ? (r.title || '') : '',
    channel: r?.hasVideo ? (r.channel || '') : '',
    why: '',
  };
}

/** Returns the desired state { mode, reason, videoId, title, channel, why } or null. */
function computeDesired(now) {
  const reports = Object.entries(rt.tabs).map(([id, r]) => ({ tabId: Number(id), ...r }));
  if (!reports.length) return null;

  const focusOk = (r) => r.focused || r.pip || !settings.unfocusedIsIdle || popupPorts > 0;
  const watching = reports
    .filter((r) => r.hasVideo && r.playing && (r.visible || r.pip) && focusOk(r) && now - r.ts <= HEARTBEAT_FRESH_MS)
    .sort((a, b) => b.ts - a.ts)[0] || null;
  const focusTab = watching || pickMostRelevant(reports);

  if (rt.idleState === 'locked') return idleTarget('Screen locked', focusTab);

  if (rt.idleState === 'idle') {
    const withinGrace =
      settings.idleHandling === 'smart' &&
      watching &&
      rt.idleSince != null &&
      now - rt.idleSince < settings.passiveGraceMin * 60_000;
    if (!withinGrace) {
      return idleTarget(`Away from computer (no input for ${settings.idleThresholdSec}s+)`, focusTab);
    }
  }

  if (watching) {
    const c = classifyVideo(watching, settings);
    return {
      mode: c.mode,
      reason: 'Watching',
      videoId: watching.videoId || null,
      title: watching.title || '',
      channel: watching.channel || '',
      why: c.why,
    };
  }
  return idleTarget(describeIdle(focusTab), focusTab);
}

/**
 * The heart of the tracker: bring the open segment up to `now`, then switch
 * segments if the activity changed.
 */
async function evaluate(now = Date.now()) {
  const cur = rt.current;
  if (cur) {
    if (now < cur.lastTick) {
      // System clock moved backwards — re-anchor without crediting anything.
      cur.lastTick = now;
      cur.start = Math.min(cur.start, now);
    } else if (now - cur.lastTick > MAX_GAP_MS) {
      // Nothing reached us for a long time (browser closed, computer asleep,
      // worker killed with no events). Close at the last confirmed moment.
      await closeCurrent(cur.lastTick);
    } else {
      await credit(cur.lastTick, now, cur, 1);
      cur.lastTick = now;
    }
  }

  const desired = computeDesired(now);
  const open = rt.current;
  if (!desired) {
    if (open) await closeCurrent(now);
  } else if (!open || stateKey(open) !== stateKey(desired)) {
    if (open) await closeCurrent(now);
    rt.current = { ...desired, start: now, lastTick: now };
  } else {
    // Same activity: refresh metadata (titles arrive a moment after navigation).
    if (desired.title) open.title = desired.title;
    if (desired.channel) open.channel = desired.channel;
    if (desired.why) open.why = desired.why;
  }
  updateBadge();
}

/** Small letter on the toolbar icon: S / F / I, coloured by mode. */
function updateBadge() {
  const cur = rt?.current;
  const badge = cur ? `${cur.mode}|${cur.title}|${cur.reason}` : '';
  if (badge === lastBadge) return;
  lastBadge = badge;
  const meta = cur ? MODE_META[cur.mode] : null;
  chrome.action.setBadgeText({ text: meta ? meta.badge : '' }).catch(() => {});
  if (meta) chrome.action.setBadgeBackgroundColor({ color: meta.color }).catch(() => {});
  const title = !cur
    ? 'YouTube Habit Tracker — not tracking'
    : cur.mode === 'idle'
      ? `YouTube Habit Tracker — Idle: ${cur.reason}`
      : `YouTube Habit Tracker — ${meta.label}: ${cur.title || 'video'}`;
  chrome.action.setTitle({ title: title.slice(0, 200) }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                         */
/* ------------------------------------------------------------------ */

/** Whitelist and size-limit what a content script reports. */
function sanitizeReport(raw) {
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    url: str(raw?.url, 500),
    pageType: str(raw?.pageType, 20),
    videoId: str(raw?.videoId, 32) || null,
    title: str(raw?.title, 300),
    channel: str(raw?.channel, 200),
    handle: str(raw?.handle, 120),
    category: str(raw?.category, 80),
    keywords: Array.isArray(raw?.keywords)
      ? raw.keywords.filter((k) => typeof k === 'string').slice(0, 50).map((k) => k.slice(0, 80))
      : [],
    hasVideo: !!raw?.hasVideo,
    playing: !!raw?.playing,
    ended: !!raw?.ended,
    visible: !!raw?.visible,
    focused: !!raw?.focused,
    pip: !!raw?.pip,
    isAd: !!raw?.isAd,
  };
}

/** Drop reports for tabs that no longer exist; re-inject into silent tabs. */
async function pruneTabs(now) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: YT_URL_PATTERNS });
  } catch (err) {
    console.warn('[YT Habit] tabs.query failed', err);
    return;
  }
  const alive = new Set(tabs.map((t) => t.id));
  for (const id of Object.keys(rt.tabs)) {
    if (!alive.has(Number(id))) delete rt.tabs[id];
  }
  for (const tab of tabs) {
    const report = rt.tabs[tab.id];
    const silent = !report || now - report.ts > REINJECT_AFTER_MS;
    if (silent && !tab.discarded && tab.status === 'complete' && !injectAttempted.has(tab.id)) {
      injectAttempted.add(tab.id);
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  }
}

/** Inject content.js into YouTube tabs that were open before install/update. */
async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: YT_URL_PATTERNS });
    await Promise.all(
      tabs
        .filter((t) => !t.discarded)
        .map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {}))
    );
  } catch (err) {
    console.warn('[YT Habit] injection failed', err);
  }
}

/** Delete day records older than the retention window (runs at most once a day). */
async function pruneOldDays() {
  const today = dayKey();
  if (rt.lastPruneDay === today) return;
  rt.lastPruneDay = today;
  const cutoff = dayKey(Date.now() - settings.retentionDays * 86_400_000);
  const keys = typeof chrome.storage.local.getKeys === 'function'
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const old = keys.filter((k) => k.startsWith('day:') && k.slice(4) < cutoff);
  if (old.length) {
    await chrome.storage.local.remove(old);
    old.forEach((k) => dayCache.delete(k.slice(4)));
  }
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
}

function applyIdleInterval() {
  try {
    chrome.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec));
  } catch (err) {
    console.warn('[YT Habit] setDetectionInterval failed', err);
  }
}

/* ------------------------------------------------------------------ */
/* Event wiring (all listeners registered synchronously at top level)  */
/* ------------------------------------------------------------------ */

// Runs every time the worker starts.
serialize(async () => {
  await ensureLoaded();
  applyIdleInterval();
  await ensureAlarm();
});

chrome.runtime.onInstalled.addListener(() => {
  serialize(async () => {
    await ensureLoaded();
    applyIdleInterval();
    await ensureAlarm();
    await injectIntoOpenTabs();
  });
});

chrome.runtime.onStartup.addListener(() => {
  serialize(async () => {
    await ensureLoaded();
    // New browser session: old tab ids are meaningless; close whatever was open.
    if (rt.current) await closeCurrent(rt.current.lastTick);
    rt.tabs = {};
    rt.idleState = 'active';
    rt.idleSince = null;
    await refreshIdleState();
    await pruneOldDays();
    updateBadge();
    await persist();
  });
});

// Messages from content.js (heartbeat / bye) and popup/options (getLive / clearData).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'heartbeat' || msg.type === 'bye') {
    const tab = sender.tab;
    if (!tab || tab.id == null) return false;
    serialize(async () => {
      await ensureLoaded();
      const now = Date.now();
      if (msg.type === 'heartbeat') {
        rt.tabs[tab.id] = { ...sanitizeReport(msg.state), ts: now, windowId: tab.windowId };
        injectAttempted.delete(tab.id);
      } else {
        delete rt.tabs[tab.id];
      }
      await evaluate(now);
      await persist();
    });
    return false;
  }

  if (msg.type === 'getLive') {
    serialize(async () => {
      await ensureLoaded();
      const now = Date.now();
      await evaluate(now);
      await persist();
      return { current: rt.current, idleState: rt.idleState, idleSince: rt.idleSince, now };
    }).then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true; // async response
  }

  if (msg.type === 'clearData') {
    serialize(async () => {
      await ensureLoaded();
      const now = Date.now();
      const keys = typeof chrome.storage.local.getKeys === 'function'
        ? await chrome.storage.local.getKeys()
        : Object.keys(await chrome.storage.local.get(null));
      const dayKeys = keys.filter((k) => k.startsWith('day:'));
      if (dayKeys.length) await chrome.storage.local.remove(dayKeys);
      dayCache.clear();
      dirtyDays.clear();
      if (rt.current) {
        rt.current.start = now;
        rt.current.lastTick = now;
      }
      await persist();
      return { ok: true, removed: dayKeys.length };
    }).then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true;
  }

  return false;
});

// While the popup is open it steals focus from the page; don't count that as idle.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPorts += 1;
  port.onDisconnect.addListener(() => {
    popupPorts = Math.max(0, popupPorts - 1);
    serialize(async () => {
      await ensureLoaded();
      await evaluate(Date.now());
      await persist();
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(async () => {
    await ensureLoaded();
    if (!(tabId in rt.tabs)) return;
    delete rt.tabs[tabId];
    await evaluate(Date.now());
    await persist();
  });
});

// Computer idle / locked / active.
chrome.idle.onStateChanged.addListener((newState) => {
  serialize(async () => {
    await ensureLoaded();
    const now = Date.now();

    // 1) Account everything up to this instant under the previous state.
    await evaluate(now);

    const prev = rt.idleState;
    if (newState === prev) {
      await persist();
      return;
    }
    rt.idleState = newState;
    if (newState === 'active') {
      rt.idleSince = null;
    } else if (prev === 'active') {
      // Chrome only reports "idle" after idleThresholdSec of no input,
      // so the user actually stopped interacting that long ago.
      rt.idleSince = newState === 'idle' ? now - settings.idleThresholdSec * 1000 : now;
    }

    // 2) Retroactive correction (strict mode): the last idleThresholdSec seconds
    //    were already "away", so move them from Study/Fun into Idle.
    const cur = rt.current;
    if (
      newState === 'idle' && prev === 'active' &&
      settings.retroactiveIdle && settings.idleHandling === 'strict' &&
      cur && cur.mode !== 'idle'
    ) {
      const backTo = Math.max(cur.start, rt.idleSince);
      const desired = computeDesired(now);
      if (backTo < now && desired && desired.mode === 'idle') {
        await credit(backTo, now, cur, -1);
        await pushSegment(segmentFrom(cur, cur.start, backTo));
        rt.current = { ...desired, start: backTo, lastTick: backTo };
        await credit(backTo, now, rt.current, 1);
        rt.current.lastTick = now;
      }
    }

    // 3) Switch to whatever the new state implies.
    await evaluate(now);
    await persist();
  });
});

// 30-second safety tick: keeps totals moving even when tabs are throttled.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  serialize(async () => {
    await ensureLoaded();
    const now = Date.now();
    await pruneTabs(now);
    await evaluate(now);
    await pruneOldDays();
    await persist();
  });
});

// Settings changed in the popup or Options page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  serialize(async () => {
    settings = buildEffectiveSettings(changes.settings.newValue);
    applyIdleInterval();
    await ensureLoaded();
    await evaluate(Date.now());
    await persist();
  });
});
