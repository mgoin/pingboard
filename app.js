"use strict";
/*
 * Pingboard — a keyboard-first triage console for GitHub notifications.
 *
 * Single classic script on purpose: no build step, works from file:// and any
 * static host. Sections below:
 *   1. constants + utils          5. notifications fetch / enrich / poll
 *   2. icons                      6. tracked threads (priority watchlist)
 *   3. state + persistence        7. actions, undo queue, bulk ops
 *   4. github api                 8. rendering
 *                                 9. keyboard + boot
 */

/* ── 1. constants + utils ──────────────────────────────────────────────── */

const STORAGE_KEY = "pingboard.githubToken";
const SESSION_KEY = "pingboard.sessionToken";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 50;          // notifications endpoint caps per_page at 50
const MAX_PAGES = 4;           // initial fetch; "Load more" extends
const HARD_MAX_PAGES = 12;
const ENRICH_CONCURRENCY = 6;
const UNDO_DELAY = 5000;       // ms before queued actions commit to GitHub
const CACHE_LIMIT = 600;       // enrichment cache entries kept in localStorage
const TRACKED_STALE_MS = 4 * 60 * 1000;
const CLOCK_TICK_MS = 60 * 1000;

const KNOWN_BOTS = new Set([
  "dependabot", "dependabot-preview", "github-actions", "renovate",
  "codecov", "codecov-commenter", "coderabbitai", "vercel", "netlify",
  "pre-commit-ci", "mergify", "stale", "allcontributors", "snyk-bot",
  "sonarqubecloud", "greenkeeper", "copilot", "github-advanced-security"
]);
const BOT_TITLE_RE = /^(\[dependabot\]|bump\s.+\sfrom\s|build\(deps(?:-dev)?\)|chore\(deps(?:-dev)?\))/i;

const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* quota/private mode: run memory-only */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
};

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child);
  }
  return node;
}

function button({ className = "icon-button", label, title, iconName, pressed, onClick, text, kbdHint }) {
  const children = [];
  if (iconName) children.push(icon(iconName));
  if (text) children.push(el("span", { text }));
  if (kbdHint) children.push(el("kbd", { text: kbdHint }));
  return el("button", {
    class: className,
    type: "button",
    title: title || label,
    "aria-label": label,
    "aria-pressed": pressed === undefined ? undefined : String(pressed),
    onclick: onClick
  }, children);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function fmtAgoShort(value) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  const units = [["y", 31536000], ["mo", 2592000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]];
  for (const [unit, size] of units) {
    const amount = Math.floor(seconds / size);
    if (amount >= 1) return `${amount}${unit}`;
  }
  return "now";
}

function fmtAgoLong(value) {
  if (!value) return "unknown";
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) {
    const amount = Math.floor(seconds / size);
    if (amount >= 1) return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

function textFromMarkdown(input = "") {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionRegex(login) {
  return new RegExp(`(^|[^\\w-])@${escapeRegExp(login)}\\b`, "i");
}

function subjectNumber(notification) {
  const match = (notification.subject?.url || "").match(/\/(?:pulls|issues)\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function repoOf(notification) {
  return notification.repository?.full_name || "unknown";
}

function threadKey(repo, number) {
  return `${repo}#${number}`;
}

function fallbackOpenUrl(notification) {
  const repoUrl = notification.repository?.html_url || "https://github.com";
  const type = notification.subject?.type;
  const number = subjectNumber(notification);
  if (number) {
    const seg = type === "PullRequest" ? "pull" : "issues";
    return `${repoUrl}/${seg}/${number}`;
  }
  if (type === "CheckSuite" || notification.reason === "ci_activity") return `${repoUrl}/actions`;
  if (type === "Release") return `${repoUrl}/releases`;
  if (type === "Discussion") return `${repoUrl}/discussions`;
  if (type === "RepositoryVulnerabilityAlert" || notification.reason === "security_alert") return `${repoUrl}/security/dependabot`;
  return repoUrl;
}

/* ── 2. icons (24px stroke paths) ──────────────────────────────────────── */

const icons = {
  radar: ["M19.07 4.93A10 10 0 0 0 6.99 3.34", "M4 6h.01", "M2.29 9.62a10 10 0 1 0 19.02-1.27", "M16.24 7.76a6 6 0 1 0-8.01 8.91", "M12 18h.01", "M17.99 11.66a6 6 0 0 1-2.22 5.01", "M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0", "M13.41 10.59l5.66-5.66"],
  search: ["M21 21l-4.34-4.34", "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"],
  refresh: ["M21 12a9 9 0 0 0-15-6.7L3 8", "M3 3v5h5", "M3 12a9 9 0 0 0 15 6.7L21 16", "M16 16h5v5"],
  logOut: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  user: ["M19 21a7 7 0 0 0-14 0", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  gitPullRequest: ["M18 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 21V6", "M18 21v-3", "M18 12V9a3 3 0 0 0-3-3h-1"],
  gitMerge: ["M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M6 21V9a9 9 0 0 0 9 9"],
  circleDot: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  check: ["M20 6 9 17l-5-5"],
  checkCheck: ["M18 6 7 17l-5-5", "M22 10l-7.5 7.5L13 16"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  eye: ["M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0"],
  eyeOff: ["M10.733 5.076A10.744 10.744 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68", "M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61", "M2 2l20 20", "M9.88 9.88a3 3 0 1 0 4.24 4.24"],
  bellOff: ["M10.268 21a2 2 0 0 0 3.464 0", "M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742", "M2 2l20 20", "M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"],
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"],
  circle: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"],
  lock: ["M6 10V8a6 6 0 0 1 12 0v2", "M5 10h14v11H5z"],
  star: ["M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"],
  flag: ["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"],
  bot: ["M5 11h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z", "M14 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0", "M12 7v4", "M8 16h.01", "M16 16h.01"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  plus: ["M5 12h14", "M12 5v14"],
  undo: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 6v6l4 2"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  alert: ["M21.73 18l-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z", "M12 9v4", "M12 17h.01"],
  keyboard: ["M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z", "M6 10h.01", "M10 10h.01", "M14 10h.01", "M18 10h.01", "M7 14h10"],
  zap: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"]
};

function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of icons[name] || icons.circle) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const lanes = [
  { id: "all", name: "All", hint: "Everything fetched", icon: "inbox", key: "1" },
  { id: "direct", name: "Direct", hint: "@you, assigned, authored", icon: "user", key: "2" },
  { id: "review", name: "Review", hint: "Personal review asks", icon: "gitPullRequest", key: "3" },
  { id: "ambient", name: "Ambient", hint: "Watching, team churn", icon: "activity", key: "4" },
  { id: "system", name: "System", hint: "CI, security, admin", icon: "shield", key: "5" }
];

/* ── 3. state + persistence ────────────────────────────────────────────── */

const state = {
  token: localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(SESSION_KEY) || "",
  remember: Boolean(localStorage.getItem(STORAGE_KEY)),
  user: null,
  authLoading: false,
  loading: false,
  fetching: false,
  error: "",

  notifications: [],
  cache: new Map(),            // thread id -> enriched summary ({u: updated_at, ...})
  inFlight: new Set(),         // thread ids currently being enriched
  committedDone: new Map(),    // thread id -> updated_at at commit time (session only)
  fetchedPages: 0,
  canLoadMore: false,
  lastModified: null,
  pollInterval: 60,
  pollTimer: null,
  lastSync: 0,

  view: "inbox",               // "inbox" | "tracked"
  lane: "all",
  repoFilter: null,
  staleOnly: false,
  typeFilter: null,            // null | "pr" | "issue"
  query: "",
  includeRead: false,
  participating: false,
  hideBots: true,
  showMuted: false,
  expandRepos: false,

  mutedRepos: new Set(),
  tracked: [],                 // [{key, repo, number, type, title, url, state, updatedAt, lastSeen, priority, addedAt, error, lastTrackedFetch}]

  cursorId: null,
  cursorHint: 0,
  trackedCursorKey: null,
  checked: new Set(),

  undo: null,                  // {mode, items: [notification], timer, startedAt}
  toasts: [],
  toastSeq: 0,
  sweepArmed: false,
  sweepTimer: null,
  helpOpen: false,

  rate: { remaining: null, limit: null, reset: null }
};

function scopedKey(suffix) {
  const login = state.user?.login || "anonymous";
  return `pingboard.v2.${login}.${suffix}`;
}

function loadUserScopedState() {
  const prefs = store.get(scopedKey("prefs"), {});
  state.lane = lanes.some((lane) => lane.id === prefs.lane) ? prefs.lane : "all";
  state.view = prefs.view === "tracked" ? "tracked" : "inbox";
  state.includeRead = Boolean(prefs.includeRead);
  state.participating = Boolean(prefs.participating);
  state.hideBots = prefs.hideBots === undefined ? true : Boolean(prefs.hideBots);
  state.showMuted = Boolean(prefs.showMuted);
  state.mutedRepos = new Set(store.get(scopedKey("muted"), []));
  state.tracked = (store.get(scopedKey("tracked"), []) || []).filter((item) => item && item.key);
  state.cache = new Map(Object.entries(store.get(scopedKey("cache"), {})));
}

function persistPrefs() {
  store.set(scopedKey("prefs"), {
    lane: state.lane,
    view: state.view,
    includeRead: state.includeRead,
    participating: state.participating,
    hideBots: state.hideBots,
    showMuted: state.showMuted
  });
}

function persistMuted() {
  store.set(scopedKey("muted"), [...state.mutedRepos]);
}

function persistTracked() {
  store.set(scopedKey("tracked"), state.tracked);
}

const persistCache = debounce(() => {
  const entries = [...state.cache.entries()];
  if (entries.length > CACHE_LIMIT) {
    entries.sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
    entries.length = CACHE_LIMIT;
    state.cache = new Map(entries);
  }
  store.set(scopedKey("cache"), Object.fromEntries(state.cache));
}, 1200);

/* ── 4. github api ─────────────────────────────────────────────────────── */

function applyRateHeaders(response) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining === null) return;
  state.rate = {
    remaining: Number(remaining),
    limit: Number(response.headers.get("x-ratelimit-limit") || 0),
    reset: Number(response.headers.get("x-ratelimit-reset") || 0) * 1000
  };
  scheduleRender(["top"]);
}

async function ghFetch(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_ROOT}${pathOrUrl}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      ...(options.headers || {})
    }
  });
  applyRateHeaders(response);
  return response;
}

