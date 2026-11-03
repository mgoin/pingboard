import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import Core from "../../core.js";

const profile = Core.profileFor("vllm-project/vllm");
const status = (name, state, at = "2026-01-01T00:00:00Z") => ({
  __typename: "StatusContext", context: name, state, createdAt: at,
  targetUrl: "https://buildkite.com/example/build/1", description: "Build status"
});
const checkRun = (name, conclusion, status = "COMPLETED") => ({
  __typename: "CheckRun", name, conclusion, status,
  startedAt: "2026-01-01T00:00:00Z", detailsUrl: "https://github.com/example/repo/actions/runs/1"
});
const pr = (number, nodes = [], extra = {}) => {
  const repo = extra.repo || "vllm-project/vllm";
  const checks = Core.normalizeChecks(nodes);
  return {
    key: Core.pinKey(repo, number), repo, number, state: "OPEN", base: "main",
    mergeable: "MERGEABLE", mergeState: "CLEAN", behind: 0, canUpdate: true,
    reviewDecision: null, checks, ci: Core.summarizeCi(checks, Core.profileFor(repo)), ...extra
  };
};

test("shared core loads as a classic browser script without exposing private symbols", () => {
  const context = {};
  runInNewContext(readFileSync(new URL("../../core.js", import.meta.url), "utf8"), context);
  assert.equal(context.PingboardCore.DEFAULT_REPO, Core.DEFAULT_REPO);
  assert.equal(context.PingboardCore.profileFor("vllm-project/vllm").ciCommands.run, "/ci run");
  assert.equal(context.REPO_PROFILES, undefined);
  assert.equal(context.state, undefined);
});

test("profiles retain workflow defaults while accepting saved overrides", () => {
  assert.equal(profile.mainPipeline, "ci");
  assert.deepEqual(Core.profileFor("another/repo"), Core.GENERIC_PROFILE);
  const overrides = Core.normalizeRepoProfiles({
    "vllm-project/vllm": { quickLabels: [" ready ", "ready", "", null], mergeMethod: "merge" },
    "another/repo": { ciPrefix: "custom/", ciCommands: { run: " /build ", retry: 3 }, mergeMethod: "invalid" },
    "not a repository": { ciPrefix: "ignored/" }
  });
  const customized = Core.profileFor("vllm-project/vllm", overrides);
  assert.deepEqual(customized.quickLabels, ["ready"]);
  assert.equal(customized.ciCommands.cancel, "/ci cancel");
  assert.equal(customized.mergeMethod, "merge");
  assert.deepEqual(overrides["another/repo"].ciCommands, { run: "/build", retry: "", cancel: "", stale: "" });
  assert.equal(overrides["another/repo"].mergeMethod, "squash");
  assert.equal(overrides["not a repository"], undefined);
  assert.equal(Core.normalizeProfile({ ciCommands: null }, profile).ciCommands, null);
  const cleared = Core.normalizePrefs({ repoProfiles: { "vllm-project/vllm": { ciPrefix: "", mainPipeline: "" } } });
  const restored = Core.profileFor("vllm-project/vllm", Core.normalizePrefs(cleared).repoProfiles);
  assert.equal(restored.ciPrefix, null);
  assert.equal(restored.mainPipeline, null);
  customized.quickLabels.push("local-only");
  assert.deepEqual(profile.quickLabels, ["ready", "verified"]);
});

test("v3 saved boards and preferences retain group, pin, and following compatibility", () => {
  const fixtureDirectory = new URL("../../tests/fixtures/", import.meta.url);
  for (const name of readdirSync(fixtureDirectory)) {
    const fixture = JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
    const prefix = `pingboard.v3.${fixture.login}.`;
    const board = Core.cleanBoard(fixture.localStorage[`${prefix}board`]);
    assert.deepEqual(board, fixture.localStorage[`${prefix}board`], name);
    const prefs = Core.normalizePrefs(fixture.localStorage[`${prefix}prefs`]);
    for (const [key, value] of Object.entries(fixture.expect.prefs)) assert.deepEqual(prefs[key], value, `${name}: ${key}`);
  }
  const board = Core.cleanBoard({ groups: [{ id: "g1", name: " Tracking " }], pins: [
    { repo: "another/repo", number: 1, group: "missing", addedAt: 42 },
    { repo: "another/repo", number: 1, group: "g1", addedAt: 43 },
    { repo: "invalid", number: 2 }, { repo: "another/repo", number: -1 }
  ] });
  assert.deepEqual(board, { groups: [{ id: "g1", name: "Tracking", collapsed: false }], pins: [
    { key: "another/repo#1", repo: "another/repo", number: 1, group: "g1", addedAt: 42 }
  ] });
  assert.equal(Core.cleanBoard({ groups: [], pins: [] }), null);
  assert.deepEqual(Core.parseLogins("@Alice,alice Bob-1 bad_login"), ["Alice", "Bob-1"]);
});

