# YouTube Habit Tracker

A Chrome extension (Manifest V3) that tracks how your YouTube time splits into **Study**, **Fun**, and **Idle**. It logs the exact time each session starts and stops and shows where you spent more or less time. It never blocks, hides, or changes anything on YouTube.

<p align="center">
  <img src="popup.png" alt="Popup showing today's Study / Fun / Idle breakdown, insights and timeline" width="360">
</p>

<sub>Screenshot rendered from simulated data.</sub>

---

## Features

### Three time buckets

| Bucket | Counted when… |
|---|---|
| 🔵 **Study** | An educational or productive video is playing in a visible, focused tab (or Picture-in-Picture) and you're at the computer. |
| 🟠 **Fun** | An entertainment, gaming, music, or casual video is playing under the same conditions. |
| ⚪ **Idle** | A YouTube tab is open but the video is paused or ended, the tab is hidden or minimized, another window has focus, you're only browsing (no video playing), or Chrome reports the computer as **idle** or **locked**. |

Nothing is counted when no YouTube tab is open.

### Hybrid classification
Each video is classified as Study or Fun in this order of precedence:

1. **Manual per-video override:** one click in the popup.
2. **Always Study channels:** built-in list plus your own.
3. **Always Fun channels:** built-in list plus your own.
4. **Weighted score:**
   - YouTube's native category. For example, *Education* adds +4 and *Gaming* adds −4.
   - Study and fun keywords in the **title** (×2), **channel name** (×2), and **tags** (×1).
5. **Tie-breaker:** what to use when there's no clear signal (configurable, defaults to Fun).

The popup shows *why* each video was classified the way it was. For example: `category Education (+4) · title: python, explained (+4) · score +8`.

### Accurate timing
- Time comes from timestamps, not timer ticks, so it stays accurate when Manifest V3 suspends the service worker.
- Time is split exactly at hour boundaries and at midnight.
- The `chrome.idle` API detects when you walk away. After 60 seconds without input (configurable), Study and Fun stop immediately and that time goes to Idle. Those 60 seconds are also moved back from Study/Fun into Idle, since that's when you actually stopped.
- If no signal arrives for more than 90 seconds (browser closed, laptop asleep), the session is closed at the last confirmed moment instead of guessing.

### Reports
- **Live status:** what's being counted right now, since what time, and for which video.
- **Donut chart** with exact `h / m / s` totals for Study, Fun, and Idle.
- **Comparison** with yesterday and your 7-day average.
- **Insights:**
  - Peak hour for Study, Fun, and Idle; heaviest and lightest hour.
  - Longest study session, fun binge, and idle stretch, each with start → end times.
  - Your most common idle cause.
  - How often you switched between Study and Fun.
  - Top study and fun channels.
- **Day timeline** and **minutes-per-hour** stacked bar chart. Hover over either for exact times.
- **Start / stop log:** every segment with exact timestamps, duration, video, channel, and reason. You can filter it by mode.
- **Top videos and channels** for the day.
- **History:** browse previous days with ‹ ›. Data is stored in `chrome.storage.local` and survives browser restarts.
- **Export:** one day as CSV from the popup, or all data as JSON from Settings.
- **Toolbar badge:** `S`, `F`, or `I` shows the current mode at a glance.

---

## Installation

The extension isn't on the Chrome Web Store, so you load it unpacked:

1. Download or clone this repository:
   ```bash
   git clone https://github.com/<your-username>/yt-habit-tracker.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin the extension: click the puzzle-piece icon in the toolbar, then click the pin next to **YouTube Habit Tracker**.
6. Play a YouTube video and click the icon to see your report.

Requires Chrome 116 or newer.

> **Updating:** after you edit any file, click the ↻ reload icon on the extension's card in `chrome://extensions`. Your history is kept.
> Chrome runs the extension from the folder you loaded, so don't move or delete it.

---

## Customizing

### Option 1: the Settings page (no code)
Right-click the toolbar icon and choose **Options**, or click **Settings** in the popup. From there you can:

- Edit Study and Fun keyword lists.
- Add Always Study and Always Fun channels (display name such as `Khan Academy`, or @handle such as `@khanacademy`).
- Adjust category weights and the tie-breaker.
- Change idle detection: threshold, strict or smart mode, back-dating, and whether an unfocused window counts as idle.
- Test the classifier on any title, channel, category, and tags.
- Manage per-video overrides, set the history retention period, export data, or delete history.

You can also mark the **current video** or **current channel** as Study or Fun straight from the popup.

### Option 2: edit `config.js`
All defaults live at the top of [`config.js`](config.js):

```js
export const ALWAYS_STUDY_CHANNELS = [
  'Khan Academy',
  'freeCodeCamp.org',
  '3Blue1Brown',
  // add yours here
];

export const ALWAYS_FUN_CHANNELS = [
  'MrBeast',
  // add yours here
];

export const STUDY_KEYWORDS = ['tutorial', 'course', 'lecture', 'coding', /* … */];
export const FUN_KEYWORDS   = ['gameplay', 'funny', 'vlog', 'reaction', /* … */];
export const CATEGORY_WEIGHTS = { 'Education': 4, 'Gaming': -4, /* … */ };
```

