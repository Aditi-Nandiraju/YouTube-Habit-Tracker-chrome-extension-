/**
 * content.js — YouTube Habit Tracker page observer
 * ================================================
 * Runs on youtube.com / m.youtube.com in Chrome's isolated world. It never
 * changes the page or blocks anything; it only *reads*:
 *   • whether the main video is playing, paused or ended
 *   • whether the tab is visible, focused, or in Picture-in-Picture
 *   • video id, title, channel name and @handle
 *   • YouTube's native category and tags (fetched once per video from the
 *     watch page's embedded player data, in English so category names match)
 *
 * It reports this to background.js as a "heartbeat" every 5 seconds and
 * immediately (debounced 250 ms) whenever something changes.
 *
 * YouTube is a single-page app and changes its markup often, so every DOM
 * lookup has several fallbacks, and the fetched metadata wins over the DOM
 * whenever it is available.
 */
(() => {
  'use strict';

  // If the extension is reloaded, a fresh copy of this script is injected.
  // The newest copy claims this token; older copies notice and stop.
  const TOKEN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.__ytHabitTrackerToken = TOKEN;

  const HEARTBEAT_MS = 5000;
  const SEND_DEBOUNCE_MS = 250;
  const META_FETCH_DELAY_MS = 1500;   // wait before fetching metadata (skip fast Shorts swipes)
  const META_CACHE_LIMIT = 150;

  // Inline hover-previews on the home page must never count as watching.
  const PREVIEW_CONTAINERS = [
    'ytd-video-preview',
    '#video-preview',
    '#inline-preview-player',
    'ytd-thumbnail',
    'ytd-rich-grid-media',
    'ytd-compact-video-renderer',
    'ytm-media-item',
  ].join(', ');

  const TITLE_SELECTORS = {
    watch: [
      'ytd-watch-metadata #title h1',
      'ytd-watch-metadata h1',
      'h1.title.ytd-video-primary-info-renderer',
      'ytm-slim-video-metadata-section-renderer h2',
      '.slim-video-metadata-header h2',
    ],
    shorts: [
      'ytd-reel-video-renderer[is-active] h2',
      'ytd-reel-video-renderer[is-active] .title',
      'yt-shorts-video-title-view-model h2',
      'ytm-shorts-player-overlay-renderer h2',
    ],
    browse: [
      'ytd-miniplayer .miniplayer-title',
      'ytd-miniplayer #video-title',
      'ytd-miniplayer h1',
    ],
  };

  const CHANNEL_SELECTORS = {
    watch: [
      'ytd-watch-metadata ytd-channel-name a',
      '#owner ytd-channel-name a',
      'ytd-video-owner-renderer #channel-name a',
      '#upload-info ytd-channel-name a',
      'ytm-slim-owner-renderer .slim-owner-channel-name',
      '.slim-owner-channel-name',
    ],
    shorts: [
      'ytd-reel-video-renderer[is-active] ytd-channel-name a',
      'ytd-reel-video-renderer[is-active] .ytReelChannelBarViewModelChannelName a',
      'ytd-reel-video-renderer[is-active] #channel-name a',
      'ytd-reel-video-renderer[is-active] a[href^="/@"]',
      'ytm-reel-player-overlay-renderer a[href^="/@"]',
    ],
    browse: [
      'ytd-miniplayer #channel-name',
      'ytd-miniplayer .miniplayer-channel',
    ],
  };

  const HANDLE_SELECTORS = {
    watch: [
      'ytd-watch-metadata ytd-channel-name a',
      '#owner a[href^="/@"]',
      'ytd-video-owner-renderer a[href^="/@"]',
      'ytm-slim-owner-renderer a[href^="/@"]',
    ],
    shorts: [
      'ytd-reel-video-renderer[is-active] a[href^="/@"]',
      'ytm-reel-player-overlay-renderer a[href^="/@"]',
    ],
    browse: [],
  };

  const metaCache = new Map();       // videoId -> { title, author, handle, category, keywords }
  const metaPending = new Set();     // videoIds being fetched
  const metaTimers = new Map();      // videoId -> delayed-fetch timer
  let stopped = false;
  let heartbeatTimer = null;
  let debounceTimer = null;

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  function isCurrentInstance() {
    try {
      return window.__ytHabitTrackerToken === TOKEN && !!chrome.runtime?.id;
    } catch {
      return false; // "Extension context invalidated"
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    clearTimeout(debounceTimer);
    metaTimers.forEach((t) => clearTimeout(t));
    metaTimers.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Page inspection                                                   */
  /* ---------------------------------------------------------------- */

  function pageType() {
    const p = location.pathname;
    if (p === '/watch') return 'watch';
    if (p.startsWith('/shorts/')) return 'shorts';
    if (p.startsWith('/live/')) return 'watch';
    return 'browse';
  }

  function videoIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{6,})/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  /** On non-watch pages a playing video is the miniplayer; try to read its id. */
  function miniplayerVideoId() {
    const link = document.querySelector('ytd-miniplayer a[href*="watch?v="], ytd-miniplayer [href*="watch?v="]');
    if (!link) return null;
    try {
      return new URL(link.getAttribute('href'), location.origin).searchParams.get('v');
    } catch {
      return null;
    }
  }

  /** The video element of the real player (never a hover preview). */
  function findMainVideo(type) {
    const ok = (v) => v && !v.closest(PREVIEW_CONTAINERS);
    if (type === 'shorts') {
      const active = document.querySelector('ytd-reel-video-renderer[is-active] video, #shorts-player video');
      if (ok(active)) return active;
      return Array.from(document.querySelectorAll('video')).find((v) => ok(v) && !v.paused) || null;
    }
    if (type === 'browse') {
      // Only the main player (which becomes the miniplayer) counts on browse pages.
      const mini = document.querySelector('ytd-miniplayer video, #movie_player video');
      return ok(mini) ? mini : null;
    }
    const main = document.querySelector('#movie_player video.html5-main-video, #player video.html5-main-video, video.html5-main-video');
    if (ok(main)) return main;
    const all = Array.from(document.querySelectorAll('video')).filter(ok);
    return all.find((v) => !v.paused) || all[0] || null;
  }

  function firstText(selectors) {
    for (const sel of selectors || []) {
      const el = document.querySelector(sel);
      const text = el?.textContent?.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return '';
  }

  function firstHandle(selectors) {
    for (const sel of selectors || []) {
      const href = document.querySelector(sel)?.getAttribute('href') || '';
      const m = href.match(/\/(@[^/?#]+)/);
      if (m) {
        try { return decodeURIComponent(m[1]); } catch { return m[1]; }
      }
    }
    return '';
  }

  /** document.title without the "(3) " notification count and " - YouTube" suffix. */
  function cleanDocTitle() {
    const t = document.title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*-\s*YouTube$/i, '').trim();
    return /^youtube$/i.test(t) ? '' : t;
  }

  /* ---------------------------------------------------------------- */
  /* Native category & tags (fetched once per video)                   */
  /* ---------------------------------------------------------------- */

  const JSON_STRING_BODY = '((?:[^"\\\\]|\\\\.)*)';

  function decodeJsonString(raw) {
    try { return JSON.parse(`"${raw}"`); } catch { return raw; }
  }

  function grab(text, key) {
    if (!text) return '';
    const m = text.match(new RegExp(`"${key}":"${JSON_STRING_BODY}"`));
    return m ? decodeJsonString(m[1]) : '';
  }

  /** Extract metadata from the watch page's embedded ytInitialPlayerResponse. */
  function parseWatchHtml(html, videoId) {
    const start = html.indexOf(`"videoDetails":{"videoId":"${videoId}"`);
    const details = start >= 0 ? html.slice(start, start + 80000) : '';
    const channelIdx = details.indexOf('"channelId"');
    const head = channelIdx > 0 ? details.slice(0, channelIdx) : details.slice(0, 4000);

    let keywords = [];
    const km = head.match(/"keywords":\[((?:"(?:[^"\\]|\\.)*",?)*)\]/);
    if (km) {
      try { keywords = JSON.parse(`[${km[1]}]`).slice(0, 50).map(String); } catch { keywords = []; }
    }

    const microStart = html.indexOf('"playerMicroformatRenderer"');
    const micro = microStart >= 0 ? html.slice(microStart, microStart + 150000) : '';
    const profileUrl = grab(micro, 'ownerProfileUrl');
    const handleMatch = profileUrl.match(/\/(@[^/?#]+)/);

    let handle = '';
    if (handleMatch) {
      try { handle = decodeURIComponent(handleMatch[1]); } catch { handle = handleMatch[1]; }
    }

    return {
      title: grab(details, 'title'),
      author: grab(details, 'author'),
      handle,
      category: grab(micro, 'category') || grab(html, 'category'),
      keywords,
    };
  }

  function rememberMeta(videoId, meta) {
    if (metaCache.size >= META_CACHE_LIMIT) metaCache.delete(metaCache.keys().next().value);
    metaCache.set(videoId, meta);
  }

  async function fetchMeta(videoId) {
    if (stopped || metaPending.has(videoId) || metaCache.has(videoId)) return;
    metaPending.add(videoId);
    try {
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}&hl=en`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      rememberMeta(videoId, parseWatchHtml(html, videoId));
    } catch (err) {
      // Don't retry endlessly; fall back to DOM scraping for this video.
      rememberMeta(videoId, { failed: true });
    } finally {
      metaPending.delete(videoId);
    }
    scheduleSend();
  }

  /** Fetch metadata only for a video that stays current for a moment. */
  function requestMetaSoon(videoId) {
    if (!videoId || metaCache.has(videoId) || metaPending.has(videoId) || metaTimers.has(videoId)) return;
    const timer = setTimeout(() => {
      metaTimers.delete(videoId);
      const stillCurrent = videoIdFromUrl() === videoId || miniplayerVideoId() === videoId;
      if (stillCurrent) fetchMeta(videoId);
    }, META_FETCH_DELAY_MS);
    metaTimers.set(videoId, timer);
  }

  /* ---------------------------------------------------------------- */
  /* Build the state report                                            */
  /* ---------------------------------------------------------------- */

  function buildState() {
    const type = pageType();
    const video = findMainVideo(type);
    const hasSource = !!(video && (video.currentSrc || video.src) && video.readyState > 0);
    const playing = !!(hasSource && !video.paused && !video.ended && video.playbackRate > 0);
    const onPlayerPage = type !== 'browse';
    const hasVideo = hasSource && (onPlayerPage || playing);

    let videoId = videoIdFromUrl();
    if (!videoId && hasVideo) videoId = miniplayerVideoId();

    const meta = videoId ? metaCache.get(videoId) : null;
    if (videoId && !meta && hasVideo) requestMetaSoon(videoId);
    const good = meta && !meta.failed ? meta : null;

    // After SPA navigation the old video's channel can linger in the DOM for a
    // moment. ytd-watch-flexy[video-id] tells us whether the DOM is up to date.
    const flexy = document.querySelector('ytd-watch-flexy');
    const domFresh = type !== 'watch' || !flexy || flexy.getAttribute('video-id') === videoId;

    const title =
      good?.title ||
      (type === 'browse' ? firstText(TITLE_SELECTORS.browse) : cleanDocTitle()) ||
      (domFresh ? firstText(TITLE_SELECTORS[type]) : '');
    const channel = good?.author || (domFresh ? firstText(CHANNEL_SELECTORS[type]) : '');
    const handle = good?.handle || (domFresh ? firstHandle(HANDLE_SELECTORS[type]) : '');
    const pip = !!document.pictureInPictureElement;

    return {
      url: location.href,
      pageType: type,
      videoId: hasVideo ? videoId : null,
      title: hasVideo ? title : '',
      channel: hasVideo ? channel : '',
      handle: hasVideo ? handle : '',
      category: good?.category || '',
      keywords: good?.keywords || [],
      hasVideo,
      playing,
      ended: !!(video && video.ended),
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
      pip,
      isAd: !!document.querySelector('.html5-video-player.ad-showing'),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Messaging                                                         */
  /* ---------------------------------------------------------------- */

  function send(type = 'heartbeat') {
    if (stopped) return;
    if (!isCurrentInstance()) {
      stop();
      return;
    }
    const payload = type === 'heartbeat' ? { type, state: buildState() } : { type };
    try {
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      stop(); // extension was reloaded or removed
    }
  }

  function scheduleSend() {
    if (stopped) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => send('heartbeat'), SEND_DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------- */
  /* Event listeners                                                   */
  /* ---------------------------------------------------------------- */

  // Media events don't bubble, but capture-phase listeners on document still see them,
  // so this keeps working when YouTube swaps out the <video> element.
  const MEDIA_EVENTS = [
    'play', 'playing', 'pause', 'ended', 'emptied', 'loadeddata', 'ratechange', 'seeked',
    'enterpictureinpicture', 'leavepictureinpicture',
  ];
  for (const ev of MEDIA_EVENTS) document.addEventListener(ev, scheduleSend, true);

  document.addEventListener('visibilitychange', scheduleSend);
  window.addEventListener('focus', scheduleSend);
  window.addEventListener('blur', scheduleSend);
  document.addEventListener('yt-navigate-finish', scheduleSend);
  document.addEventListener('yt-page-data-updated', scheduleSend);
  window.addEventListener('popstate', scheduleSend);
  window.addEventListener('pageshow', (e) => { if (e.persisted) scheduleSend(); });
  window.addEventListener('pagehide', () => send('bye'));

  heartbeatTimer = setInterval(() => send('heartbeat'), HEARTBEAT_MS);
  send('heartbeat');
})();
