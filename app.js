"use strict";

/* Pingboard — a board for the pull requests you are shepherding through CI.
   Static, no build step: talks to the GitHub API straight from the browser.

   Sections
     1. constants + utils
     2. state + persistence
     3. github api
     4. PR model (checks, CI summary, failure evidence)
     5. refresh scheduler
     6. board operations (pins, groups, cursor)
     7. actions (comments, update branch, labels, review, merge)
     8. rendering
     9. modals
    10. keyboard + boot */

/* ── 1. constants + utils ──────────────────────────────────────────────── */

const TOKEN_KEY = "pingboard.githubToken";
const SESSION_KEY = "pingboard.sessionToken";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";

const DEFAULT_REPO = "vllm-project/vllm";
const REFRESH_CONCURRENCY = 4;
const REFRESH_BATCH = 10;           // PRs read per GraphQL request
const TICK_MS = 15 * 1000;
const CLOSED_TTL_S = 15 * 60;       // merged/closed PRs barely change
const HIDDEN_SLOWDOWN = 5;          // background tabs poll this much slower
const BASELINE_TTL_MS = 10 * 60 * 1000;
const BASELINE_COMMITS = 30;        // recent base-branch commits scanned for failing jobs
const LABELS_TTL_MS = 24 * 60 * 60 * 1000;
const ACTION_DELAY = 3000;          // ms before a comment / branch update is sent
const BOARD_WIDTH = 520;            // default list width in px; the detail pane takes the rest
const BOARD_MIN = 280;
const DETAIL_MIN = 380;
const RATE_FLOOR = 150;             // stop background polling below this many points
const GROUP_SEARCH_MS = 5 * 60 * 1000;
const UNPIN_CLOSED_MS = 24 * 60 * 60 * 1000;
const DISMISSED_MAX = 200;          // unpinned search results remembered per group

/* Per-repo workflow knowledge. Anything not listed gets GENERIC_PROFILE. */
const REPO_PROFILES = {
  "vllm-project/vllm": {
    ciPrefix: "buildkite/",         // only these checks count as "CI"; the rest are side checks
    mainPipeline: "ci",             // buildkite/<this>/… is the CI that gates merging; other pipelines are informational
    ciCommands: { run: "/ci run", retry: "/ci retry", cancel: "/ci cancel", stale: "/ci run --allow-stale" },
    quickLabels: ["ready", "verified"],
    mergeMethod: "squash"
  }
};
const GENERIC_PROFILE = { ciPrefix: null, mainPipeline: null, ciCommands: null, quickLabels: [], mergeMethod: "squash" };
const PROFILE_COMMAND_KEYS = ["run", "retry", "cancel", "stale"];
const MERGE_METHODS = new Set(["merge", "rebase", "squash"]);

function normalizeCommands(value, fallback) {
  if (value === null) return null;
  const source = value && typeof value === "object" ? value : fallback;
  if (!source) return null;
  const commands = Object.fromEntries(PROFILE_COMMAND_KEYS.map((key) => [key, typeof source[key] === "string" ? source[key].trim() : ""]));
  return PROFILE_COMMAND_KEYS.some((key) => commands[key]) ? commands : null;
}

function normalizeProfile(raw, fallback = GENERIC_PROFILE) {
  const value = raw && typeof raw === "object" ? raw : {};
  const labels = Array.isArray(value.quickLabels)
    ? [...new Set(value.quickLabels.filter((label) => typeof label === "string").map((label) => label.trim()).filter(Boolean))]
    : [...fallback.quickLabels];
  return {
    ciPrefix: typeof value.ciPrefix === "string" ? value.ciPrefix.trim() || null : fallback.ciPrefix,
    mainPipeline: typeof value.mainPipeline === "string" ? value.mainPipeline.trim() || null : fallback.mainPipeline,
    ciCommands: normalizeCommands(value.ciCommands, fallback.ciCommands),
    quickLabels: labels,
    mergeMethod: MERGE_METHODS.has(value.mergeMethod) ? value.mergeMethod : fallback.mergeMethod
  };
}

function normalizeRepoProfiles(raw) {
  if (!raw || typeof raw !== "object") return {};
  const profiles = {};
  for (const [repo, value] of Object.entries(raw)) {
    if (/^[\w.-]+\/[\w.-]+$/.test(repo) && value && typeof value === "object") {
      profiles[repo] = normalizeProfile(value, REPO_PROFILES[repo] || GENERIC_PROFILE);
    }
  }
  return profiles;
}

function profileFor(repo) {
  const base = REPO_PROFILES[repo] || GENERIC_PROFILE;
  return normalizeProfile(state.prefs.repoProfiles?.[repo], base);
}

