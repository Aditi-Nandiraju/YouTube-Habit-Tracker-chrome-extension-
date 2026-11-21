/**
 * classifier.js — Hybrid Study/Fun classifier
 * -------------------------------------------
 * Order of precedence:
 *   1. Manual per-video override (set from the popup)
 *   2. "Always Study" channel list   (config.js + Options + popup)
 *   3. "Always Fun" channel list
 *   4. Weighted score: YouTube category + keyword hits in title, channel and tags
 *   5. Tie → settings.tieBreaker
 *
 * Shared by background.js (live tracking) and options.js (the test box).
 */

import { normalizeName } from './utils.js';

/** Optional suffixes so "lecture" also matches "lectures", "learn" matches "learning", etc. */
const SUFFIX = '(?:s|es|ed|ing|er|ers)?';
const matcherCache = new Map();

/** Build (and cache) a matcher function for one keyword. */
function keywordMatcher(keyword) {
  const kw = normalizeName(keyword);
  if (!kw) return null;
  if (matcherCache.has(kw)) return matcherCache.get(kw);

  let matcher;
  if (/^[\x20-\x7e]+$/.test(kw)) {
    // Plain ASCII keyword: match it as a whole word/phrase.
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}${SUFFIX}(?=$|[^a-z0-9])`);
    matcher = (text) => re.test(text);
  } else {
    // Non-ASCII keyword (e.g. Hindi): word boundaries are unreliable, use substring.
    matcher = (text) => text.includes(kw);
  }
  matcherCache.set(kw, matcher);
  return matcher;
}

/** Return up to `limit` distinct keywords from `keywords` that appear in `text`. */
export function keywordHits(keywords, text, limit = 3) {
  const haystack = normalizeName(text);
  if (!haystack) return [];
  const hits = [];
  for (const keyword of keywords || []) {
    const match = keywordMatcher(keyword);
    if (match && match(haystack) && !hits.includes(keyword)) {
      hits.push(keyword);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** True if a channel (by display name or @handle) is in a list of names/handles. */
export function channelMatches(list, channel, handle) {
  const name = normalizeName(channel);
  const h = normalizeName(handle);
  if (!name && !h) return false;
  return (list || []).some((entry) => {
    const n = normalizeName(entry);
    if (!n) return false;
    const asHandle = n.startsWith('@') ? n : `@${n.replace(/\s+/g, '')}`;
    return n === name || (!!h && asHandle === h);
  });
}

/**
 * Classify a video.
 * @param {{videoId?:string,title?:string,channel?:string,handle?:string,category?:string,keywords?:string[]}} info
 * @param {object} s  effective settings from buildEffectiveSettings()
 * @returns {{mode:'study'|'fun', why:string, score:number}}
 */
export function classifyVideo(info, s) {
  const override = info.videoId ? s.videoOverrides?.[info.videoId] : null;
  if (override === 'study' || override === 'fun') {
    return { mode: override, why: 'Manual override for this video', score: override === 'study' ? 99 : -99 };
  }
  if (channelMatches(s.allStudyChannels, info.channel, info.handle)) {
    return { mode: 'study', why: '"Always Study" channel', score: 99 };
  }
  if (channelMatches(s.allFunChannels, info.channel, info.handle)) {
    return { mode: 'fun', why: '"Always Fun" channel', score: -99 };
  }

  let score = 0;
  const why = [];

  // 1) YouTube's own category
  const category = (info.category || '').trim();
  const weight = category ? Number(s.categoryWeights?.[category]) : NaN;
  if (Number.isFinite(weight) && weight !== 0) {
    score += weight;
    why.push(`category ${category} (${weight > 0 ? '+' : ''}${weight})`);
  } else if (category) {
    why.push(`category ${category} (0)`);
  }

  // 2) Keywords in title (×2), channel name (×2) and tags (×1)
  const tags = Array.isArray(info.keywords) ? info.keywords.join(' | ') : '';
  const sources = [
    { label: 'title', text: info.title || '', weight: 2 },
    { label: 'channel', text: info.channel || '', weight: 2 },
    { label: 'tags', text: tags, weight: 1 },
  ];
  for (const src of sources) {
    const studyHits = keywordHits(s.studyKeywords, src.text);
    const funHits = keywordHits(s.funKeywords, src.text);
    if (studyHits.length) {
      score += studyHits.length * src.weight;
      why.push(`${src.label}: ${studyHits.join(', ')} (+${studyHits.length * src.weight})`);
    }
    if (funHits.length) {
      score -= funHits.length * src.weight;
      why.push(`${src.label}: ${funHits.join(', ')} (−${funHits.length * src.weight})`);
    }
  }

  let mode;
  if (score > 0) mode = 'study';
  else if (score < 0) mode = 'fun';
  else {
    mode = s.tieBreaker === 'study' ? 'study' : 'fun';
    why.push(`no clear signal → default ${mode}`);
  }
  why.push(`score ${score > 0 ? '+' : ''}${score}`);
  return { mode, why: why.join(' · '), score };
}
