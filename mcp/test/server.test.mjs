import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/server.mjs";
import { BoardStore } from "../src/store.mjs";
import core from "../../core.js";

const repo = "vllm-project/vllm";
const head = "a".repeat(40);
function pr(number, options = {}) {
  const checks = core.normalizeChecks([{
    __typename: "StatusContext", context: "buildkite/ci/pr/test", state: "FAILURE",
    targetUrl: "https://buildkite.com/example/builds/1", createdAt: "2026-01-01T00:00:00Z"
  }]);
  return { key: `${repo}#${number}`, repo, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`,
    state: "OPEN", isDraft: false, author: "someone", base: "main", headOid: head, behind: 0,
    mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: "REVIEW_REQUIRED", canUpdate: true,
    requestedReviewers: [], checks, ci: core.summarizeCi(checks, core.profileFor(repo)), ...options };
}

async function fixture(t, github = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pingboard-server-"));
  const store = new BoardStore(join(dir, "board.json"));
  const api = { getPR: async ({ number }) => pr(number), getBaseline: async () => ({ at: Date.now(), total: 10, counts: new Map() }), ...github };
  const server = createServer({ store, github: api });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    return result.structuredContent;
  };
  return { store, client, call };
}

test("MCP discovery advertises schemas and distinguishes local, read and GitHub writes", async (t) => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.length, 18);
  assert.equal(byName.list_review_requests.annotations.readOnlyHint, true);
  assert.equal(byName.clear_board.annotations.destructiveHint, true);
  assert.equal(byName.track_pr.annotations.openWorldHint, false);
  assert.equal(byName.set_default_repo.annotations.openWorldHint, false);
  assert.equal(byName.cancel_ci.annotations.destructiveHint, true);
  assert.ok(byName.clear_board.inputSchema.required.includes("scope"));
  const invalid = await client.callTool({ name: "track_pr", arguments: { repo: "bad", number: 0 } });
  assert.equal(invalid.isError, true);
});

test("protocol tools persist, import and export the browser board without secrets", async (t) => {
  const { call, store } = await fixture(t);
  assert.equal((await call("track_pr", { repo, number: 1, group: "Review" })).added, true);
  assert.equal((await call("track_pr", { repo, number: 1 })).added, false);
  const exported = await call("export_board");
  exported.token = "never-save-this";
  exported.prefs.githubToken = "never-save-this";
  await call("clear_board", { scope: "all" });
  assert.equal((await call("get_board", { refresh: false })).board.pins.length, 0);
  await call("import_board", { payload: exported, mode: "replace" });
  assert.equal((await store.read()).board.pins.length, 1);
  assert.ok(!JSON.stringify(await call("export_board")).includes("never-save-this"));
  assert.equal((await call("untrack_pr", { repo, number: 1 })).removed, 1);
});

test("board and inspection return matching-failure evidence plus coverage errors", async (t) => {
  const { call } = await fixture(t, {
    getPR: async ({ number }) => { if (number === 3) throw new Error("Unavailable PR"); return pr(number); },
    getBaseline: async () => { throw new Error("Baseline permission denied"); }
  });
  for (const number of [1, 2, 3]) await call("track_pr", { repo, number });
  const board = await call("get_board");
  assert.equal(board.pins[2].error, "Unavailable PR");
  assert.equal(board.pins[0].baselineError, "Baseline permission denied");
  const compared = await call("compare_failures", { repo, number: 1 });
  assert.equal(compared.failures.baselineReady, false);
  assert.equal(compared.failures.likelyUnrelated[0].evidence.others[0].number, 2);
  assert.equal(compared.comparisonErrors[0].key, `${repo}#3`);
  assert.match(compared.failures.interpretation, /not proof/);
  assert.equal((await call("inspect_pr", { repo, number: 4 })).number, 4);
  assert.equal((await call("get_board", { refresh: false })).board.pins.length, 3);
});

test("clear scopes preview, retain unreadable PRs, and treat no matches as a no-op", async (t) => {
  const { call } = await fixture(t, {
    getPR: async ({ number }) => {
      if (number === 4) throw new Error("Permission denied");
      return pr(number, { state: ({ 1: "OPEN", 2: "CLOSED", 3: "MERGED" })[number] });
    }
  });
  assert.equal((await call("clear_board", { scope: "all" })).removed, 0);
  for (const number of [1, 2, 3, 4]) await call("track_pr", { repo, number });
  const preview = await call("clear_board", { scope: "closed", dry_run: true });
  assert.deepEqual(preview.wouldRemove, [`${repo}#2`, `${repo}#3`]);
  assert.equal((await call("get_board", { refresh: false })).board.pins.length, 4);
  assert.equal((await call("clear_board", { scope: "merged" })).removed, 1);
  assert.equal((await call("clear_board", { scope: "merged" })).removed, 0);
  const cleared = await call("clear_board", { scope: "closed" });
  assert.equal(cleared.removed, 1);
  assert.equal(cleared.errors[0].key, `${repo}#4`);
  assert.deepEqual(cleared.board.pins.map((pin) => pin.number), [1, 4]);
});