const store = {
  get(key, fallback) {
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
    } catch {
      /* quota or private mode: the board still works for this session */
    }
  }
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function ago(value) {
  if (!value) return "";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function pinKey(repo, number) {
  return `${repo}#${number}`;
}

function shortRef(repo, number) {
  return repo === state.prefs.defaultRepo ? `#${number}` : `${repo}#${number}`;
}

/* URLs from the API end up in href / window.open; only ever follow web links. */
function safeUrl(url) {
  return /^https?:\/\//.test(url || "") ? url : null;
}

function openUrl(url) {
  if (safeUrl(url)) window.open(url, "_blank", "noopener");
}

/* "123", "#123", "owner/repo#123" or a PR URL; several may be pasted at once.
   Returns null when the input is not purely PR references (i.e. it is a search). */
function parseRefs(raw) {
  const refs = [];
  for (const token of raw.trim().split(/[\s,]+/).filter(Boolean)) {
    let match;
    if ((match = token.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/))) refs.push({ repo: match[1], number: Number(match[2]) });
    else if ((match = token.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/))) refs.push({ repo: match[1], number: Number(match[2]) });
    else if ((match = token.match(/^#?(\d+)$/))) refs.push({ repo: state.prefs.defaultRepo, number: Number(match[1]) });
    else return null;
  }
  return refs.length ? refs : null;
}

/* ── 2. state + persistence ────────────────────────────────────────────── */

const state = {
  token: localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(SESSION_KEY) || "",
  remember: Boolean(localStorage.getItem(TOKEN_KEY)),
  user: null,
  authLoading: false,
  authError: "",

  board: { groups: [], pins: [] },   // groups: [{id, name, collapsed, query?, dismissed?}]; pins: [{key, repo, number, group, addedAt, seen, seenActivity, via}]
  prefs: { interval: 60, notify: false, defaultRepo: DEFAULT_REPO, boardWidth: BOARD_WIDTH, following: [], repoProfiles: {}, sort: "manual", filter: "all", owner: "all", unpinClosed: false },

  data: new Map(),        // pin key -> PR model
  status: new Map(),      // pin key -> {at, loading, error}
  baselines: new Map(),   // "repo@branch" -> {at, total, counts: Map(jobKey -> commits failing)}
  commitFailures: new Map(), // "repo@oid" -> {hasCI, failed: [jobKey]} for finished base commits
  labels: new Map(),      // repo -> {at, items: [{name, color}]}
  searches: new Map(),    // group id -> {at, loading, error, missing: Set(pin key)}

  cursor: null,
  query: "",
  modal: null,
  pending: [],            // deferred actions: [{id, label, timer}]
  toasts: [],
  seq: 0,
  rate: { remaining: null, limit: null, reset: null },
  lastSync: 0
};

function scopedKey(suffix) {
  return `pingboard.v3.${state.user?.login || "anonymous"}.${suffix}`;
}

function normalizePrefs(raw) {
  const prefs = raw && typeof raw === "object" ? raw : {};
  return {
    interval: [30, 60, 120, 300].includes(prefs.interval) ? prefs.interval : 60,
    notify: Boolean(prefs.notify),
    boardWidth: Number(prefs.boardWidth) || BOARD_WIDTH,
    defaultRepo: /^[\w.-]+\/[\w.-]+$/.test(prefs.defaultRepo || "") ? prefs.defaultRepo : DEFAULT_REPO,
    following: parseLogins(Array.isArray(prefs.following) ? prefs.following.join(" ") : ""),
    repoProfiles: normalizeRepoProfiles(prefs.repoProfiles),
    sort: SORTS.some((sort) => sort.id === prefs.sort) ? prefs.sort : "manual",
    filter: FILTERS.some((filter) => filter.id === prefs.filter) ? prefs.filter : "all",
    owner: OWNERS.some((owner) => owner.id === prefs.owner) ? prefs.owner : "all",
    unpinClosed: Boolean(prefs.unpinClosed)
  };
}

function loadUserState() {
  state.prefs = normalizePrefs(store.get(scopedKey("prefs"), {}));

  state.board = cleanBoard(store.get(scopedKey("board"), null)) || { groups: [{ id: "g1", name: "Tracking", collapsed: false }], pins: [] };
  state.cursor = null;
}

/* Normalise a board read from storage or a backup file; null if it is not one. */
function cleanBoard(raw) {
  if (!Array.isArray(raw?.groups) || !Array.isArray(raw.pins)) return null;
  const groups = raw.groups
    .filter((group) => group && typeof group.id === "string" && typeof group.name === "string" && group.name.trim())
    .map((group) => ({
      id: group.id,
      name: group.name.trim(),
      collapsed: Boolean(group.collapsed),
      ...(typeof group.query === "string" && group.query.trim() ? {
        query: group.query.trim(),
        dismissed: (Array.isArray(group.dismissed) ? group.dismissed : []).filter((key) => /^[\w.-]+\/[\w.-]+#\d+$/.test(key)).slice(-DISMISSED_MAX)
      } : {})
    }));
  if (!groups.length) return null;
  const seen = new Set();
  const pins = [];
  for (const pin of raw.pins) {
    if (!pin || !/^[\w.-]+\/[\w.-]+$/.test(pin.repo || "") || !Number.isInteger(pin.number) || pin.number <= 0) continue;
    const key = pinKey(pin.repo, pin.number);
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push({
      key,
      repo: pin.repo,
      number: pin.number,
      group: groups.some((group) => group.id === pin.group) ? pin.group : groups[0].id,
      addedAt: Number(pin.addedAt) || Date.now(),
      ...(typeof pin.seen === "string" ? { seen: pin.seen } : {}),
      ...(typeof pin.seenActivity === "string" ? { seenActivity: pin.seenActivity } : {}),
      ...(groups.some((group) => group.id === pin.via) ? { via: pin.via } : {})
    });
  }
  return { groups, pins };
}

/* Another tab saved the board: adopt it, so this tab never writes a stale copy back over it. */
function syncFromStorage(event) {
  if (!state.user || event.storageArea !== localStorage) return;
  if (event.key === scopedKey("board")) {
    let board = null;
    try {
      board = cleanBoard(JSON.parse(event.newValue));
    } catch {
      /* unreadable: keep what this tab has */
    }
    if (!board) return;
    state.board = board;
    for (const key of [...state.data.keys()]) {
      if (!pinByKey(key)) {
        state.data.delete(key);
        state.status.delete(key);
      }
    }
    tick();
  }
}

function exportBoard() {
  const payload = {
    pingboard: 1,
    login: state.user.login,
    exportedAt: new Date().toISOString(),
    board: state.board,
    // Deliberately copy only non-secret preferences; the GitHub token is never exported.
    prefs: normalizePrefs(state.prefs)
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  el("a", { href: url, download: `pingboard-${state.user.login}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBoard(file) {
  let board = null;
  let prefs = null;
  try {
    const parsed = JSON.parse(await file.text());
    board = cleanBoard(parsed.board || parsed);
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "prefs")) {
      prefs = normalizePrefs(parsed.prefs);
    }
  } catch {
    /* handled below */
  }
  if (!board) return toast("That file is not a Pingboard backup", "error");
  const count = `${board.pins.length} pull request${board.pins.length === 1 ? "" : "s"}`;
  const applyPrefs = () => {
    if (!prefs) return;
    state.prefs = prefs;
    persistPrefs();
    applyBoardWidth();
  };
  openChoice({
    title: `Import ${count}?`,
    body: `From ${file.name}.${prefs ? " This backup includes non-secret preferences and repository profiles, but never your GitHub token." : ""} Adding keeps what is on your board now; replacing discards it.`,
    options: [
      {
        key: "Enter",
        label: "Add to my board",
        run: () => {
          const groupIds = new Map(board.groups.map((group) => {
            const target = ensureGroup(group.name);
            if (group.query && !target.query) Object.assign(target, { query: group.query, dismissed: group.dismissed });
            return [group.id, target.id];
          }));
          const added = board.pins.filter((pin) => addPin(pin.repo, pin.number, groupIds.get(pin.group))).length;
          applyPrefs();
          toast(`Added ${added} of ${count}`, "ok");
          render();
        }
      },
      {
        key: "r",
        label: "Replace my board",
        danger: true,
        run: () => {
          state.board = board;
          state.data.clear();
          state.status.clear();
          persistBoard();
          applyPrefs();
          toast(`Board replaced with ${count}`, "ok");
          tick();
        }
      }
    ]
  });
}

/* Authors the user follows: highlighted wherever they appear, and a list in Add PRs. */
function parseLogins(text) {
  const logins = [];
  for (const token of text.split(/[\s,@]+/)) {
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(token) && !logins.some((login) => login.toLowerCase() === token.toLowerCase())) logins.push(token);
  }
  return logins;
}

function isFollowed(login) {
  return state.prefs.following.some((item) => item.toLowerCase() === String(login).toLowerCase());
}

function toggleFollow(login) {
  const following = state.prefs.following;
  state.prefs.following = isFollowed(login) ? following.filter((item) => item.toLowerCase() !== login.toLowerCase()) : following.concat(login);
  persistPrefs();
  render();
}

function authorName(login) {
  return el("span", { class: `author${isFollowed(login) ? " followed" : ""}`, title: isFollowed(login) ? "You follow this author" : null, text: login });
}

function persistBoard() {
  store.set(scopedKey("board"), state.board);
}

function persistPrefs() {
  store.set(scopedKey("prefs"), state.prefs);
}

/* ── 3. github api ─────────────────────────────────────────────────────── */

function authHeaders() {
  return {
    Authorization: `Bearer ${state.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION
  };
}

async function rest(method, path, body) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 401) signOut("GitHub rejected the token.");
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!response.ok) throw new Error(json?.message || `${response.status} ${response.statusText}`);
  return json;
}

async function gql(query, variables = {}, { strict = false, partial = false } = {}) {
  const response = await fetch(`${API_ROOT}/graphql`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    state.rate = {
      remaining: Number(remaining),
      limit: Number(response.headers.get("x-ratelimit-limit")),
      reset: Number(response.headers.get("x-ratelimit-reset")) * 1000
    };
  }
  if (response.status === 401) signOut("GitHub rejected the token.");
  const json = await response.json().catch(() => null);
  // Reads tolerate partial errors (e.g. a ref that cannot be compared) because the
  // rest of the data is usable; a mutation that reports any error did not happen.
  if (!response.ok || !json?.data || (strict && json.errors?.length)) {
    throw new Error(json?.errors?.[0]?.message || json?.message || `${response.status} ${response.statusText}`);
  }
  return partial ? { data: json.data, errors: json.errors || [] } : json.data;
}

const CONTEXT_FIELDS = `
  __typename
  ... on StatusContext { context state description targetUrl createdAt }
  ... on CheckRun { name status conclusion detailsUrl startedAt checkSuite { app { slug } } }`;

const PR_FIELDS = `
fragment PullRequestFields on PullRequest {
  id number title url state isDraft updatedAt closedAt
  author { login } authorAssociation
  baseRefName headRefOid
  mergeable mergeStateStatus reviewDecision
  viewerCanUpdateBranch
  autoMergeRequest { enabledAt }
  additions deletions changedFiles
  labels(first: 40) { nodes { name color } }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { isViewer } } } }
  comments(last: 5) { nodes { author { login } bodyText createdAt url } }
  reviews(last: 5) { nodes { author { login } submittedAt } }
  commits(last: 1) { nodes { commit {
    oid committedDate
    statusCheckRollup { state contexts(first: 100) {
      totalCount
      statusContextCountsByState { state count }
      checkRunCountsByState { state count }
      pageInfo { hasNextPage endCursor }
      nodes { ${CONTEXT_FIELDS} }
    } }
  } } }
}`;

/* Many PRs in one request, each under its own alias (pr0, pr1, …). */
function prsQuery(count) {
  const at = [...Array(count).keys()];
  const params = at.map((i) => `$owner${i}: String!, $name${i}: String!, $number${i}: Int!, $baseRef${i}: String!, $headRef${i}: String!`);
  const fields = at.map((i) => `
  pr${i}: repository(owner: $owner${i}, name: $name${i}) {
    ref(qualifiedName: $baseRef${i}) { compare(headRef: $headRef${i}) { aheadBy behindBy } }
    pullRequest(number: $number${i}) { ...PullRequestFields }
  }`);
  return `query(${params.join(", ")}) {${fields.join("")}\n}\n${PR_FIELDS}`;
}

const CONTEXTS_QUERY = `
query($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit { statusCheckRollup { contexts(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${CONTEXT_FIELDS} }
    } } } }
  }
}`;

const BASE_HISTORY_QUERY = `
query($owner: String!, $name: String!, $ref: String!, $count: Int!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { ... on Commit { history(first: $count) {
      nodes { oid statusCheckRollup { state } }
    } } } }
  }
}`;

const SEARCH_QUERY = `
query($query: String!) {
  search(type: ISSUE, first: 30, query: $query) {
    issueCount
    nodes { ... on PullRequest {
      number title isDraft updatedAt url
      author { login }
      reviewDecision
      repository { nameWithOwner }
      labels(first: 8) { nodes { name color } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    } }
  }
}`;

async function fetchContexts(owner, name, oid, cursor = null) {
  const nodes = [];
  for (let page = 0; page < 15; page += 1) {
    const data = await gql(CONTEXTS_QUERY, { owner, name, oid, cursor });
    const contexts = data.repository?.object?.statusCheckRollup?.contexts;
    if (!contexts) break;
    nodes.push(...contexts.nodes);
    if (!contexts.pageInfo.hasNextPage) break;
    cursor = contexts.pageInfo.endCursor;
  }
  return nodes;
}

/* ── 4. PR model ───────────────────────────────────────────────────────── */

const STATUS_STATES = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };
const CHECK_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/* Flatten statuses + check runs into one shape, newest entry per name.
   Buildkite contexts look like buildkite/<pipeline>[/pr]/<job>; the bare
   buildkite/<pipeline>[/pr] context is the build itself. Dropping the "pr"
   segment makes job keys comparable between PR builds and base-branch builds. */
function normalizeChecks(nodes) {
  const byName = new Map();
  for (const node of nodes) {
    if (!node) continue;
    let check;
    if (node.__typename === "StatusContext") {
      check = { name: node.context, state: STATUS_STATES[node.state] || "pending", desc: node.description || "", url: safeUrl(node.targetUrl), at: node.createdAt };
    } else if (node.__typename === "CheckRun") {
      const done = node.status === "COMPLETED";
      check = {
        name: node.name,
        state: !done ? "pending" : node.conclusion === "SUCCESS" ? "pass" : CHECK_OK.has(node.conclusion) ? "skip" : "fail",
        desc: (done ? node.conclusion : node.status || "").toLowerCase().replace(/_/g, " "),
        url: safeUrl(node.detailsUrl),
        at: node.startedAt
      };
    } else {
      continue;
    }
    const bk = check.name.match(/^buildkite\/([^/]+)(?:\/(.*))?$/);
    if (bk) {
      check.pipeline = bk[1];
      check.job = (bk[2] || "").replace(/^pr(\/|$)/, "");
      check.isBuild = !check.job;
      check.jobKey = `${check.pipeline}/${check.job}`;
      check.label = check.isBuild ? `${check.pipeline} build` : check.job;
    } else {
      check.jobKey = check.name;
      check.label = check.name;
    }
    const prev = byName.get(check.name);
    if (!prev || (check.at || "") >= (prev.at || "")) byName.set(check.name, check);
  }
  return [...byName.values()];
}

function isCiCheck(check, profile) {
  if (!profile.ciPrefix) return true;
  if (!check.name.startsWith(profile.ciPrefix)) return false;
  return !profile.mainPipeline || check.pipeline === profile.mainPipeline;
}

/* A check from the CI system but not the gating pipeline (e.g. buildkite/amd-ci). */
function isAuxCheck(check, profile) {
  return Boolean(profile.ciPrefix) && check.name.startsWith(profile.ciPrefix) && !isCiCheck(check, profile);
}

function summarizeCi(checks, profile) {
  const ci = { state: "none", pass: 0, fail: 0, pending: 0, builds: [], failed: [], running: [], aux: [], other: { pass: 0, failed: [], running: [] } };
  for (const check of checks) {
    if (isAuxCheck(check, profile)) {
      ci.aux.push(check);
      continue;
    }
    if (!isCiCheck(check, profile)) {
      if (check.state === "pass") ci.other.pass += 1;
      else if (check.state === "fail") ci.other.failed.push(check);
      else if (check.state === "pending") ci.other.running.push(check);
      continue;
    }
    if (check.isBuild) {
      ci.builds.push(check);
    } else if (check.state === "fail") {
      ci.fail += 1;
      ci.failed.push(check);
    } else if (check.state === "pending") {
      ci.pending += 1;
      ci.running.push(check);
    } else if (check.state === "pass") {
      ci.pass += 1;
    }
  }
  const any = ci.builds.length + ci.pass + ci.fail + ci.pending > 0;
  if (!any) ci.state = "none";
  else if (ci.pending || ci.builds.some((build) => build.state === "pending")) ci.state = "running";
  else if (ci.fail || ci.builds.some((build) => build.state === "fail")) ci.state = "failed";
  else ci.state = "passed";
  ci.failed.sort((a, b) => a.label.localeCompare(b.label));
  ci.running.sort((a, b) => a.label.localeCompare(b.label));
  return ci;
}

/* Each pin's repository (with its pullRequest), or the Error that kept it out:
   GraphQL answers with partial data, and an error's path names its alias. */
async function loadPRs(pins, bases) {
  const variables = {};
  pins.forEach((pin, i) => {
    const [owner, name] = pin.repo.split("/");
    Object.assign(variables, {
      [`owner${i}`]: owner, [`name${i}`]: name, [`number${i}`]: pin.number,
      [`baseRef${i}`]: `refs/heads/${bases[i]}`, [`headRef${i}`]: `refs/pull/${pin.number}/head`
    });
  });
  try {
    const { data, errors } = await gql(prsQuery(pins.length), variables, { partial: true });
    return pins.map((_, i) => {
      if (data[`pr${i}`]?.pullRequest) return data[`pr${i}`];
      // A missing PR also fails its compare; that error would be misleading.
      const error = errors.find((entry) => entry.path?.[0] === `pr${i}` && entry.path[1] !== "ref");
      return new Error(error?.message || "Pull request not found (or the token cannot see it)");
    });
  } catch (error) {
    return pins.map(() => error);
  }
}

/* Reads [{ pin, options }] in one request (two if a base branch moved); each
   entry settles to its PR or its own Error. */
async function fetchPRs(entries) {
  const pins = entries.map((entry) => entry.pin);
  const bases = pins.map((pin) => state.data.get(pin.key)?.base || "main");
  const repos = await loadPRs(pins, bases);
  const moved = repos.flatMap((repo, i) => (!(repo instanceof Error) && repo.pullRequest.baseRefName !== bases[i] ? [i] : []));
  if (moved.length) {
    for (const i of moved) bases[i] = repos[i].pullRequest.baseRefName;
    const again = await loadPRs(moved.map((i) => pins[i]), moved.map((i) => bases[i]));
    moved.forEach((i, j) => (repos[i] = again[j]));
  }
  return Promise.all(entries.map(({ pin, options }, i) => (repos[i] instanceof Error ? repos[i] : toPR(pin, repos[i], bases[i], options).catch((error) => error))));
}

async function fetchPR(pin, options = {}) {
  const [pr] = await fetchPRs([{ pin, options }]);
  if (pr instanceof Error) throw pr;
  return pr;
}

async function toPR(pin, repo, base, { force = false } = {}) {
  const prev = state.data.get(pin.key);
  const [owner, name] = pin.repo.split("/");
  const pr = repo.pullRequest;
  const commit = pr.commits.nodes[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts;
  // Statuses do not bump the PR's updatedAt, so fingerprint the per-state counts:
  // while they are unchanged the previously paged job list is still right.
  const fingerprint = JSON.stringify([
    commit?.oid, contexts?.totalCount, contexts?.statusContextCountsByState, contexts?.checkRunCountsByState,
    contexts?.nodes.map((node) => node?.state || node?.conclusion || node?.status)
  ]);
  let checks;
  if (!contexts) {
    checks = [];
  } else if (!contexts.pageInfo.hasNextPage) {
    checks = normalizeChecks(contexts.nodes);
  } else if (!force && prev?.fingerprint === fingerprint) {
    checks = prev.checks;
  } else {
    const rest_ = await fetchContexts(owner, name, commit.oid, contexts.pageInfo.endCursor);
    checks = normalizeChecks(contexts.nodes.concat(rest_));
  }

  const profile = profileFor(pin.repo);
  return {
    key: pin.key,
    repo: pin.repo,
    number: pr.number,
    id: pr.id,
    title: pr.title,
    url: safeUrl(pr.url),
    state: pr.state,
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    author: pr.author?.login || "ghost",
    base,
    headOid: pr.headRefOid,
    headDate: commit?.committedDate,
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    canUpdate: pr.viewerCanUpdateBranch,
    autoMerge: Boolean(pr.autoMergeRequest),
    additions: pr.additions,
    deletions: pr.deletions,
    files: pr.changedFiles,
    labels: pr.labels.nodes,
    reviews: pr.latestOpinionatedReviews.nodes.map((review) => ({ login: review.author?.login || "ghost", state: review.state })),
    reviewRequested: pr.state === "OPEN" && pr.reviewRequests.nodes.some((request) => request.requestedReviewer?.isViewer),
    comments: pr.comments.nodes.map((comment) => ({ login: comment.author?.login || "ghost", text: comment.bodyText.slice(0, 700), at: comment.createdAt, url: safeUrl(comment.url) })),
    activityAt: newestActivity(pr),
    behind: repo.ref?.compare?.behindBy ?? null,
    checks,
    fingerprint,
    ci: summarizeCi(checks, profile)
  };
}

/* What the user has "seen" for a PR; a different signature lights the change dot.
   A review request is appended only while it stands, so other signatures stay as they were saved. */
function signature(pr) {
  const parts = [pr.state, pr.headOid, pr.ci.state, pr.ci.fail, pr.reviewDecision];
  return (pr.reviewRequested ? [...parts, "review-requested"] : parts).join("|");
}

/* Newest comment or review by someone else; COMMENTED reviews and repeat approvals don't change reviewDecision. */
function newestActivity(pr) {
  const items = pr.comments.nodes.map((comment) => [comment.author?.login, comment.createdAt])
    .concat(pr.reviews.nodes.map((review) => [review.author?.login, review.submittedAt]));
  return items.reduce((newest, [login, at]) => (at && login !== state.user.login && at > newest ? at : newest), "");
}

function hasChanged(pin) {
  const pr = state.data.get(pin.key);
  if (!pr) return false;
  return Boolean(pin.seen && pin.seen !== signature(pr)) || (pin.seenActivity !== undefined && pr.activityAt > pin.seenActivity);
}

/* Failing-job evidence, without reading logs:
     base   — the same job failed on N of the recent base-branch commits
     others — the same job is failing on other PRs on this board */
function failureIndex() {
  const index = new Map();
  for (const pr of state.data.values()) {
    if (pr.state !== "OPEN") continue;
    for (const check of pr.ci.failed) {
      if (!index.has(check.jobKey)) index.set(check.jobKey, []);
      index.get(check.jobKey).push(pr);
    }
  }
  return index;
}

function splitFailures(pr, index = failureIndex()) {
  const baseline = state.baselines.get(`${pr.repo}@${pr.base}`);
  const own = [];
  const shared = [];
  for (const check of pr.ci.failed) {
    const evidence = {
      base: baseline?.counts.get(check.jobKey) || 0,
      baseTotal: baseline?.total || 0,
      others: (index.get(check.jobKey) || []).filter((other) => other.key !== pr.key && other.repo === pr.repo)
    };
    (evidence.base || evidence.others.length ? shared : own).push({ check, evidence });
  }
  return { own, shared, baselineReady: Boolean(baseline) };
}

async function refreshBaseline(repo, base) {
  const key = `${repo}@${base}`;
  const [owner, name] = repo.split("/");
  const profile = profileFor(repo);
  const data = await gql(BASE_HISTORY_QUERY, { owner, name, ref: `refs/heads/${base}`, count: BASELINE_COMMITS });
  const commits = data.repository?.ref?.target?.history?.nodes || [];
  const failuresOf = async (commit) => {
    const cacheKey = `${repo}@${commit.oid}`;
    const cached = state.commitFailures.get(cacheKey);
    if (cached) return cached;
    const checks = normalizeChecks(await fetchContexts(owner, name, commit.oid)).filter((check) => isCiCheck(check, profile));
    const jobs = checks.filter((check) => !check.isBuild);
    const result = {
      hasCI: jobs.length > 0,
      finished: jobs.length > 0 && !checks.some((check) => check.state === "pending"),
      failed: jobs.filter((check) => check.state === "fail").map((check) => check.jobKey)
    };
    // Only a finished build is final. (The rollup turns FAILURE at the first failed
    // job, long before the build is done, so it cannot be used for this.)
    if (result.finished) state.commitFailures.set(cacheKey, result);
    return result;
  };
  const withChecks = commits.filter((commit) => commit.statusCheckRollup);
  const counts = new Map();
  let total = 0;
  for (let at = 0; at < withChecks.length; at += REFRESH_CONCURRENCY) {
    const results = await Promise.all(withChecks.slice(at, at + REFRESH_CONCURRENCY).map(failuresOf));
    for (const result of results) {
      // Count builds that are done, plus unfinished ones that already show a failure.
      if (!result.finished && !result.failed.length) continue;
      total += 1;
      for (const jobKey of result.failed) counts.set(jobKey, (counts.get(jobKey) || 0) + 1);
    }
  }
  state.baselines.set(key, { at: Date.now(), total, counts });
}

async function loadLabels(repo) {
  const cached = state.labels.get(repo) || store.get(`pingboard.v3.labels.${repo}`, null);
  if (cached && Date.now() - cached.at < LABELS_TTL_MS) {
    state.labels.set(repo, cached);
    return cached.items;
  }
  const items = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await rest("GET", `/repos/${repo}/labels?per_page=100&page=${page}`);
    items.push(...batch.map((label) => ({ name: label.name, color: label.color })));
    if (batch.length < 100) break;
  }
  const entry = { at: Date.now(), items };
  state.labels.set(repo, entry);
  store.set(`pingboard.v3.labels.${repo}`, entry);
  return items;
}

/* ── 5. refresh scheduler ──────────────────────────────────────────────── */

const refreshQueue = [];
const refreshQueued = new Set();
let refreshActive = 0;
const baselineInFlight = new Set();

const refreshAgain = new Set();   // keys whose in-flight refresh must be followed by a forced one

function queueRefresh(pin, options = {}) {
  if (refreshQueued.has(pin.key)) {
    if (!options.force) return;
    const waiting = refreshQueue.find((entry) => entry.pin.key === pin.key);
    if (waiting) waiting.options = { ...waiting.options, force: true };
    else refreshAgain.add(pin.key);
    return;
  }
  refreshQueued.add(pin.key);
  refreshQueue.push({ pin, options });
  queueMicrotask(pumpRefresh);   // let pins queued in the same tick share a request
}

function pumpRefresh() {
  while (refreshActive < REFRESH_CONCURRENCY && refreshQueue.length) {
    const batch = refreshQueue.splice(0, REFRESH_BATCH);
    refreshActive += 1;
    refreshPins(batch).finally(() => {
      refreshActive -= 1;
      for (const { pin } of batch) {
        refreshQueued.delete(pin.key);
        if (refreshAgain.delete(pin.key) && pinByKey(pin.key)) queueRefresh(pin, { force: true });
      }
      pumpRefresh();
    });
  }
}

async function refreshPins(batch) {
  for (const { pin } of batch) state.status.set(pin.key, { ...state.status.get(pin.key), loading: true });
  render();
  const results = await fetchPRs(batch);
  batch.forEach(({ pin }, i) => settleRefresh(pin, results[i]));
  refreshBaselines();
  render();
}

function settleRefresh(pin, pr) {
  if (pr instanceof Error) {
    state.status.set(pin.key, { at: Date.now(), loading: false, error: pr.message });
    return;
  }
  const prev = state.data.get(pin.key);
  if (!pinByKey(pin.key)) return;   // unpinned while the request was in flight
  state.data.set(pin.key, pr);
  // GitHub computes mergeability lazily; ask again shortly instead of showing a guess for a full interval.
  const unknownTries = pr.state === "OPEN" && pr.mergeable === "UNKNOWN" ? (state.status.get(pin.key)?.unknownTries || 0) + 1 : 0;
  state.status.set(pin.key, { at: Date.now(), loading: false, error: "", unknownTries });
  if (unknownTries && unknownTries <= 2) setTimeout(() => pinByKey(pin.key) && queueRefresh(pin), 4000);
  state.lastSync = Date.now();
  // Pins saved before seenActivity existed start from what is there now, so upgrading lights no dots.
  if (!pin.seen || pin.seenActivity === undefined) {
    pin.seen ||= signature(pr);
    pin.seenActivity ??= pr.activityAt;
    persistBoard();
  }
  if (prev && prev.headOid === pr.headOid && prev.ci.state === "running" && pr.ci.state !== "running") announceCi(pr);
}

function announceCi(pr) {
  const passed = pr.ci.state === "passed";
  const summary = passed ? "CI passed" : `CI finished · ${pr.ci.fail} failed`;
  toast(`${shortRef(pr.repo, pr.number)} ${summary}`, passed ? "ok" : "error");
  if (state.prefs.notify && "Notification" in window && Notification.permission === "granted") {
    const note = new Notification(`${shortRef(pr.repo, pr.number)} ${summary}`, { body: pr.title, tag: pr.key });
    note.onclick = () => {
      window.focus();
      setCursor(pr.key);
    };
  }
}

/* Keep the base-branch failure baseline fresh for every base an open PR targets.
   A failed read just leaves the previous baseline in place until the next try. */
function refreshBaselines() {
  const now = Date.now();
  for (const pr of state.data.values()) {
    const key = `${pr.repo}@${pr.base}`;
    if (pr.state !== "OPEN" || baselineInFlight.has(key)) continue;
    if (now - (state.baselines.get(key)?.at || 0) <= BASELINE_TTL_MS) continue;
    baselineInFlight.add(key);
    refreshBaseline(pr.repo, pr.base).catch(() => {}).finally(() => {
      baselineInFlight.delete(key);
      render();
    });
  }
}

function tick() {
  if (!state.user) return;
  const now = Date.now();
  const throttled = state.rate.remaining !== null && state.rate.remaining < RATE_FLOOR && now < state.rate.reset;
  if (!throttled) {
    const slowdown = document.hidden ? HIDDEN_SLOWDOWN : 1;
    for (const pin of state.board.pins) {
      const pr = state.data.get(pin.key);
      const status = state.status.get(pin.key);
      const ttl = (pr && pr.state !== "OPEN" ? CLOSED_TTL_S : state.prefs.interval) * 1000 * slowdown;
      if (!status?.at || now - status.at >= ttl) queueRefresh(pin);
    }
    for (const group of state.board.groups) {
      if (group.query && now - (state.searches.get(group.id)?.at || 0) >= GROUP_SEARCH_MS * slowdown) syncGroup(group.id);
    }
    refreshBaselines();
  }
  if (state.prefs.unpinClosed) {
    const old = state.board.pins.filter((pin) => {
      const pr = state.data.get(pin.key);
      return pr && pr.state !== "OPEN" && now - Date.parse(pr.closedAt) > UNPIN_CLOSED_MS;
    });
    if (old.length) {
      dropPins(old);
      toast(`Unpinned ${old.length} merged/closed over a day ago`);
    }
  }
  render();
}

/* Pin what a group's search finds, except results the user unpinned from it. A PR the
   search pinned is unpinned once two searches in a row miss it while it is still open;
   the forced refresh in between shows a merge as merged instead of making it vanish. */
async function syncGroup(id) {
  const group = state.board.groups.find((item) => item.id === id);
  const status = state.searches.get(id) || { missing: new Set() };
  if (!group?.query || status.loading) return;
  const query = group.query;
  state.searches.set(id, { ...status, loading: true });
  try {
    const data = await gql(SEARCH_QUERY, { query: `is:pr is:open ${query} sort:updated-desc` });
    const current = state.board.groups.find((item) => item.id === id);   // another tab may have replaced the board
    if (current?.query !== query) {
      state.searches.delete(id);
      return;
    }
    const found = new Set();
    let added = 0;
    for (const node of data.search.nodes) {
      if (!node?.number) continue;
      const repo = node.repository.nameWithOwner;
      found.add(pinKey(repo, node.number));
      if (!current.dismissed.includes(pinKey(repo, node.number)) && addPin(repo, node.number, id, id)) added += 1;
    }
    const missing = new Set();
    // Only a complete result list shows that a PR left the search.
    if (data.search.issueCount <= found.size) {
      const leaving = state.board.pins.filter((pin) => pin.via === id && pin.group === id && !found.has(pin.key) && state.data.get(pin.key)?.state === "OPEN");
      dropPins(leaving.filter((pin) => status.missing.has(pin.key)));
      for (const pin of leaving.filter((item) => !status.missing.has(item.key))) {
        missing.add(pin.key);
        queueRefresh(pin, { force: true });
      }
    }
    state.searches.set(id, { at: Date.now(), loading: false, error: "", missing });
    if (added) toast(`Pinned ${added} from the "${current.name}" search`);
  } catch (error) {
    state.searches.set(id, { ...status, at: Date.now(), loading: false, error: error.message });
  }
  render();
}

function refreshAll() {
  for (const pin of state.board.pins) queueRefresh(pin, { force: true });
  state.baselines.clear();
}

/* After an action: re-read the PR once GitHub has had a moment. Takes a key so a
   PR that was unpinned in the meantime is simply skipped. */
function refreshSoon(key) {
  for (const delay of [1500, 9000]) {
    setTimeout(() => {
      const pin = pinByKey(key);
      if (pin) queueRefresh(pin, { force: true });
    }, delay);
  }
}

/* ── 6. board operations ───────────────────────────────────────────────── */

function pinByKey(key) {
  return state.board.pins.find((pin) => pin.key === key);
}

function cursorPin() {
  return pinByKey(state.cursor);
}

function cursorPR() {
  return state.data.get(state.cursor);
}

function targetGroupId() {
  return cursorPin()?.group || state.board.groups[0].id;
}

/* `via` is the group whose search pinned it, so that search may unpin it again. */
function addPin(repo, number, group = targetGroupId(), via = null) {
  const key = pinKey(repo, number);
  if (pinByKey(key)) return false;
  const pin = { key, repo, number, group, addedAt: Date.now(), ...(via ? { via } : {}) };
  state.board.pins.push(pin);
  // Ask the browser not to evict this site's storage under disk pressure.
  navigator.storage?.persist?.().catch(() => {});
  const target = state.board.groups.find((item) => item.id === group);
  if (target && !via) target.collapsed = false;
  persistBoard();
  queueRefresh(pin);
  if (!state.cursor) state.cursor = key;
  return true;
}

function removePin(key) {
  const pin = pinByKey(key);
  if (!pin) return;
  const visible = visiblePins();
  const at = visible.findIndex((item) => item.key === key);
  const index = state.board.pins.indexOf(pin);
  const searched = state.board.groups.find((group) => group.id === pin.group && group.query);
  const dismissed = searched && !searched.dismissed.includes(key);
  if (dismissed) searched.dismissed = searched.dismissed.concat(key).slice(-DISMISSED_MAX);
  state.board.pins.splice(index, 1);
  state.data.delete(key);
  state.status.delete(key);
  if (state.cursor === key) state.cursor = (visible[at + 1] || visible[at - 1])?.key || null;
  persistBoard();
  toast(`Unpinned ${shortRef(pin.repo, pin.number)}`, "info", {
    label: "Undo",
    run: () => {
      if (pinByKey(key)) return;
      const from = dismissed && state.board.groups.find((item) => item.id === pin.group);
      if (from?.dismissed) from.dismissed = from.dismissed.filter((item) => item !== key);
      if (!state.board.groups.some((group) => group.id === pin.group)) pin.group = state.board.groups[0].id;
      state.board.pins.splice(Math.min(index, state.board.pins.length), 0, pin);
      persistBoard();
      queueRefresh(pin);
      setCursor(key);
    }
  });
}

/* Unpin without undo, and without remembering it as dismissed from a search. */
function dropPins(pins) {
  state.board.pins = state.board.pins.filter((pin) => !pins.includes(pin));
  for (const pin of pins) {
    state.data.delete(pin.key);
    state.status.delete(pin.key);
  }
  persistBoard();
}

function clearClosed() {
  const closed = state.board.pins.filter((pin) => {
    const pr = state.data.get(pin.key);
    return pr && pr.state !== "OPEN";
  });
  dropPins(closed);
  toast(closed.length ? `Cleared ${closed.length} merged/closed` : "Nothing merged or closed to clear");
}

function ensureGroup(name) {
  const existing = state.board.groups.find((group) => group.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const group = { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, collapsed: false };
  state.board.groups.push(group);
  persistBoard();
  return group;
}

function movePinToGroup(pin, group) {
  pin.group = group.id;
  group.collapsed = false;
  // Re-append so it lands at the end of its new group.
  state.board.pins = state.board.pins.filter((item) => item !== pin).concat(pin);
  persistBoard();
  render();
}

function newGroup() {
  openPrompt({
    title: "New group",
    placeholder: "Group name",
    submit: "Create",
    onSubmit(name) {
      if (state.board.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) return `There is already a group called "${name}".`;
      ensureGroup(name);
      return null;
    }
  });
}

/* Drag-and-drop target: place a pin in a group, before another pin or at the end. */
function dropPin(key, groupId, beforeKey = null) {
  const pin = pinByKey(key);
  if (!pin || key === beforeKey) return;
  const pins = state.board.pins.filter((item) => item !== pin);
  pin.group = groupId;
  const at = beforeKey ? pins.findIndex((item) => item.key === beforeKey) : -1;
  if (at === -1) pins.push(pin);
  else pins.splice(at, 0, pin);
  state.board.pins = pins;
  persistBoard();
}

function renameGroup(group) {
  openPrompt({
    title: `Rename "${group.name}"`,
    value: group.name,
    submit: "Rename",
    onSubmit(name) {
      if (state.board.groups.some((other) => other !== group && other.name.toLowerCase() === name.toLowerCase())) return `There is already a group called "${name}".`;
      group.name = name;
      persistBoard();
      return null;
    }
  });
}

function editGroupSearch(group) {
  openPrompt({
    title: `Sync "${group.name}" with a search`,
    hint: "New open pull requests it finds are pinned here; ones it pinned leave when they stop matching. Leave blank to stop.",
    value: group.query || "",
    placeholder: "e.g. review-requested:@me label:ready",
    submit: "Save",
    allowEmpty: true,
    onSubmit(text) {
      // Scoped to the default repository like Add PRs, unless it names its own scope.
      const query = !text || /(^|\s)(repo|org|user):/.test(text) ? text : `repo:${state.prefs.defaultRepo} ${text}`;
      if (query) Object.assign(group, { query, dismissed: group.dismissed || [] });
      else {
        delete group.query;
        delete group.dismissed;
      }
      state.searches.delete(group.id);
      persistBoard();
      tick();
      return null;
    }
  });
}

function deleteGroup(group) {
  if (state.board.groups.length === 1) return toast("The board needs at least one group");
  const fallback = state.board.groups.find((item) => item !== group);
  const count = state.board.pins.filter((pin) => pin.group === group.id).length;
  const remove = () => {
    for (const pin of state.board.pins) if (pin.group === group.id) pin.group = fallback.id;
    state.board.groups = state.board.groups.filter((item) => item !== group);
    persistBoard();
    render();
  };
  if (!count) return remove();
  openChoice({
    title: `Delete "${group.name}"?`,
    body: `Its ${count} pull request${count === 1 ? "" : "s"} will move to "${fallback.name}".`,
    options: [{ key: "Enter", label: "Delete group", danger: true, run: remove }]
  });
}

/* Reorder within the group by swapping with the neighbouring pin of that group. */
function shiftPin(delta) {
  const pin = cursorPin();
  if (!pin) return;
  if (isSorted()) return toast("Switch the sort to Manual order to reorder by hand");
  const pins = state.board.pins;
  const peers = pins.filter((item) => item.group === pin.group);
  const neighbour = peers[peers.indexOf(pin) + delta];
  if (!neighbour) return;
  const a = pins.indexOf(pin);
  const b = pins.indexOf(neighbour);
  [pins[a], pins[b]] = [pins[b], pins[a]];
  persistBoard();
  render();
  scrollCursorIntoView();
}

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "failing", label: "Failing", test: (pr) => pr?.state === "OPEN" && pr.ci.fail > 0 },
  { id: "running", label: "Running", test: (pr) => pr?.state === "OPEN" && pr.ci.state === "running" },
  { id: "green", label: "Green", test: (pr) => pr?.state === "OPEN" && pr.ci.state === "passed" },
  { id: "noci", label: "No CI", test: (pr) => pr?.state === "OPEN" && pr.ci.state === "none" },
  { id: "closed", label: "Closed", test: (pr) => Boolean(pr) && pr.state !== "OPEN" },
  { id: "requested", label: "Review requested", test: (pr) => Boolean(pr?.reviewRequested) }
];

const OWNERS = [
  { id: "all", label: "Everyone", test: () => true },
  { id: "mine", label: "Mine", test: (pr) => Boolean(pr) && isMine(pr) },
  { id: "others", label: "Others'", test: (pr) => Boolean(pr) && !isMine(pr) }
];

function isMine(pr) {
  return pr.author.toLowerCase() === state.user?.login.toLowerCase();
}

function setOwner(id) {
  state.prefs.owner = id;
  persistPrefs();
  reselect();
  render();
}

function cycleOwner() {
  setOwner(OWNERS[(OWNERS.findIndex((owner) => owner.id === state.prefs.owner) + 1) % OWNERS.length].id);
}

/* Orders within each group. Pins that have not loaded yet sort last. */
const TONE_ORDER = ["bad", "todo", "warn", "running", "good", "neutral", "done"];
const SORTS = [
  { id: "manual", label: "Manual order" },
  { id: "updated", label: "Recently updated", value: (pin, pr) => pr && Date.parse(pr.updatedAt) },
  { id: "added", label: "Recently pinned", value: (pin) => pin.addedAt },
  { id: "number", label: "Newest PR", value: (pin) => pin.number },
  { id: "status", label: "Needs attention", value: (pin, pr, index) => pr && -TONE_ORDER.indexOf(verdict(pr, index).tone) }
];

function isSorted() {
  return state.prefs.sort !== "manual";
}

function setSort(id) {
  state.prefs.sort = id;
  persistPrefs();
  scrollCursorIntoView();
}

function cycleSort() {
  setSort(SORTS[(SORTS.findIndex((sort) => sort.id === state.prefs.sort) + 1) % SORTS.length].id);
}

function sortPins(pins) {
  const sort = SORTS.find((item) => item.id === state.prefs.sort);
  if (!sort?.value) return pins;
  const index = failureIndex();
  const keyed = pins.map((pin) => {
    const pr = state.data.get(pin.key);
    return { pin, value: sort.value(pin, pr, index) ?? -Infinity, updated: pr ? Date.parse(pr.updatedAt) : -Infinity };
  });
  keyed.sort((a, b) => b.value - a.value || b.updated - a.updated);
  return keyed.map((item) => item.pin);
}

/* The selected PR stays listed even if a refresh moves it out of the filter, so
   actions never silently retarget to another row. */
function matchesView(pin) {
  return pin.key === state.cursor || matchesFilter(pin);
}

function setFilter(id) {
  state.prefs.filter = id;
  persistPrefs();
  reselect();
  render();
}

/* After the user changes what is shown, select the first real match. */
function reselect() {
  const pin = cursorPin();
  if (pin && !matchesFilter(pin)) state.cursor = null;
}

function matchesFilter(pin) {
  const pr = state.data.get(pin.key);
  const filter = FILTERS.find((item) => item.id === state.prefs.filter) || FILTERS[0];
  const owner = OWNERS.find((item) => item.id === state.prefs.owner) || OWNERS[0];
  if (!filter.test(pr) || !owner.test(pr)) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = `${pin.repo}#${pin.number} ${pr?.title || ""} ${pr?.author || ""} ${(pr?.labels || []).map((label) => label.name).join(" ")}`.toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
}

function groupPins(group) {
  return sortPins(state.board.pins.filter((pin) => pin.group === group.id && matchesView(pin)));
}

function visiblePins() {
  return state.board.groups.flatMap((group) => (group.collapsed ? [] : groupPins(group)));
}

function acknowledge(key) {
  const pin = pinByKey(key);
  const pr = state.data.get(key);
  if (!pin || !pr || (pin.seen === signature(pr) && pin.seenActivity === pr.activityAt)) return;
  pin.seen = signature(pr);
  pin.seenActivity = pr.activityAt;
  persistBoard();
}

function setCursor(key) {
  if (key !== state.cursor) acknowledge(state.cursor);
  state.cursor = key;
  acknowledge(key);
  render();
}

function moveCursor(delta) {
  const pins = visiblePins();
  if (!pins.length) return;
  const index = pins.findIndex((pin) => pin.key === state.cursor);
  const next = index === -1 ? 0 : Math.min(pins.length - 1, Math.max(0, index + delta));
  setCursor(pins[next].key);
  scrollCursorIntoView();
}

function scrollCursorIntoView() {
  scrollAfterRender = true;
  render();
}

/* ── 7. actions ────────────────────────────────────────────────────────── */

function toast(message, kind = "info", action = null) {
  const item = { id: (state.seq += 1), message, kind, action };
  state.toasts.push(item);
  setTimeout(() => dismissToast(item), action || kind === "error" ? 7000 : 3500);
  render();
}

function dismissToast(item) {
  state.toasts = state.toasts.filter((entry) => entry !== item);
  render();
}

async function perform(label, run) {
  try {
    await run();
    toast(`${label} — done`, "ok");
  } catch (error) {
    toast(`${label} failed: ${error.message}`, "error");
  }
}

/* Comments and branch updates are visible to others, so they wait ACTION_DELAY
   behind an undo bar before being sent. */
function defer(label, run) {
  const item = { id: (state.seq += 1), label };
  item.timer = setTimeout(() => {
    state.pending = state.pending.filter((entry) => entry !== item);
    render();
    perform(label, run);
  }, ACTION_DELAY);
  state.pending.push(item);
  render();
}

function undoPending() {
  const item = state.pending.pop();
  if (!item) return;
  clearTimeout(item.timer);
  toast(`Cancelled: ${item.label}`);
}

function postComment(pr, body) {
  defer(`${body} → ${shortRef(pr.repo, pr.number)}`, async () => {
    await rest("POST", `/repos/${pr.repo}/issues/${pr.number}/comments`, { body });
    refreshSoon(pr.key);
  });
}

function closedNotice(pr) {
  if (pr && pr.state !== "OPEN") toast(`${shortRef(pr.repo, pr.number)} is ${pr.state.toLowerCase()}`);
}

function ciCommand(kind, pr = cursorPR()) {
  if (!pr || pr.state !== "OPEN") return closedNotice(pr);
  const commands = profileFor(pr.repo).ciCommands;
  const command = commands?.[kind];
  if (!command) return toast(`No ${kind} command configured for ${pr.repo}`);
  if (kind !== "run" || !pr.behind) return postComment(pr, commands[kind]);
  // The bot refuses to start CI on a branch that is behind its base.
  openChoice({
    title: `${shortRef(pr.repo, pr.number)} is ${pr.behind} behind ${pr.base}`,
    body: `${commands.run} is refused on a branch that is behind its base.`,
    options: [
      pr.mergeable !== "CONFLICTING" && pr.canUpdate && { key: "Enter", label: `Update branch, then ${commands.run}`, run: () => updateBranch(pr, commands.run) },
      commands.stale && { key: "s", label: `Post ${commands.stale}`, run: () => postComment(pr, commands.stale) }
    ].filter(Boolean)
  });
}

/* Merge the base branch into the PR head; optionally post a command once the
   new head commit is visible (CI commands apply to the latest commit). */
function updateBranch(pr = cursorPR(), thenComment = null) {
  if (!pr || pr.state !== "OPEN") return closedNotice(pr);
  if (!pr.canUpdate) return toast(`You cannot update ${shortRef(pr.repo, pr.number)} — the author has not allowed maintainer edits`, "error");
  if (pr.behind === 0) return toast(`${shortRef(pr.repo, pr.number)} is already up to date with ${pr.base}`);
  if (pr.mergeable === "CONFLICTING") return toast(`${shortRef(pr.repo, pr.number)} has conflicts — it cannot be updated from here`, "error");
  const ref = shortRef(pr.repo, pr.number);
  defer(thenComment ? `Update branch + ${thenComment} → ${ref}` : `Update branch → ${ref}`, async () => {
    const before = pr.headOid;
    await rest("PUT", `/repos/${pr.repo}/pulls/${pr.number}/update-branch`, { expected_head_sha: before });
    if (!thenComment) return refreshSoon(pr.key);
    // Works from the PR itself, so it still finishes if the PR is unpinned meanwhile.
    const ref = { key: pr.key, repo: pr.repo, number: pr.number };
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await sleep(3000);
      const fresh = await fetchPR(ref, { force: true });
      if (fresh.headOid === before) continue;
      await rest("POST", `/repos/${pr.repo}/issues/${pr.number}/comments`, { body: thenComment });
      return refreshSoon(pr.key);
    }
    throw new Error(`the updated commit did not appear, so ${thenComment} was not posted`);
  });
}

