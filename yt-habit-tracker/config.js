/**
 * config.js — YouTube Habit Tracker configuration
 * ================================================
 * THIS IS THE FILE TO EDIT if you want to customise classification in code.
 * After editing, open chrome://extensions and click the reload (↻) icon.
 *
 *  • ALWAYS_STUDY_CHANNELS / ALWAYS_FUN_CHANNELS are ALWAYS applied, merged
 *    with any channels you add from the popup or the Options page.
 *    Matching is case-insensitive and accepts either the display name
 *    ("Khan Academy") or the @handle ("@khanacademy").
 *    If a channel is in BOTH lists, Study wins.
 *
 *  • STUDY_KEYWORDS / FUN_KEYWORDS / CATEGORY_WEIGHTS are the starting values.
 *    Once you press "Save" on the Options page, the saved lists take
 *    precedence; press "Reset to defaults" there to pick up edits made here.
 *
 * How the score works (see classifier.js):
 *   + category weight (YouTube's own category, e.g. "Education" = +4)
 *   + 2 per study keyword in the title,  − 2 per fun keyword in the title
 *   + 2 per study keyword in the channel, − 2 per fun keyword in the channel
 *   + 1 per study keyword in the tags,   − 1 per fun keyword in the tags
 *   (each source counts at most 3 keyword hits)
 *   score > 0 → STUDY, score < 0 → FUN, score = 0 → the "tie breaker" setting.
 */

import { uniqueList } from './utils.js';

/* ------------------------------------------------------------------ */
/* 1. Channels that are ALWAYS Study (edit freely)                     */
/* ------------------------------------------------------------------ */
export const ALWAYS_STUDY_CHANNELS = [
  'Khan Academy',
  'CrashCourse',
  'freeCodeCamp.org',
  'MIT OpenCourseWare',
  '3Blue1Brown',
  'CS50',
  'Stanford Online',
  'The Organic Chemistry Tutor',
  'Programming with Mosh',
  'Traversy Media',
  'StatQuest with Josh Starmer',
  'NPTEL-NOC IITM',
  'TED-Ed',
];

/* ------------------------------------------------------------------ */
/* 2. Channels that are ALWAYS Fun (edit freely)                       */
/* ------------------------------------------------------------------ */
export const ALWAYS_FUN_CHANNELS = [
  'MrBeast',
  'PewDiePie',
  'Markiplier',
  'Dude Perfect',
  'CarryMinati',
  'Techno Gamerz',
  'BB Ki Vines',
];

/* ------------------------------------------------------------------ */
/* 3. Keywords (matched as whole words, with simple plural/-ing forms) */
/* ------------------------------------------------------------------ */
export const STUDY_KEYWORDS = [
  // generic learning words
  'tutorial', 'course', 'full course', 'crash course', 'lecture', 'lesson', 'class',
  'learn', 'study', 'explained', 'explanation', 'how to', 'guide', 'beginner',
  'masterclass', 'workshop', 'webinar', 'syllabus', 'notes', 'revision', 'exam',
  'practice problems', 'solved', 'derivation', 'proof', 'theory', 'concept',
  'documentation', 'docs', 'deep dive', 'interview prep', 'case study', 'research',
  'documentary', 'khan academy', 'mit', 'nptel', 'iit', 'university', 'professor',
  // subjects
  'math', 'mathematics', 'calculus', 'algebra', 'geometry', 'statistics', 'probability',
  'physics', 'chemistry', 'biology', 'economics', 'finance', 'accounting', 'history',
  'geography', 'grammar', 'vocabulary', 'english speaking',
  // tech
  'coding', 'programming', 'code', 'developer', 'software', 'computer science',
  'algorithm', 'data structures', 'dsa', 'leetcode', 'system design', 'python',
  'javascript', 'typescript', 'java', 'c++', 'rust', 'golang', 'react', 'node.js',
  'sql', 'database', 'linux', 'git', 'docker', 'kubernetes', 'aws', 'machine learning',
  'deep learning', 'neural network', 'data science', 'excel', 'api',
  // Indian exams
  'jee', 'neet', 'upsc', 'gate', 'cbse', 'icse', 'cat exam', 'ssc',
];

export const FUN_KEYWORDS = [
  'gameplay', 'gaming', "let's play", 'lets play', 'playthrough', 'speedrun',
  'funny', 'comedy', 'prank', 'meme', 'memes', 'vlog', 'reaction', 'reacts',
  'highlights', 'trailer', 'teaser', 'music video', 'official video', 'lyric video',
  'lyrics', 'song', 'remix', 'live stream', 'stream highlights', 'roast', 'challenge',
  'unboxing', 'mukbang', 'asmr', 'compilation', 'fails', 'movie', 'episode',
  'web series', 'stand-up', 'standup', 'sketch', 'shorts', 'tiktok', 'edit',
  'minecraft', 'fortnite', 'gta', 'bgmi', 'pubg', 'valorant', 'free fire', 'roblox',
  'cricket highlights', 'ipl', 'bigg boss', 'anime', 'cartoon',
];