test("clear closed preserves pins added while GitHub reads are in flight", async (t) => {
  let store;
  const setup = await fixture(t, {
    getPR: async ({ number }) => { await store.track({ repo, number: 9 }); return pr(number, { state: "CLOSED" }); }
  });
  store = setup.store;
  await setup.call("track_pr", { repo, number: 1 });
  const cleared = await setup.call("clear_board", { scope: "closed" });
  assert.equal(cleared.removed, 1);
  assert.deepEqual(cleared.board.pins.map((pin) => pin.number), [9]);
});

test("review search uses preferences and carries cursors without pinning results", async (t) => {
  const seen = [];
  const { call } = await fixture(t, {
    searchPRs: async (args) => { seen.push(args); return { items: [{ number: 1 }], total: 2, nextCursor: "next" }; }
  });
  await call("list_review_requests", { limit: 1, cursor: "first" });
  assert.deepEqual(seen[0], { repo, view: "review_requested", query: "", limit: 1, cursor: "first" });
  await call("find_prs", { repo: "owner/repo", view: "ready", query: "author:octocat" });
  assert.equal(seen[1].view, "ready");
  assert.equal(seen[1].repo, "owner/repo");
  assert.equal((await call("get_board", { refresh: false })).board.pins.length, 0);
});

test("CI tools dispatch effective profile commands and head guards", async (t) => {
  const calls = [];
  const { call } = await fixture(t, {
    command: async (...args) => { calls.push(args); return { posted: true }; },
    updateBranch: async (...args) => { calls.push(args); return { accepted: true }; }
  });
  await call("set_repo_profile", { repo, profile: { ciCommands: { run: "/custom run", retry: "/custom retry", cancel: "/custom cancel", stale: "/custom stale" } } });
  await call("run_ci", { repo, number: 1, allow_stale: true, expected_head_oid: head });
  assert.equal(calls[0][1], "stale");
  assert.equal(calls[0][2].ciCommands.stale, "/custom stale");
  assert.equal(calls[0][3].expectedHeadOid, head);
  await call("retry_ci", { repo, number: 1 });
  assert.equal(calls[1][1], "retry");
  await call("cancel_ci", { repo, number: 1 });
  assert.equal(calls[2][1], "cancel");
  await call("update_branch_and_run_ci", { repo, number: 1, expected_head_oid: head });
  assert.deepEqual(calls[3][2], { runCi: true, expectedHeadOid: head });
});

test("switching default repository redirects searches while explicit targets and CI profiles stay independent", async (t) => {
  const searches = [];
  const commands = [];
  const otherRepo = "mgoin/pingboard";
  const { call, client } = await fixture(t, {
    searchPRs: async (args) => { searches.push(args); return { items: [], total: 0, nextCursor: null }; },
    command: async (...args) => { commands.push(args); return { posted: true }; }
  });
  await call("track_pr", { repo, number: 1 });
  await call("track_pr", { repo: otherRepo, number: 4 });
  const switched = await call("set_default_repo", { repo: otherRepo });
  assert.equal(switched.previousDefaultRepo, repo);
  assert.equal(switched.defaultRepo, otherRepo);
  assert.equal(switched.profile.ciCommands, null);
  await call("find_prs");
  await call("list_review_requests");
  await call("find_prs", { repo });
  await call("list_review_requests", { repo });
  assert.deepEqual(searches.map((args) => args.repo), [otherRepo, otherRepo, repo, repo]);
  const local = await call("get_board", { refresh: false });
  assert.equal(local.prefs.defaultRepo, otherRepo);
  assert.deepEqual(local.board.pins.map((pin) => pin.repo), [repo, otherRepo]);
  assert.equal((await call("get_repo_profile", { repo: otherRepo })).profile.ciCommands, null);
  await call("retry_ci", { repo, number: 1 });
  assert.equal(commands[0][0].repo, repo);
  assert.equal(commands[0][2].ciCommands.retry, "/ci retry");
  const invalid = await client.callTool({ name: "set_default_repo", arguments: { repo: "bad" } });
  assert.equal(invalid.isError, true);
  assert.equal((await call("export_board")).prefs.defaultRepo, otherRepo);
});

test("actual stdio CLI negotiates MCP and persists a board across process restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pingboard-stdio-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  async function session(fn) {
    const client = new Client({ name: "stdio-smoke", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli],
      env: { PINGBOARD_STATE_FILE: join(dir, "board.json") }, stderr: "pipe" });
    let errors = "";
    transport.stderr.on("data", (data) => { errors += data; });
    try {
      await client.connect(transport);
      await fn(client);
      assert.equal(errors, "");
    } finally { await client.close(); }
  }
  await session(async (client) => {
    assert.equal((await client.listTools()).tools.length, 18);
    const result = await client.callTool({ name: "track_pr", arguments: { repo, number: 42 } });
    assert.ok(!result.isError, result.content?.[0]?.text);
    const changed = await client.callTool({ name: "set_default_repo", arguments: { repo: "mgoin/pingboard" } });
    assert.ok(!changed.isError, changed.content?.[0]?.text);
  });
  await session(async (client) => {
    const result = await client.callTool({ name: "get_board", arguments: { refresh: false } });
    assert.equal(result.structuredContent.board.pins[0].number, 42);
    assert.equal(result.structuredContent.prefs.defaultRepo, "mgoin/pingboard");
  });
});