async function github(pathOrUrl, options = {}) {
  const response = await ghFetch(pathOrUrl, options);
  if ([204, 205, 304].includes(response.status)) return null;
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.message || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function safeGithub(url) {
  if (!url) return null;
  try {
    return await github(url);
  } catch {
    return null;
  }
}

/* ── 5. classification + enrichment ────────────────────────────────────── */

function classify(notification, subject = null, latest = null, pull = null) {
  const reason = notification.reason || "unknown";
  const login = state.user?.login || "";
  const mentionedInLatest = Boolean(login && latest?.body && mentionRegex(login).test(latest.body));
  const mentionedInSubject = Boolean(login && (subject?.body || pull?.body) && mentionRegex(login).test(subject?.body || pull?.body));
  const requestedReviewers = pull?.requested_reviewers || [];
  const requestedTeams = pull?.requested_teams || [];
  const personallyRequested = requestedReviewers.some((reviewer) => reviewer.login?.toLowerCase() === login.toLowerCase());

  if (reason === "mention" || mentionedInLatest || mentionedInSubject) {
    return {
      lane: "direct",
      reasonLabel: "Mention",
      context: mentionedInLatest ? "The newest comment names you directly." : "This thread reached you through an @mention.",
      pills: ["@" + (login || "you")]
    };
  }
  if (reason === "team_mention") {
    return { lane: "direct", reasonLabel: "Team mention", context: "A team you belong to was mentioned.", pills: ["team"] };
  }
  if (reason === "assign") {
    return { lane: "direct", reasonLabel: "Assigned", context: "You are assigned to this thread.", pills: ["assigned"] };
  }
  if (reason === "author") {
    return { lane: "direct", reasonLabel: "Your thread", context: "You opened this thread, so activity comes back to you.", pills: ["author"] };
  }
  if (reason === "review_requested") {
    if (personallyRequested) {
      return {
        lane: "review",
        reasonLabel: "Review · you",
        context: "You are individually listed as a requested reviewer.",
        pills: ["personal"],
        reviewStyle: "personal"
      };
    }
    if (requestedTeams.length) {
      return {
        lane: "ambient",
        reasonLabel: "Review · team",
        context: `Team review request: ${requestedTeams.map((team) => team.name || team.slug).join(", ")}. Possibly CODEOWNERS.`,
        pills: ["team review"],
        reviewStyle: "team"
      };
    }
    return {
      lane: "review",
      reasonLabel: "Review",
      context: "GitHub says you or one of your teams was requested for review.",
      pills: ["review"],
      reviewStyle: "unknown"
    };
  }
  if (reason === "approval_requested") {
    return { lane: "review", reasonLabel: "Deploy approval", context: "A deployment is waiting on your approval.", pills: ["deployment"] };
  }
  if (["ci_activity", "security_alert", "security_advisory_credit", "member_feature_requested", "invitation", "state_change"].includes(reason)) {
    return { lane: "system", reasonLabel: systemLabel(reason), context: systemContext(reason), pills: [reason.replaceAll("_", " ")] };
  }
  if (reason === "manual") {
    return { lane: "ambient", reasonLabel: "Subscribed", context: "You manually subscribed to this thread.", pills: ["manual"] };
  }
  if (reason === "comment") {
    return { lane: "ambient", reasonLabel: "Follow-up", context: "You commented earlier, so this is follow-up activity.", pills: ["comment"] };
  }
  return { lane: "ambient", reasonLabel: "Watching", context: "From repository watch settings or a broad subscription.", pills: [reason] };
}

function systemLabel(reason) {
  return {
    ci_activity: "CI",
    security_alert: "Security",
    security_advisory_credit: "Advisory credit",
    member_feature_requested: "Org request",
    invitation: "Invitation",
    state_change: "State change"
  }[reason] || "System";
}

function systemContext(reason) {
  return {
    ci_activity: "A workflow run you triggered completed.",
    security_alert: "GitHub detected a security vulnerability in a repository.",
    security_advisory_credit: "You were credited for a security advisory.",
    member_feature_requested: "Organization members requested a feature change.",
    invitation: "You accepted a repository invitation.",
    state_change: "You changed this thread's state earlier."
  }[reason] || "GitHub generated this from account or repository activity.";
}

function deriveState(type, subject, pull) {
  if (type === "PullRequest") {
    const pr = pull || subject;
    if (!pr || pr.state === undefined) return null;
    if (pr.merged_at || pr.merged) return "merged";
    if (pr.state === "closed") return "closed";
    if (pr.draft) return "draft";
    return "open";
  }
  if (type === "Issue") {
    if (!subject || subject.state === undefined) return null;
    return subject.state === "closed" ? "closed" : "open";
  }
  return null;
}

function buildSummary(notification, subject, latest, pull) {
  const classification = classify(notification, subject, latest, pull);
  const actor = latest?.user || subject?.user || pull?.user || null;
  return {
    u: notification.updated_at,
    t: Date.now(),
    lane: classification.lane,
    reasonLabel: classification.reasonLabel,
    context: classification.context,
    pills: classification.pills || [],
    reviewStyle: classification.reviewStyle || null,
    title: subject?.title || pull?.title || notification.subject?.title || "Untitled thread",
    snippet: textFromMarkdown(latest?.body || subject?.body || pull?.body || ""),
    htmlUrl: latest?.html_url || subject?.html_url || pull?.html_url || fallbackOpenUrl(notification),
    actorLogin: actor?.login || null,
    actorAvatar: actor?.avatar_url || null,
    type: notification.subject?.type || "Thread",
    number: subjectNumber(notification),
    state: deriveState(notification.subject?.type, subject, pull),
    assoc: (pull || subject)?.author_association || null,
    reviewers: (pull?.requested_reviewers || []).map((user) => user.login).join(", "),
    teams: (pull?.requested_teams || []).map((team) => team.name || team.slug).join(", "),
    enriched: true
  };
}

function fallbackSummary(notification) {
  const classification = classify(notification);
  return {
    u: notification.updated_at,
    lane: classification.lane,
    reasonLabel: classification.reasonLabel,
    context: classification.context,
    pills: classification.pills || [],
    title: notification.subject?.title || "Untitled thread",
    snippet: "",
    htmlUrl: fallbackOpenUrl(notification),
    actorLogin: null,
    actorAvatar: null,
    type: notification.subject?.type || "Thread",
    number: subjectNumber(notification),
    state: null,
    enriched: false
  };
}

function getSummary(notification) {
  const cached = state.cache.get(notification.id);
  if (cached && cached.u === notification.updated_at) return cached;
  return fallbackSummary(notification);
}

function isBot(notification) {
  const summary = getSummary(notification);
  const actor = (summary.actorLogin || "").toLowerCase();
  if (actor.endsWith("[bot]")) return true;
  if (actor && KNOWN_BOTS.has(actor.replace(/\[bot\]$/, ""))) return true;
  return BOT_TITLE_RE.test(notification.subject?.title || "");
}

async function enrichOne(notification) {
  const [subject, latest] = await Promise.all([
    safeGithub(notification.subject?.url),
    notification.subject?.latest_comment_url && notification.subject.latest_comment_url !== notification.subject.url
      ? safeGithub(notification.subject.latest_comment_url)
      : null
  ]);
  let pull = null;
  if (notification.subject?.type === "PullRequest") {
    pull = subject;
  } else if (subject?.pull_request?.url) {
    pull = await safeGithub(subject.pull_request.url);
  }
  const summary = buildSummary(notification, subject, latest, pull);
  state.cache.set(notification.id, summary);
  syncTrackedFromSummary(notification, summary);
  persistCache();
}

async function enrichAll(rows) {
  const queue = rows.filter((row) => {
    const cached = state.cache.get(row.id);
    if (cached && cached.u === row.updated_at && cached.enriched) return false;
    return !state.inFlight.has(row.id);
  });
  if (!queue.length) return;
  for (const row of queue) state.inFlight.add(row.id);

  const flusher = setInterval(() => scheduleRender(["list", "side", "detail"]), 220);
  const pending = [...queue];
  const workers = Array.from({ length: ENRICH_CONCURRENCY }, async () => {
    while (pending.length) {
      const row = pending.shift();
      try {
        await enrichOne(row);
      } catch { /* fallback summary stays */ }
      state.inFlight.delete(row.id);
    }
  });
  await Promise.all(workers);
  clearInterval(flusher);
  scheduleRender(["list", "side", "detail"]);
}

/* ── 5b. notifications fetch + poll ────────────────────────────────────── */

async function fetchNotifications({ background = false, pages = MAX_PAGES } = {}) {
  if (state.fetching) return;
  state.fetching = true;
  if (!background) {
    state.loading = true;
    state.error = "";
    scheduleRender(["list", "top"]);
  }

  try {
    const rows = [];
    let pollSeconds = state.pollInterval;
    let lastModified = state.lastModified;
    let notModified = false;

    for (let page = 1; page <= pages; page += 1) {
      const params = new URLSearchParams({
        all: String(state.includeRead),
        participating: String(state.participating),
        per_page: String(PAGE_SIZE),
        page: String(page)
      });
      const headers = {};
      if (background && page === 1 && state.lastModified) headers["If-Modified-Since"] = state.lastModified;
      const response = await ghFetch(`/notifications?${params}`, { headers });

      if (page === 1) {
        pollSeconds = Math.max(60, Number(response.headers.get("x-poll-interval") || 60));
        if (response.status === 304) { notModified = true; break; }
        lastModified = response.headers.get("last-modified") || lastModified;
      }
      if (!response.ok) {
        const body = await response.text();
        let message = `${response.status} ${response.statusText}`;
        try { message = JSON.parse(body)?.message || message; } catch { /* keep default */ }
        throw new Error(message);
      }
      const batch = await response.json();
      if (!Array.isArray(batch) || batch.length === 0) {
        state.canLoadMore = false;
        state.fetchedPages = page;
        break;
      }
      rows.push(...batch);
      state.fetchedPages = page;
      state.canLoadMore = batch.length === PAGE_SIZE && page < HARD_MAX_PAGES;
      if (batch.length < PAGE_SIZE) { state.canLoadMore = false; break; }
    }

    state.pollInterval = pollSeconds;
    state.lastSync = Date.now();

    if (!notModified) {
      state.lastModified = lastModified;
      const pendingIds = new Set((state.undo?.items || []).map((item) => item.id));
      state.notifications = rows.filter((row) => {
        if (pendingIds.has(row.id)) return false;
        const committedAt = state.committedDone.get(row.id);
        return !(committedAt && row.updated_at <= committedAt);
      });
      ensureCursor(visibleRows());
      enrichAll(state.notifications);
    }
  } catch (error) {
    state.error = error.message;
    if (!background) toast(error.message, "error");
  } finally {
    state.fetching = false;
    state.loading = false;
    scheduleRender();
    schedulePoll();
  }
}

function loadMore() {
  if (!state.canLoadMore || state.loading) return;
  fetchNotifications({ pages: Math.min(state.fetchedPages + 2, HARD_MAX_PAGES) });
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.user) return;
  state.pollTimer = setTimeout(async () => {
    if (document.hidden) { schedulePoll(); return; }
    await fetchNotifications({ background: true, pages: state.fetchedPages || MAX_PAGES });
    refreshTracked();
  }, state.pollInterval * 1000);
}

