import assert from "node:assert/strict";
import { test } from "node:test";
import Core from "../../core.js";

const repo = "vllm-project/vllm";
const timestamp = "2026-01-01T00:00:00Z";
const status = (state) => ({
  __typename: "StatusContext", context: "buildkite/ci/pr/unit", state, createdAt: timestamp
});
const checkRun = (conclusion, status = "COMPLETED", startedAt = timestamp) => ({
  __typename: "CheckRun", name: "lint", conclusion, status, startedAt
});
function pr(number, nodes = [status("SUCCESS")], extra = {}) {
  const target = extra.repo || repo;
  const checks = Core.normalizeChecks(nodes);
  return {
    key: Core.pinKey(target, number), repo: target, number, state: "OPEN", base: "main",
    mergeable: "MERGEABLE", mergeState: "CLEAN", behind: 0, canUpdate: true,
    reviewDecision: "APPROVED", checks, ci: Core.summarizeCi(checks, Core.profileFor(target)), ...extra
  };
}

test("cleared built-in profile settings survive normalization and reload", () => {
  const prefs = Core.normalizePrefs({ repoProfiles: {
    [repo]: { ciPrefix: "", mainPipeline: "", ciCommands: null }
  } });
  const restored = Core.profileFor(repo, Core.normalizePrefs(prefs).repoProfiles);
  assert.equal(restored.ciPrefix, null);
  assert.equal(restored.mainPipeline, null);
  assert.equal(restored.ciCommands, null);
  assert.equal(Core.profileFor(repo).ciCommands.run, "/ci run");
});

test("saved browser view preferences survive shared normalization and JSON roundtrips", () => {
  for (const view of [
    { sort: "manual", filter: "all", owner: "all" },
    { sort: "updated", filter: "failing", owner: "mine", unpinClosed: true },
    { sort: "added", filter: "running", owner: "others" },
    { sort: "number", filter: "green", owner: "all" },
    { sort: "status", filter: "noci", owner: "mine" },
    { sort: "manual", filter: "closed", owner: "others" },
    { sort: "updated", filter: "requested", owner: "mine", unpinClosed: false }
  ]) {
    const prefs = Core.normalizePrefs(view);
    for (const [key, value] of Object.entries(view)) assert.equal(prefs[key], value, key);
    assert.deepEqual(Core.normalizePrefs(JSON.parse(JSON.stringify(prefs))), prefs);
  }
});

test("missing or malformed browser view preferences use the existing defaults", () => {
  for (const raw of [undefined, null, {},
    { sort: "unknown", filter: "unknown", owner: "unknown" },
    { sort: [], filter: {}, owner: 1 },
    { sort: null, filter: null, owner: null }
  ]) {
    const { sort, filter, owner, unpinClosed } = Core.normalizePrefs(raw);
    assert.deepEqual({ sort, filter, owner, unpinClosed }, { sort: "manual", filter: "all", owner: "all", unpinClosed: false });
  }
});

test("search groups retain their query, dismissals and moved search pins on reload", () => {
  const board = {
    groups: [
      { id: "search", name: "Review requests", collapsed: true, query: `repo:${repo} review-requested:@me`, dismissed: [`${repo}#9`] },
      { id: "manual", name: "Tracking", collapsed: false }
    ],
    pins: [
      { key: `${repo}#1`, repo, number: 1, group: "search", addedAt: 123, via: "search" },
      { key: `${repo}#2`, repo, number: 2, group: "manual", addedAt: 124, via: "search" }
    ]
  };
  assert.deepEqual(Core.cleanBoard(board), board);
  assert.deepEqual(Core.cleanBoard(JSON.parse(JSON.stringify(board))), board);
});

