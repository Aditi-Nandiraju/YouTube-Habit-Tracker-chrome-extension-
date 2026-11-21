/**
 * options.js — Settings page for YouTube Habit Tracker
 * ----------------------------------------------------
 * Loads the effective settings, lets the user edit them, and saves the full
 * settings object to chrome.storage.local ("settings"). The background
 * worker listens for that change and applies it immediately.
 */

import {
  DEFAULT_SETTINGS, ALWAYS_STUDY_CHANNELS, ALWAYS_FUN_CHANNELS, CATEGORY_WEIGHTS,
  buildEffectiveSettings,
} from './config.js';
import { classifyVideo } from './classifier.js';
import { MODE_META, parseList, parseLines, escapeHtml } from './utils.js';

const $ = (id) => document.getElementById(id);
let toastTimer = null;

function toast(text) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 3500);
}

function weightsToText(weights) {
  return Object.entries(weights).map(([k, w]) => `${k} = ${w}`).join('\n');
}

function textToWeights(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(.+?)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** Put an effective-settings object into the form. */
function fillForm(s) {
  $('studyKeywords').value = s.studyKeywords.join('\n');
  $('funKeywords').value = s.funKeywords.join('\n');
  $('alwaysStudyChannels').value = s.alwaysStudyChannels.join('\n');
  $('alwaysFunChannels').value = s.alwaysFunChannels.join('\n');
  $('categoryWeights').value = weightsToText(s.categoryWeights);
  $('tieBreaker').value = s.tieBreaker;
  $('idleThresholdSec').value = s.idleThresholdSec;
  $('idleHandling').value = s.idleHandling;
  $('passiveGraceMin').value = s.passiveGraceMin;
  $('retroactiveIdle').checked = s.retroactiveIdle;
  $('unfocusedIsIdle').checked = s.unfocusedIsIdle;
  $('retentionDays').value = s.retentionDays;
  syncGraceField();
}

/** Read the form into a settings object (overrides are kept separately). */
function readForm(videoOverrides = {}) {
  return {
    studyKeywords: parseList($('studyKeywords').value),
    funKeywords: parseList($('funKeywords').value),
    alwaysStudyChannels: parseLines($('alwaysStudyChannels').value),
    alwaysFunChannels: parseLines($('alwaysFunChannels').value),
    categoryWeights: textToWeights($('categoryWeights').value),
    tieBreaker: $('tieBreaker').value,
    idleThresholdSec: Number($('idleThresholdSec').value),
    idleHandling: $('idleHandling').value,
    passiveGraceMin: Number($('passiveGraceMin').value),
    retroactiveIdle: $('retroactiveIdle').checked,
    unfocusedIsIdle: $('unfocusedIsIdle').checked,
    retentionDays: Number($('retentionDays').value),
    videoOverrides,
  };
}

function syncGraceField() {
  const smart = $('idleHandling').value === 'smart';
  $('passiveGraceMin').disabled = !smart;
  $('retroactiveIdle').disabled = smart;
}

function renderBuiltins() {
  $('builtinStudy').innerHTML = `<b>Built-in (config.js):</b> ${escapeHtml(ALWAYS_STUDY_CHANNELS.join(', ') || 'none')}`;
  $('builtinFun').innerHTML = `<b>Built-in (config.js):</b> ${escapeHtml(ALWAYS_FUN_CHANNELS.join(', ') || 'none')}`;
}

function renderOverrides(overrides) {
  const entries = Object.entries(overrides || {});
  $('overrides').innerHTML = entries.length
    ? entries.map(([id, mode]) => `<div class="ov-row">
        <span><span class="chip" style="--c:${MODE_META[mode]?.color || 'gray'}">${escapeHtml(MODE_META[mode]?.label || mode)}</span>
        <a href="https://www.youtube.com/watch?v=${encodeURIComponent(id)}" target="_blank" rel="noopener"><code>${escapeHtml(id)}</code></a></span>
        <button class="btn" data-remove="${escapeHtml(id)}">Remove</button>
      </div>`).join('')
    : '<span class="muted">No overrides yet.</span>';
}

async function load() {
  const { settings: raw } = await chrome.storage.local.get('settings');
  const s = buildEffectiveSettings(raw);
  fillForm(s);
  renderOverrides(s.videoOverrides);
  renderBuiltins();
}

async function save() {
  const { settings: raw } = await chrome.storage.local.get('settings');
  const overrides = raw?.videoOverrides && typeof raw.videoOverrides === 'object' ? raw.videoOverrides : {};
  const next = readForm(overrides);
  if (!next.studyKeywords.length && !next.funKeywords.length) {
    toast('Add at least one keyword before saving.');
    return;
  }
  // Validate/clamp through the same function the background uses, then store the clean values.
  const clean = buildEffectiveSettings(next);
  const toStore = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) toStore[key] = clean[key];
  await chrome.storage.local.set({ settings: toStore });
  fillForm(clean);
  toast('Saved ✓ — tracking uses the new settings now.');
}

function resetForm() {
  const s = buildEffectiveSettings({});
  fillForm(s);
  $('categoryWeights').value = weightsToText(CATEGORY_WEIGHTS);
  toast('Defaults loaded into the form — press Save to apply.');
}

function testClassifier() {
  const s = buildEffectiveSettings(readForm({}));
  const info = {
    title: $('tTitle').value,
    channel: $('tChannel').value,
    handle: $('tChannel').value.trim().startsWith('@') ? $('tChannel').value.trim() : '',
    category: $('tCategory').value.trim(),
    keywords: parseList($('tTags').value),
  };
  const r = classifyVideo(info, s);
  $('testResult').innerHTML = `<span class="chip" style="--c:${MODE_META[r.mode].color}">${MODE_META[r.mode].label}</span>
    <span class="muted" style="margin-left:8px">${escapeHtml(r.why)}</span>`;
}

async function exportAll() {
  const all = await chrome.storage.local.get(null);
  delete all.runtime;
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `youtube-habits-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function clearAll() {
  if (!confirm('Delete ALL tracked YouTube history? Settings are kept. This cannot be undone.')) return;
  const res = await chrome.runtime.sendMessage({ type: 'clearData' });
  toast(res?.ok ? `Deleted ${res.removed} day${res.removed === 1 ? '' : 's'} of history.` : 'Could not clear data.');
}

async function removeOverride(id) {
  const { settings: raw } = await chrome.storage.local.get('settings');
  const next = raw && typeof raw === 'object' ? { ...raw } : {};
  next.videoOverrides = { ...(next.videoOverrides || {}) };
  delete next.videoOverrides[id];
  await chrome.storage.local.set({ settings: next });
  renderOverrides(next.videoOverrides);
  toast('Override removed.');
}

$('saveBtn').addEventListener('click', save);
$('resetBtn').addEventListener('click', resetForm);
$('testBtn').addEventListener('click', testClassifier);
$('exportBtn').addEventListener('click', exportAll);
$('clearBtn').addEventListener('click', clearAll);
$('idleHandling').addEventListener('change', syncGraceField);
$('overrides').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (btn) removeOverride(btn.dataset.remove);
});

// Keep the overrides list current if the popup changes it while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    renderOverrides(changes.settings.newValue?.videoOverrides || {});
  }
});

load();