/* ── 6. tracked threads ────────────────────────────────────────────────── */

function trackedByKey(key) {
  return state.tracked.find((item) => item.key === key) || null;
}

function trackedKeyForNotification(notification) {
  const number = subjectNumber(notification);
  return number ? threadKey(repoOf(notification), number) : null;
}

function toggleTrack(notification, { priority = false } = {}) {
  const key = trackedKeyForNotification(notification);
  if (!key) {
    toast("Only issues and pull requests can be tracked.", "error");
    return;
  }
  const existing = trackedByKey(key);
  if (existing) {
    state.tracked = state.tracked.filter((item) => item.key !== key);
    persistTracked();
    toast(`Untracked ${key}`);
  } else {
    const summary = getSummary(notification);
    const item = {
      key,
      repo: repoOf(notification),
      number: subjectNumber(notification),
      type: notification.subject?.type === "PullRequest" ? "pr" : "issue",
      title: summary.title,
      url: summary.htmlUrl || fallbackOpenUrl(notification),
      state: summary.state || "open",
      updatedAt: notification.updated_at,
      lastSeen: notification.updated_at,
      priority,
      addedAt: Date.now(),
      lastTrackedFetch: 0
    };
    state.tracked.unshift(item);
    persistTracked();
    refreshTrackedItem(item).then(() => scheduleRender(["list", "side", "detail"]));
    toast(priority ? `Tracking ${key} as priority` : `Tracking ${key}`);
  }
  scheduleRender(["list", "side", "detail"]);
}

function parseTrackInput(raw) {
  const input = raw.trim();
  let match = input.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)/i);
  if (match) {
    return { repo: `${match[1]}/${match[2]}`, number: Number(match[4]), type: match[3].toLowerCase() === "pull" ? "pr" : "issue" };
  }
  match = input.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (match) return { repo: match[1], number: Number(match[2]), type: "pr" };
  return null;
}

async function trackByInput(raw) {
  const parsed = parseTrackInput(raw);
  if (!parsed) {
    toast("Paste a PR/issue URL or owner/repo#123", "error");
    return false;
  }
  const key = threadKey(parsed.repo, parsed.number);
  if (trackedByKey(key)) {
    toast(`${key} is already tracked`);
    return true;
  }
  const item = {
    key,
    repo: parsed.repo,
    number: parsed.number,
    type: parsed.type,
    title: key,
    url: `https://github.com/${parsed.repo}/${parsed.type === "pr" ? "pull" : "issues"}/${parsed.number}`,
    state: "open",
    updatedAt: null,
    lastSeen: null,
    priority: false,
    addedAt: Date.now(),
    lastTrackedFetch: 0
  };
  state.tracked.unshift(item);
  persistTracked();
  scheduleRender(["list", "side"]);
  await refreshTrackedItem(item);
  if (!item.error) item.lastSeen = item.updatedAt;
  persistTracked();
  scheduleRender(["list", "side", "detail"]);
  toast(item.error ? `Tracked ${key}, but it could not be fetched` : `Tracking ${key}`, item.error ? "error" : "info");
  return true;
}

async function refreshTrackedItem(item) {
  try {
    if (item.type === "pr") {
      const pull = await github(`/repos/${item.repo}/pulls/${item.number}`);
      item.title = pull.title || item.title;
      item.url = pull.html_url || item.url;
      item.state = pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open";
      item.updatedAt = pull.updated_at;
    } else {
      const issue = await github(`/repos/${item.repo}/issues/${item.number}`);
      item.title = issue.title || item.title;
      item.url = issue.html_url || item.url;
      item.state = issue.state === "closed" ? "closed" : "open";
      item.updatedAt = issue.updated_at;
      if (issue.pull_request) {
        item.type = "pr";
        if (issue.pull_request.merged_at) item.state = "merged";
      }
    }
    item.error = null;
  } catch (error) {
    item.error = error.message;
  }
  item.lastTrackedFetch = Date.now();
}

async function refreshTracked(force = false) {
  const now = Date.now();
  const stale = state.tracked.filter((item) => force || now - (item.lastTrackedFetch || 0) > TRACKED_STALE_MS);
  if (!stale.length) return;
  const queue = [...stale];
  const workers = Array.from({ length: ENRICH_CONCURRENCY }, async () => {
    while (queue.length) {
      await refreshTrackedItem(queue.shift());
    }
  });
  await Promise.all(workers);
  persistTracked();
  scheduleRender(["list", "side", "detail"]);
}

/* Keep tracked titles/states in sync when inbox enrichment sees the same thread. */
function syncTrackedFromSummary(notification, summary) {
  const key = trackedKeyForNotification(notification);
  if (!key) return;
  const item = trackedByKey(key);
  if (!item) return;
  item.title = summary.title || item.title;
  if (summary.state) item.state = summary.state;
  if (summary.htmlUrl) item.url = summary.htmlUrl;
  if (!item.updatedAt || notification.updated_at > item.updatedAt) item.updatedAt = notification.updated_at;
  persistTracked();
}

function trackedHasNew(item) {
  return Boolean(item.updatedAt && item.lastSeen && item.updatedAt > item.lastSeen);
}

function trackedSections() {
  const active = state.tracked.filter((item) => item.state === "open" || item.state === "draft");
  const shipped = state.tracked.filter((item) => item.state === "merged" || item.state === "closed");
  const byPriorityThenFresh = (a, b) =>
    Number(b.priority) - Number(a.priority) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  const fresh = active.filter(trackedHasNew).sort(byPriorityThenFresh);
  const quiet = active.filter((item) => !trackedHasNew(item)).sort(byPriorityThenFresh);
  shipped.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return [
    { id: "fresh", title: "New activity", hint: "Updated since you last looked", items: fresh },
    { id: "quiet", title: "Waiting", hint: "No new activity", items: quiet },
    { id: "shipped", title: "Shipped / closed", hint: "Merged or closed — clear when acknowledged", items: shipped }
  ];
}

function trackedFlatList() {
  return trackedSections().flatMap((section) => section.items);
}

function markSeen(item) {
  if (item.updatedAt) item.lastSeen = item.updatedAt;
  persistTracked();
  scheduleRender(["list", "side", "detail"]);
}

function clearTracked(item) {
  const flat = trackedFlatList();
  const idx = flat.findIndex((entry) => entry.key === item.key);
  state.tracked = state.tracked.filter((entry) => entry.key !== item.key);
  persistTracked();
  const next = trackedFlatList();
  state.trackedCursorKey = next[clamp(idx, 0, next.length - 1)]?.key || null;
  scheduleRender(["list", "side", "detail"]);
}

function clearShipped() {
  const count = state.tracked.filter((item) => item.state === "merged" || item.state === "closed").length;
  state.tracked = state.tracked.filter((item) => item.state !== "merged" && item.state !== "closed");
  persistTracked();
  toast(`Cleared ${count} shipped thread${count === 1 ? "" : "s"}`);
  scheduleRender(["list", "side", "detail"]);
}

function toggleTrackedPriority(item) {
  item.priority = !item.priority;
  persistTracked();
  scheduleRender(["list", "detail"]);
}

/* ── 7. filters, actions, undo queue ───────────────────────────────────── */

function baseRows() {
  return state.notifications.filter((notification) => {
    if (!state.showMuted && state.mutedRepos.has(repoOf(notification))) return false;
    if (state.hideBots && isBot(notification)) return false;
    return true;
  });
}