test("normalization deduplicates newest statuses and compares Buildkite jobs across PR and base builds", () => {
  const checks = Core.normalizeChecks([
    null, { __typename: "Unknown" },
    status("buildkite/ci/pr/unit", "FAILURE"),
    status("buildkite/ci/pr/unit", "SUCCESS", "2026-01-02T00:00:00Z"),
    status("buildkite/ci/unit", "ERROR"), status("buildkite/ci/pr", "PENDING"),
    { ...status("bad-url", "SUCCESS"), targetUrl: "javascript:alert(1)" },
    checkRun("skipped", "SKIPPED"), checkRun("neutral", "NEUTRAL"),
    checkRun("queued", null, "QUEUED"), checkRun("cancelled", "CANCELLED")
  ]);
  assert.equal(checks.length, 8);
  const current = checks.find((check) => check.name === "buildkite/ci/pr/unit");
  assert.equal(current.state, "pass");
  assert.equal(current.jobKey, "ci/unit");
  assert.equal(current.jobKey, checks.find((check) => check.name === "buildkite/ci/unit").jobKey);
  assert.equal(checks.find((check) => check.name === "buildkite/ci/pr").isBuild, true);
  assert.equal(checks.find((check) => check.name === "bad-url").url, null);
  assert.equal(checks.find((check) => check.name === "skipped").state, "skip");
  assert.equal(checks.find((check) => check.name === "neutral").state, "skip");
  assert.equal(checks.find((check) => check.name === "queued").state, "pending");
  assert.equal(checks.find((check) => check.name === "cancelled").state, "fail");
});

test("CI gating separates the configured pipeline, auxiliary builds, and side checks", () => {
  const checks = Core.normalizeChecks([
    status("buildkite/ci/pr", "SUCCESS"), status("buildkite/ci/pr/unit", "SUCCESS"),
    status("buildkite/amd-ci/pr/gpu", "FAILURE"), checkRun("lint", "FAILURE")
  ]);
  const ci = Core.summarizeCi(checks, profile);
  assert.equal(ci.state, "passed");
  assert.equal(ci.pass, 1);
  assert.equal(ci.fail, 0);
  assert.equal(ci.aux.length, 1);
  assert.deepEqual(ci.other.failed.map((check) => check.name), ["lint"]);
  assert.equal(Core.isCiCheck(checks[2], profile), false);
  assert.equal(Core.summarizeCi(checks, Core.GENERIC_PROFILE).state, "failed");
  const unfinished = pr(1, [status("buildkite/ci/pr", "PENDING"), status("buildkite/ci/pr/unit", "FAILURE")]);
  assert.equal(unfinished.ci.state, "running");
  assert.equal(Core.verdict(unfinished).text, "CI running · 1 failed so far");
});

test("undated queued reruns and timestamp ties cannot become passing based on API order", () => {
  const success = checkRun("unit tests", "SUCCESS");
  const queued = { ...checkRun("unit tests", null, "QUEUED"), startedAt: null };
  const pending = checkRun("unit tests", null, "IN_PROGRESS");
  const failed = checkRun("unit tests", "FAILURE");
  for (const [first, second, expected] of [
    [success, queued, "running"],
    [success, pending, "running"],
    [success, failed, "failed"],
    [failed, pending, "running"]
  ]) {
    for (const nodes of [[first, second], [second, first]]) {
      const checks = Core.normalizeChecks(nodes);
      assert.equal(checks.length, 1);
      assert.equal(Core.summarizeCi(checks, Core.GENERIC_PROFILE).state, expected);
    }
  }
  // A known later completion still supersedes an earlier run.
  const laterSuccess = { ...success, startedAt: "2026-01-02T00:00:00Z" };
  for (const nodes of [[pending, laterSuccess], [laterSuccess, pending]]) {
    assert.equal(Core.summarizeCi(Core.normalizeChecks(nodes), Core.GENERIC_PROFILE).state, "passed");
  }
});