async function toggleLabel(pr, name) {
  if (!pr || pr.state !== "OPEN") return closedNotice(pr);
  const had = pr.labels.some((label) => label.name === name);
  const before = pr.labels;
  const color = state.labels.get(pr.repo)?.items.find((label) => label.name === name)?.color || "888888";
  pr.labels = had ? before.filter((label) => label.name !== name) : before.concat({ name, color });
  render();
  try {
    if (had) await rest("DELETE", `/repos/${pr.repo}/issues/${pr.number}/labels/${encodeURIComponent(name)}`);
    else await rest("POST", `/repos/${pr.repo}/issues/${pr.number}/labels`, { labels: [name] });
    toast(`${had ? "Removed" : "Added"} ${name} · ${shortRef(pr.repo, pr.number)}`, "ok");
    // A refresh that started before the change may land after it with the old labels.
    refreshSoon(pr.key);
  } catch (error) {
    (state.data.get(pr.key) || pr).labels = before;
    toast(`Label ${name} on ${shortRef(pr.repo, pr.number)} failed: ${error.message}`, "error");
  }
  render();
}

function quickLabel(index, pr = cursorPR()) {
  const name = pr && profileFor(pr.repo).quickLabels[index];
  if (name) toggleLabel(pr, name);
}

function approve(pr = cursorPR()) {
  if (!pr || pr.state !== "OPEN") return closedNotice(pr);
  const ref = shortRef(pr.repo, pr.number);
  openChoice({
    title: `Approve ${ref}?`,
    body: pr.title,
    options: [{
      key: "Enter",
      label: "Submit approving review",
      run: () => perform(`Approve ${ref}`, async () => {
        await rest("POST", `/repos/${pr.repo}/pulls/${pr.number}/reviews`, { event: "APPROVE", commit_id: pr.headOid });
        refreshSoon(pr.key);
      })
    }]
  });
}