function matchesQuery(notification, query) {
  const summary = getSummary(notification);
  const haystack = [
    summary.title,
    summary.snippet,
    repoOf(notification),
    notification.reason,
    summary.reasonLabel,
    summary.actorLogin,
    summary.number ? `#${summary.number}` : "",
    summary.state
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function scopedRows({ ignoreStale = false, ignoreType = false } = {}) {
  const query = state.query.trim().toLowerCase();
  return baseRows().filter((notification) => {
    const summary = getSummary(notification);
    if (state.lane !== "all" && summary.lane !== state.lane) return false;
    if (state.repoFilter && repoOf(notification) !== state.repoFilter) return false;
    if (!ignoreType && state.typeFilter && summary.type !== (state.typeFilter === "pr" ? "PullRequest" : "Issue")) return false;
    if (!ignoreStale && state.staleOnly && !["merged", "closed"].includes(summary.state)) return false;
    if (query && !matchesQuery(notification, query)) return false;
    return true;
  });
}

function visibleRows() {
  return scopedRows();
}

function staleCount() {
  return scopedRows({ ignoreStale: true }).filter((notification) => ["merged", "closed"].includes(getSummary(notification).state)).length;
}

function typeCounts() {
  const counts = { pr: 0, issue: 0 };
  for (const notification of scopedRows({ ignoreType: true })) {
    const type = notification.subject?.type;
    if (type === "PullRequest") counts.pr += 1;
    else if (type === "Issue") counts.issue += 1;
  }
  return counts;
}

function laneCounts() {
  const counts = Object.fromEntries(lanes.map((lane) => [lane.id, 0]));
  for (const notification of baseRows()) {
    if (state.repoFilter && repoOf(notification) !== state.repoFilter) continue;
    counts.all += 1;
    counts[getSummary(notification).lane] += 1;
  }
  return counts;
}

function repoCounts() {
  const counts = new Map();
  for (const notification of baseRows()) {
    const summary = getSummary(notification);
    if (state.lane !== "all" && summary.lane !== state.lane) continue;
    const repo = repoOf(notification);
    if (state.mutedRepos.has(repo)) continue;
    counts.set(repo, (counts.get(repo) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function hiddenBotCount() {
  if (!state.hideBots) return 0;
  return state.notifications.filter((notification) => !state.mutedRepos.has(repoOf(notification)) && isBot(notification)).length;
}

function mutedCount() {
  return state.notifications.filter((notification) => state.mutedRepos.has(repoOf(notification))).length;
}

/* Cursor */

function ensureCursor(rows) {
  if (!rows.length) {
    state.cursorId = null;
    return;
  }
  const idx = rows.findIndex((row) => row.id === state.cursorId);
  if (idx >= 0) {
    state.cursorHint = idx;
    return;
  }
  state.cursorHint = clamp(state.cursorHint, 0, rows.length - 1);
  state.cursorId = rows[state.cursorHint].id;
}

function moveCursor(delta) {
  if (state.view === "tracked") {
    const flat = trackedFlatList();
    if (!flat.length) return;
    const idx = flat.findIndex((item) => item.key === state.trackedCursorKey);
    const next = clamp((idx < 0 ? 0 : idx + delta), 0, flat.length - 1);
    state.trackedCursorKey = flat[next].key;
    scheduleRender(["list", "detail"]);
    scrollCursorIntoView();
    return;
  }
  const rows = visibleRows();
  if (!rows.length) return;
  const idx = rows.findIndex((row) => row.id === state.cursorId);
  const next = clamp((idx < 0 ? 0 : idx + delta), 0, rows.length - 1);
  state.cursorId = rows[next].id;
  state.cursorHint = next;
  scheduleRender(["list", "detail"]);
  scrollCursorIntoView();
}

function scrollCursorIntoView() {
  requestAnimationFrame(() => {
    const node = document.querySelector('[data-cursor="true"]');
    node?.scrollIntoView({ block: "nearest" });
  });
}

function cursorNotification() {
  return state.notifications.find((row) => row.id === state.cursorId) || null;
}

function cursorTracked() {
  return trackedByKey(state.trackedCursorKey) || trackedFlatList()[0] || null;
}

/* Undo queue: actions land locally first, commit to GitHub after UNDO_DELAY. */

function queueAction(notifications, mode) {
  const items = notifications.filter(Boolean);
  if (!items.length) return;

  // Advance cursor before removal so triage flows top-to-bottom without mouse.
  const rows = visibleRows();
  const removed = new Set(items.map((item) => item.id));
  const idx = rows.findIndex((row) => row.id === state.cursorId);
  const after = rows.slice(idx + 1).find((row) => !removed.has(row.id)) || rows.slice(0, Math.max(idx, 0)).reverse().find((row) => !removed.has(row.id));

  state.notifications = state.notifications.filter((row) => !removed.has(row.id));
  for (const id of removed) state.checked.delete(id);
  state.cursorId = after?.id || null;

  if (state.undo && state.undo.mode === mode) {
    clearTimeout(state.undo.timer);
    state.undo.items.push(...items);
  } else {
    if (state.undo) {
      // Different action type: commit the old batch now, start a fresh window.
      clearTimeout(state.undo.timer);
      commitUndo(state.undo);
    }
    state.undo = { mode, items: [...items] };
  }
  const batch = state.undo;
  batch.startedAt = Date.now();
  batch.timer = setTimeout(() => {
    if (state.undo === batch) state.undo = null;
    scheduleRender(["undo"]);
    commitUndo(batch);
  }, UNDO_DELAY);

  scheduleRender(["list", "side", "detail", "undo", "bulk", "top"]);
}

function undoNow() {
  if (!state.undo) return;
  clearTimeout(state.undo.timer);
  const restored = state.undo.items.length;
  state.notifications.push(...state.undo.items);
  state.notifications.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  state.cursorId = state.undo.items[0]?.id || state.cursorId;
  state.undo = null;
  toast(`Restored ${restored} thread${restored === 1 ? "" : "s"}`);
  scheduleRender(["list", "side", "detail", "undo", "top"]);
}

async function commitUndo(batch, { keepalive = false } = {}) {
  if (!batch || batch.committed) return;
  batch.committed = true;
  const failures = [];
  const queue = [...batch.items];
  const run = async (item) => {
    const id = item.id;
    try {
      if (batch.mode === "read") {
        await github(`/notifications/threads/${id}`, { method: "PATCH", keepalive });
      } else if (batch.mode === "done") {
        await github(`/notifications/threads/${id}`, { method: "DELETE", keepalive });
        state.committedDone.set(id, item.updated_at);
      } else if (batch.mode === "mute") {
        await github(`/notifications/threads/${id}/subscription`, {
          method: "PUT",
          keepalive,
          body: JSON.stringify({ ignored: true }),
          headers: { "Content-Type": "application/json" }
        });
        await github(`/notifications/threads/${id}`, { method: "DELETE", keepalive });
        state.committedDone.set(id, item.updated_at);
      }
    } catch {
      failures.push(item);
    }
  };
  if (keepalive) {
    // Page is going away: fire everything without waiting.
    for (const item of queue) run(item);
    return;
  }
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) await run(queue.shift());
  });
  await Promise.all(workers);
  if (failures.length) {
    state.notifications.push(...failures);
    state.notifications.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    toast(`${failures.length} action${failures.length === 1 ? "" : "s"} failed and were restored`, "error");
    scheduleRender(["list", "side", "detail"]);
  }
}

function flushPendingActions() {
  if (!state.undo) return;
  clearTimeout(state.undo.timer);
  const batch = state.undo;
  state.undo = null;
  commitUndo(batch, { keepalive: true });
}

const actionVerbs = { done: "done", read: "marked read", mute: "muted" };

function actOnCursor(mode) {
  if (state.view === "tracked") {
    const item = cursorTracked();
    if (!item) return;
    if (mode === "done") {
      if (item.state === "merged" || item.state === "closed") clearTracked(item);
      else markSeen(item);
    }
    return;
  }
  const notification = cursorNotification();
  if (!notification) return;
  if (mode === "read" && state.includeRead && notification.unread) {
    // In "show read" mode, read just dims the row instead of removing it.
    notification.unread = false;
    github(`/notifications/threads/${notification.id}`, { method: "PATCH" }).catch(() => {});
    scheduleRender(["list", "side", "top"]);
    return;
  }
  queueAction([notification], mode);
}

function openNotification(notification) {
  const summary = getSummary(notification);
  const url = summary.htmlUrl || fallbackOpenUrl(notification);
  if (url) window.open(url, "_blank", "noopener");
  if (notification.unread) {
    // GitHub marks the thread read once you view it; mirror that optimistically.
    notification.unread = false;
    scheduleRender(["list", "side", "top"]);
  }
}

function openCursor() {
  if (state.view === "tracked") {
    const item = cursorTracked();
    if (!item) return;
    window.open(item.url, "_blank", "noopener");
    markSeen(item);
    return;
  }
  const notification = cursorNotification();
  if (notification) openNotification(notification);
}

/* Bulk selection */

function toggleCheck(notification) {
  if (!notification) return;
  if (state.checked.has(notification.id)) state.checked.delete(notification.id);
  else state.checked.add(notification.id);
  scheduleRender(["list", "bulk"]);
}

function checkAllVisible() {
  for (const row of visibleRows()) state.checked.add(row.id);
  scheduleRender(["list", "bulk"]);
}

function clearChecked() {
  state.checked.clear();
  scheduleRender(["list", "bulk"]);
}

function bulkAct(mode) {
  const items = state.notifications.filter((row) => state.checked.has(row.id));
  state.checked.clear();
  queueAction(items, mode);
}

function sweepView() {
  const rows = visibleRows();
  if (!rows.length) return;
  if (!state.sweepArmed) {
    state.sweepArmed = true;
    clearTimeout(state.sweepTimer);
    state.sweepTimer = setTimeout(() => {
      state.sweepArmed = false;
      scheduleRender(["list"]);
    }, 3000);
    scheduleRender(["list"]);
    return;
  }
  clearTimeout(state.sweepTimer);
  state.sweepArmed = false;
  queueAction(rows, "done");
}

/* Repo mute */

function muteRepo(repo) {
  if (!repo || repo === "unknown") return;
  state.mutedRepos.add(repo);
  if (state.repoFilter === repo) state.repoFilter = null;
  persistMuted();
  toast(`Muted ${repo} — hidden from lanes`);
  scheduleRender(["list", "side", "detail"]);
}

function unmuteRepo(repo) {
  state.mutedRepos.delete(repo);
  persistMuted();
  scheduleRender(["list", "side", "detail"]);
}

/* Toasts */

function toast(message, kind = "info") {
  const id = ++state.toastSeq;
  state.toasts.push({ id, message, kind });
  if (state.toasts.length > 3) state.toasts.shift();
  scheduleRender(["toast"]);
  setTimeout(() => {
    state.toasts = state.toasts.filter((entry) => entry.id !== id);
    scheduleRender(["toast"]);
  }, kind === "error" ? 5200 : 2600);
}

/* ── 8. rendering ──────────────────────────────────────────────────────── */

const app = document.querySelector("#app");
const ALL_PARTS = ["top", "side", "list", "detail", "bulk", "undo", "toast", "modal"];
let pendingParts = null;

function scheduleRender(parts = ALL_PARTS) {
  if (!pendingParts) {
    pendingParts = new Set();
    // rAF never fires in hidden tabs; fall back so background polls still paint.
    if (document.hidden) setTimeout(flushRender, 0);
    else requestAnimationFrame(flushRender);
  }
  for (const part of parts) pendingParts.add(part);
}

function render(parts = ALL_PARTS) {
  scheduleRender(parts);
}

function flushRender() {
  const parts = pendingParts || new Set(ALL_PARTS);
  pendingParts = null;
  const mode = state.token && state.user ? "dash" : "auth";
  if (ensureShell(mode)) {
    parts.clear();
    for (const part of ALL_PARTS) parts.add(part);
  }

  if (mode === "auth") {
    renderAuthView();
    renderToastStack();
    document.title = "Pingboard";
    return;
  }
  if (parts.has("top")) renderTop();
  if (parts.has("side")) renderSide();
  if (parts.has("list")) renderListPanel();
  if (parts.has("detail")) renderDetail();
  if (parts.has("bulk")) renderBulk();
  if (parts.has("undo")) renderUndoBar();
  if (parts.has("toast")) renderToastStack();
  if (parts.has("modal")) renderModal();
  updateTitle();
}

function updateTitle() {
  const unread = baseRows().filter((row) => row.unread).length;
  document.title = unread ? `(${unread}) Pingboard` : "Pingboard";
}

/* Shell: static chrome built once per mode; renderers fill stable slots. */

function ensureShell(mode) {
  if (app.dataset.mode === mode) return false;
  app.dataset.mode = mode;
  app.replaceChildren();

  if (mode === "auth") {
    app.append(el("div", { id: "authRoot" }), el("div", { id: "toastSlot", class: "toast-stack" }));
    return true;
  }

  const searchInput = el("input", {
    id: "searchInput",
    type: "search",
    placeholder: "Search repo, title, actor, #number",
    autocomplete: "off",
    oninput: debounce((event) => {
      state.query = event.target.value;
      scheduleRender(["list"]);
    }, 120),
    onkeydown: (event) => {
      if (event.key === "Escape") {
        event.target.value = "";
        state.query = "";
        event.target.blur();
        scheduleRender(["list"]);
      }
      if (event.key === "Enter") event.target.blur();
    }
  });

  app.append(
    el("header", { class: "topbar" }, [
      el("div", { class: "brand" }, [
        el("div", { class: "brand-mark" }, [icon("radar")]),
        el("div", { class: "brand-copy" }, [
          el("h1", { text: "Pingboard" }),
          el("p", { id: "brandUser", text: "…" })
        ])
      ]),
      el("label", { class: "search" }, [
        icon("search"),
        searchInput,
        el("kbd", { class: "search-kbd", text: "/" })
      ]),
      el("div", { class: "top-status", id: "syncSlot" }),
      el("div", { class: "top-actions" }, [
        button({ label: "Refresh now (shift+R)", iconName: "refresh", onClick: () => fetchNotifications(), className: "icon-button", title: "Refresh (shift+R)" }),
        button({
          label: "Keyboard shortcuts (?)",
          iconName: "keyboard",
          onClick: () => { state.helpOpen = !state.helpOpen; scheduleRender(["modal"]); }
        }),
        el("span", { id: "avatarSlot" }),
        button({ label: "Sign out", iconName: "logOut", onClick: signOut })
      ])
    ]),
    el("section", { class: "grid" }, [
      el("aside", { class: "panel side", id: "sideSlot" }),
      el("section", { class: "panel list-panel", id: "listSlot" }),
      el("aside", { class: "panel detail", id: "detailSlot" })
    ]),
    el("div", { id: "bulkSlot" }),
    el("div", { id: "undoSlot" }),
    el("div", { id: "toastSlot", class: "toast-stack" }),
    el("div", { id: "modalSlot" })
  );
  return true;
}

function renderTop() {
  const brandUser = document.querySelector("#brandUser");
  if (brandUser) brandUser.textContent = state.user ? `@${state.user.login}` : "";

  const avatarSlot = document.querySelector("#avatarSlot");
  if (avatarSlot) {
    avatarSlot.replaceChildren(
      state.user?.avatar_url
        ? el("img", { class: "avatar", src: state.user.avatar_url, alt: state.user.login || "" })
        : icon("user")
    );
  }

  const syncSlot = document.querySelector("#syncSlot");
  if (!syncSlot) return;
  const rate = state.rate.remaining === null ? "—" : state.rate.remaining.toLocaleString();
  const rateClass = state.rate.remaining !== null && state.rate.remaining < 200 ? "rate-low" : "";
  syncSlot.replaceChildren(
    el("span", { class: `sync-dot ${state.loading ? "busy" : ""}`, title: "Background poll is active" }),
    el("span", { class: "sync-line", text: state.loading ? "syncing…" : state.lastSync ? `sync ${fmtAgoShort(state.lastSync)}` : "not synced" }),
    el("span", { class: `rate-line ${rateClass}`, title: "GitHub API requests remaining this hour", text: `api ${rate}` })
  );
}

function renderSide() {
  const side = document.querySelector("#sideSlot");
  if (!side) return;
  const counts = laneCounts();
  const repos = repoCounts();
  const shownRepos = state.expandRepos ? repos : repos.slice(0, 8);
  const trackedFresh = state.tracked.filter((item) => (item.state === "open" || item.state === "draft") && trackedHasNew(item)).length;
  const trackedActive = state.tracked.filter((item) => item.state === "open" || item.state === "draft").length;
  const trackedShipped = state.tracked.length - trackedActive;
  const botsHidden = hiddenBotCount();
  const muted = mutedCount();

  const viewSwitch = el("div", { class: "view-switch", role: "tablist" }, [
    el("button", {
      class: "view-btn",
      type: "button",
      role: "tab",
      "aria-selected": String(state.view === "inbox"),
      onclick: () => { state.view = "inbox"; persistPrefs(); render(); }
    }, [icon("inbox"), el("span", { text: "Inbox" }), el("span", { class: "count", text: String(counts.all) })]),
    el("button", {
      class: "view-btn",
      type: "button",
      role: "tab",
      "aria-selected": String(state.view === "tracked"),
      onclick: () => { state.view = "tracked"; persistPrefs(); render(); }
    }, [
      icon("star"),
      el("span", { text: "Tracked" }),
      trackedFresh
        ? el("span", { class: "count fresh", title: `${trackedFresh} with new activity`, text: String(trackedFresh) })
        : el("span", { class: "count", text: String(state.tracked.length) })
    ])
  ]);

  const laneList = el("div", { class: "lane-list", role: "group", "aria-label": "Lanes" }, lanes.map((lane) =>
    el("button", {
      class: "lane-button",
      type: "button",
      style: { "--lane-color": `var(--${lane.id === "all" ? "ambient" : lane.id})` },
      "aria-pressed": String(state.view === "inbox" && state.lane === lane.id),
      onclick: () => {
        state.view = "inbox";
        state.lane = lane.id;
        persistPrefs();
        render();
      }
    }, [
      el("span", { class: "lane-dot" }, [icon(lane.icon)]),
      el("span", { class: "lane-copy" }, [
        el("span", { class: "lane-name", text: lane.name }),
        el("span", { class: "lane-hint", text: lane.hint })
      ]),
      el("kbd", { text: lane.key }),
      el("span", { class: "count", text: String(counts[lane.id] || 0) })
    ])
  ));

  const repoSection = el("div", { class: "side-section" }, [
    el("p", { class: "side-label", text: "Repositories" }),
    repos.length === 0
      ? el("p", { class: "side-empty", text: "No repos in scope." })
      : el("div", { class: "facet-list" }, [
        ...shownRepos.map(([repo, count]) => el("div", { class: "facet-row" }, [
          el("button", {
            class: "facet",
            type: "button",
            "aria-pressed": String(state.repoFilter === repo),
            title: repo,
            onclick: () => {
              state.repoFilter = state.repoFilter === repo ? null : repo;
              state.view = "inbox";
              scheduleRender(["list", "side", "detail"]);
            }
          }, [
            el("span", { class: "facet-name", text: repo }),
            el("span", { class: "facet-count", text: String(count) })
          ]),
          button({
            className: "facet-mute",
            label: `Mute ${repo}`,
            title: `Mute ${repo} (hide from all lanes)`,
            iconName: "bellOff",
            onClick: () => muteRepo(repo)
          })
        ])),
        repos.length > 8
          ? el("button", {
            class: "side-more",
            type: "button",
            text: state.expandRepos ? "Show fewer" : `Show all ${repos.length}`,
            onclick: () => { state.expandRepos = !state.expandRepos; scheduleRender(["side"]); }
          })
          : null
      ])
  ]);

  const toggles = el("div", { class: "side-section" }, [
    el("p", { class: "side-label", text: "Noise" }),
    toggleRow({
      label: "Hide bots",
      sub: botsHidden ? `${botsHidden} hidden` : "dependabot & friends",
      checked: state.hideBots,
      onChange: (checked) => { state.hideBots = checked; persistPrefs(); scheduleRender(["list", "side"]); }
    }),
    toggleRow({
      label: "Show read",
      sub: "fetch read threads too",
      checked: state.includeRead,
      onChange: (checked) => { state.includeRead = checked; persistPrefs(); fetchNotifications(); }
    }),
    toggleRow({
      label: "Participating only",
      sub: "skip pure watch traffic",
      checked: state.participating,
      onChange: (checked) => { state.participating = checked; persistPrefs(); fetchNotifications(); }
    }),
    state.mutedRepos.size
      ? toggleRow({
        label: "Show muted repos",
        sub: `${state.mutedRepos.size} repo${state.mutedRepos.size === 1 ? "" : "s"} · ${muted} thread${muted === 1 ? "" : "s"}`,
        checked: state.showMuted,
        onChange: (checked) => { state.showMuted = checked; persistPrefs(); scheduleRender(["list", "side"]); }
      })
      : null
  ]);

  const mutedSection = state.mutedRepos.size
    ? el("div", { class: "side-section" }, [
      el("p", { class: "side-label", text: "Muted" }),
      el("div", { class: "facet-list" }, [...state.mutedRepos].sort().map((repo) =>
        el("div", { class: "facet-row muted" }, [
          el("span", { class: "facet name-only", title: repo }, [el("span", { class: "facet-name", text: repo })]),
          button({
            className: "facet-mute",
            label: `Unmute ${repo}`,
            title: `Unmute ${repo}`,
            iconName: "bellOff",
            onClick: () => unmuteRepo(repo)
          })
        ])
      ))
    ])
    : null;

  side.replaceChildren(...[
    viewSwitch,
    state.view === "inbox" ? laneList : el("div", { class: "side-section tracked-side" }, [
      el("p", { class: "side-label", text: "Tracked" }),
      el("p", { class: "side-empty", text: `${trackedActive} active · ${trackedShipped} shipped` })
    ]),
    repoSection,
    toggles,
    mutedSection
  ].filter(Boolean));
}

function toggleRow({ label, sub, checked, onChange }) {
  return el("label", { class: "toggle-row" }, [
    el("span", { class: "toggle-copy" }, [
      el("span", { class: "toggle-label", text: label }),
      el("span", { class: "toggle-sub", text: sub })
    ]),
    el("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-checked": String(checked),
      "aria-label": label,
      onclick: () => onChange(!checked)
    }, [el("span", { class: "knob" })])
  ]);
}

function renderListPanel() {
  const slot = document.querySelector("#listSlot");
  if (!slot) return;

  // Preserve focus/value of inputs living inside this panel across re-renders.
  const active = document.activeElement;
  const preserve = active && slot.contains(active) && active.tagName === "INPUT"
    ? { id: active.id, value: active.value, start: active.selectionStart }
    : null;

  if (state.view === "tracked") renderTrackedView(slot);
  else renderInboxList(slot);

  if (preserve?.id) {
    const input = document.getElementById(preserve.id);
    if (input) {
      input.value = preserve.value;
      input.focus();
      try { input.setSelectionRange(preserve.start, preserve.start); } catch { /* not all inputs */ }
    }
  }
}

function renderInboxList(slot) {
  const rows = visibleRows();
  ensureCursor(rows);
  const lane = lanes.find((entry) => entry.id === state.lane) || lanes[0];
  const stale = staleCount();
  const types = typeCounts();

  const scopeBits = [lane.name];
  if (state.repoFilter) scopeBits.push(state.repoFilter);
  if (state.typeFilter) scopeBits.push(state.typeFilter === "pr" ? "PRs" : "Issues");
  if (state.query.trim()) scopeBits.push(`“${state.query.trim()}”`);

  const header = el("div", { class: "list-header" }, [
    el("div", { class: "list-title-wrap" }, [
      el("p", { class: "eyebrow", text: scopeBits.join(" · ") }),
      el("h2", { class: "section-title", text: state.loading && !rows.length ? "Scanning…" : `${rows.length} thread${rows.length === 1 ? "" : "s"}` })
    ]),
    el("div", { class: "list-tools" }, [
      types.pr || state.typeFilter === "pr"
        ? button({
          className: "chip",
          label: "Only pull requests (i cycles type filter)",
          text: `PRs ${types.pr}`,
          iconName: "gitPullRequest",
          pressed: state.typeFilter === "pr",
          onClick: () => { state.typeFilter = state.typeFilter === "pr" ? null : "pr"; scheduleRender(["list"]); }
        })
        : null,
      types.issue || state.typeFilter === "issue"
        ? button({
          className: "chip",
          label: "Only issues (i cycles type filter)",
          text: `Issues ${types.issue}`,
          iconName: "circleDot",
          pressed: state.typeFilter === "issue",
          onClick: () => { state.typeFilter = state.typeFilter === "issue" ? null : "issue"; scheduleRender(["list"]); }
        })
        : null,
      stale || state.staleOnly
        ? button({
          className: `chip ${state.staleOnly ? "on" : ""}`,
          label: "Toggle stale filter (s): threads whose PR/issue is already merged or closed",
          text: `Stale ${stale}`,
          iconName: "gitMerge",
          pressed: state.staleOnly,
          onClick: () => { state.staleOnly = !state.staleOnly; scheduleRender(["list"]); }
        })
        : null,
      state.repoFilter || state.query.trim() || state.staleOnly || state.typeFilter
        ? button({
          className: "chip",
          label: "Clear filters (Esc)",
          text: "Clear",
          iconName: "x",
          onClick: () => {
            state.repoFilter = null;
            state.staleOnly = false;
            state.typeFilter = null;
            state.query = "";
            const input = document.querySelector("#searchInput");
            if (input) input.value = "";
            scheduleRender(["list", "side"]);
          }
        })
        : null,
      rows.length
        ? button({
          className: `sweep-btn ${state.sweepArmed ? "armed" : ""}`,
          label: "Mark every thread in this view done",
          text: state.sweepArmed ? `Confirm ×${rows.length}` : "Done all",
          iconName: "checkCheck",
          onClick: sweepView
        })
        : null
    ])
  ]);

  const listChildren = rows.map((notification) => notifRow(notification));
  if (state.canLoadMore && rows.length) {
    listChildren.push(el("button", {
      class: "load-more",
      type: "button",
      onclick: loadMore
    }, [icon("plus"), el("span", { text: state.loading ? "Loading…" : `Load more (${state.notifications.length} fetched)` })]));
  }

  const children = [
    header,
    state.error && !rows.length ? errorBanner() : null,
    state.loading && !rows.length && !state.error
      ? loadingBlock()
      : rows.length
        ? el("div", { class: "notification-list", role: "listbox", "aria-label": "Notifications" }, listChildren)
        : state.error ? null : emptyBlock()
  ].filter(Boolean);
  slot.replaceChildren(...children);
}

function errorBanner() {
  return el("div", { class: "error-banner" }, [
    icon("alert"),
    el("span", { text: state.error }),
    button({ className: "chip", label: "Retry", text: "Retry", onClick: () => fetchNotifications() })
  ]);
}

function notifRow(notification) {
  const summary = getSummary(notification);
  const isCursor = notification.id === state.cursorId;
  const checked = state.checked.has(notification.id);
  const tracked = trackedByKey(trackedKeyForNotification(notification) || "");
  const bot = isBot(notification);

  const check = el("button", {
    class: "n-check",
    type: "button",
    role: "checkbox",
    "aria-checked": String(checked),
    "aria-label": "Select thread",
    title: "Select (x)",
    onclick: (event) => {
      event.stopPropagation();
      toggleCheck(notification);
    }
  }, [icon("check", "icon check-mark")]);

  const quick = el("span", { class: "hover-actions" }, [
    button({
      className: "ha-btn", label: "Done (e)", iconName: "check",
      onClick: (event) => { event.stopPropagation(); state.cursorId = notification.id; queueAction([notification], "done"); }
    }),
    button({
      className: "ha-btn", label: tracked ? "Untrack (t)" : "Track (t)", iconName: "star",
      pressed: Boolean(tracked),
      onClick: (event) => { event.stopPropagation(); toggleTrack(notification); }
    }),
    button({
      className: "ha-btn", label: "Open on GitHub (o)", iconName: "external",
      onClick: (event) => { event.stopPropagation(); openNotification(notification); }
    })
  ]);

  return el("div", {
    class: `notification ${notification.unread === false ? "is-read" : ""}`,
    style: { "--lane-color": `var(--${summary.lane})` },
    role: "option",
    tabindex: "-1",
    "aria-selected": String(isCursor),
    "data-cursor": String(isCursor),
    "data-id": notification.id,
    onclick: () => {
      state.cursorId = notification.id;
      const rows = visibleRows();
      state.cursorHint = Math.max(0, rows.findIndex((row) => row.id === notification.id));
      scheduleRender(["list", "detail"]);
    },
    ondblclick: () => openNotification(notification)
  }, [
    el("span", { class: "notification-accent" }),
    check,
    el("span", { class: "n-body" }, [
      el("span", { class: "n-top" }, [
        el("span", { class: "repo mono", text: repoOf(notification) }),
        summary.number ? el("span", { class: "n-num mono", text: `#${summary.number}` }) : null,
        stateBadge(summary),
        el("span", { class: "spacer" }),
        tracked ? el("span", { class: `t-mark ${tracked.priority ? "prio" : ""}`, title: tracked.priority ? "Tracked · priority" : "Tracked" }, [icon(tracked.priority ? "flag" : "star")]) : null,
        el("span", { class: "time mono", text: fmtAgoShort(notification.updated_at) })
      ]),
      el("span", { class: "title-row" }, [
        notification.unread !== false ? el("span", { class: "unread-dot" }) : null,
        el("span", { class: "title", text: summary.title })
      ]),
      el("span", { class: "meta-row" }, [
        el("span", { class: "pill strong", text: summary.reasonLabel }),
        assocPill(summary),
        bot ? el("span", { class: "pill bot" }, [icon("bot", "icon pill-icon"), el("span", { text: "bot" })]) : null,
        summary.actorLogin
          ? el("span", { class: "actor" }, [
            summary.actorAvatar ? el("img", { class: "avatar tiny", src: summary.actorAvatar, alt: "", loading: "lazy" }) : icon("user", "icon tiny-icon"),
            el("span", { text: summary.actorLogin })
          ])
          : null,
        summary.snippet ? el("span", { class: "snippet", text: summary.snippet }) : null
      ])
    ]),
    quick
  ]);
}

const CORE_ASSOC = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/* Author standing, from author_association on the thread the API already returns. */
function assocPill(summary) {
  if (!summary.assoc) return null;
  if (CORE_ASSOC.has(summary.assoc)) return el("span", { class: "pill assoc-core", text: "core" });
  if (summary.assoc.startsWith("FIRST_TIME")) return el("span", { class: "pill assoc-first", text: "first-time" });
  return null;
}

function stateBadge(summary) {
  if (!summary.state) {
    return summary.type && !["PullRequest", "Issue"].includes(summary.type)
      ? el("span", { class: "badge kind", text: summary.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() })
      : null;
  }
  const map = {
    open: { icon: summary.type === "Issue" ? "circleDot" : "gitPullRequest", label: "open" },
    draft: { icon: "gitPullRequest", label: "draft" },
    merged: { icon: "gitMerge", label: "merged" },
    closed: { icon: "x", label: "closed" }
  };
  const def = map[summary.state] || map.open;
  return el("span", { class: `badge st-${summary.state}` }, [icon(def.icon, "icon badge-icon"), el("span", { text: def.label })]);
}

/* Tracked view */

function renderTrackedView(slot) {
  const sections = trackedSections();
  const flat = sections.flatMap((section) => section.items);
  if (!flat.some((item) => item.key === state.trackedCursorKey)) {
    state.trackedCursorKey = flat[0]?.key || null;
  }

  const form = el("form", {
    class: "track-add",
    onsubmit: async (event) => {
      event.preventDefault();
      const input = document.querySelector("#trackUrlInput");
      if (!input) return;
      const ok = await trackByInput(input.value);
      if (ok) {
        input.value = "";
        scheduleRender(["list", "side"]);
      }
    }
  }, [
    icon("link"),
    el("input", {
      id: "trackUrlInput",
      type: "text",
      placeholder: "Track by URL or owner/repo#123",
      autocomplete: "off",
      spellcheck: "false"
    }),
    button({ className: "chip", label: "Track", text: "Track", iconName: "plus", onClick: null })
  ]);
  form.querySelector("button").type = "submit";

  const header = el("div", { class: "list-header" }, [
    el("div", { class: "list-title-wrap" }, [
      el("p", { class: "eyebrow", text: "Priority watchlist" }),
      el("h2", { class: "section-title", text: `${flat.length} tracked thread${flat.length === 1 ? "" : "s"}` })
    ]),
    el("div", { class: "list-tools" }, [
      button({
        className: "chip",
        label: "Re-check all tracked threads now",
        text: "Re-check",
        iconName: "refresh",
        onClick: () => { refreshTracked(true); toast("Re-checking tracked threads…"); }
      })
    ])
  ]);

  const sectionNodes = sections.map((section) => {
    if (!section.items.length) return null;
    return el("div", { class: `tracked-section ts-${section.id}` }, [
      el("div", { class: "ts-header" }, [
        el("span", { class: "ts-title", text: section.title }),
        el("span", { class: "ts-hint", text: section.hint }),
        el("span", { class: "spacer" }),
        section.id === "shipped"
          ? button({ className: "chip", label: "Clear all shipped", text: "Clear all", iconName: "trash", onClick: clearShipped })
          : el("span", { class: "ts-count mono", text: String(section.items.length) })
      ]),
      el("div", { class: "tracked-list" }, section.items.map((item) => trackedRow(item)))
    ]);
  }).filter(Boolean);

  slot.replaceChildren(
    header,
    form,
    flat.length
      ? el("div", { class: "tracked-scroll" }, sectionNodes)
      : el("div", { class: "empty" }, [
        el("div", { class: "empty-inner" }, [
          el("div", { class: "radar-pulse" }, [icon("star", "icon large")]),
          el("strong", { text: "Nothing tracked yet" }),
          el("span", { text: "Press t on any notification to pin its PR or issue here. Merged work files itself under Shipped so you can clear it." })
        ])
      ])
  );
}

function trackedRow(item) {
  const isCursor = item.key === state.trackedCursorKey;
  const fresh = trackedHasNew(item);
  const shipped = item.state === "merged" || item.state === "closed";
  return el("div", {
    class: `tracked-item ${fresh ? "fresh" : ""}`,
    role: "option",
    "aria-selected": String(isCursor),
    "data-cursor": String(isCursor),
    onclick: () => { state.trackedCursorKey = item.key; scheduleRender(["list", "detail"]); },
    ondblclick: () => { window.open(item.url, "_blank", "noopener"); markSeen(item); }
  }, [
    el("span", { class: `t-state st-${item.state}` }, [
      icon(item.state === "merged" ? "gitMerge" : item.state === "closed" ? "x" : item.type === "issue" ? "circleDot" : "gitPullRequest")
    ]),
    el("span", { class: "t-body" }, [
      el("span", { class: "t-top" }, [
        item.priority ? el("span", { class: "prio-flag", title: "Priority" }, [icon("flag")]) : null,
        el("span", { class: "repo mono", text: item.repo }),
        el("span", { class: "n-num mono", text: `#${item.number}` }),
        el("span", { class: `badge st-${item.state}`, text: item.state }),
        item.error ? el("span", { class: "badge st-closed", title: item.error, text: "fetch failed" }) : null,
        el("span", { class: "spacer" }),
        fresh ? el("span", { class: "new-dot", title: "New activity since you last looked" }) : null,
        el("span", { class: "time mono", text: fmtAgoShort(item.updatedAt) })
      ]),
      el("span", { class: "t-title", text: item.title })
    ]),
    el("span", { class: "hover-actions" }, [
      button({
        className: "ha-btn", label: item.priority ? "Unset priority (p)" : "Set priority (p)", iconName: "flag",
        pressed: item.priority,
        onClick: (event) => { event.stopPropagation(); toggleTrackedPriority(item); }
      }),
      shipped
        ? button({
          className: "ha-btn", label: "Clear (e)", iconName: "check",
          onClick: (event) => { event.stopPropagation(); clearTracked(item); }
        })
        : button({
          className: "ha-btn", label: "Mark seen (e)", iconName: "eye",
          onClick: (event) => { event.stopPropagation(); markSeen(item); }
        }),
      button({
        className: "ha-btn", label: "Untrack (t)", iconName: "x",
        onClick: (event) => { event.stopPropagation(); clearTracked(item); }
      }),
      button({
        className: "ha-btn", label: "Open on GitHub (o)", iconName: "external",
        onClick: (event) => { event.stopPropagation(); window.open(item.url, "_blank", "noopener"); markSeen(item); }
      })
    ])
  ]);
}

/* Detail pane */

function renderDetail() {
  const slot = document.querySelector("#detailSlot");
  if (!slot) return;
  if (state.view === "tracked") {
    const item = cursorTracked();
    slot.replaceChildren(item ? trackedDetail(item) : detailEmpty("Track a thread to see it here."));
    return;
  }
  const notification = cursorNotification();
  slot.replaceChildren(notification ? notifDetail(notification) : detailEmpty("Select a notification — j/k moves the cursor."));
}

function detailEmpty(message) {
  return el("div", { class: "detail-inner" }, [
    el("div", { class: "detail-header" }, [
      el("p", { class: "eyebrow", text: "Context" }),
      el("h2", { class: "detail-title", text: "Nothing selected" })
    ]),
    el("div", { class: "empty slim" }, [
      el("div", { class: "empty-inner" }, [
        el("div", { class: "radar-pulse" }, [icon("radar", "icon large")]),
        el("span", { text: message })
      ])
    ])
  ]);
}

function notifDetail(notification) {
  const summary = getSummary(notification);
  const repo = repoOf(notification);
  const tracked = trackedByKey(trackedKeyForNotification(notification) || "");

  return el("div", { class: "detail-inner", style: { "--lane-color": `var(--${summary.lane})` } }, [
    el("div", { class: "detail-header" }, [
      el("p", { class: "eyebrow", text: summary.reasonLabel }),
      el("h2", { class: "detail-title", text: summary.title }),
      el("div", { class: "pill-row" }, [
        stateBadge(summary),
        el("span", { class: "pill", text: notification.reason }),
        el("span", { class: "pill", text: summary.type }),
        ...(summary.pills || []).slice(0, 2).map((pill) => el("span", { class: "pill", text: pill }))
      ])
    ]),
    el("div", { class: "detail-content" }, [
      el("div", { class: "detail-actions" }, [
        button({ className: "primary-button", label: "Open on GitHub", iconName: "external", text: "Open", kbdHint: "o", onClick: () => openNotification(notification) }),
        button({ className: "action-btn", label: "Mark done", iconName: "check", text: "Done", kbdHint: "e", onClick: () => queueAction([notification], "done") }),
        button({ className: "action-btn", label: "Mark read", iconName: "eye", text: "Read", kbdHint: "r", onClick: () => actOnCursorTarget(notification, "read") }),
        button({ className: "action-btn", label: tracked ? "Untrack" : "Track", iconName: "star", text: tracked ? "Untrack" : "Track", kbdHint: "t", pressed: Boolean(tracked), onClick: () => toggleTrack(notification) }),
        button({ className: "action-btn", label: "Mute this thread", iconName: "bellOff", text: "Mute", kbdHint: "m", onClick: () => queueAction([notification], "mute") }),
        button({ className: "action-btn", label: `Mute repository ${repo}`, iconName: "eyeOff", text: "Mute repo", kbdHint: "M", onClick: () => muteRepo(repo) })
      ]),
      el("div", { class: "context-block" }, [
        el("h3", { text: "Why this ping exists" }),
        el("p", { text: summary.context || "GitHub did not return more context for this thread." })
      ]),
      el("div", { class: "meta-grid" }, [
        metaItem("Repository", repo),
        metaItem("Updated", fmtAgoLong(notification.updated_at)),
        metaItem("Thread", summary.number ? `${summary.type} #${summary.number}` : summary.type),
        metaItem("State", summary.state || (notification.unread === false ? "read" : "unread")),
        metaItem("Author standing", summary.assoc ? summary.assoc.toLowerCase().replaceAll("_", " ") : "—"),
        metaItem("Last actor", summary.actorLogin || "—")
      ]),
      summary.reviewers || summary.teams
        ? el("div", { class: "context-block" }, [
          el("h3", { text: "Requested reviewers" }),
          el("p", { text: `People: ${summary.reviewers || "none"}` }),
          el("p", { text: `Teams: ${summary.teams || "none"}` })
        ])
        : null,
      summary.snippet
        ? el("div", { class: "context-block" }, [
          el("h3", { text: "Latest visible text" }),
          el("pre", { text: summary.snippet })
        ])
        : null,
      !summary.enriched
        ? el("p", { class: "detail-foot", text: "Thread context is still loading (or your token cannot see this repo)." })
        : null
    ])
  ]);
}

function actOnCursorTarget(notification, mode) {
  state.cursorId = notification.id;
  actOnCursor(mode);
}

function trackedDetail(item) {
  const fresh = trackedHasNew(item);
  const shipped = item.state === "merged" || item.state === "closed";
  return el("div", { class: "detail-inner" }, [
    el("div", { class: "detail-header" }, [
      el("p", { class: "eyebrow", text: item.priority ? "Tracked · priority" : "Tracked" }),
      el("h2", { class: "detail-title", text: item.title }),
      el("div", { class: "pill-row" }, [
        el("span", { class: `badge st-${item.state}`, text: item.state }),
        el("span", { class: "pill mono", text: item.key }),
        fresh ? el("span", { class: "pill fresh", text: "new activity" }) : null
      ])
    ]),
    el("div", { class: "detail-content" }, [
      el("div", { class: "detail-actions" }, [
        button({ className: "primary-button", label: "Open on GitHub", iconName: "external", text: "Open", kbdHint: "o", onClick: () => { window.open(item.url, "_blank", "noopener"); markSeen(item); } }),
        shipped
          ? button({ className: "action-btn", label: "Clear from list", iconName: "check", text: "Clear", kbdHint: "e", onClick: () => clearTracked(item) })
          : button({ className: "action-btn", label: "Mark seen", iconName: "eye", text: "Seen", kbdHint: "e", onClick: () => markSeen(item) }),
        button({ className: "action-btn", label: item.priority ? "Unset priority" : "Set priority", iconName: "flag", text: item.priority ? "Unflag" : "Priority", kbdHint: "p", pressed: item.priority, onClick: () => toggleTrackedPriority(item) }),
        button({ className: "action-btn", label: "Untrack", iconName: "x", text: "Untrack", kbdHint: "t", onClick: () => clearTracked(item) })
      ]),
      el("div", { class: "meta-grid" }, [
        metaItem("Repository", item.repo),
        metaItem("Last activity", fmtAgoLong(item.updatedAt)),
        metaItem("You last looked", fmtAgoLong(item.lastSeen)),
        metaItem("Tracked since", fmtAgoLong(item.addedAt))
      ]),
      item.error
        ? el("div", { class: "context-block" }, [
          el("h3", { text: "Fetch problem" }),
          el("p", { text: `${item.error} — your token may not see this repository.` })
        ])
        : null,
      shipped
        ? el("div", { class: "context-block" }, [
          el("h3", { text: item.state === "merged" ? "Shipped" : "Closed" }),
          el("p", { text: "This thread reached a terminal state. Clear it (e) once acknowledged." })
        ])
        : null
    ])
  ]);
}

function metaItem(label, value) {
  return el("div", { class: "meta-item" }, [
    el("span", { class: "meta-label", text: label }),
    el("span", { class: "meta-value", text: String(value ?? "—") })
  ]);
}

/* Overlays */

function renderBulk() {
  const slot = document.querySelector("#bulkSlot");
  if (!slot) return;
  if (!state.checked.size || state.view === "tracked") {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(el("div", { class: "bulk-bar" }, [
    el("span", { class: "bulk-count mono", text: `${state.checked.size} selected` }),
    button({ className: "action-btn", label: "Mark selected done", iconName: "check", text: "Done", onClick: () => bulkAct("done") }),
    button({ className: "action-btn", label: "Mark selected read", iconName: "eye", text: "Read", onClick: () => bulkAct("read") }),
    button({ className: "action-btn", label: "Mute selected threads", iconName: "bellOff", text: "Mute", onClick: () => bulkAct("mute") }),
    button({ className: "action-btn", label: "Select everything in view (shift+X)", iconName: "checkCheck", text: "All in view", onClick: checkAllVisible }),
    button({ className: "action-btn quiet", label: "Clear selection (Esc)", iconName: "x", text: "Clear", onClick: clearChecked })
  ]));
}

function renderUndoBar() {
  const slot = document.querySelector("#undoSlot");
  if (!slot) return;
  if (!state.undo) {
    slot.replaceChildren();
    return;
  }
  const { mode, items } = state.undo;
  const bar = el("div", { class: "undo-bar" }, [
    icon("clock"),
    el("span", { class: "undo-text", text: `${items.length} thread${items.length === 1 ? "" : "s"} ${actionVerbs[mode]}` }),
    button({ className: "undo-btn", label: "Undo (u)", text: "Undo", kbdHint: "u", onClick: undoNow }),
    el("span", { class: "undo-progress", style: { animationDuration: `${UNDO_DELAY}ms` } })
  ]);
  slot.replaceChildren(bar);
}

function renderToastStack() {
  const slot = document.querySelector("#toastSlot");
  if (!slot) return;
  slot.replaceChildren(...state.toasts.map((entry) =>
    el("div", { class: `toast ${entry.kind}`, role: "status", text: entry.message })
  ));
}

const HELP_ROWS = [
  ["j / k", "move cursor down / up"],
  ["o / Enter", "open on GitHub (marks read)"],
  ["e", "done · in Tracked: mark seen / clear shipped"],
  ["r", "mark read"],
  ["m", "mute thread (unsubscribe + done)"],
  ["shift+m", "mute repository"],
  ["t", "track / untrack PR or issue"],
  ["p", "priority-track · toggle priority flag"],
  ["x", "select thread"],
  ["shift+x", "select everything in view"],
  ["u", "undo pending actions"],
  ["s", "toggle stale filter (merged/closed)"],
  ["i", "cycle type filter: all · PRs · issues"],
  ["1–5", "lanes: all · direct · review · ambient · system"],
  ["6", "tracked view"],
  ["/", "focus search"],
  ["shift+r", "refresh now"],
  ["Esc", "clear selection / search / filters"],
  ["?", "toggle this help"]
];

function renderModal() {
  const slot = document.querySelector("#modalSlot");
  if (!slot) return;
  if (!state.helpOpen) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(el("div", {
    class: "modal-backdrop",
    onclick: (event) => {
      if (event.target === event.currentTarget) {
        state.helpOpen = false;
        scheduleRender(["modal"]);
      }
    }
  }, [
    el("div", { class: "modal", role: "dialog", "aria-label": "Keyboard shortcuts" }, [
      el("div", { class: "modal-head" }, [
        el("div", {}, [
          el("p", { class: "eyebrow", text: "Pingboard" }),
          el("h2", { class: "section-title", text: "Keyboard shortcuts" })
        ]),
        button({ label: "Close", iconName: "x", onClick: () => { state.helpOpen = false; scheduleRender(["modal"]); } })
      ]),
      el("div", { class: "kbd-grid" }, HELP_ROWS.flatMap(([keys, desc]) => [
        el("span", { class: "kbd-keys" }, keys.split(" / ").flatMap((key, i) => i ? [el("span", { class: "kbd-sep", text: "/" }), el("kbd", { text: key })] : [el("kbd", { text: key })])),
        el("span", { class: "kbd-desc", text: desc })
      ])),
      el("p", { class: "modal-foot", text: "Actions wait 5 seconds before hitting GitHub — u takes them back." })
    ])
  ]));
}

/* Empty / loading */

function emptyBlock() {
  const swept = state.lane !== "all" || state.repoFilter || state.query;
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-inner" }, [
      el("div", { class: "radar-pulse" }, [icon("radar", "icon large")]),
      el("strong", { text: swept ? "Nothing in this slice" : "All clear" }),
      el("span", { text: swept ? "Change lanes, clear filters, or refresh when GitHub has new activity." : "Inbox zero. Go review something tracked, or touch grass." })
    ])
  ]);
}

