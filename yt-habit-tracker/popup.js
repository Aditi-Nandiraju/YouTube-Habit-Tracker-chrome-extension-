/**
 * popup.js — YouTube Habit Tracker report UI
 * ==========================================
 * Reads day records from chrome.storage.local and the live "current segment"
 * from the background worker, then renders:
 *   • live status (what is being counted right now, since when)
 *   • SVG donut + exact H/M/S totals for Study / Fun / Idle
 *   • comparison with yesterday and the 7-day average
 *   • insights: peak & lightest hours, longest sessions with start → end times
 *   • a day ribbon (every segment on a time axis) and an hourly stacked bar chart
 *   • a start/stop log with exact timestamps for every segment
 *   • top videos and channels
 *
 * Between data refreshes (every 5 s) the numbers tick every second by
 * extrapolating the open segment, so the display is live to the second.
 */

import {
  MODES, MODE_META, dayKey, addDays, startOfDayTs, normalizeDay, newDay,
  formatDuration, formatClock, formatStamp, formatHourRange, formatHourLabel,
  escapeHtml, normalizeName, uniqueList,
} from './utils.js';

const LIVE_EXTRAPOLATION_CAP_MS = 90_000; // never extrapolate further than the background would credit
const RUN_JOIN_GAP_MS = 5_000;            // segments of the same mode this close form one "session"
const LOG_LIMIT = 400;
const REFRESH_MS = 5_000;

const state = {
  todayKey: dayKey(),
  viewKey: dayKey(),
  live: null,          // { current, idleState, now } from background
  days: {},            // dayKey -> day record (view day + 7 previous)
  rawSettings: {},     // settings exactly as stored (partial)
  filter: 'all',
  loaded: false,
};

const $ = (id) => document.getElementById(id);
const fmt = formatDuration;
const total3 = (b) => (b.study || 0) + (b.fun || 0) + (b.idle || 0);
const active2 = (b) => (b.study || 0) + (b.fun || 0);

