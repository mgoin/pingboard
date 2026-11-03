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

test("repository switching changes searches while CI uses its explicit target and profile", async (t) => {
  const searches = [];
  const commands = [];
  const otherRepo = "mgoin/pingboard";
  const { call } = await fixture(t, {
    searchPRs: async (args) => { searches.push(args); return { items: [], total: 0, nextCursor: null }; },
    command: async (...args) => { commands.push(args); return { posted: true }; },
    updateBranch: async (...args) => { commands.push(args); return { accepted: true }; }
  });
  await call("set_default_repo", { repo: otherRepo });
  await call("find_prs");
  await call("list_review_requests", { repo, limit: 1, cursor: "next" });
  assert.equal(searches[0].repo, otherRepo);
  assert.deepEqual(searches[1], { repo, view: "review_requested", query: "", limit: 1, cursor: "next" });
  await call("set_repo_profile", { repo, profile: { ciCommands: { stale: "/custom stale" } } });
  await call("run_ci", { repo, number: 1, allow_stale: true, expected_head_oid: head });
  assert.equal(commands[0][0].repo, repo);
  assert.equal(commands[0][1], "stale");
  assert.equal(commands[0][2].ciCommands.stale, "/custom stale");
  assert.equal(commands[0][3].expectedHeadOid, head);
  await call("update_branch_and_run_ci", { repo, number: 1, expected_head_oid: head });
  assert.deepEqual(commands[1][2], { runCi: true, expectedHeadOid: head });
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
    const { tools } = await client.listTools();
    assert.equal(tools.length, 18);
    assert.equal(tools.find((tool) => tool.name === "clear_board").annotations.destructiveHint, true);
    const invalid = await client.callTool({ name: "track_pr", arguments: { repo: "bad", number: 0 } });
    assert.equal(invalid.isError, true);
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