function mergeMenu(pr = cursorPR()) {
  if (!pr || pr.state !== "OPEN") return closedNotice(pr);
  const ref = shortRef(pr.repo, pr.number);
  const method = profileFor(pr.repo).mergeMethod;
  const autoMerge = (enable) => perform(`${enable ? "Enable" : "Disable"} auto-merge ${ref}`, async () => {
    const mutation = enable
      ? `mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { clientMutationId } }`
      : `mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }`;
    await gql(mutation, enable ? { id: pr.id, method: method.toUpperCase() } : { id: pr.id }, { strict: true });
    refreshSoon(pr.key);
  });
  openChoice({
    title: `Merge ${ref}`,
    body: `${pr.title} · CI ${pr.ci.state}${pr.ci.fail ? ` (${pr.ci.fail} failed)` : ""} · ${reviewWord(pr) || "no review decision"}`,
    options: [
      pr.autoMerge
        ? { key: "a", label: "Disable auto-merge", run: () => autoMerge(false) }
        : { key: "a", label: `Enable auto-merge (${method})`, run: () => autoMerge(true) },
      {
        key: "m",
        label: `${method[0].toUpperCase()}${method.slice(1)} and merge now`,
        danger: true,
        run: () => perform(`Merge ${ref}`, async () => {
          await rest("PUT", `/repos/${pr.repo}/pulls/${pr.number}/merge`, { merge_method: method, sha: pr.headOid });
          refreshSoon(pr.key);
        })
      }
    ]
  });
}

function openBuild(pr = cursorPR()) {
  if (!pr) return;
  const pipeline = profileFor(pr.repo).mainPipeline;
  const build = (pipeline && pr.ci.builds.find((item) => item.pipeline === pipeline)) || pr.ci.builds[0] || pr.ci.failed[0] || pr.ci.running[0];
  if (build?.url) openUrl(build.url);
  else toast("No CI build on the head commit");
}

/* ── 8. rendering ──────────────────────────────────────────────────────── */

let renderQueued = false;
let shellMode = null;

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    flushRender();
  });
}

let pointerHeld = false;
let dragKey = null;
let renderSkipped = false;      // a render was requested while it was unsafe to swap the DOM
let scrollAfterRender = false;

function selectingText() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const node = selection.anchorNode;
  return Boolean(node && (document.querySelector("#board")?.contains(node) || document.querySelector("#detail")?.contains(node)));
}