test("search metadata normalizes queries, bounds valid dismissals and drops unknown origins", () => {
  const dismissed = Array.from({ length: 201 }, (_, i) => `${repo}#${i + 1}`);
  const board = Core.cleanBoard({
    groups: [
      { id: "search", name: "Reviews", query: "  review-requested:@me  ", dismissed: [...dismissed, "invalid", null] },
      { id: "blank", name: "Blank", query: " ", dismissed },
      { id: "malformed", name: "Malformed", query: 123, dismissed }
    ],
    pins: [{ repo, number: 1, group: "search", addedAt: 123, via: "missing" }]
  });
  assert.equal(board.groups[0].query, "review-requested:@me");
  assert.deepEqual(board.groups[0].dismissed, dismissed.slice(1));
  for (const group of board.groups.slice(1)) {
    assert.equal(Object.hasOwn(group, "query"), false);
    assert.equal(Object.hasOwn(group, "dismissed"), false);
  }
  assert.equal(Object.hasOwn(board.pins[0], "via"), false);
});

test("queued retries and timestamp ties cannot look passed in either API order", () => {
  const success = checkRun("SUCCESS");
  const pending = checkRun(null, "IN_PROGRESS");
  const queued = checkRun(null, "QUEUED", null);
  const failed = checkRun("FAILURE");
  const laterSuccess = checkRun("SUCCESS", "COMPLETED", "2026-01-02T00:00:00Z");
  for (const [first, second, expected] of [
    [success, queued, "running"], [success, pending, "running"],
    [success, failed, "failed"], [failed, pending, "running"],
    [pending, laterSuccess, "passed"]
  ]) {
    for (const nodes of [[first, second], [second, first]]) {
      const ci = Core.summarizeCi(Core.normalizeChecks(nodes), Core.GENERIC_PROFILE);
      assert.equal(ci.state, expected);
    }
  }
});

test("failure evidence stays repository scoped and distinguishes an unavailable baseline", () => {
  const failed = [status("FAILURE")];
  const current = pr(1, failed);
  const sibling = pr(2, failed);
  const foreign = pr(3, failed, { repo: "another/repo" });
  const closed = pr(4, failed, { state: "CLOSED" });
  const isolated = Core.splitFailures(current, Core.failureIndex([current, foreign, closed]));
  assert.equal(isolated.own.length, 1);
  assert.equal(isolated.shared.length, 0);
  assert.equal(isolated.baselineReady, false);
  assert.equal(Core.verdict(current).action, null);
  const baseline = { total: 5, counts: new Map([["ci/unit", 2]]) };
  const index = Core.failureIndex([current, sibling, foreign, closed]);
  const shared = Core.splitFailures(current, index, baseline).shared[0].evidence;
  assert.deepEqual([shared.base, shared.baseTotal], [2, 5]);
  assert.deepEqual(shared.others.map((other) => other.key), [sibling.key]);
  assert.equal(Core.verdict(current, { index, baseline }).action, "retry_ci");
});

test("verdicts offer actions only when branch, checks, and review state permit them", () => {
  assert.equal(Core.verdict(pr(1)).action, "merge");
  assert.equal(Core.verdict(pr(1, [])).action, "run_ci");
  assert.equal(Core.verdict(pr(1, [], { behind: 3 })).action, "update_branch_and_run_ci");
  assert.equal(Core.verdict(pr(1, [], { behind: null })).action, null);
  assert.equal(Core.verdict(pr(1, [], { repo: "another/repo" })).action, null);
  for (const extra of [
    { isDraft: true }, { state: "MERGED" }, { mergeable: "UNKNOWN" },
    { mergeable: "CONFLICTING" }, { reviewDecision: "CHANGES_REQUESTED" },
    ...["BLOCKED", "UNKNOWN", "UNSTABLE", "DIRTY", "DRAFT"].map((mergeState) => ({ mergeState }))
  ]) {
    assert.equal(Core.verdict(pr(1, [status("SUCCESS")], extra)).action, null, JSON.stringify(extra));
  }
  for (const side of [checkRun("FAILURE"), checkRun(null, "IN_PROGRESS")]) {
    const current = pr(1, [status("SUCCESS"), side]);
    assert.equal(current.ci.state, "passed");
    assert.equal(Core.verdict(current).action, null);
  }
});
