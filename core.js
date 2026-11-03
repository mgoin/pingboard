/* Shared Pingboard domain logic. No browser state, network access, or build step. */
(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.PingboardCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

const DEFAULT_REPO = "vllm-project/vllm";
const BOARD_WIDTH = 520;
const DISMISSED_MAX = 200;

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
    ciPrefix: value.ciPrefix === null ? null : typeof value.ciPrefix === "string" ? value.ciPrefix.trim() || null : fallback.ciPrefix,
    mainPipeline: value.mainPipeline === null ? null : typeof value.mainPipeline === "string" ? value.mainPipeline.trim() || null : fallback.mainPipeline,
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

function profileFor(repo, overrides = {}) {
  const base = REPO_PROFILES[repo] || GENERIC_PROFILE;
  return normalizeProfile(overrides?.[repo], base);
}

function pinKey(repo, number) {
  return `${repo}#${number}`;
}

/* URLs from the API end up in href / window.open; only ever follow web links. */
function safeUrl(url) {
  return /^https?:\/\//.test(url || "") ? url : null;
}

function parseLogins(text) {
  const logins = [];
  for (const token of text.split(/[\s,@]+/)) {
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(token) && !logins.some((login) => login.toLowerCase() === token.toLowerCase())) logins.push(token);
  }
  return logins;
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
    sort: ["manual", "updated", "added", "number", "status"].includes(prefs.sort) ? prefs.sort : "manual",
    filter: ["all", "failing", "running", "green", "noci", "closed", "requested"].includes(prefs.filter) ? prefs.filter : "all",
    owner: ["all", "mine", "others"].includes(prefs.owner) ? prefs.owner : "all",
    unpinClosed: Boolean(prefs.unpinClosed)
  };
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
      ...(groups.some((group) => group.id === pin.via) ? { via: pin.via } : {})
    });
  }
  return { groups, pins };
}

const STATUS_STATES = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };
const CHECK_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CHECK_PRIORITY = { skip: 0, pass: 1, fail: 2, pending: 3 };

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
    // Queued reruns have no startedAt. When recency cannot be established, do
    // not let an older success hide pending or failed work. Equal timestamps
    // need the same rule because API ordering does not establish which is newer.
    const comparable = prev && check.at && prev.at;
    const uncertain = !comparable || check.at === prev.at;
    if (!prev || (comparable && check.at > prev.at)
      || (uncertain && CHECK_PRIORITY[check.state] > CHECK_PRIORITY[prev.state])) {
      byName.set(check.name, check);
    }
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

/* Failing-job evidence, without reading logs:
     base   — the same job failed on N of the recent base-branch commits
     others — the same job is failing on other PRs on this board */
function failureIndex(prs = []) {
  const index = new Map();
  for (const pr of prs) {
    if (pr.state !== "OPEN") continue;
    for (const check of pr.ci.failed) {
      if (!index.has(check.jobKey)) index.set(check.jobKey, []);
      index.get(check.jobKey).push(pr);
    }
  }
  return index;
}

function splitFailures(pr, index = new Map(), baseline = null) {
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

/* The one-line answer to "what is going on with this PR, and what comes next?" */
function computeVerdict(pr, { profile = profileFor(pr.repo), index = new Map(), baseline = null } = {}) {
  if (pr.state === "MERGED") return { tone: "done", text: "Merged" };
  if (pr.state === "CLOSED") return { tone: "done", text: "Closed" };

  const ci = pr.ci;
  const commands = profile.ciCommands;
  const behind = pr.behind || 0;
  const plural = (count) => (count === 1 ? "" : "s");
  const behindNote = behind ? ` The branch is ${behind} behind ${pr.base}.` : "";
  // Starting CI needs an up-to-date branch; offer the one-step version when we may push to it.
  const runCi = commands?.run && Number.isInteger(pr.behind) && pr.behind >= 0
    ? behind && pr.canUpdate ? "update_branch_and_run_ci" : "run_ci"
    : null;

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
    const { own, shared, baselineReady } = splitFailures(pr, index, baseline);
    const mine = own.length + side.length;
    if (!baselineReady) {
      return { tone: "bad", text: `${ci.fail} failed job${plural(ci.fail)}`, why: `Base-branch evidence is not available yet; comparison with ${pr.base} is incomplete.` };
    }
    if (mine) {
      return {
        tone: "bad",
        text: `${mine} failure${plural(mine)} to look at`,
        why: shared.length
          ? `${shared.length} more also fail${shared.length === 1 ? "s" : ""} on ${pr.base} or other pinned PRs and look${shared.length === 1 ? "s" : ""} unrelated.`
          : `No matching failures were found on ${pr.base} or on other pinned PRs. This does not establish a cause.`
      };
    }
    return {
      tone: "warn",
      text: `${shared.length} failure${plural(shared.length)}, likely unrelated`,
      why: `Every failing job also fails on ${pr.base} or on other pinned PRs.`,
      action: commands?.retry ? "retry_ci" : null
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
      why: pr.behind === null || pr.behind === undefined
        ? "No build on the latest commit. Branch freshness is unavailable; refresh it before starting CI."
        : behind
        ? `No build on the latest commit, and the branch is ${behind} behind ${pr.base} — CI only starts on an up-to-date branch.`
        : "No build on the latest commit.",
      action: runCi
    };
  }

  if (ci.other.running.length) {
    return {
      tone: "running", text: "CI passed · other checks running",
      why: `${ci.other.running.map((check) => check.label).join(", ")} still running; wait for the remaining checks.`
    };
  }
  if (pr.isDraft || pr.mergeState === "DRAFT") {
    return { tone: "neutral", text: "CI passed · draft", why: "The PR must be marked ready for review before it can merge." };
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
    if (pr.mergeable !== "MERGEABLE" || !["CLEAN", "HAS_HOOKS"].includes(pr.mergeState)) {
      return { tone: "warn", text: "CI passed · merge requirements unresolved", why: `GitHub has not confirmed this approved PR is ready to merge (mergeability: ${pr.mergeable || "UNKNOWN"}; merge state: ${pr.mergeState || "UNKNOWN"}).${behindNote}` };
    }
    return { tone: "good", text: "Ready to merge", why: `CI passed and the PR is approved.${behindNote}`, action: "merge" };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { tone: "warn", text: "CI passed · changes requested", why: behindNote.trim() };
  return { tone: "good", text: "CI passed · needs review", why: behindNote.trim() };
}

function verdict(pr, context) {
  return { why: "", action: null, ...computeVerdict(pr, context) };
}

return { DEFAULT_REPO, REPO_PROFILES, GENERIC_PROFILE, PROFILE_COMMAND_KEYS, normalizeProfile, normalizeRepoProfiles, profileFor, pinKey, safeUrl, parseLogins, normalizePrefs, cleanBoard, normalizeChecks, isCiCheck, summarizeCi, failureIndex, splitFailures, verdict };
});