/* Rebuilding a pane drops keyboard focus; put it back on the same-named control. */
function keepFocus(container, build) {
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const label = active?.textContent;
  const tag = active?.tagName;
  build();
  if (!active) return;
  [...container.querySelectorAll(tag)].find((node) => node.textContent === label)?.focus({ preventScroll: true });
}

function flushRender() {
  // Replacing nodes mid-press would swallow the click, mid-drag would cancel it,
  // and mid-selection would throw away what the user is trying to copy.
  if (pointerHeld || dragKey || selectingText()) {
    renderSkipped = true;
    return;
  }
  renderSkipped = false;
  const app = document.querySelector("#app");
  const mode = state.user ? "board" : "auth";
  if (shellMode !== mode) {
    shellMode = mode;
    app.replaceChildren(mode === "board" ? buildShell() : buildAuth());
  }
  if (mode !== "board") return;

  const pins = visiblePins();
  if (!pins.some((pin) => pin.key === state.cursor)) state.cursor = pins[0]?.key || null;
  const index = failureIndex();

  renderTop();
  keepFocus(document.querySelector("#board"), () => renderBoard(index));
  keepFocus(document.querySelector("#detail"), () => renderDetail(index));
  renderOverlays();
  updateTitle();
  if (scrollAfterRender) {
    scrollAfterRender = false;
    document.querySelector(".row.cursor")?.scrollIntoView({ block: "nearest" });
  }
}

function updateTitle() {
  let failing = 0;
  let running = 0;
  for (const pr of state.data.values()) {
    if (pr.state !== "OPEN") continue;
    if (pr.ci.fail) failing += 1;
    if (pr.ci.state === "running") running += 1;
  }
  const badge = [failing && `${failing}✗`, running && `${running}●`].filter(Boolean).join(" ");
  document.title = `${badge ? `${badge} · ` : ""}Pingboard`;
}

function buildShell() {
  return el("div", { class: "shell" }, [
    el("header", { class: "top" }, [
      el("div", { class: "brand" }, [el("span", { class: "brand-dot" }), "Pingboard"]),
      el("div", { class: "top-right" }, [
        el("span", { class: "sync", id: "sync" }),
        el("button", { class: "btn primary", onclick: () => openAdd(), text: "+ Add PRs" }),
        el("button", { class: "btn", title: "Refresh everything now", onclick: refreshAll, text: "Refresh" }),
        el("button", { class: "btn", id: "me", title: "Settings", onclick: openSettings })
      ])
    ]),
    buildMain(),
    el("div", { id: "undo" }),
    el("div", { class: "toasts", id: "toasts" }),
    el("div", { id: "modal" })
  ]);
}

/* List on the left, detail on the right, with a draggable divider between them. */
function buildMain() {
  const main = el("main", { class: "main" });
  const divider = el("div", {
    class: "divider",
    role: "separator",
    title: "Drag to resize · double-click to reset",
    onpointerdown: (event) => {
      event.preventDefault();
      divider.setPointerCapture(event.pointerId);
      divider.classList.add("dragging");
    },
    onpointermove: (event) => {
      if (!divider.classList.contains("dragging")) return;
      state.prefs.boardWidth = Math.round(event.clientX - main.getBoundingClientRect().left);
      state.prefs.boardWidth = applyBoardWidth(main);
    },
    onpointerup: () => {
      divider.classList.remove("dragging");
      persistPrefs();
    },
    ondblclick: () => {
      state.prefs.boardWidth = BOARD_WIDTH;
      applyBoardWidth(main);
      persistPrefs();
    }
  });
  applyBoardWidth(main);
  const list = el("section", { class: "list" }, [
    el("div", { class: "list-bar" }, [
      el("input", {
        id: "filter",
        class: "filter",
        type: "search",
        placeholder: "Filter pinned PRs",
        spellcheck: "false",
        autocomplete: "off",
        "aria-label": "Filter pinned pull requests",
        oninput: (event) => {
          state.query = event.target.value;
          reselect();
          render();
        },
        onkeydown: (event) => {
          if (event.key === "Enter") event.target.blur();
          if (event.key === "Escape") {
            event.target.value = "";
            state.query = "";
            event.target.blur();
            render();
          }
        }
      }),
      el("select", {
        id: "sort",
        class: "sort",
        title: "Sort each group (s)",
        "aria-label": "Sort pinned pull requests",
        onchange: (event) => {
          setSort(event.target.value);
          event.target.blur();
        }
      }, SORTS.map((sort) => el("option", { value: sort.id, text: sort.label }))),
      el("div", { class: "chips", id: "chips" })
    ]),
    el("div", { class: "board", id: "board" })
  ]);
  main.append(list, divider, el("aside", { class: "detail", id: "detail" }));
  return main;
}

/* Show the preferred list width, limited to what the window can fit. */
function applyBoardWidth(main = document.querySelector(".main")) {
  const max = Math.max(BOARD_MIN, window.innerWidth - DETAIL_MIN);
  const width = Math.min(max, Math.max(BOARD_MIN, state.prefs.boardWidth));
  main?.style.setProperty("--board-w", `${width}px`);
  return width;
}

function renderTop() {
  // Each chip counts the pins it would show combined with the other row's selection.
  const filter = FILTERS.find((item) => item.id === state.prefs.filter) || FILTERS[0];
  const owner = OWNERS.find((item) => item.id === state.prefs.owner) || OWNERS[0];
  const counts = new Map([...FILTERS, ...OWNERS].map((item) => [item, 0]));
  for (const pin of state.board.pins) {
    const pr = state.data.get(pin.key);
    if (owner.test(pr)) for (const item of FILTERS) if (item.test(pr)) counts.set(item, counts.get(item) + 1);
    if (filter.test(pr)) for (const item of OWNERS) if (item.test(pr)) counts.set(item, counts.get(item) + 1);
  }
  const chip = (item, active, onclick, count) => el("button", {
    class: `chip-btn f-${item.id}${active ? " active" : ""}`,
    onclick
  }, [item.label, el("span", { class: "count", text: String(count) })]);
  document.querySelector("#chips").replaceChildren(
    el("div", { class: "chip-row" }, FILTERS.map((item) => chip(item, state.prefs.filter === item.id, () => setFilter(item.id), counts.get(item)))),
    el("div", { class: "chip-row" }, OWNERS.map((item) => chip(item, state.prefs.owner === item.id, () => setOwner(item.id), counts.get(item))))
  );

  const busy = refreshActive > 0;
  const rate = state.rate.remaining;
  const throttled = rate !== null && rate < RATE_FLOOR;
  const parts = [busy ? "syncing…" : state.lastSync ? `synced ${ago(state.lastSync)} ago` : ""];
  if (rate !== null) parts.push(throttled ? `rate limit low (${rate}) — paused until ${new Date(state.rate.reset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : `${rate} api`);
  const sync = document.querySelector("#sync");
  sync.className = `sync${busy ? " busy" : ""}${throttled ? " warn" : ""}`;
  sync.textContent = parts.filter(Boolean).join(" · ");
  document.querySelector("#me").textContent = "Settings";
  document.querySelector("#sort").value = state.prefs.sort;
}

/* The one-line answer to "what is going on with this PR, and what comes next?" */
function verdict(pr, index) {
  if (pr.state === "MERGED") return { tone: "done", text: "Merged" };
  if (pr.state === "CLOSED") return { tone: "done", text: "Closed" };

  const ci = pr.ci;
  const commands = profileFor(pr.repo).ciCommands;
  const behind = pr.behind || 0;
  const plural = (count) => (count === 1 ? "" : "s");
  const behindNote = behind ? ` The branch is ${behind} behind ${pr.base}.` : "";
  // Starting CI needs an up-to-date branch; offer the one-step version when we may push to it.
  const runCi = commands?.run && (!behind
    ? { label: "Run CI", run: () => postComment(pr, commands.run) }
    : pr.canUpdate
      ? { label: "Update branch & run CI", run: () => updateBranch(pr, commands.run) }
      : { label: "Run CI…", run: () => ciCommand("run", pr) });

  if (pr.mergeable === "CONFLICTING") {
    return { tone: "bad", text: "Merge conflicts", why: `The branch conflicts with ${pr.base}. The author has to resolve that before this can move.` };
  }

  if (ci.state === "running") {
    if (!ci.pass && !ci.fail && !ci.pending) return { tone: "running", text: "CI starting", why: "The build is queued; no jobs have reported yet." };
    return {
      tone: "running",
      text: ci.fail ? `CI running · ${ci.fail} failed so far` : "CI running",
      why: `${ci.pending} job${plural(ci.pending)} still running, ${ci.pass + ci.fail} finished.`
    };
  }

  const side = ci.other.failed;
  if (ci.state === "failed" && ci.fail) {
    const { own, shared, baselineReady } = splitFailures(pr, index);
    const mine = own.length + side.length;
    if (!baselineReady) {
      return { tone: "bad", text: `${ci.fail} failed job${plural(ci.fail)}`, why: `Checking whether they also fail on ${pr.base}…` };
    }
    if (mine) {
      return {
        tone: "bad",
        text: `${mine} failure${plural(mine)} to look at`,
        why: shared.length
          ? `${shared.length} more also fail${shared.length === 1 ? "s" : ""} on ${pr.base} or other pinned PRs and look${shared.length === 1 ? "s" : ""} unrelated.`
          : `Not failing on ${pr.base} or on other pinned PRs, so probably caused by this change.`
      };
    }
    return {
      tone: "warn",
      text: `${shared.length} failure${plural(shared.length)}, likely unrelated`,
      why: `Every failing job also fails on ${pr.base} or on other pinned PRs.`,
      action: commands?.retry && { label: "Retry failed jobs", run: () => postComment(pr, commands.retry) }
    };
  }

  if (side.length) {
    return {
      tone: "bad",
      text: side.length === 1 ? `${side[0].label} failing` : `${side.length} checks failing`,
      why: `${side.map((check) => check.label).join(", ")} — these run on every push and are the author's to fix.`
    };
  }

  if (ci.state === "failed") {
    return { tone: "warn", text: "CI build did not finish", why: "The build failed or was cancelled without a failing job.", action: runCi };
  }

  if (ci.state === "none") {
    if (!commands) return { tone: "neutral", text: "No checks reported" };
    return {
      tone: "todo",
      text: "CI not started",
      why: behind
        ? `No build on the latest commit, and the branch is ${behind} behind ${pr.base} — CI only starts on an up-to-date branch.`
        : "No build on the latest commit.",
      action: runCi
    };
  }

  // CI passed. Being behind only matters once GitHub itself says it blocks the merge.
  if (pr.mergeState === "BEHIND") {
    return {
      tone: "warn",
      text: `CI passed, but must catch up with ${pr.base}`,
      why: `GitHub requires the branch to be up to date before merging, and it is ${behind} behind. Updating means CI has to run again.`,
      action: runCi
    };
  }
  if (pr.autoMerge) return { tone: "good", text: "CI passed · auto-merge is on", why: `It merges by itself once the remaining requirements are met.${behindNote}` };
  if (pr.reviewDecision === "APPROVED") {
    return { tone: "good", text: "Ready to merge", why: `CI passed and the PR is approved.${behindNote}`, action: { label: "Merge…", run: () => mergeMenu(pr) } };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { tone: "warn", text: "CI passed · changes requested", why: behindNote.trim() };
  return { tone: "good", text: "CI passed · needs review", why: behindNote.trim() };
}

function renderBoard(index) {
  const board = document.querySelector("#board");
  if (!state.board.pins.length && state.board.groups.length === 1) {
    board.replaceChildren(el("div", { class: "empty" }, [
      el("h2", { text: "Nothing pinned yet" }),
      el("p", { text: "Pin the pull requests you are shepherding. Pingboard keeps their CI, branch freshness and review state in one view, and tells you what each one needs next." }),
      el("button", { class: "btn primary big", onclick: () => openAdd(), text: "+ Add pull requests" })
    ]));
    return;
  }
  const filtering = state.prefs.filter !== "all" || state.prefs.owner !== "all" || state.query.trim();
  const sections = [];
  for (const group of state.board.groups) {
    const pins = groupPins(group);
    if (filtering && !pins.length) continue;
    sections.push(el("div", {
      class: "group",
      ondragover: (event) => {
        if (!dragKey) return;
        event.preventDefault();
        event.currentTarget.classList.add("drop");
      },
      ondragleave: (event) => event.currentTarget.classList.remove("drop"),
      ondrop: (event) => {
        event.preventDefault();
        dropPin(dragKey, group.id);
      }
    }, [
      el("div", { class: "group-head" }, [
        el("button", {
          class: "group-toggle",
          title: group.collapsed ? "Expand" : "Collapse",
          onclick: () => {
            group.collapsed = !group.collapsed;
            persistBoard();
            render();
          }
        }, [el("span", { class: "caret", text: group.collapsed ? "▸" : "▾" }), group.name]),
        el("span", { class: "group-count", text: String(pins.length) }),
        groupSummary(pins, index),
        el("span", { class: "spacer" }),
        el("button", { class: "link-btn", onclick: () => openAdd(group.id), text: "+ Add" }),
        groupSearchButton(group),
        el("button", { class: "link-btn", onclick: () => renameGroup(group), text: "Rename" }),
        el("button", { class: "link-btn", onclick: () => deleteGroup(group), text: "Delete" })
      ]),
      !group.collapsed && el("div", { class: "rows" }, pins.length
        ? pins.map((pin) => row(pin, index))
        : el("div", { class: "group-empty", text: filtering ? "Nothing here matches." : "Empty — drag a pull request here, or use + Add." }))
    ]));
  }
  if (!sections.length) sections.push(el("div", { class: "empty" }, [el("p", { text: "No pinned pull requests match this filter." })]));
  else if (!filtering) sections.push(el("button", { class: "link-btn new-group", onclick: newGroup, text: "+ New group" }));
  // WebKit resets scrollTop when every child is replaced.
  const { scrollTop } = board;
  board.replaceChildren(...sections);
  board.scrollTop = scrollTop;
}

function groupSearchButton(group) {
  if (!group.query) return el("button", { class: "link-btn", onclick: () => editGroupSearch(group), text: "Sync search" });
  const status = state.searches.get(group.id);
  const detail = status?.error ? `Search failed: ${status.error}` : status?.at ? `Searched ${ago(status.at)} ago` : "Searching…";
  return el("button", {
    class: `link-btn group-search${status?.error ? " t-bad" : ""}`,
    title: `Pins new results of: ${group.query}\n${detail}`,
    onclick: () => editGroupSearch(group),
    text: `⟳ ${group.query.replace(`repo:${state.prefs.defaultRepo} `, "")}`
  });
}

