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

function profileFor(repo) {
  return REPO_PROFILES[repo] || GENERIC_PROFILE;
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

  board: { groups: [], pins: [] },   // pins: [{key, repo, number, group, addedAt, seen}]
  prefs: { interval: 60, notify: false, defaultRepo: DEFAULT_REPO, boardWidth: BOARD_WIDTH },

  data: new Map(),        // pin key -> PR model
  status: new Map(),      // pin key -> {at, loading, error}
  baselines: new Map(),   // "repo@branch" -> {at, total, counts: Map(jobKey -> commits failing)}
  commitFailures: new Map(), // "repo@oid" -> {hasCI, failed: [jobKey]} for finished base commits
  labels: new Map(),      // repo -> {at, items: [{name, color}]}

  cursor: null,
  filter: "all",
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

function loadUserState() {
  const prefs = store.get(scopedKey("prefs"), {});
  state.prefs = {
    interval: [30, 60, 120, 300].includes(prefs.interval) ? prefs.interval : 60,
    notify: Boolean(prefs.notify),
    boardWidth: Number(prefs.boardWidth) || BOARD_WIDTH,
    defaultRepo: /^[\w.-]+\/[\w.-]+$/.test(prefs.defaultRepo || "") ? prefs.defaultRepo : DEFAULT_REPO
  };

  const board = store.get(scopedKey("board"), null);
  if (board?.groups?.length) {
    state.board = board;
  } else {
    state.board = { groups: [{ id: "g1", name: "Tracking", collapsed: false }], pins: [] };
  }
  state.cursor = state.board.pins[0]?.key || null;
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

async function gql(query, variables = {}, { strict = false } = {}) {
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
  return json.data;
}

const CONTEXT_FIELDS = `
  __typename
  ... on StatusContext { context state description targetUrl createdAt }
  ... on CheckRun { name status conclusion detailsUrl startedAt checkSuite { app { slug } } }`;

const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $baseRef: String!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $baseRef) { compare(headRef: $headRef) { aheadBy behindBy } }
    pullRequest(number: $number) {
      id number title url state isDraft updatedAt
      author { login } authorAssociation
      baseRefName headRefOid
      mergeable mergeStateStatus reviewDecision
      viewerCanUpdateBranch
      autoMergeRequest { enabledAt }
      additions deletions changedFiles
      labels(first: 40) { nodes { name color } }
      latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
      comments(last: 5) { nodes { author { login } bodyText createdAt url } }
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
    }
  }
}`;

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

async function fetchPR(pin, { force = false } = {}) {
  const prev = state.data.get(pin.key);
  const [owner, name] = pin.repo.split("/");
  const headRef = `refs/pull/${pin.number}/head`;
  const load = async (base) => (await gql(PR_QUERY, { owner, name, number: pin.number, baseRef: `refs/heads/${base}`, headRef })).repository;

  let base = prev?.base || "main";
  let repo = await load(base);
  if (repo?.pullRequest && repo.pullRequest.baseRefName !== base) {
    base = repo.pullRequest.baseRefName;
    repo = await load(base);
  }
  const pr = repo?.pullRequest;
  if (!pr) throw new Error("Pull request not found (or the token cannot see it)");

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
    comments: pr.comments.nodes.map((comment) => ({ login: comment.author?.login || "ghost", text: comment.bodyText.slice(0, 700), at: comment.createdAt, url: safeUrl(comment.url) })),
    behind: repo.ref?.compare?.behindBy ?? null,
    checks,
    fingerprint,
    ci: summarizeCi(checks, profile)
  };
}

/* What the user has "seen" for a PR; a different signature lights the change dot. */
function signature(pr) {
  return [pr.state, pr.headOid, pr.ci.state, pr.ci.fail, pr.reviewDecision].join("|");
}

function hasChanged(pin) {
  const pr = state.data.get(pin.key);
  return Boolean(pr && pin.seen && pin.seen !== signature(pr));
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
  pumpRefresh();
}

function pumpRefresh() {
  while (refreshActive < REFRESH_CONCURRENCY && refreshQueue.length) {
    const { pin, options } = refreshQueue.shift();
    refreshActive += 1;
    refreshPin(pin, options).finally(() => {
      refreshActive -= 1;
      refreshQueued.delete(pin.key);
      if (refreshAgain.delete(pin.key) && pinByKey(pin.key)) queueRefresh(pin, { force: true });
      pumpRefresh();
    });
  }
}

async function refreshPin(pin, options = {}) {
  state.status.set(pin.key, { ...state.status.get(pin.key), loading: true });
  render();
  try {
    const prev = state.data.get(pin.key);
    const pr = await fetchPR(pin, options);
    if (!pinByKey(pin.key)) return;   // unpinned while the request was in flight
    state.data.set(pin.key, pr);
    // GitHub computes mergeability lazily; ask again shortly instead of showing a guess for a full interval.
    const unknownTries = pr.state === "OPEN" && pr.mergeable === "UNKNOWN" ? (state.status.get(pin.key)?.unknownTries || 0) + 1 : 0;
    state.status.set(pin.key, { at: Date.now(), loading: false, error: "", unknownTries });
    if (unknownTries && unknownTries <= 2) setTimeout(() => pinByKey(pin.key) && queueRefresh(pin), 4000);
    state.lastSync = Date.now();
    if (!pin.seen) {
      pin.seen = signature(pr);
      persistBoard();
    }
    if (prev && prev.headOid === pr.headOid && prev.ci.state === "running" && pr.ci.state !== "running") announceCi(pr);
    refreshBaselines();
  } catch (error) {
    state.status.set(pin.key, { at: Date.now(), loading: false, error: error.message });
  }
  render();
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
    refreshBaselines();
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

function addPin(repo, number, group = targetGroupId()) {
  const key = pinKey(repo, number);
  if (pinByKey(key)) return false;
  const pin = { key, repo, number, group, addedAt: Date.now() };
  state.board.pins.push(pin);
  const target = state.board.groups.find((item) => item.id === group);
  if (target) target.collapsed = false;
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
  state.board.pins.splice(index, 1);
  state.data.delete(key);
  state.status.delete(key);
  if (state.cursor === key) state.cursor = (visible[at + 1] || visible[at - 1])?.key || null;
  persistBoard();
  toast(`Unpinned ${shortRef(pin.repo, pin.number)}`, "info", {
    label: "Undo",
    run: () => {
      if (pinByKey(key)) return;
      if (!state.board.groups.some((group) => group.id === pin.group)) pin.group = state.board.groups[0].id;
      state.board.pins.splice(Math.min(index, state.board.pins.length), 0, pin);
      persistBoard();
      queueRefresh(pin);
      setCursor(key);
    }
  });
}

function clearClosed() {
  const closed = state.board.pins.filter((pin) => {
    const pr = state.data.get(pin.key);
    return pr && pr.state !== "OPEN";
  });
  state.board.pins = state.board.pins.filter((pin) => !closed.includes(pin));
  for (const pin of closed) {
    state.data.delete(pin.key);
    state.status.delete(pin.key);
  }
  persistBoard();
  toast(closed.length ? `Cleared ${closed.length} merged/closed` : "Nothing merged or closed to clear");
}

function ensureGroup(name) {
  const existing = state.board.groups.find((group) => group.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const group = { id: `g${Date.now().toString(36)}`, name, collapsed: false };
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
  { id: "closed", label: "Closed", test: (pr) => Boolean(pr) && pr.state !== "OPEN" }
];

/* The selected PR stays listed even if a refresh moves it out of the filter, so
   actions never silently retarget to another row. */
function matchesView(pin) {
  return pin.key === state.cursor || matchesFilter(pin);
}

function setFilter(id) {
  state.filter = id;
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
  const filter = FILTERS.find((item) => item.id === state.filter) || FILTERS[0];
  if (!filter.test(pr)) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = `${pin.repo}#${pin.number} ${pr?.title || ""} ${pr?.author || ""} ${(pr?.labels || []).map((label) => label.name).join(" ")}`.toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
}