function loadingBlock() {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-inner" }, [
      el("div", { class: "radar-pulse busy" }, [icon("radar", "icon large")]),
      el("span", { text: "Sweeping GitHub for activity…" })
    ])
  ]);
}

/* Auth view */

function renderAuthView() {
  const root = document.querySelector("#authRoot");
  if (!root) return;

  const tokenInput = el("input", {
    id: "token",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "ghp_…",
    value: state.token,
    oninput: (event) => { state.token = event.target.value.trim(); },
    onkeydown: (event) => { if (event.key === "Enter") connect(); }
  });

  root.replaceChildren(el("section", { class: "auth" }, [
    el("div", { class: "auth-brand" }, [
      el("div", { class: "brand-mark large" }, [icon("radar")]),
      el("p", { class: "eyebrow", text: "GitHub triage console" }),
      el("h1", { class: "auth-title", text: "Pingboard" }),
      el("p", { class: "auth-sub", text: "Sweep an oversubscribed notification inbox with your keyboard. Track the PRs that matter, mute the ones that don't." })
    ]),
    el("div", { class: "auth-body" }, [
      el("div", { class: "feature-grid" }, [
        authFeature("zap", "Keyboard triage", "j/k to move, e done, t track — with a 5s undo buffer."),
        authFeature("star", "Tracked PRs", "Pin priority threads; merged work files itself under Shipped."),
        authFeature("bellOff", "Noise controls", "Mute repos, hide bots, sweep stale merged/closed threads.")
      ]),
      el("div", { class: "callout" }, [
        icon("lock"),
        el("span", {
          html: "<strong>Classic token, kept in your browser.</strong> Minimum scope <code>notifications</code>; add <code>repo</code> for private-repo context. Calls go straight from this tab to api.github.com — no server in between."
        })
      ]),
      el("div", { class: "token-field" }, [
        el("label", { for: "token", text: "GitHub token" }),
        tokenInput
      ]),
      el("label", { class: "check-row", for: "remember" }, [
        el("input", {
          id: "remember",
          type: "checkbox",
          checked: state.remember ? "checked" : undefined,
          onchange: (event) => { state.remember = event.target.checked; }
        }),
        el("span", { text: "Keep token after closing this tab" })
      ]),
      el("div", { class: "auth-actions" }, [
        button({
          className: "primary-button",
          label: "Connect",
          iconName: "radar",
          text: state.authLoading ? "Connecting…" : "Connect",
          onClick: connect
        })
      ])
    ])
  ]));
}