test("failure evidence excludes the current PR, closed PRs, and identically named jobs in other repositories", () => {
  const failed = [status("buildkite/ci/pr/unit", "FAILURE")];
  const current = pr(1, failed);
  const sibling = pr(2, failed);
  const foreign = pr(3, failed, { repo: "another/repo" });
  const closed = pr(4, failed, { state: "CLOSED" });
  const isolated = Core.splitFailures(current, Core.failureIndex([current, foreign, closed]));
  assert.equal(isolated.own.length, 1);
  assert.equal(isolated.shared.length, 0);
  assert.equal(isolated.baselineReady, false);
  const shared = Core.splitFailures(current, Core.failureIndex([current, sibling, foreign, closed]), { total: 5, counts: new Map([["ci/unit", 2]]) });
  assert.equal(shared.own.length, 0);
  assert.equal(shared.shared[0].evidence.base, 2);
  assert.equal(shared.shared[0].evidence.baseTotal, 5);
  assert.deepEqual(shared.shared[0].evidence.others.map((other) => other.key), [sibling.key]);
});

test("verdicts distinguish unavailable comparison evidence, unmatched failures, and shared failures", () => {
  const current = pr(1, [status("buildkite/ci/pr/unit", "FAILURE")]);
  const unknown = Core.verdict(current);
  assert.equal(unknown.action, null);
  assert.match(unknown.why, /not available/);
  const unmatched = Core.verdict(current, { baseline: { total: 5, counts: new Map() } });
  assert.equal(unmatched.tone, "bad");
  assert.match(unmatched.why, /does not establish a cause/);
  const shared = Core.verdict(current, { baseline: { total: 5, counts: new Map([["ci/unit", 2]]) } });
  assert.equal(shared.tone, "warn");
  assert.equal(shared.action, "retry_ci");
  assert.match(shared.text, /likely unrelated/);
});

test("verdict actions depend on CI availability, branch freshness, conflicts, and reviews", () => {
  assert.equal(Core.verdict(pr(1)).action, "run_ci");
  assert.equal(Core.verdict(pr(1, [], { behind: 3 })).action, "update_branch_and_run_ci");
  assert.equal(Core.verdict(pr(1, [], { behind: 3, canUpdate: false })).action, "run_ci");
  assert.equal(Core.verdict(pr(1, [], { behind: null })).action, null);
  assert.equal(Core.verdict(pr(1, [], { repo: "another/repo" })).action, null);
  assert.equal(Core.verdict(pr(1, [], { mergeable: "CONFLICTING" })).text, "Merge conflicts");
  assert.equal(Core.verdict(pr(1, [], { state: "MERGED" })).action, null);
  const passed = [status("buildkite/ci/pr/unit", "SUCCESS")];
  assert.equal(Core.verdict(pr(1, passed)).text, "CI passed · needs review");
  assert.equal(Core.verdict(pr(1, passed, { reviewDecision: "APPROVED" })).action, "merge");
  assert.equal(Core.verdict(pr(1, passed, { reviewDecision: "CHANGES_REQUESTED" })).action, null);
  assert.equal(Core.verdict(pr(1, passed, { autoMerge: true })).action, null);
  assert.equal(Core.verdict(pr(1, passed, { behind: 3, mergeState: "BEHIND" })).action, "update_branch_and_run_ci");
  assert.equal(Core.verdict(pr(1, [...passed, checkRun("lint", "FAILURE")], { reviewDecision: "APPROVED" })).action, null);
  assert.equal(Core.verdict(pr(1, [...passed, checkRun("lint", null, "IN_PROGRESS")], { reviewDecision: "APPROVED" })).action, null);
  assert.equal(Core.verdict(pr(1, passed, { reviewDecision: "APPROVED", isDraft: true })).action, null);
  assert.equal(Core.verdict(pr(1, passed, { reviewDecision: "APPROVED", mergeable: "UNKNOWN" })).action, null);
  for (const mergeState of ["BLOCKED", "UNKNOWN", "UNSTABLE", "DIRTY", "DRAFT"]) {
    assert.equal(Core.verdict(pr(1, passed, { reviewDecision: "APPROVED", mergeState })).action, null, mergeState);
  }
});