function groupSummary(pins, index) {
  const tones = {};
  for (const pin of pins) {
    const pr = state.data.get(pin.key);
    if (!pr || pr.state !== "OPEN") continue;
    const tone = verdict(pr, index).tone;
    tones[tone] = (tones[tone] || 0) + 1;
  }
  const part = (tone, word) => (tones[tone] ? el("span", { class: `t-${tone}`, text: `${tones[tone]} ${word}` }) : null);
  return el("span", { class: "group-sum" }, [
    part("bad", "need a look"),
    part("todo", "waiting on you"),
    part("warn", "to nudge"),
    part("running", "running"),
    part("good", "green")
  ]);
}

function row(pin, index) {
  const pr = state.data.get(pin.key);
  const status = state.status.get(pin.key) || {};
  const result = pr ? verdict(pr, index) : { tone: "neutral" };
  const classes = ["row", `tone-${result.tone}`];
  if (pin.key === state.cursor) classes.push("cursor");
  if (hasChanged(pin)) classes.push("changed");
  const stop = (fn) => (event) => {
    event.stopPropagation();
    fn();
  };
  const props = {
    class: classes.join(" "),
    draggable: "true",
    onclick: () => setCursor(pin.key),
    ondragstart: (event) => {
      dragKey = pin.key;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", pr?.url || pin.key);
    },
    ondragover: (event) => {
      if (!dragKey || dragKey === pin.key || isSorted()) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.add("drop-before");
    },
    ondragleave: (event) => event.currentTarget.classList.remove("drop-before"),
    ondrop: (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropPin(dragKey, pin.group, pin.key);
    }
  };
  const unpin = el("button", { class: "icon-btn", title: "Unpin", onclick: stop(() => removePin(pin.key)), text: "×" });

  if (!pr) {
    return el("div", props, [
      el("div", { class: "row-main" }, [
        el("div", { class: `row-title${status.error ? " t-bad" : " muted"}`, text: status.error || "Loading…" }),
        el("div", { class: "row-meta", text: `${pin.repo}#${pin.number}` })
      ]),
      el("div", { class: "row-status" }),
      el("div", { class: "row-actions" }, [unpin])
    ]);
  }

  const quick = profileFor(pr.repo).quickLabels;
  const review = pr.state === "OPEN" && pr.reviewDecision !== "REVIEW_REQUIRED" ? reviewWord(pr) : "";
  return el("div", props, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [
        hasChanged(pin) ? el("span", { class: "new-dot", title: "Changed since you last looked" }) : null,
        stateBadge(pr),
        el("span", { class: "title-text", text: pr.title, title: pr.title })
      ]),
      el("div", { class: "row-meta" }, [
        el("a", { class: "num", href: pr.url, target: "_blank", rel: "noopener", title: "Open on GitHub", onclick: (event) => event.stopPropagation(), text: shortRef(pr.repo, pr.number) }),
        authorName(pr.author),
        pr.reviewRequested ? el("span", { class: "t-warn", text: "your review requested" }) : null,
        el("span", { title: new Date(pr.updatedAt).toLocaleString(), text: `updated ${ago(pr.updatedAt)} ago` }),
        review ? el("span", { class: pr.reviewDecision === "APPROVED" ? "t-good" : "t-bad", text: review }) : null,
        ...pr.labels.filter((label) => quick.includes(label.name)).map(labelChip),
        status.error ? el("span", { class: "t-bad", title: status.error, text: "refresh failed" }) : null
      ])
    ]),
    el("div", { class: "row-status" }, [
      el("div", { class: "verdict", text: result.text }),
      ciLine(pr)
    ]),
    el("div", { class: "row-actions" }, [
      result.action ? el("button", { class: "btn primary", onclick: stop(result.action.run), text: result.action.label }) : null,
      unpin
    ])
  ]);
}

/* Bar + counts in words; shared by the board rows and the detail pane. */
function ciLine(pr) {
  if (pr.state !== "OPEN") return el("div", { class: "ci-line" });
  const ci = pr.ci;
  const total = ci.pass + ci.fail + ci.pending;
  const segment = (kind, value) => (value ? el("span", { class: `seg ${kind}`, style: `flex:${value}` }) : null);
  const counts = [
    ci.pass ? el("span", { text: `${ci.pass} passed` }) : null,
    ci.fail ? el("span", { class: "t-bad", text: `${ci.fail} failed` }) : null,
    ci.pending ? el("span", { class: "t-running", text: `${ci.pending} running` }) : null,
    ci.other.failed.length ? el("span", { class: "t-bad", text: `${ci.other.failed.length} check${ci.other.failed.length === 1 ? "" : "s"} failed` }) : null
  ].filter(Boolean);
  const branch = pr.mergeable === "CONFLICTING" || !pr.behind ? null : el("span", { class: "t-warn", text: `${pr.behind} behind ${pr.base}` });
  return el("div", { class: "ci-line" }, [
    total ? el("span", { class: "bar", "aria-hidden": "true" }, [segment("pass", ci.pass), segment("fail", ci.fail), segment("pending", ci.pending)]) : null,
    ...counts,
    branch
  ]);
}

function stateBadge(pr) {
  if (pr.state === "MERGED") return el("span", { class: "badge merged", text: "merged" });
  if (pr.state === "CLOSED") return el("span", { class: "badge closed", text: "closed" });
  if (pr.isDraft) return el("span", { class: "badge draft", text: "draft" });
  return null;
}

function labelChip(label) {
  return el("span", { class: "tag", style: `--c:#${label.color}`, text: label.name });
}

function reviewWord(pr) {
  return { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "needs review" }[pr.reviewDecision] || "";
}

/* Detail pane */

function renderDetail(index) {
  const detail = document.querySelector("#detail");
  const pin = cursorPin();
  const pr = cursorPR();
  if (!pin) return detail.replaceChildren(el("div", { class: "detail-empty", text: "Select a pull request to see its CI, failures and actions." }));
  if (!pr) {
    const status = state.status.get(pin.key) || {};
    return detail.replaceChildren(el("div", { class: "detail-empty" }, [
      el("p", { text: `${pin.repo}#${pin.number}` }),
      el("p", { class: status.error ? "t-bad" : "muted", text: status.error || "Loading…" }),
      el("button", { class: "btn", onclick: () => removePin(pin.key), text: "Unpin" })
    ]));
  }

  const open = pr.state === "OPEN";
  const profile = profileFor(pr.repo);
  const commands = profile.ciCommands;
  const result = verdict(pr, index);
  const ci = pr.ci;
  const btn = (label, onclick, options = {}) => el("button", { class: `btn${options.primary ? " primary" : ""}${options.danger ? " danger" : ""}`, title: options.title, onclick, text: label });
  const hasLabel = (name) => pr.labels.some((label) => label.name === name);
  const { own, shared, baselineReady } = splitFailures(pr, index);
  const blocks = [];
  const primary = [];   // CI: the wide column
  const side = [];      // branch, review, labels, comments

  blocks.push(el("div", { class: "detail-head" }, [
    el("div", { class: "btn-row detail-tools" }, [
      btn("Open on GitHub ↗", () => openUrl(pr.url)),
      btn("Move to group…", () => openGroupPicker(pin)),
      btn("Refresh", () => queueRefresh(pin, { force: true })),
      btn("Unpin", () => removePin(pr.key))
    ]),
    el("div", { class: "detail-meta" }, [
      el("a", { href: pr.url, target: "_blank", rel: "noopener", text: `${pr.repo}#${pr.number}` }),
      stateBadge(pr),
      authorName(pr.author),
      el("button", { class: "link-btn", onclick: () => toggleFollow(pr.author), text: isFollowed(pr.author) ? "Following ✓" : "Follow" }),
      el("span", { class: "muted", text: `updated ${ago(pr.updatedAt)} ago` })
    ]),
    el("h2", { text: pr.title }),
    el("div", { class: "muted small", text: `+${pr.additions} −${pr.deletions} in ${pr.files} file${pr.files === 1 ? "" : "s"} · last commit ${ago(pr.headDate)} ago` })
  ]));

  blocks.push(el("div", { class: `banner tone-${result.tone}` }, [
    el("div", { class: "banner-text" }, [
      el("div", { class: "verdict", text: result.text }),
      result.why ? el("div", { class: "banner-why", text: result.why }) : null
    ]),
    result.action ? btn(result.action.label, result.action.run, { primary: true }) : null
  ]));

  if (open) {
    const build = ci.builds.map((item) => item.desc).filter(Boolean)[0];
    primary.push(panel("CI", [
      ci.state === "none"
        ? el("div", { class: "muted", text: commands ? "No build on the latest commit." : "No checks reported." })
        : ciLine({ ...pr, behind: 0 }),
      build ? el("div", { class: "muted small", text: build }) : null,
      el("div", { class: "btn-row" }, [
        commands?.run && btn("Run CI", () => ciCommand("run", pr), { title: `Comment ${commands.run}` }),
        commands?.retry && ci.fail ? btn("Retry failed", () => ciCommand("retry", pr), { title: `Comment ${commands.retry}` }) : null,
        commands?.cancel && ci.state === "running" ? btn("Cancel", () => ciCommand("cancel", pr), { title: `Comment ${commands.cancel}` }) : null,
        ci.builds.length ? btn("Open build ↗", () => openBuild(pr)) : null
      ]),
      ci.other.failed.length ? jobList("Failing checks", "bad", ci.other.failed.map((check) => ({ check }))) : null,
      own.length ? jobList(baselineReady ? "To look at — failing only on this PR" : `Failed jobs — still checking ${pr.base}`, "bad", own) : null,
      shared.length ? jobList("Likely unrelated — also failing elsewhere", "quiet", shared) : null,
      ci.running.length ? jobList("Running", "running", ci.running.map((check) => ({ check })), 8) : null,
      ci.other.running.length ? jobList("Other checks running", "running", ci.other.running.map((check) => ({ check })), 5) : null,
      ci.aux.length ? el("div", { class: "muted small" }, [
        "Other pipelines (informational): ",
        ...ci.aux.filter((check) => check.isBuild).map((check, i) => el("span", {}, [
          i ? " · " : "",
          el("a", { href: check.url, target: "_blank", rel: "noopener", text: check.pipeline }),
          ` ${check.state === "pass" ? "passed" : check.state === "fail" ? "failed" : "running"}`
        ]))
      ]) : null
    ]));

    const conflict = pr.mergeable === "CONFLICTING";
    side.push(panel("Branch", [
      el("div", { class: "split" }, [
        el("span", {
          class: conflict ? "t-bad" : pr.behind ? "t-warn" : "",
          text: conflict ? `Conflicts with ${pr.base}` : pr.behind === null ? `Targets ${pr.base}` : pr.behind ? `${pr.behind} commit${pr.behind === 1 ? "" : "s"} behind ${pr.base}` : `Up to date with ${pr.base}`
        }),
        pr.behind && !conflict && pr.canUpdate ? btn("Update branch", () => updateBranch(pr), { title: `Merge ${pr.base} into this branch` }) : null,
        pr.behind && !conflict && !pr.canUpdate ? el("span", { class: "muted small", text: "maintainer edits are off" }) : null
      ])
    ]));

    const mine = pr.reviews.find((review) => review.login === state.user.login);
    side.push(panel("Review & merge", [
      el("div", { text: reviewSentence(pr) }),
      pr.reviewRequested ? el("div", { class: "t-warn", text: "Your review is requested" }) : null,
      el("div", { class: "btn-row" }, [
        mine?.state === "APPROVED" ? el("span", { class: "t-good", text: "✓ You approved" }) : btn("Approve", () => approve(pr)),
        btn(pr.autoMerge ? "Auto-merge is on…" : "Merge…", () => mergeMenu(pr))
      ])
    ]));

    side.push(panel("Labels", [
      pr.labels.length ? el("div", { class: "label-wrap" }, pr.labels.map(labelChip)) : el("div", { class: "muted", text: "No labels" }),
      el("div", { class: "btn-row" }, [
        ...profile.quickLabels.map((name) => btn(hasLabel(name) ? `Remove ${name}` : `Add ${name}`, () => toggleLabel(pr, name))),
        btn("Edit labels…", () => openLabels(pr))
      ])
    ]));
  }

  const comments = [];
  if (pr.comments.length) {
    const section = panel("Latest comments", [el("div", { class: "comment-list" }, pr.comments.slice().reverse().map((comment) => el("a", { class: "comment", href: comment.url, target: "_blank", rel: "noopener" }, [
      el("span", { class: "comment-head", text: `${comment.login} · ${ago(comment.at)} ago` }),
      el("span", { class: "comment-body", text: comment.text })
    ])))]);
    section.classList.add("comments");
    comments.push(section);
  }

  if (primary.length) {
    blocks.push(el("div", { class: "detail-body" }, [
      el("div", { class: "detail-col" }, primary),
      el("div", { class: "detail-col" }, side)
    ]));
  }
  // Comments run the full width below, newest first.
  blocks.push(...comments);

  const scrollTop = detail.dataset.key === pin.key ? detail.scrollTop : 0;
  detail.replaceChildren(...blocks);
  detail.scrollTop = scrollTop;
  detail.dataset.key = pin.key;
}

function panel(title, children) {
  return el("section", { class: "panel" }, [el("h3", { text: title }), ...children]);
}

function reviewSentence(pr) {
  const by = (wanted) => pr.reviews.filter((review) => review.state === wanted).map((review) => review.login);
  const approved = by("APPROVED");
  const changes = by("CHANGES_REQUESTED");
  const parts = [];
  if (approved.length) parts.push(`Approved by ${approved.join(", ")}`);
  if (changes.length) parts.push(`Changes requested by ${changes.join(", ")}`);
  if (!parts.length) parts.push(pr.reviewDecision === "REVIEW_REQUIRED" ? "Waiting for a review" : "No reviews yet");
  if (pr.autoMerge) parts.push("auto-merge is on");
  return parts.join(" · ");
}

