import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import core from "../../core.js";
import { BoardStore } from "../src/store.mjs";

const execFileAsync = promisify(execFile);
const storeUrl = new URL("../src/store.mjs", import.meta.url).href;

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "pingboard-store-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("pingboard-store-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "board.json");
  return { directory, filePath, store: new BoardStore(filePath) };
}

test("pins and named groups persist across store reloads without duplicate pins", async (t) => {
  const { filePath, directory, store } = await setup(t);
  assert.deepEqual((await store.read()).board, {
    groups: [{ id: "g1", name: "Tracking", collapsed: false }], pins: []
  });
  const first = await store.track({ repo: "mgoin/pingboard", number: 1, group: "Release" });
  assert.equal(first.added, true);
  assert.equal(first.board.groups[1].name, "Release");
  const duplicate = await store.track({ repo: "mgoin/pingboard", number: 1, group: "Other" });
  assert.equal(duplicate.added, false);
  assert.deepEqual(duplicate.pin, first.pin);
  assert.equal(duplicate.board.groups.length, 2);
  const second = await store.track({ repo: "mgoin/pingboard", number: 2, group: "release" });
  assert.equal(second.pin.group, first.pin.group);
  assert.deepEqual((await new BoardStore(filePath).read()).board, second.board);
  assert.deepEqual(await readdir(directory), ["board.json"]);
  assert.equal((await store.untrack({ repo: "mgoin/pingboard", number: 1 })).removed, 1);
  assert.equal((await store.untrack({ repo: "mgoin/pingboard", number: 1 })).removed, 0);
});

test("concurrent instances and interleaved reads do not lose writes", async (t) => {
  const { filePath, store } = await setup(t);
  const other = new BoardStore(filePath);
  const operations = Array.from({ length: 32 }, (_, index) => (index % 2 ? other : store).track({ repo: "mgoin/pingboard", number: index + 1 }));
  const readDuringWrites = other.read();
  await Promise.all(operations);
  assert.equal((await readDuringWrites).board.pins.length, 32);
  assert.equal((await store.read()).board.pins.length, 32);
});

test("independent server processes serialize read-modify-write transactions", async (t) => {
  const { filePath, store } = await setup(t);
  await Promise.all([0, 20, 40].map((offset) => {
    const script = `import { BoardStore } from ${JSON.stringify(storeUrl)};
      const store = new BoardStore(${JSON.stringify(filePath)});
      await Promise.all(Array.from({ length: 12 }, (_, index) => store.track({ repo: "mgoin/pingboard", number: ${offset} + index + 1 })));`;
    return execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { timeout: 20_000 });
  }));
  const { board } = await store.read();
  assert.equal(board.pins.length, 36);
  assert.equal(new Set(board.pins.map((pin) => pin.key)).size, 36);
});

test("corrupt or unsupported files are preserved and the operation queue recovers", async (t) => {
  const { filePath, directory, store } = await setup(t);
  for (const bad of [
    "{not valid JSON",
    JSON.stringify({ board: { groups: [], pins: [] } }),
    JSON.stringify({ board: { groups: [{ id: "g1", name: "Tracking" }], pins: [{ repo: "invalid", number: 1 }] } }),
    JSON.stringify({ board: { groups: [{ id: "g1", name: "Tracking" }], pins: [{ repo: "mgoin/pingboard", number: 1, group: "missing" }] } }),
    JSON.stringify({ pingboard: 2, board: { groups: [{ id: "g1", name: "Tracking" }], pins: [] } })
  ]) {
    await writeFile(filePath, bad);
    await assert.rejects(store.read(), /original file was left unchanged/);
    await assert.rejects(store.track({ repo: "mgoin/pingboard", number: 1 }), /original file was left unchanged/);
    assert.equal(await readFile(filePath, "utf8"), bad);
    assert.deepEqual(await readdir(directory), ["board.json"]);
  }
  await writeFile(filePath, JSON.stringify({ pingboard: 1, board: { groups: [{ id: "g1", name: "Tracking" }], pins: [] } }));
  assert.equal((await store.track({ repo: "mgoin/pingboard", number: 1 })).added, true);
});

test("an occupied process lock times out without overwriting the board or stealing the lock", async (t) => {
  const { filePath, store } = await setup(t);
  await store.track({ repo: "mgoin/pingboard", number: 1 });
  const original = await readFile(filePath, "utf8");
  const lockPath = `${filePath}.lock`;
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
  const started = Date.now();
  await assert.rejects(store.track({ repo: "mgoin/pingboard", number: 2 }), /Timed out waiting for Pingboard store lock/);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(await readFile(filePath, "utf8"), original);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid);
});