function authFeature(iconName, title, body) {
  return el("div", { class: "feature" }, [
    el("div", { class: "feature-icon" }, [icon(iconName)]),
    el("strong", { text: title }),
    el("span", { text: body })
  ]);
}

/* ── 9. session, keyboard, boot ────────────────────────────────────────── */

async function connect() {
  if (!state.token) {
    toast("Paste a GitHub token first.", "error");
    return;
  }
  state.authLoading = true;
  render();
  try {
    state.user = await github("/user");
    if (state.remember) {
      localStorage.setItem(STORAGE_KEY, state.token);
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, state.token);
      localStorage.removeItem(STORAGE_KEY);
    }
    loadUserScopedState();
    render();
    await fetchNotifications();
    refreshTracked(true);
  } catch (error) {
    state.user = null;
    toast(error.status === 401 ? "GitHub rejected that token (401)." : error.message, "error");
  } finally {
    state.authLoading = false;
    render();
  }
}

function signOut() {
  flushPendingActions();
  clearTimeout(state.pollTimer);
  state.token = "";
  state.user = null;
  state.notifications = [];
  state.cache = new Map();
  state.tracked = [];
  state.mutedRepos = new Set();
  state.checked = new Set();
  state.cursorId = null;
  state.trackedCursorKey = null;
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  render();
}

function onKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  if (typing) return; // inputs own their keys; Esc handled by the input itself

  if (state.helpOpen) {
    if (["Escape", "?"].includes(event.key)) {
      state.helpOpen = false;
      scheduleRender(["modal"]);
      event.preventDefault();
    }
    return;
  }
  if (!state.user) return;

  const key = event.key;
  // Enter/Space on a focused button should stay native; don't double-fire.
  if ((key === "Enter" || key === " ") && target?.closest?.("button, a")) return;
  const handled = () => event.preventDefault();

  switch (key) {
    case "j": case "ArrowDown": moveCursor(1); return handled();
    case "k": case "ArrowUp": moveCursor(-1); return handled();
    case "o": case "Enter": openCursor(); return handled();
    case "e": actOnCursor("done"); return handled();
    case "r": actOnCursor("read"); return handled();
    case "m": actOnCursor("mute"); return handled();
    case "M": {
      const notification = cursorNotification();
      if (state.view === "inbox" && notification) muteRepo(repoOf(notification));
      return handled();
    }
    case "t": {
      if (state.view === "tracked") {
        const item = cursorTracked();
        if (item) clearTracked(item);
      } else {
        const notification = cursorNotification();
        if (notification) toggleTrack(notification);
      }
      return handled();
    }
    case "p": {
      if (state.view === "tracked") {
        const item = cursorTracked();
        if (item) toggleTrackedPriority(item);
      } else {
        const notification = cursorNotification();
        if (!notification) return handled();
        const existing = trackedByKey(trackedKeyForNotification(notification) || "");
        if (existing) toggleTrackedPriority(existing);
        else toggleTrack(notification, { priority: true });
      }
      return handled();
    }
    case "x": {
      if (state.view === "inbox") toggleCheck(cursorNotification());
      return handled();
    }
    case "X": {
      if (state.view === "inbox") checkAllVisible();
      return handled();
    }
    case "u": undoNow(); return handled();
    case "s": {
      if (state.view === "inbox") {
        state.staleOnly = !state.staleOnly;
        scheduleRender(["list"]);
      }
      return handled();
    }
    case "i": {
      if (state.view === "inbox") {
        state.typeFilter = state.typeFilter === null ? "pr" : state.typeFilter === "pr" ? "issue" : null;
        scheduleRender(["list"]);
      }
      return handled();
    }
    case "/": {
      const input = document.querySelector("#searchInput");
      if (input) { input.focus(); input.select(); }
      return handled();
    }
    case "?": state.helpOpen = true; scheduleRender(["modal"]); return handled();
    case "R": fetchNotifications(); refreshTracked(true); return handled();
    case "1": case "2": case "3": case "4": case "5": {
      state.view = "inbox";
      state.lane = lanes[Number(key) - 1].id;
      persistPrefs();
      render();
      return handled();
    }
    case "6": state.view = "tracked"; persistPrefs(); render(); return handled();
    case "Escape": {
      if (state.checked.size) clearChecked();
      else if (state.query.trim()) {
        state.query = "";
        const input = document.querySelector("#searchInput");
        if (input) input.value = "";
        scheduleRender(["list"]);
      } else if (state.repoFilter || state.staleOnly || state.typeFilter) {
        state.repoFilter = null;
        state.staleOnly = false;
        state.typeFilter = null;
        scheduleRender(["list", "side"]);
      }
      return handled();
    }
    default:
  }
}

async function boot() {
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("pagehide", flushPendingActions);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (state.user && Date.now() - state.lastSync > state.pollInterval * 1000) {
      fetchNotifications({ background: true, pages: state.fetchedPages || MAX_PAGES });
      refreshTracked();
    }
  });
  setInterval(() => {
    if (!document.hidden && state.user) scheduleRender(["top", "list"]);
  }, CLOCK_TICK_MS);

  render();
  if (state.token) {
    state.authLoading = true;
    try {
      state.user = await github("/user");
      loadUserScopedState();
      render();
      await fetchNotifications();
      refreshTracked(true);
    } catch {
      signOut();
      toast("Stored token no longer works — sign in again.", "error");
    } finally {
      state.authLoading = false;
      render();
    }
  }
}

/* Debug/console escape hatch (also used by UI tests). Not a public API. */
window.__pingboard = { state, render, boot, connect, fetchNotifications, queueAction, toggleTrack, trackByInput, visibleRows, getSummary };

boot();