function jobList(title, kind, items, limit = 40) {
  const shown = items.slice(0, limit);
  return el("div", { class: `jobs ${kind}` }, [
    el("h4", { text: `${title} (${items.length})` }),
    ...shown.map(({ check, evidence }) => el("a", { class: "job", href: check.url || null, target: "_blank", rel: "noopener", title: `${check.name} — open the job` }, [
      el("span", { class: "job-name", text: check.label }),
      evidence ? el("span", { class: "job-evidence" }, [
        evidence.base ? el("span", { class: "ev", title: `Failed on ${evidence.base} of the last ${evidence.baseTotal} base-branch commits that ran CI`, text: `${evidence.base}/${evidence.baseTotal} on base` }) : null,
        evidence.others.length ? el("span", { class: "ev", title: "Also failing on these pinned PRs", text: `also ${evidence.others.slice(0, 3).map((other) => `#${other.number}`).join(" ")}${evidence.others.length > 3 ? ` +${evidence.others.length - 3}` : ""}` }) : null
      ]) : null
    ])),
    items.length > shown.length ? el("div", { class: "muted small", text: `+${items.length - shown.length} more` }) : null
  ]);
}

/* Overlays */

function renderOverlays() {
  const undo = document.querySelector("#undo");
  const pending = state.pending[state.pending.length - 1];
  undo.replaceChildren(pending ? el("div", { class: "undo-bar" }, [
    el("span", { text: `About to send: ${pending.label}${state.pending.length > 1 ? ` (+${state.pending.length - 1} more)` : ""}` }),
    el("button", { class: "btn primary", onclick: undoPending, text: "Undo" })
  ]) : "");

  document.querySelector("#toasts").replaceChildren(...state.toasts.map((item) => el("div", { class: `toast ${item.kind}` }, [
    item.message,
    item.action ? el("button", {
      class: "toast-btn",
      text: item.action.label,
      onclick: () => {
        dismissToast(item);
        item.action.run();
      }
    }) : null
  ])));
  state.modal?.update?.();
}

/* Auth view */

function buildAuth() {
  const input = el("input", {
    id: "token",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "ghp_…",
    value: state.token,
    oninput: (event) => {
      state.token = event.target.value.trim();
    },
    onkeydown: (event) => {
      if (event.key === "Enter") connect();
    }
  });
  return el("section", { class: "auth" }, [
    el("div", { class: "brand large" }, [el("span", { class: "brand-dot" }), "Pingboard"]),
    el("p", { class: "auth-sub", text: "One compact board for the pull requests you are shepherding through CI — status, failures, branch freshness and the usual maintainer actions, without a tab per PR." }),
    el("label", { for: "token", text: "GitHub classic token" }),
    input,
    el("p", { class: "muted small" }, [
      "Scope ", el("code", { text: "repo" }), " (or ", el("code", { text: "public_repo" }),
      " for public repositories only). It acts as you: comments, labels, reviews and merges are made under your account. The token stays in this browser and is sent only to api.github.com."
    ]),
    el("label", { class: "check-row" }, [
      el("input", {
        type: "checkbox",
        checked: state.remember,
        onchange: (event) => {
          state.remember = event.target.checked;
        }
      }),
      "Keep token after closing this tab"
    ]),
    state.authError ? el("p", { class: "t-fail", text: state.authError }) : null,
    el("button", { class: "btn primary", disabled: state.authLoading, onclick: connect, text: state.authLoading ? "Connecting…" : "Connect" })
  ]);
}

async function connect() {
  if (!state.token || state.authLoading) return;
  state.authLoading = true;
  state.authError = "";
  rerenderAuth();
  try {
    const user = await rest("GET", "/user");
    if (state.remember) {
      localStorage.setItem(TOKEN_KEY, state.token);
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, state.token);
      localStorage.removeItem(TOKEN_KEY);
    }
    state.user = user;
    loadUserState();
    tick();
  } catch (error) {
    state.authError = state.authError || error.message;
  }
  state.authLoading = false;
  rerenderAuth();
}

function rerenderAuth() {
  if (!state.user) shellMode = null;
  render();
}

function signOut(message = "") {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  state.token = "";
  state.user = null;
  state.modal = null;
  state.query = "";
  for (const item of state.pending) clearTimeout(item.timer);
  state.pending = [];
  state.toasts = [];
  state.authError = message;
  state.data.clear();
  state.status.clear();
  shellMode = null;
  render();
}

/* ── 9. modals ─────────────────────────────────────────────────────────── */

function closeModal() {
  state.modal = null;
  document.querySelector("#modal")?.replaceChildren();
  render();
}

function mountModal(modal, node) {
  document.activeElement?.blur();
  state.modal = modal;
  document.querySelector("#modal").replaceChildren(el("div", {
    class: "scrim",
    onmousedown: (event) => {
      if (event.target === event.currentTarget) closeModal();
    }
  }, [node]));
}

/* A short list of single-key choices; Esc cancels. */
function openChoice({ title, body, options }) {
  const pick = (option) => {
    closeModal();
    option.run();
  };
  mountModal({
    onKey(event) {
      const option = options.find((item) => item.key === event.key);
      if (!option) return;
      event.preventDefault();
      pick(option);
    }
  }, el("div", { class: "modal small" }, [
    el("h2", { text: title }),
    body ? el("p", { class: "muted", text: body }) : null,
    el("div", { class: "choices", id: "choices" }, [
      ...options.map((option, i) => el("button", { class: `btn${option.danger ? " danger" : i === 0 ? " primary" : ""}`, onclick: () => pick(option), text: option.label })),
      el("button", { class: "btn", onclick: closeModal, text: "Cancel" })
    ])
  ]));
  // Focus the first choice so Enter / Space act on what is visibly highlighted.
  document.querySelector("#choices button")?.focus();
}

/* One line of text. onSubmit returns an error message to keep the dialog open. */
function openPrompt({ title, hint = "", value = "", placeholder = "", submit, allowEmpty = false, onSubmit }) {
  const error = el("p", { class: "t-bad small" });
  const send = () => {
    const text = input.value.trim();
    if (!text && !allowEmpty) return;
    const problem = onSubmit(text);
    if (problem) error.textContent = problem;
    else closeModal();
  };
  const input = el("input", { type: "text", class: "picker-input", value, placeholder, "aria-label": title, spellcheck: "false", onkeydown: (event) => event.key === "Enter" && send() });
  mountModal({}, el("div", { class: "modal small" }, [
    el("h2", { text: title }),
    hint ? el("p", { class: "muted small", text: hint }) : null,
    input,
    error,
    el("div", { class: "choices" }, [
      el("button", { class: "btn primary", onclick: send, text: submit }),
      el("button", { class: "btn", onclick: closeModal, text: "Cancel" })
    ])
  ]));
  input.focus();
  input.select();
}

/* Text input over a filterable list. `getItems(query)` returns
   [{id, node}] synchronously; async sources call modal.update() when ready. */
function openPicker({ title, placeholder, hint, tabs, getItems, onPick, onQuery, onTab }) {
  const list = el("div", { class: "picker-list" });
  const tabRow = el("div", { class: "tabs" });
  const modal = {
    query: "",
    index: 0,
    items: [],
    update() {
      modal.items = getItems(modal.query, modal);
      modal.index = Math.min(modal.index, Math.max(0, modal.items.length - 1));
      list.replaceChildren(...modal.items.map((item, i) => el("div", {
        class: `picker-item${i === modal.index ? " active" : ""}`,
        onclick: () => {
          modal.index = i;
          onPick(item, modal);
          if (state.modal !== modal) return;
          modal.update();
          input.focus();
        }
      }, [item.node])));
      if (!modal.items.length) list.append(el("div", { class: "picker-empty muted", text: modal.emptyText || "No matches" }));
      if (tabs) {
        tabRow.replaceChildren(...tabs.map((tab) => el("button", {
          class: `chip-btn${modal.tab === tab.id ? " active" : ""}`,
          text: tab.label,
          onclick: () => {
            modal.tab = tab.id;
            onTab(modal);
            input.focus();
          }
        })));
      }
    }
  };
  const input = el("input", {
    class: "picker-input",
    type: "text",
    placeholder,
    "aria-label": title,
    spellcheck: "false",
    autocomplete: "off",
    oninput: (event) => {
      modal.query = event.target.value;
      modal.index = 0;
      onQuery?.(modal);
      modal.update();
    },
    onkeydown: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        modal.index = Math.min(modal.items.length - 1, Math.max(0, modal.index + step));
        modal.update();
        list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        onPick(modal.items[modal.index] || null, modal);
        if (state.modal === modal) modal.update();
      } else if (event.key === "Tab" && tabs) {
        event.preventDefault();
        const at = tabs.findIndex((tab) => tab.id === modal.tab);
        modal.tab = tabs[(at + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length].id;
        onTab(modal);
      }
    }
  });
  modal.input = input;
  if (tabs) modal.tab = tabs[0].id;
  mountModal(modal, el("div", { class: "modal" }, [
    el("h2", { text: title }),
    input,
    tabs ? tabRow : null,
    list,
    el("div", { class: "modal-foot" }, [
      el("span", { class: "muted small", text: hint }),
      el("button", { class: "btn", onclick: closeModal, text: "Done" })
    ])
  ]));
  modal.update();
  input.focus();
  return modal;
}

/* Add / discover PRs */

const searchCache = new Map();   // query -> {at, count, nodes}

function openAdd(groupId = targetGroupId()) {
  const repo = state.prefs.defaultRepo;
  const quick = profileFor(repo).quickLabels[0];
  const tabs = [
    { id: "mine", label: "Mine", q: "author:@me" },
    { id: "requested", label: "Review requested", q: "user-review-requested:@me" },
    { id: "reviewed", label: "Reviewed", q: "reviewed-by:@me" },
    { id: "involved", label: "Involved", q: "involves:@me" },
    { id: "following", label: "Following", q: state.prefs.following.map((login) => `author:${login}`).join(" ") },
    ...(quick ? [{ id: "quick", label: quick, q: `label:${quick}` }] : []),
    { id: "recent", label: "All recent", q: "" }
  ];
  const group = state.board.groups.find((item) => item.id === groupId) || state.board.groups[0];
  const queryFor = (modal) => {
    const tab = tabs.find((item) => item.id === modal.tab);
    // "@name" in the search box is shorthand for GitHub's author:name.
    const text = modal.query.trim().replace(/(^|\s)@([A-Za-z0-9-]+)/g, "$1author:$2");
    return ["is:pr is:open", `repo:${repo}`, tab.q, text, "sort:updated-desc"].filter(Boolean).join(" ");
  };
  const nobodyFollowed = (modal) => modal.tab === "following" && !state.prefs.following.length;
  const search = async (modal) => {
    if (parseRefs(modal.query) || nobodyFollowed(modal)) return modal.update();
    const query = queryFor(modal);
    const cached = searchCache.get(query);
    if (cached && Date.now() - cached.at < 60000) return modal.update();
    modal.loading = true;
    modal.update();
    try {
      const data = await gql(SEARCH_QUERY, { query });
      searchCache.set(query, { at: Date.now(), count: data.search.issueCount, nodes: data.search.nodes.filter((node) => node?.number) });
      modal.error = "";
    } catch (error) {
      modal.error = error.message;
    }
    modal.loading = false;
    if (state.modal === modal) modal.update();
  };
  const searchSoon = debounce(search, 300);

  search(openPicker({
    title: `Add pull requests → ${group.name}`,
    placeholder: `Search ${repo}, @author, or paste PR numbers / URLs`,
    hint: "Click a pull request to pin it; click again to unpin.",
    tabs,
    onQuery: searchSoon,
    onTab: search,
    getItems(query, modal) {
      const refs = parseRefs(query);
      if (refs) {
        modal.emptyText = "";
        return refs.map((ref) => ({
          id: pinKey(ref.repo, ref.number),
          ref,
          node: el("div", { class: "result" }, [
            el("span", { class: "num", text: `${ref.repo}#${ref.number}` }),
            el("span", { class: "muted", text: pinByKey(pinKey(ref.repo, ref.number)) ? "already pinned" : "press Enter to pin" })
          ])
        }));
      }
      if (nobodyFollowed(modal)) {
        modal.emptyText = "You are not following anyone yet. Add usernames in Settings, or use Follow next to an author's name.";
        return [];
      }
      const result = searchCache.get(queryFor(modal));
      modal.emptyText = modal.error || (modal.loading || !result ? "Searching…" : "No open pull requests match");
      return (result?.nodes || []).map((node) => {
        const ref = { repo: node.repository.nameWithOwner, number: node.number };
        const rollup = node.commits.nodes[0]?.commit.statusCheckRollup?.state;
        const pinned = Boolean(pinByKey(pinKey(ref.repo, ref.number)));
        return {
          id: pinKey(ref.repo, ref.number),
          ref,
          node: el("div", { class: `result${pinned ? " pinned" : ""}` }, [
            el("span", { class: `rollup ${(rollup || "none").toLowerCase()}`, title: `Checks: ${(rollup || "none").toLowerCase()}` }),
            el("span", { class: "num", text: `#${node.number}` }),
            el("span", { class: "title-text", text: node.title }),
            el("span", { class: "tags" }, node.labels.nodes.filter((label) => profileFor(ref.repo).quickLabels.includes(label.name)).map(labelChip)),
            authorName(node.author?.login || "ghost"),
            el("span", { class: "age", text: ago(node.updatedAt) }),
            el("span", { class: `pin-mark${pinned ? " on" : ""}`, text: pinned ? "✓ Pinned" : "Pin" })
          ])
        };
      });
    },
    onPick(item, modal) {
      if (!item) return;
      const refs = parseRefs(modal.query);
      if (refs) {
        const added = refs.filter((ref) => addPin(ref.repo, ref.number, group.id)).length;
        toast(added ? `Pinned ${added} PR${added > 1 ? "s" : ""} to ${group.name}` : "Already pinned");
        modal.input.value = "";
        modal.query = "";
        search(modal);
        return;
      }
      if (pinByKey(item.id)) removePin(item.id);
      else addPin(item.ref.repo, item.ref.number, group.id);
      render();
    }
  }));
}

function openLabels(pr = cursorPR()) {
  if (!pr || pr.state !== "OPEN") return;
  let all = state.labels.get(pr.repo)?.items || [];
  const appliedAtOpen = new Set(pr.labels.map((label) => label.name));
  const modal = openPicker({
    title: `Labels · ${shortRef(pr.repo, pr.number)}`,
    placeholder: "Filter labels",
    hint: "Click a label to add or remove it.",
    getItems(query) {
      const current = state.data.get(pr.key) || pr;
      const has = (name) => current.labels.some((label) => label.name === name);
      const needle = query.trim().toLowerCase();
      return all
        .filter((label) => label.name.toLowerCase().includes(needle))
        .sort((a, b) => appliedAtOpen.has(b.name) - appliedAtOpen.has(a.name) || a.name.localeCompare(b.name))
        .map((label) => ({
          id: label.name,
          node: el("div", { class: "result" }, [el("span", { class: "check", text: has(label.name) ? "✓" : "" }), labelChip(label)])
        }));
    },
    onPick(item) {
      if (item) toggleLabel(state.data.get(pr.key) || pr, item.id);
    }
  });
  modal.emptyText = all.length ? "No labels match" : "Loading labels…";
  loadLabels(pr.repo).then((items) => {
    all = items;
    modal.emptyText = "No labels match";
    if (state.modal === modal) modal.update();
  }).catch((error) => {
    modal.emptyText = error.message;
    if (state.modal === modal) modal.update();
  });
}