test("clear removes only selected pins or all pins while retaining groups and preferences", async (t) => {
  const { store } = await setup(t);
  await store.track({ repo: "mgoin/pingboard", number: 1 });
  await store.track({ repo: "mgoin/pingboard", number: 2, group: "Blockers" });
  await store.setProfile("mgoin/pingboard", { ciPrefix: "custom/", ciCommands: { run: "/run-ci" }, quickLabels: ["ready"] });
  const original = await store.read();
  await assert.rejects(store.clear({ scope: "selected" }), /explicit/);
  await assert.rejects(store.clear({ scope: "selected", keys: [] }), /explicit/);
  await assert.rejects(store.clear({ scope: "closed" }), /scope/);
  assert.deepEqual(await store.read(), original);
  assert.equal((await store.clear({ scope: "selected", keys: ["mgoin/pingboard#1", "mgoin/pingboard#999"] })).removed, 1);
  assert.deepEqual((await store.read()).board.pins.map((pin) => pin.number), [2]);
  assert.equal((await store.clear()).removed, 1);
  const cleared = await store.read();
  assert.deepEqual(cleared.board.groups, original.board.groups);
  assert.deepEqual(cleared.prefs, original.prefs);
  assert.deepEqual(cleared.board.pins, []);
});

for (const name of ["v3-two-groups", "v3-following", "v3-collapsed-and-empty-groups"]) {
  test(`browser fixture ${name} roundtrips groups, pins, and preferences`, async (t) => {
    const { store } = await setup(t);
    const fixture = JSON.parse(await readFile(new URL(`../../tests/fixtures/${name}.json`, import.meta.url), "utf8"));
    const prefix = `pingboard.v3.${fixture.login}`;
    const board = fixture.localStorage[`${prefix}.board`];
    const prefs = fixture.localStorage[`${prefix}.prefs`];
    await store.importBoard({ pingboard: 1, board, prefs }, { mode: "replace" });
    const exported = await store.exportBoard();
    assert.equal(exported.pingboard, 1);
    assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
    assert.deepEqual(exported.board, core.cleanBoard(board));
    assert.deepEqual(exported.prefs, core.normalizePrefs(prefs));
    assert.ok(!JSON.stringify(exported).includes("test-token"));
  });
}

test("imports and profile updates whitelist persisted fields and preserve overrides", async (t) => {
  const { store, filePath } = await setup(t);
  const secret = "sentinel-github-token";
  const profile = { ciPrefix: "custom/", mainPipeline: "build", ciCommands: { run: "/build", retry: "/retry", token: secret }, quickLabels: ["ready", "ready", "reviewed"], mergeMethod: "merge", token: secret };
  const board = { groups: [{ id: "g1", name: "Tracking", token: secret }], pins: [{ repo: "mgoin/pingboard", number: 1, group: "g1", addedAt: 123, token: secret }] };
  await store.importBoard({ pingboard: 1, token: secret, board, prefs: { token: secret, following: ["alice"], repoProfiles: { "mgoin/pingboard": profile } } }, { mode: "replace" });
  let exported = await store.exportBoard();
  assert.equal(exported.prefs.repoProfiles["mgoin/pingboard"].ciCommands.run, "/build");
  assert.deepEqual(exported.prefs.repoProfiles["mgoin/pingboard"].quickLabels, ["ready", "reviewed"]);
  assert.ok(!JSON.stringify(exported).includes(secret));
  assert.ok(!(await readFile(filePath, "utf8")).includes(secret));
  const result = await store.setProfile("vllm-project/vllm", { mainPipeline: "changed", token: secret });
  assert.equal(result.profile.mainPipeline, "changed");
  assert.equal(result.profile.ciCommands.run, "/ci run");
  assert.equal(result.profile.ciPrefix, "buildkite/");
  exported = await store.exportBoard();
  assert.equal(exported.prefs.repoProfiles["mgoin/pingboard"].ciCommands.run, "/build");
  assert.ok(!JSON.stringify(exported).includes(secret));
});