function groupPins(group) {
  return state.board.pins.filter((pin) => pin.group === group.id && matchesView(pin));
}

function visiblePins() {
  return state.board.groups.flatMap((group) => (group.collapsed ? [] : groupPins(group)));
}

function acknowledge(key) {
  const pin = pinByKey(key);
  const pr = state.data.get(key);
  if (!pin || !pr || pin.seen === signature(pr)) return;
  pin.seen = signature(pr);
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
  if (!commands) return toast(`No CI commands configured for ${pr.repo}`);
  if (kind !== "run" || !pr.behind) return postComment(pr, commands[kind]);
  // The bot refuses to start CI on a branch that is behind its base.
  openChoice({
    title: `${shortRef(pr.repo, pr.number)} is ${pr.behind} behind ${pr.base}`,
    body: `${commands.run} is refused on a branch that is behind its base.`,
    options: [
      pr.mergeable !== "CONFLICTING" && pr.canUpdate && { key: "Enter", label: `Update branch, then ${commands.run}`, run: () => updateBranch(pr, commands.run) },
      { key: "s", label: `Post ${commands.stale}`, run: () => postComment(pr, commands.stale) }
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
  const build = pr.ci.builds.find((item) => item.pipeline === "ci") || pr.ci.builds[0] || pr.ci.failed[0] || pr.ci.running[0];
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
      el("div", { class: "chips", id: "chips" }),
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
  main.append(el("section", { class: "board", id: "board" }), divider, el("aside", { class: "detail", id: "detail" }));
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
  const counts = Object.fromEntries(FILTERS.map((filter) => [filter.id, 0]));
  for (const pin of state.board.pins) {
    const pr = state.data.get(pin.key);
    for (const filter of FILTERS) if (filter.test(pr)) counts[filter.id] += 1;
  }
  document.querySelector("#chips").replaceChildren(...FILTERS.map((filter) => el("button", {
    class: `chip-btn f-${filter.id}${state.filter === filter.id ? " active" : ""}`,
    onclick: () => setFilter(filter.id)
  }, [filter.label, el("span", { class: "count", text: String(counts[filter.id]) })])));

  const busy = refreshActive > 0;
  const rate = state.rate.remaining;
  const throttled = rate !== null && rate < RATE_FLOOR;
  const parts = [busy ? "syncing…" : state.lastSync ? `synced ${ago(state.lastSync)} ago` : ""];
  if (rate !== null) parts.push(throttled ? `rate limit low (${rate}) — paused until ${new Date(state.rate.reset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : `${rate} api`);
  const sync = document.querySelector("#sync");
  sync.className = `sync${busy ? " busy" : ""}${throttled ? " warn" : ""}`;
  sync.textContent = parts.filter(Boolean).join(" · ");
  document.querySelector("#me").textContent = state.user.login;
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
  const runCi = commands && (!behind
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
      action: commands && { label: "Retry failed jobs", run: () => postComment(pr, commands.retry) }
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
  const filtering = state.filter !== "all" || state.query.trim();
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
  board.replaceChildren(...sections);
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
      if (!dragKey || dragKey === pin.key) return;
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
        el("span", { text: pr.author }),
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
      el("span", { class: "muted", text: `${pr.author} · updated ${ago(pr.updatedAt)} ago` })
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
        commands && btn("Run CI", () => ciCommand("run", pr), { title: `Comment ${commands.run}` }),
        commands && ci.fail ? btn("Retry failed", () => ciCommand("retry", pr), { title: `Comment ${commands.retry}` }) : null,
        commands && ci.state === "running" ? btn("Cancel", () => ciCommand("cancel", pr), { title: `Comment ${commands.cancel}` }) : null,
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

  detail.replaceChildren(...blocks);
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
  state.filter = "all";
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
function openPrompt({ title, value = "", placeholder = "", submit, onSubmit }) {
  const error = el("p", { class: "t-bad small" });
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    const problem = onSubmit(text);
    if (problem) error.textContent = problem;
    else closeModal();
  };
  const input = el("input", { type: "text", class: "picker-input", value, placeholder, "aria-label": title, spellcheck: "false", onkeydown: (event) => event.key === "Enter" && send() });
  mountModal({}, el("div", { class: "modal small" }, [
    el("h2", { text: title }),
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
    ...(quick ? [{ id: "quick", label: quick, q: `label:${quick}` }] : []),
    { id: "recent", label: "All recent", q: "" }
  ];
  const group = state.board.groups.find((item) => item.id === groupId) || state.board.groups[0];
  const queryFor = (modal) => {
    const tab = tabs.find((item) => item.id === modal.tab);
    return ["is:pr is:open", `repo:${repo}`, tab.q, modal.query.trim(), "sort:updated-desc"].filter(Boolean).join(" ");
  };
  const search = async (modal) => {
    if (parseRefs(modal.query)) return modal.update();
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
    placeholder: `Search ${repo}, or paste PR numbers / URLs`,
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
            el("span", { class: "author", text: node.author?.login || "ghost" }),
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
  const repoInput = el("input", { type: "text", value: state.prefs.defaultRepo, spellcheck: "false", onkeydown: (event) => event.key === "Enter" && save() });
  const interval = el("select", {}, [30, 60, 120, 300].map((seconds) => el("option", { value: seconds, selected: seconds === state.prefs.interval, text: seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds > 60 ? "s" : ""}` })));
  const notify = el("input", { type: "checkbox", checked: state.prefs.notify });
  const save = async () => {
    const repo = repoInput.value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast("Default repository must look like owner/name", "error");
    state.prefs.defaultRepo = repo;
    state.prefs.interval = Number(interval.value);
    state.prefs.notify = notify.checked;
    if (notify.checked && "Notification" in window && Notification.permission !== "granted") {
      state.prefs.notify = (await Notification.requestPermission()) === "granted";
      if (!state.prefs.notify) toast("Browser notifications are blocked for this site", "error");
    }
    persistPrefs();
    closeModal();
  };
  mountModal({}, el("div", { class: "modal small" }, [
    el("h2", { text: `Settings · ${state.user.login}` }),
    el("label", { class: "field" }, ["Default repository", repoInput]),
    el("p", { class: "muted small", text: "Used for bare PR numbers and for the Add PRs lists." }),
    el("label", { class: "field" }, ["Refresh open PRs every", interval]),
    el("label", { class: "check-row" }, [notify, "Browser notification when CI finishes"]),
    el("div", { class: "choices" }, [
      el("button", { class: "btn primary", onclick: save, text: "Save" }),
      el("button", { class: "btn", onclick: () => { closeModal(); clearClosed(); }, text: "Clear merged / closed" }),
      el("button", { class: "btn", onclick: openHelp, text: "Help & shortcuts" }),
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
  ]));
}

const HELP = [
  ["j / k", "move down / up"],
  ["shift+j / shift+k", "reorder within the group"],
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
  ["1 – 6", "filter: all · failing · running · green · no CI · closed"],
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

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});

setInterval(tick, TICK_MS);

if (state.token) connect();
else render();