function openGroupPicker(pin = cursorPin()) {
  if (!pin) return;
  openPicker({
    title: `Move ${shortRef(pin.repo, pin.number)} to group`,
    placeholder: "Group name — type a new one to create it",
    hint: "Pick a group, or type a new name to create one.",
    getItems(query) {
      const needle = query.trim().toLowerCase();
      const items = state.board.groups
        .filter((group) => group.name.toLowerCase().includes(needle))
        .map((group) => ({ id: group.id, group, node: el("div", { class: "result" }, [group.name, group.id === pin.group ? el("span", { class: "muted", text: "current" }) : null]) }));
      if (needle && !state.board.groups.some((group) => group.name.toLowerCase() === needle)) {
        items.push({ id: "new", name: query.trim(), node: el("div", { class: "result" }, [`Create "${query.trim()}"`]) });
      }
      return items;
    },
    onPick(item) {
      if (!item) return;
      movePinToGroup(pin, item.group || ensureGroup(item.name));
      closeModal();
    }
  });
}

function openSettings() {
  const repoInput = el("input", {
    type: "text",
    value: state.prefs.defaultRepo,
    spellcheck: "false",
    onkeydown: (event) => event.key === "Enter" && save()
  });
  const NEW_PROFILE = "__new_profile__";
  const profileRepos = [...new Set([
    ...Object.keys(REPO_PROFILES),
    ...Object.keys(state.prefs.repoProfiles),
    state.prefs.defaultRepo
  ])].sort();
  const profileSelect = el("select", { onchange: loadProfile }, [
    ...profileRepos.map((repo) => el("option", { value: repo, selected: repo === state.prefs.defaultRepo, text: repo })),
    el("option", { value: NEW_PROFILE, text: "New repository…" })
  ]);
  const deleteProfileButton = el("button", { class: "btn", type: "button", text: "Delete saved profile", onclick: deleteProfile });
  const profileRepoInput = el("input", { class: "profile-repo-input", type: "text", spellcheck: "false", placeholder: "owner/repo", onchange: loadProfile });
  const profileRepoField = el("label", { class: "field" }, ["Repository", profileRepoInput]);
  const ciPrefix = el("input", { type: "text", spellcheck: "false", placeholder: "e.g. buildkite/" });
  const mainPipeline = el("input", { type: "text", spellcheck: "false", placeholder: "e.g. ci" });
  const commandInputs = Object.fromEntries(PROFILE_COMMAND_KEYS.map((key) => [key, el("input", { type: "text", spellcheck: "false" })]));
  const quickLabels = el("input", { type: "text", spellcheck: "false", placeholder: "ready, verified" });
  const mergeMethod = el("select", {}, ["merge", "rebase", "squash"].map((method) => el("option", { value: method, text: method })));
  const interval = el("select", {}, [30, 60, 120, 300].map((seconds) => el("option", { value: seconds, selected: seconds === state.prefs.interval, text: seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds > 60 ? "s" : ""}` })));
  const notify = el("input", { type: "checkbox", checked: state.prefs.notify });
  const unpinClosed = el("input", { type: "checkbox", checked: state.prefs.unpinClosed });
  const following = el("input", { type: "text", value: state.prefs.following.join(" "), placeholder: "usernames, separated by spaces", spellcheck: "false", onkeydown: (event) => event.key === "Enter" && save() });
  const file = el("input", {
    type: "file",
    accept: "application/json,.json",
    hidden: true,
    onchange: () => file.files[0] && importBoard(file.files[0])
  });
  function deleteProfile() {
    const isNew = profileSelect.value === NEW_PROFILE;
    const profileRepo = isNew ? profileRepoInput.value.trim() : profileSelect.value;
    if (!/^[\w.-]+\/[\w.-]+$/.test(profileRepo) || !Object.prototype.hasOwnProperty.call(state.prefs.repoProfiles, profileRepo)) return;
    openChoice({
      title: `Delete saved profile for ${profileRepo}?`,
      body: REPO_PROFILES[profileRepo]
        ? "This will restore the built-in defaults for this repository."
        : "This removes the repository's saved workflow settings from this browser.",
      options: [{
        key: "Enter",
        label: "Delete profile",
        danger: true,
        run: () => {
          const profiles = { ...state.prefs.repoProfiles };
          delete profiles[profileRepo];
          state.prefs.repoProfiles = profiles;
          persistPrefs();
          toast(REPO_PROFILES[profileRepo] ? `Restored built-in profile for ${profileRepo}` : `Deleted profile for ${profileRepo}`);
        }
      }]
    });
  }
  function loadProfile() {
    const isNew = profileSelect.value === NEW_PROFILE;
    if (isNew) {
      if (profileRepoInput.readOnly) profileRepoInput.value = "";
      profileRepoInput.readOnly = false;
    } else {
      profileRepoInput.value = profileSelect.value;
      profileRepoInput.readOnly = true;
    }
    const repo = isNew ? profileRepoInput.value.trim() : profileSelect.value;
    const validRepo = /^[\w.-]+\/[\w.-]+$/.test(repo);
    deleteProfileButton.disabled = !validRepo || !Object.prototype.hasOwnProperty.call(state.prefs.repoProfiles, repo);
    const profile = validRepo ? profileFor(repo) : GENERIC_PROFILE;
    ciPrefix.value = profile.ciPrefix || "";
    mainPipeline.value = profile.mainPipeline || "";
    for (const key of PROFILE_COMMAND_KEYS) commandInputs[key].value = profile.ciCommands?.[key] || "";
    quickLabels.value = profile.quickLabels.join(", ");
    mergeMethod.value = profile.mergeMethod;
  }
  const save = async () => {
    const repo = repoInput.value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast("Default repository must look like owner/name", "error");
    const profileRepo = profileSelect.value === NEW_PROFILE ? profileRepoInput.value.trim() : profileSelect.value;
    if (!/^[\w.-]+\/[\w.-]+$/.test(profileRepo)) return toast("Workflow repository must look like owner/name", "error");
    const commands = Object.fromEntries(PROFILE_COMMAND_KEYS.map((key) => [key, commandInputs[key].value.trim()]));
    const hasCommands = PROFILE_COMMAND_KEYS.some((key) => commands[key]);
    state.prefs.defaultRepo = repo;
    state.prefs.interval = Number(interval.value);
    state.prefs.notify = notify.checked;
    state.prefs.unpinClosed = unpinClosed.checked;
    state.prefs.following = parseLogins(following.value);
    state.prefs.repoProfiles = {
      ...state.prefs.repoProfiles,
      [profileRepo]: normalizeProfile({
        ciPrefix: ciPrefix.value,
        mainPipeline: mainPipeline.value,
        ciCommands: hasCommands ? commands : null,
        quickLabels: quickLabels.value.split(",").map((label) => label.trim()).filter(Boolean),
        mergeMethod: mergeMethod.value
      }, REPO_PROFILES[profileRepo] || GENERIC_PROFILE)
    };
    if (notify.checked && "Notification" in window && Notification.permission !== "granted") {
      state.prefs.notify = (await Notification.requestPermission()) === "granted";
      if (!state.prefs.notify) toast("Browser notifications are blocked for this site", "error");
    }
    persistPrefs();
    closeModal();
  };
  loadProfile();
  mountModal({}, el("div", { class: "modal settings-modal" }, [
    el("div", { class: "settings-body" }, [
      el("h2", { text: `Settings · ${state.user.login}` }),
      el("label", { class: "field" }, ["Default repository", repoInput]),
      el("p", { class: "muted small", text: "Used for bare PR numbers and for the Add PRs lists." }),
      el("h2", { text: "Repository workflow" }),
      el("p", { class: "muted small", text: "These settings are saved in this browser. Choose the repository whose CI, commands, labels and merge behavior you want to configure." }),
      el("div", { class: "field" }, [
        "Workflow profile",
        el("div", { class: "settings-profile-controls" }, [profileSelect, deleteProfileButton])
      ]),
      profileRepoField,
      el("label", { class: "field" }, ["CI check prefix · blank means all checks", ciPrefix]),
      el("label", { class: "field" }, ["Gating pipeline · blank means all pipelines", mainPipeline]),
      el("div", { class: "field" }, [
        "CI comment commands · leave all blank to disable",
        ...PROFILE_COMMAND_KEYS.map((key) => el("label", { class: "field" }, [key === "stale" ? "Run stale branch" : `/${key}`, commandInputs[key]]))
      ]),
      el("label", { class: "field" }, ["Quick labels · comma-separated", quickLabels]),
      el("label", { class: "field" }, ["Merge method", mergeMethod]),
      el("label", { class: "field" }, ["Refresh open PRs every", interval]),
      el("label", { class: "check-row" }, [notify, "Browser notification when CI finishes"]),
      el("label", { class: "check-row" }, [unpinClosed, "Unpin merged/closed PRs after a day"]),
      el("label", { class: "field" }, ["Following", following]),
      el("p", { class: "muted small", text: "Their names are highlighted, and Add PRs gets a Following list." }),
      el("p", { class: "muted small", text: `Your board is saved in this browser for ${location.host}. Export it to move it to another browser or address, or to keep a copy.` })
    ]),
    el("div", { class: "settings-footer" }, [
      el("div", { class: "settings-backup" }, [
        el("span", { class: "muted small", text: "Board backup" }),
        el("div", { class: "choices" }, [
          el("button", { class: "btn", onclick: exportBoard, text: "Export board + settings" }),
          el("button", { class: "btn", onclick: () => file.click(), text: "Import board + settings…" }),
          file
        ])
      ]),
      el("div", { class: "settings-actions" }, [
        el("div", { class: "choices" }, [
          el("button", { class: "btn primary", onclick: save, text: "Save" }),
          el("button", { class: "btn", onclick: () => { closeModal(); clearClosed(); }, text: "Clear merged / closed" }),
          el("button", { class: "btn", onclick: openHelp, text: "Help & shortcuts" })
        ]),
        el("button", {
          class: "btn danger",
          text: "Sign out",
          onclick: () => openChoice({
            title: "Sign out?",
            body: "This removes the token from this browser. Your board stays saved for next time.",
            options: [{ key: "Enter", label: "Sign out", danger: true, run: () => signOut() }]
          })
        })
      ])
    ])
  ]));
}

const HELP = [
  ["j / k", "move down / up"],
  ["shift+j / shift+k", "reorder within the group (manual order only)"],
  ["s", "cycle sort: manual · recently updated · recently pinned · newest PR · needs attention"],
  ["o / Enter", "open the PR on GitHub"],
  ["b", "open the CI build"],
  ["a", "add PRs (search, lists, paste numbers or URLs)"],
  ["g", "move to a group (or create one)"],
  ["e", "unpin"],
  ["u", "update branch from base"],
  ["c", "/ci run (offers update-then-run when behind)"],
  ["r / shift+x", "/ci retry / /ci cancel"],
  ["l", "add or remove any label"],
  ["y / v", "toggle ready / verified"],
  ["shift+a", "approve"],
  ["shift+m", "merge or auto-merge"],
  ["z", "undo a comment or branch update before it is sent"],
  ["1 – 7", "filter: all · failing · running · green · no CI · closed · review requested"],
  ["m", "cycle owner: everyone · mine · others'"],
  ["/", "filter by text"],
  [". / shift+r", "refresh this PR / everything"],
  ["?", "this help"],
  [",", "settings"]
];

function openHelp() {
  mountModal({}, el("div", { class: "modal" }, [
    el("h2", { text: "How failures are sorted" }),
    el("p", { class: "muted", text: "Pingboard does not read logs. A failing job counts as “likely unrelated” when the same job failed on recent base-branch commits or is failing on other PRs you have pinned; everything else is “to look at”." }),
    el("h2", { text: "Keyboard shortcuts" }),
    el("div", { class: "help" }, HELP.flatMap(([keys, what]) => [el("span", { class: "help-keys", text: keys }), el("span", { text: what })])),
    el("div", { class: "modal-foot" }, [el("span"), el("button", { class: "btn", onclick: closeModal, text: "Close" })])
  ]));
}

/* ── 10. keyboard + boot ───────────────────────────────────────────────── */

const KEYS = {
  j: () => moveCursor(1),
  k: () => moveCursor(-1),
  ArrowDown: () => moveCursor(1),
  ArrowUp: () => moveCursor(-1),
  J: () => shiftPin(1),
  K: () => shiftPin(-1),
  s: cycleSort,
  o: () => openUrl(cursorPR()?.url),
  Enter: () => openUrl(cursorPR()?.url),
  b: () => openBuild(),
  a: () => openAdd(),
  g: () => openGroupPicker(),
  e: () => state.cursor && removePin(state.cursor),
  u: () => updateBranch(),
  c: () => ciCommand("run"),
  r: () => ciCommand("retry"),
  X: () => ciCommand("cancel"),
  l: () => openLabels(),
  y: () => quickLabel(0),
  v: () => quickLabel(1),
  A: () => approve(),
  M: () => mergeMenu(),
  m: cycleOwner,
  z: undoPending,
  ".": () => cursorPin() && queueRefresh(cursorPin(), { force: true }),
  R: refreshAll,
  ",": openSettings,
  "?": openHelp,
  "/": () => document.querySelector("#filter")?.focus(),
  Escape: () => {
    state.query = "";
    const input = document.querySelector("#filter");
    if (input) input.value = "";
    state.prefs.owner = "all";
    setFilter("all");
  }
};
FILTERS.forEach((filter, index) => {
  KEYS[String(index + 1)] = () => setFilter(filter.id);
});

document.addEventListener("keydown", (event) => {
  if (!state.user || event.metaKey || event.ctrlKey || event.altKey) return;
  if ((event.key === "Enter" || event.key === " ") && /^(BUTTON|A)$/.test(event.target.tagName)) return;
  if (state.modal) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    } else {
      state.modal.onKey?.(event);
    }
    return;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  const handler = KEYS[event.key];
  if (!handler) return;
  event.preventDefault();
  handler();
});

/* Hold renders while the primary button is down (see flushRender), then catch up. */
function releasePointer() {
  pointerHeld = false;
  if (renderSkipped) render();
}
document.addEventListener("pointerdown", (event) => {
  if (event.button === 0) pointerHeld = true;
});
// A native drag ends the pointer stream with pointercancel, so only dragend may end the drag.
for (const type of ["pointerup", "pointercancel", "contextmenu"]) document.addEventListener(type, releasePointer);
window.addEventListener("blur", releasePointer);
document.addEventListener("dragend", () => {
  dragKey = null;
  pointerHeld = false;
  render();
});
document.addEventListener("selectionchange", () => {
  if (renderSkipped && !pointerHeld && !selectingText()) render();
});
window.addEventListener("resize", () => applyBoardWidth());
window.addEventListener("storage", syncFromStorage);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});

setInterval(tick, TICK_MS);

if (state.token) connect();
else render();