/* ------------------------------------------------------------------ */
/* 4. YouTube's native category → score weight                          */
/*    (category names are fetched in English regardless of UI language) */
/* ------------------------------------------------------------------ */
export const CATEGORY_WEIGHTS = {
  'Education': 4,
  'Science & Technology': 3,
  'Howto & Style': 1,
  'News & Politics': 1,
  'Nonprofits & Activism': 1,
  'Gaming': -4,
  'Comedy': -4,
  'Entertainment': -3,
  'Music': -3,
  'Film & Animation': -3,
  'Sports': -2,
  'Shows': -2,
  'People & Blogs': -1,
  'Pets & Animals': -1,
  'Autos & Vehicles': -1,
  'Travel & Events': -1,
};

/* ------------------------------------------------------------------ */
/* 5. All user settings and their defaults                              */
/* ------------------------------------------------------------------ */
export const DEFAULT_SETTINGS = {
  studyKeywords: [...STUDY_KEYWORDS],
  funKeywords: [...FUN_KEYWORDS],
  /** Extra channels added from the popup/Options (merged with the lists above). */
  alwaysStudyChannels: [],
  alwaysFunChannels: [],
  categoryWeights: { ...CATEGORY_WEIGHTS },

  /** Seconds of no keyboard/mouse input before Chrome reports "idle" (min 15). */
  idleThresholdSec: 60,
  /**
   * 'strict' – as soon as the computer is idle, Study/Fun time stops and goes to Idle.
   * 'smart'  – if a video is actively playing in the foreground, keep counting it
   *            as watching for up to `passiveGraceMin` minutes of no input
   *            (useful for long lectures you watch without touching the mouse).
   *            A locked screen is always Idle.
   */
  idleHandling: 'strict',
  passiveGraceMin: 30,
  /** In strict mode, move the last `idleThresholdSec` seconds before idle was detected into Idle too. */
  retroactiveIdle: true,
  /** Treat "YouTube visible but another app/window has focus" as Idle. */
  unfocusedIsIdle: true,
  /** What a video with no strong signals counts as: 'fun' or 'study'. */
  tieBreaker: 'fun',
  /** How many days of history to keep. */
  retentionDays: 180,
  /** Per-video manual overrides: { videoId: 'study' | 'fun' }. */
  videoOverrides: {},
};

/** Clamp a value to an integer range, falling back when it is not a number. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Merge whatever is saved in chrome.storage.local ("settings") with the
 * defaults above, validate it, and add the merged channel lists
 * (allStudyChannels / allFunChannels) that the classifier actually uses.
 */
export function buildEffectiveSettings(stored) {
  const raw = stored && typeof stored === 'object' ? stored : {};
  const s = { ...DEFAULT_SETTINGS, ...raw };

  s.studyKeywords = Array.isArray(raw.studyKeywords) ? uniqueList(raw.studyKeywords) : [...STUDY_KEYWORDS];
  s.funKeywords = Array.isArray(raw.funKeywords) ? uniqueList(raw.funKeywords) : [...FUN_KEYWORDS];
  s.alwaysStudyChannels = Array.isArray(raw.alwaysStudyChannels) ? uniqueList(raw.alwaysStudyChannels) : [];
  s.alwaysFunChannels = Array.isArray(raw.alwaysFunChannels) ? uniqueList(raw.alwaysFunChannels) : [];
  s.categoryWeights = { ...CATEGORY_WEIGHTS, ...(raw.categoryWeights && typeof raw.categoryWeights === 'object' ? raw.categoryWeights : {}) };
  s.videoOverrides = raw.videoOverrides && typeof raw.videoOverrides === 'object' ? { ...raw.videoOverrides } : {};

  s.idleThresholdSec = clampInt(s.idleThresholdSec, 15, 3600, 60);
  s.passiveGraceMin = clampInt(s.passiveGraceMin, 1, 600, 30);
  s.retentionDays = clampInt(s.retentionDays, 7, 3650, 180);
  s.idleHandling = s.idleHandling === 'smart' ? 'smart' : 'strict';
  s.tieBreaker = s.tieBreaker === 'study' ? 'study' : 'fun';
  s.retroactiveIdle = s.retroactiveIdle !== false;
  s.unfocusedIsIdle = s.unfocusedIsIdle !== false;

  s.allStudyChannels = uniqueList([...ALWAYS_STUDY_CHANNELS, ...s.alwaysStudyChannels]);
  s.allFunChannels = uniqueList([...ALWAYS_FUN_CHANNELS, ...s.alwaysFunChannels]);
  return s;
}