/** Only touch the DOM when the markup actually changed (keeps scroll/hover stable). */
const htmlCache = new WeakMap();
function setHTML(node, html) {
  if (htmlCache.get(node) === html) return;
  node.innerHTML = html;
  htmlCache.set(node, html);
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function fetchData() {
  state.todayKey = dayKey();
  try {
    const live = await chrome.runtime.sendMessage({ type: 'getLive' });
    state.live = live && !live.error ? live : null;
  } catch {
    state.live = null;
  }
  const keys = Array.from({ length: 8 }, (_, i) => addDays(state.viewKey, -i));
  const stored = await chrome.storage.local.get([...keys.map((k) => `day:${k}`), 'settings']);
  state.days = Object.fromEntries(keys.map((k) => [k, normalizeDay(stored[`day:${k}`], k)]));
  state.rawSettings = stored.settings && typeof stored.settings === 'object' ? stored.settings : {};
  state.loaded = true;
  render();
}

/** Day record for the view, with the open segment extrapolated up to this second. */
function buildView() {
  const key = state.viewKey;
  const day = structuredClone(state.days[key] || newDay(key));
  const isToday = key === state.todayKey;
  const now = Date.now();
  let liveSeg = null;

  const cur = state.live?.current;
  if (isToday && cur) {
    const extra = Math.max(0, Math.min(now - cur.lastTick, LIVE_EXTRAPOLATION_CAP_MS));
    day.totals[cur.mode] += extra;
    day.hours[new Date(now).getHours()][cur.mode] += extra;
    const start = Math.max(cur.start, startOfDayTs(key));
    const end = cur.lastTick + extra;
    if (end > start) liveSeg = { ...cur, start, end, live: true };
  }
  const segments = liveSeg ? [...day.segments, liveSeg] : day.segments.slice();
  return { key, day, isToday, now, segments, liveSeg };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  if (!state.loaded) return;
  const v = buildView();
  renderHeader(v);
  renderStatus(v);
  renderOverview(v);
  renderCompare(v);
  renderInsights(v);
  renderRibbon(v);
  renderHourly(v);
  renderClassify(v);
  renderLog(v);
  renderTop(v);
}

function renderHeader(v) {
  const nice = new Date(startOfDayTs(v.key)).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const rel = v.key === state.todayKey ? 'Today' : v.key === addDays(state.todayKey, -1) ? 'Yesterday' : '';
  $('dateLabel').textContent = rel ? `${rel} · ${nice}` : nice;
  $('nextDay').disabled = v.key >= state.todayKey;
}

function renderStatus(v) {
  const box = $('status');
  if (!v.isToday) {
    setHTML(box, `<div class="status"><span class="dot"></span><div class="status-text"><b>History</b>
      <small>Showing ${escapeHtml(v.key)}. Live tracking appears on Today.</small></div></div>`);
    return;
  }
  const cur = state.live?.current;
  if (!state.live) {
    setHTML(box, `<div class="status"><span class="dot"></span><div class="status-text"><b>Background not reachable</b>
      <small>Reload the extension from chrome://extensions.</small></div></div>`);
    return;
  }
  if (!cur) {
    setHTML(box, `<div class="status"><span class="dot"></span><div class="status-text"><b>Not tracking</b>
      <small>No YouTube tab is open — nothing is being counted.</small></div></div>`);
    return;
  }
  const meta = MODE_META[cur.mode];
  const verb = cur.mode === 'study' ? 'Studying' : cur.mode === 'fun' ? 'Having fun' : 'Idle';
  const elapsed = v.liveSeg ? v.liveSeg.end - cur.start : 0;
  const line = cur.mode === 'idle' ? cur.reason : (cur.title || 'Untitled video');
  const sub = cur.mode === 'idle'
    ? (cur.title ? `On: ${cur.title}` : '')
    : [cur.channel, cur.why].filter(Boolean).join(' · ');
  setHTML(box, `<div class="status" style="--c:${meta.color}">
      <span class="dot live"></span>
      <div class="status-text">
        <b>${verb}</b> <span class="since">since ${formatClock(cur.start)} · ${fmt(elapsed)}</span>
        <div class="status-line" title="${escapeHtml(line)}">${escapeHtml(line)}</div>
        ${sub ? `<small title="${escapeHtml(sub)}">${escapeHtml(sub)}</small>` : ''}
      </div>
    </div>`);
}

function renderOverview(v) {
  const t = v.day.totals;
  const all = total3(t);
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = MODES.map((m) => {
    const len = all ? (t[m] / all) * c : 0;
    const gap = len > 4 && all > t[m] ? 1.5 : 0; // tiny gap between arcs
    const arc = len > 0
      ? `<circle cx="66" cy="66" r="${r}" fill="none" stroke="${MODE_META[m].color}" stroke-width="16"
           stroke-dasharray="${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}" stroke-dashoffset="${-offset}"
           transform="rotate(-90 66 66)"><title>${MODE_META[m].label}: ${fmt(t[m])}</title></circle>`
      : '';
    offset += len;
    return arc;
  }).join('');

  const centerTop = all ? fmt(active2(t)) : '0s';
  setHTML($('donut'), `<svg class="donut" viewBox="0 0 132 132" role="img" aria-label="Study, fun and idle breakdown">
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--track)" stroke-width="16"/>
      ${arcs}
      <text class="center-big" x="66" y="66" text-anchor="middle">${centerTop}</text>
      <text class="center-small" x="66" y="82" text-anchor="middle">watching</text>
    </svg>`);

  setHTML($('legend'), MODES.map((m) => {
    const pct = all ? Math.round((t[m] / all) * 100) : 0;
    return `<div class="legend-row" style="--c:${MODE_META[m].color}">
        <i></i><span class="name">${MODE_META[m].label}</span><span class="pct">${pct}%</span>
        <span class="time">${fmt(t[m])}</span>
      </div>`;
  }).join(''));

  $('trackedNote').textContent = all ? `${fmt(all)} with YouTube open` : '';
}

function deltaText(diff, mode) {
  if (Math.abs(diff) < 1000) return '<small>= same as yesterday</small>';
  const up = diff > 0;
  const good = mode === 'study' ? up : !up;
  return `<small class="${good ? 'up-good' : 'up-bad'}">${up ? '▲' : '▼'} ${fmt(Math.abs(diff))} vs yesterday</small>`;
}

function renderCompare(v) {
  const yesterday = state.days[addDays(v.key, -1)] || newDay(addDays(v.key, -1));
  const prev = Array.from({ length: 7 }, (_, i) => state.days[addDays(v.key, -(i + 1))])
    .filter((d) => d && total3(d.totals) > 0);
  setHTML($('compare'), MODES.map((m) => {
    const avg = prev.length ? prev.reduce((a, d) => a + d.totals[m], 0) / prev.length : null;
    return `<div class="cmp" style="--c:${MODE_META[m].color}">
        <div class="lbl">${MODE_META[m].label}</div>
        <div class="val">${fmt(v.day.totals[m])}</div>
        ${deltaText(v.day.totals[m] - yesterday.totals[m], m)}
        <small>avg ${avg == null ? '—' : fmt(avg)}</small>
      </div>`;
  }).join(''));
}

/** Join consecutive segments of one mode into sessions. */
function computeRuns(segments, mode) {
  const runs = [];
  segments
    .filter((s) => s.mode === mode)
    .sort((a, b) => a.start - b.start)
    .forEach((s) => {
      const last = runs[runs.length - 1];
      if (last && s.start - last.end <= RUN_JOIN_GAP_MS) {
        last.end = Math.max(last.end, s.end);
        last.items.push(s);
      } else {
        runs.push({ start: s.start, end: s.end, items: [s] });
      }
    });
  return runs;
}

function longestRun(runs) {
  return runs.reduce((best, r) => (!best || r.end - r.start > best.end - best.start ? r : best), null);
}

function insightRow(color, key, value, detail) {
  return `<div class="insight" style="--c:${color}">
      <span class="k"><i></i>${escapeHtml(key)}</span>
      <span class="v">${escapeHtml(value)}</span>
      ${detail ? `<span class="d" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>` : ''}
    </div>`;
}

function renderInsights(v) {
  const { day, segments } = v;
  const t = day.totals;
  const rows = [];
  if (!total3(t)) {
    setHTML($('insights'), '<div class="empty">No YouTube time recorded for this day yet.</div>');
    return;
  }

  // Focus ratio
  if (active2(t)) {
    const pct = Math.round((t.study / active2(t)) * 100);
    rows.push(insightRow(MODE_META.study.color, 'Focus ratio', `${pct}% study`,
      `${fmt(t.study)} studying vs ${fmt(t.fun)} for fun`));
  }

  // Peak hour per mode
  for (const m of MODES) {
    if (!t[m]) continue;
    let best = 0;
    day.hours.forEach((h, i) => { if (h[m] > day.hours[best][m]) best = i; });
    const label = m === 'study' ? 'Most study' : m === 'fun' ? 'Most fun' : 'Most idle';
    rows.push(insightRow(MODE_META[m].color, label, formatHourRange(best),
      `${fmt(day.hours[best][m])} of ${MODE_META[m].label.toLowerCase()} in that hour`));
  }

  // Lightest hour among hours where YouTube was open
  const openHours = day.hours.map((h, i) => ({ i, all: total3(h), act: active2(h) })).filter((h) => h.all > 0);
  if (openHours.length > 1) {
    const light = openHours.reduce((a, b) => (b.act < a.act ? b : a));
    const heavy = openHours.reduce((a, b) => (b.act > a.act ? b : a));
    rows.push(insightRow('var(--faint)', 'Heaviest watching hour', formatHourRange(heavy.i),
      `${fmt(heavy.act)} watched (study + fun)`));
    rows.push(insightRow('var(--faint)', 'Lightest hour (YouTube open)', formatHourRange(light.i),
      `only ${fmt(light.act)} watched, ${fmt(light.all - light.act)} idle`));
  }

  // Longest sessions with exact start → stop
  for (const m of MODES) {
    const run = longestRun(computeRuns(segments, m));
    if (!run || run.end - run.start < 1000) continue;
    const label = m === 'study' ? 'Longest study session' : m === 'fun' ? 'Longest fun binge' : 'Longest idle stretch';
    let detail;
    if (m === 'idle') {
      const byReason = {};
      run.items.forEach((s) => { byReason[s.reason] = (byReason[s.reason] || 0) + (s.end - s.start); });
      const top = Object.entries(byReason).sort((a, b) => b[1] - a[1])[0];
      detail = `${formatClock(run.start)} → ${formatClock(run.end)}${top ? ` · mostly “${top[0]}”` : ''}`;
    } else {
      const vids = new Set(run.items.map((s) => s.videoId || s.title)).size;
      detail = `${formatClock(run.start)} → ${formatClock(run.end)} · ${vids} video${vids === 1 ? '' : 's'}`;
    }
    rows.push(insightRow(MODE_META[m].color, label, fmt(run.end - run.start), detail));
  }

  // Why idle?
  const idleReasons = {};
  segments.filter((s) => s.mode === 'idle').forEach((s) => {
    idleReasons[s.reason] = (idleReasons[s.reason] || 0) + (s.end - s.start);
  });
  const reasonList = Object.entries(idleReasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (reasonList.length) {
    rows.push(insightRow(MODE_META.idle.color, 'Top idle cause', reasonList[0][0].replace(/\s*\(.*\)$/, ''),
      reasonList.map(([r, ms]) => `${r.replace(/\s*\(.*\)$/, '')}: ${fmt(ms)}`).join(' · ')));
  }

  // Study ↔ fun switches
  const activeSegs = segments.filter((s) => s.mode !== 'idle').sort((a, b) => a.start - b.start);
  let switches = 0;
  for (let i = 1; i < activeSegs.length; i++) if (activeSegs[i].mode !== activeSegs[i - 1].mode) switches++;
  if (activeSegs.length) {
    rows.push(insightRow('var(--faint)', 'Study ↔ fun switches', String(switches),
      switches > 6 ? 'Frequent context switching today' : 'Mostly stayed in one mode at a time'));
  }

  // First / last seen
  if (segments.length) {
    const first = Math.min(...segments.map((s) => s.start));
    const last = Math.max(...segments.map((s) => s.end));
    rows.push(insightRow('var(--faint)', 'First → last YouTube activity',
      `${formatClock(first)} → ${formatClock(last)}`, ''));
  }

  // Top channel per mode
  for (const m of ['study', 'fun']) {
    const top = Object.entries(day.channels).sort((a, b) => (b[1][m] || 0) - (a[1][m] || 0))[0];
    if (top && top[1][m] > 0) {
      rows.push(insightRow(MODE_META[m].color, m === 'study' ? 'Top study channel' : 'Top fun channel', fmt(top[1][m]), top[0]));
    }
  }

  setHTML($('insights'), rows.join(''));
}

function renderRibbon(v) {
  const segs = v.segments;
  if (!segs.length) {
    setHTML($('ribbon'), '<div class="empty">No segments yet.</div>');
    $('ribbonRange').textContent = '';
    return;
  }
  const dayStart = startOfDayTs(v.key);
  const hourMs = 3_600_000;
  const minStart = Math.min(...segs.map((s) => s.start));
  const maxEnd = Math.max(...segs.map((s) => s.end));
  let h0 = Math.max(0, Math.floor((minStart - dayStart) / hourMs));
  let h1 = Math.min(24, Math.ceil((maxEnd - dayStart) / hourMs));
  if (h1 <= h0) h1 = Math.min(24, h0 + 1);
  if (h1 <= h0) h0 = h1 - 1;
  const rangeStart = dayStart + h0 * hourMs;
  const span = (h1 - h0) * hourMs;
  const W = 372;
  const x = (ts) => ((ts - rangeStart) / span) * W;

  const rects = segs.map((s) => {
    const x0 = x(Math.max(s.start, rangeStart));
    const w = Math.max(0.8, x(s.end) - x0);
    const label = `${formatClock(s.start)} – ${s.live ? 'now' : formatClock(s.end)} · ${MODE_META[s.mode].label} · ${fmt(s.end - s.start)}\n${s.mode === 'idle' ? s.reason : (s.title || '')}`;
    return `<rect x="${x0.toFixed(2)}" y="4" width="${w.toFixed(2)}" height="22" fill="${MODE_META[s.mode].color}"><title>${escapeHtml(label)}</title></rect>`;
  }).join('');

  const hours = h1 - h0;
  const step = hours <= 6 ? 1 : hours <= 12 ? 2 : hours <= 18 ? 3 : 4;
  let ticks = '';
  for (let h = h0; h <= h1; h += step) {
    const tx = ((h - h0) / hours) * W;
    const anchor = h === h0 ? 'start' : h + step > h1 ? 'end' : 'middle';
    ticks += `<line x1="${tx}" x2="${tx}" y1="26" y2="30" stroke="var(--line)"/>
      <text class="axis" x="${tx}" y="40" text-anchor="${anchor}">${formatHourLabel(h % 24)}</text>`;
  }
  setHTML($('ribbon'), `<svg viewBox="0 0 ${W} 44" width="100%" role="img" aria-label="Timeline of segments">
      <defs><clipPath id="ribbonClip"><rect x="0" y="4" width="${W}" height="22" rx="5"/></clipPath></defs>
      <rect x="0" y="4" width="${W}" height="22" rx="5" fill="var(--track)"/>
      <g clip-path="url(#ribbonClip)">${rects}</g>
      ${ticks}
    </svg>`);
  $('ribbonRange').textContent = `${formatHourLabel(h0)}–${formatHourLabel(h1 % 24)} · hover for times`;
}

function renderHourly(v) {
  const hours = v.day.hours;
  const W = 372, H = 96, top = 6, bottom = 16;
  const chartH = H - top - bottom;
  const maxMs = Math.max(60_000, ...hours.map(total3));
  const slot = W / 24;
  const barW = slot - 3;
  const nowHour = v.isToday ? new Date().getHours() : -1;

  let bars = '';
  hours.forEach((h, i) => {
    let y = top + chartH;
    const x = i * slot + 1.5;
    for (const m of MODES) {
      const hgt = (h[m] / maxMs) * chartH;
      if (hgt <= 0) continue;
      y -= hgt;
      bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${hgt.toFixed(2)}" fill="${MODE_META[m].color}"/>`;
    }
    const tip = `${formatHourRange(i)}\nStudy ${fmt(h.study)} · Fun ${fmt(h.fun)} · Idle ${fmt(h.idle)}`;
    bars += `<rect x="${(i * slot).toFixed(2)}" y="${top}" width="${slot.toFixed(2)}" height="${chartH}" fill="transparent"><title>${escapeHtml(tip)}</title></rect>`;
    if (i === nowHour) {
      bars += `<rect x="${(x + barW / 2 - 1.5).toFixed(2)}" y="${top + chartH + 2}" width="3" height="3" rx="1.5" fill="var(--text)"/>`;
    }
    if (i % 3 === 0) {
      bars += `<text class="axis" x="${(i * slot + slot / 2).toFixed(2)}" y="${H - 2}" text-anchor="middle">${String(i).padStart(2, '0')}</text>`;
    }
  });
  const maxMin = Math.round(maxMs / 60_000);
  setHTML($('hourly'), `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Minutes per hour by mode">
      <line x1="0" x2="${W}" y1="${top}" y2="${top}" stroke="var(--line)" stroke-dasharray="2 3"/>
      <text class="axis" x="${W}" y="${top + 9}" text-anchor="end">${maxMin}m</text>
      <line x1="0" x2="${W}" y1="${top + chartH}" y2="${top + chartH}" stroke="var(--line)"/>
      ${bars}
    </svg>`);
}

function renderClassify(v) {
  const card = $('classifyCard');
  const cur = state.live?.current;
  if (!v.isToday || !cur || (!cur.videoId && !cur.channel)) {
    card.classList.add('hidden');
    setHTML(card, '');
    return;
  }
  card.classList.remove('hidden');
  const overrides = state.rawSettings.videoOverrides || {};
  const override = cur.videoId ? overrides[cur.videoId] : null;
  const inList = (list) => (list || []).some((n) => normalizeName(n) === normalizeName(cur.channel));
  const chStudy = inList(state.rawSettings.alwaysStudyChannels);
  const chFun = inList(state.rawSettings.alwaysFunChannels);
  const counted = cur.mode === 'idle' ? `Idle (${cur.reason})` : MODE_META[cur.mode].label;

  setHTML(card, `<h2>This video</h2>
    <p><b>${escapeHtml(cur.title || 'Untitled video')}</b><br><span class="muted">${escapeHtml(cur.channel || '')} · counting as ${escapeHtml(counted)}</span></p>
    ${cur.why ? `<p class="why">Why: ${escapeHtml(cur.why)}</p>` : ''}
    ${cur.videoId ? `<div class="btnrow">
      <button class="btn ${override === 'study' ? 'on' : ''}" data-c="study" data-action="video-study">Video is Study</button>
      <button class="btn ${override === 'fun' ? 'on' : ''}" data-c="fun" data-action="video-fun">Video is Fun</button>
      ${override ? '<button class="btn" data-action="video-auto">Use auto</button>' : ''}
    </div>` : ''}
    ${cur.channel ? `<div class="btnrow">
      <button class="btn ${chStudy ? 'on' : ''}" data-c="study" data-action="channel-study">Always Study channel</button>
      <button class="btn ${chFun ? 'on' : ''}" data-c="fun" data-action="channel-fun">Always Fun channel</button>
      ${chStudy || chFun ? '<button class="btn" data-action="channel-clear">Remove rule</button>' : ''}
    </div>` : ''}`);
}

function segRow(s) {
  const m = MODE_META[s.mode];
  const main = s.mode === 'idle' ? s.reason : (s.title || 'Untitled video');
  const sub = s.mode === 'idle'
    ? [s.title, s.channel].filter(Boolean).join(' — ')
    : [s.channel, s.why].filter(Boolean).join(' · ');
  const titleHtml = s.videoId && s.mode !== 'idle'
    ? `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(s.videoId)}" target="_blank" rel="noopener">${escapeHtml(main)}</a>`
    : escapeHtml(main);
  return `<div class="seg${s.live ? ' live' : ''}">
      <div class="seg-time"><span>${formatClock(s.start)}</span><span>${s.live ? 'now' : formatClock(s.end)}</span></div>
      <div class="seg-bar" style="background:${m.color}"></div>
      <div class="seg-main">
        <div class="seg-head">
          <span class="chip" style="--c:${m.color}">${m.label}</span>
          <span class="seg-dur">${fmt(s.end - s.start)}</span>
          ${s.live ? '<span class="nowtag">● LIVE</span>' : ''}
        </div>
        <div class="seg-title" title="${escapeHtml(main)}">${titleHtml}</div>
        ${sub ? `<div class="seg-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>` : ''}
      </div>
    </div>`;
}

function renderLog(v) {
  const match = (s) => state.filter === 'all' || s.mode === state.filter;
  const closed = v.day.segments.filter(match);
  const shown = closed.slice(-LOG_LIMIT).reverse();
  const live = v.liveSeg && match(v.liveSeg) ? segRow(v.liveSeg) : '';
  setHTML($('liveRow'), live);
  setHTML($('log'), shown.length
    ? shown.map(segRow).join('')
    : (live ? '' : '<div class="empty">No start/stop entries for this filter yet.</div>'));
  const n = closed.length + (live ? 1 : 0);
  $('logCount').textContent = `${n} entr${n === 1 ? 'y' : 'ies'}${closed.length > LOG_LIMIT ? ` · latest ${LOG_LIMIT}` : ''}`;
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.filter));
}

function stackBar(b) {
  const all = total3(b) || 1;
  return `<div class="stack">${MODES.map((m) => `<b style="width:${(b[m] / all) * 100}%;background:${MODE_META[m].color}"></b>`).join('')}</div>`;
}

function renderTop(v) {
  const videos = Object.entries(v.day.videos)
    .map(([id, x]) => ({ id, ...x, act: active2(x) }))
    .filter((x) => x.act > 0)
    .sort((a, b) => b.act - a.act)
    .slice(0, 5);
  setHTML($('topVideos'), videos.length ? videos.map((x) => {
    const mode = (x.study || 0) >= (x.fun || 0) ? 'study' : 'fun';
    return `<div class="top-row">
        <a class="t" href="https://www.youtube.com/watch?v=${encodeURIComponent(x.id)}" target="_blank" rel="noopener" title="${escapeHtml(x.title)}">${escapeHtml(x.title || x.id)}</a>
        <span class="n">${fmt(x.act)}</span>
        <span class="s"><span class="chip" style="--c:${MODE_META[mode].color}">${MODE_META[mode].label}</span> ${escapeHtml(x.channel || '')}${x.idle ? ` · ${fmt(x.idle)} paused/idle` : ''}</span>
      </div>`;
  }).join('') : '<div class="empty">No videos watched yet.</div>');

  const channels = Object.entries(v.day.channels)
    .map(([name, x]) => ({ name, ...x, act: active2(x) }))
    .filter((x) => x.act > 0)
    .sort((a, b) => b.act - a.act)
    .slice(0, 5);
  setHTML($('topChannels'), channels.length ? channels.map((x) => `<div class="top-row">
        <span class="t" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</span>
        <span class="n">${fmt(x.act)}</span>
        ${stackBar(x)}
      </div>`).join('') : '<div class="empty">No channels yet.</div>');
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/** Read the stored (partial) settings, apply a change, save. Background reacts via storage.onChanged. */
async function updateStoredSettings(mutate) {
  const { settings: raw } = await chrome.storage.local.get('settings');
  const next = raw && typeof raw === 'object' ? structuredClone(raw) : {};
  mutate(next);
  await chrome.storage.local.set({ settings: next });
  setTimeout(fetchData, 300);
}

function setChannelRule(channel, target) {
  return updateStoredSettings((s) => {
    const norm = normalizeName(channel);
    const strip = (list) => (Array.isArray(list) ? list : []).filter((n) => normalizeName(n) !== norm);
    s.alwaysStudyChannels = strip(s.alwaysStudyChannels);
    s.alwaysFunChannels = strip(s.alwaysFunChannels);
    if (target === 'study') s.alwaysStudyChannels = uniqueList([...s.alwaysStudyChannels, channel]);
    if (target === 'fun') s.alwaysFunChannels = uniqueList([...s.alwaysFunChannels, channel]);
  });
}

function setVideoOverride(videoId, mode) {
  return updateStoredSettings((s) => {
    s.videoOverrides = s.videoOverrides && typeof s.videoOverrides === 'object' ? s.videoOverrides : {};
    if (mode) s.videoOverrides[videoId] = mode;
    else delete s.videoOverrides[videoId];
  });
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportCsv() {
  const v = buildView();
  const header = ['date', 'start', 'end', 'duration_seconds', 'mode', 'reason', 'title', 'channel', 'video_url', 'classification'];
  const lines = [header.join(',')];
  [...v.segments].sort((a, b) => a.start - b.start).forEach((s) => {
    lines.push([
      v.key, formatStamp(s.start), formatStamp(s.end), Math.round((s.end - s.start) / 1000),
      s.mode, s.reason, s.title, s.channel,
      s.videoId ? `https://www.youtube.com/watch?v=${s.videoId}` : '', s.why,
    ].map(csvCell).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `youtube-habits-${v.key}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const cur = state.live?.current;
  switch (btn.dataset.action) {
    case 'filter':
      state.filter = btn.dataset.filter;
      render();
      break;
    case 'video-study': if (cur?.videoId) setVideoOverride(cur.videoId, 'study'); break;
    case 'video-fun': if (cur?.videoId) setVideoOverride(cur.videoId, 'fun'); break;
    case 'video-auto': if (cur?.videoId) setVideoOverride(cur.videoId, null); break;
    case 'channel-study': if (cur?.channel) setChannelRule(cur.channel, 'study'); break;
    case 'channel-fun': if (cur?.channel) setChannelRule(cur.channel, 'fun'); break;
    case 'channel-clear': if (cur?.channel) setChannelRule(cur.channel, null); break;
    case 'export-csv': exportCsv(); break;
    case 'options': chrome.runtime.openOptionsPage(); break;
    default: break;
  }
});

$('prevDay').addEventListener('click', () => {
  state.viewKey = addDays(state.viewKey, -1);
  fetchData();
});
$('nextDay').addEventListener('click', () => {
  if (state.viewKey >= state.todayKey) return;
  state.viewKey = addDays(state.viewKey, 1);
  fetchData();
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

// Tells the background the popup is open (so the page losing focus to the popup isn't "idle").
chrome.runtime.connect({ name: 'popup' });

fetchData();
setInterval(() => { if (state.viewKey === state.todayKey) render(); }, 1000);
setInterval(fetchData, REFRESH_MS);