test("default repository switches persist without changing mixed-repo pins, preferences, or profiles", async (t) => {
  const { store, filePath } = await setup(t);
  await store.importBoard({
    pingboard: 1,
    board: {
      groups: [{ id: "g1", name: "Tracking", collapsed: false }, { id: "release", name: "Release", collapsed: true }],
      pins: [
        { repo: "vllm-project/vllm", number: 1, group: "g1", addedAt: 100 },
        { repo: "mgoin/pingboard", number: 2, group: "release", addedAt: 200 }
      ]
    },
    prefs: {
      defaultRepo: "vllm-project/vllm", interval: 120, notify: true, boardWidth: 400, following: ["alice"],
      repoProfiles: {
        "mgoin/pingboard": { ciPrefix: "custom/", mainPipeline: "test", ciCommands: { run: "/test" }, quickLabels: ["ready"] }
      }
    }
  }, { mode: "replace" });
  const before = await store.read();
  const switched = await store.setDefaultRepo("mgoin/pingboard");
  assert.equal(switched.previousDefaultRepo, "vllm-project/vllm");
  assert.equal(switched.defaultRepo, "mgoin/pingboard");
  assert.equal(switched.profile.ciPrefix, "custom/");
  assert.equal(switched.profile.ciCommands.run, "/test");
  const reloaded = new BoardStore(filePath);
  assert.deepEqual(await reloaded.read(), { ...before, prefs: { ...before.prefs, defaultRepo: "mgoin/pingboard" } });

  const generic = await reloaded.setDefaultRepo("other/repo");
  assert.equal(generic.previousDefaultRepo, "mgoin/pingboard");
  assert.equal(generic.defaultRepo, "other/repo");
  assert.equal(generic.profile.ciPrefix, null);
  assert.equal(generic.profile.mainPipeline, null);
  assert.equal(generic.profile.ciCommands, null);
  assert.deepEqual(generic.profile.quickLabels, []);
  assert.deepEqual(await new BoardStore(filePath).read(), { ...before, prefs: { ...before.prefs, defaultRepo: "other/repo" } });

  const persisted = await readFile(filePath, "utf8");
  await assert.rejects(reloaded.setDefaultRepo("invalid"), /owner\/repo/);
  assert.equal(await readFile(filePath, "utf8"), persisted);
});

test("merge matches group names, deduplicates pins, and applies imported preferences like the browser", async (t) => {
  const { store } = await setup(t);
  const original = await store.track({ repo: "mgoin/pingboard", number: 1, group: "Blockers" });
  const before = await store.read();
  const imported = {
    pingboard: 1,
    board: {
      groups: [{ id: "gother", name: "BLOCKERS", collapsed: true }, { id: "gnew", name: "New", collapsed: true }, { id: "gcollision", name: "g1", collapsed: false }],
      pins: [
        { repo: "mgoin/pingboard", number: 1, group: "gnew", addedAt: 10 },
        { repo: "mgoin/pingboard", number: 2, group: "gother", addedAt: 20 },
        { repo: "mgoin/pingboard", number: 3, group: "gnew", addedAt: 30, seen: "OPEN|abc" }
      ]
    }
  };
  let result = await store.importBoard(imported);
  assert.deepEqual(result.board.groups.map((group) => group.name), ["Tracking", "Blockers", "New", "g1"]);
  assert.deepEqual(result.board.pins[0], original.pin);
  assert.equal(result.board.pins[1].group, original.pin.group);
  assert.equal(result.board.pins[2].seen, "OPEN|abc");
  assert.equal(result.board.pins.length, 3);
  assert.deepEqual(result.prefs, before.prefs);
  result = await store.importBoard({ ...imported, prefs: { interval: 120, defaultRepo: "mgoin/pingboard" } });
  assert.equal(result.board.pins.length, 3);
  assert.equal(result.prefs.interval, 120);
  assert.equal(result.prefs.defaultRepo, "mgoin/pingboard");
  await assert.rejects(store.importBoard({ ...imported, pingboard: 9 }), /Unsupported/);
  await assert.rejects(store.importBoard(imported, { mode: "invalid" }), /mode/);
});

test("legacy bare boards import and malformed PR references reject without writes", async (t) => {
  const { store, directory } = await setup(t);
  for (const input of [{ repo: "bad", number: 1 }, { repo: "mgoin/pingboard", number: 0 }, { repo: "mgoin/pingboard", number: 1.5 }, { repo: "mgoin/pingboard" }]) {
    await assert.rejects(store.track(input));
  }
  await assert.rejects(store.track({ repo: "mgoin/pingboard", number: 1, group: " " }));
  await assert.rejects(store.setProfile("invalid", {}));
  await assert.rejects(store.setProfile("mgoin/pingboard", null));
  assert.deepEqual(await readdir(directory), []);
  await store.importBoard({ groups: [{ id: "legacy", name: "Legacy" }], pins: [] }, { mode: "replace" });
  assert.equal((await store.read()).board.groups[0].id, "legacy");
});