- Channel lists from `config.js` are **always** merged with the ones you add in Settings. If a channel appears in both the Study and Fun lists, Study wins.
- Keywords and category weights are only the **starting values**. Once you save from the Settings page, the saved lists take over. Click **Reset form to defaults** there, then **Save settings**, to pick up later edits to `config.js`.

### Strict vs. smart idle
- **Strict** (default): 60 seconds without keyboard or mouse input switches you to Idle, even while a video is playing.
- **Smart:** a video playing in the foreground keeps counting for up to 30 minutes without input (configurable). This suits long lectures you watch hands-off.

A locked screen always counts as Idle in both modes.

---

## Project structure

```
yt-habit-tracker/
├── manifest.json     # Extension manifest (MV3): permissions, scripts, popup, options
├── background.js     # Service worker: time accounting, segment log, idle handling, badge
├── content.js        # Runs on YouTube: reads player state, title, channel, category & tags
├── classifier.js     # Study/Fun decision logic (shared by background and options)
├── config.js         # ✏️  Channel lists, keywords, category weights, default settings
├── utils.js          # Shared helpers: date keys, duration/time formatting, list parsing
├── popup.html        # Report UI layout and styles
├── popup.js          # Report UI logic: charts, insights, log, CSV export
├── options.html      # Settings page layout
├── options.js        # Settings page logic
├── icons/            # Toolbar icons (16, 32, 48, 128 px)
└── docs/popup.png    # Screenshot for this README (not used by the extension)
```

### How tracking works
1. **`content.js`** sends a heartbeat every 5 seconds. It also sends one immediately on play, pause, ended, tab visibility or focus changes, and YouTube's in-page navigation. Each heartbeat reports whether a video is playing, whether the tab is visible and focused, and the video's ID, title, channel, category, and tags. It reads the category and tags once per video from the watch page's own player data, in English so the category names match.
2. **`background.js`** keeps one open *segment* (`mode`, `start`, `lastTick`, video info) persisted in storage. On every event it:
   1. credits `now − lastTick` to the current mode, split at hour boundaries;
   2. works out what you're doing now;
   3. if that changed, closes the segment into the day's log with exact start and end times, then opens a new one.
3. A 30-second `chrome.alarms` tick keeps totals moving even when Chrome throttles background tabs.
4. All state changes run through a serial queue, so concurrent messages never overwrite each other's storage writes.

### Stored data
Everything stays in `chrome.storage.local` on your machine. One record is kept per day under `day:YYYY-MM-DD`:

| Field | Contents |
|---|---|
| `totals` | Milliseconds of Study, Fun, and Idle for the day |
| `hours` | 24 hourly buckets of the same |
| `segments` | `{ start, end, mode, reason, videoId, title, channel, why }` |
| `videos` | Per-video time by mode |
| `channels` | Per-channel time by mode |

History older than the retention period (default 180 days) is deleted automatically.

---

## Permissions

| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Save settings and daily history locally |
| `idle` | Detect when the computer is idle or locked |
| `alarms` | Periodic tick that keeps timing accurate when the service worker sleeps |
| `scripting` | Inject the tracker into YouTube tabs that were already open when the extension was installed |
| `host_permissions`: `youtube.com` | Read player state and video info on YouTube pages |

**Privacy:** the extension makes no network requests except to YouTube itself, to read a video's category and tags. It has no analytics, no tracking, and no outside servers. Your data never leaves your browser unless you export it.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Manifest file is missing or unreadable" | You selected the wrong folder. Pick the one that has `manifest.json` directly inside it. Unzipping often creates a folder inside another folder with the same name. |
| Red **Errors** button on the extension card | Click it to see the message. Make sure every file from the project structure is in the folder. |
| A YouTube tab isn't being counted | Refresh the tab. Tabs open before install are picked up automatically, but a reload is the quickest fix. |
| A video is in the wrong bucket | Use **Video is Study / Fun** or **Always Study / Fun channel** in the popup, or add keywords in Settings. |
| Long lectures show up as Idle | Switch idle detection to **Smart** in Settings. |
| Watching on a second monitor counts as Idle | In Settings, turn off **Count "YouTube visible but another window focused" as Idle**. |

---

## Limitations
- YouTube changes its page structure often. Every page lookup has fallbacks, but channel or title detection may occasionally need updating in `content.js`.
- Classification is keyword- and category-based, not AI. Edge cases are what the per-video and per-channel overrides are for.
- Data is stored per browser profile and isn't synced across devices.
- Edited keywords and settings apply from the moment you save. Past time isn't re-labelled.

## License
MIT. Use it, fork it, change it.
