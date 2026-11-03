import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BoardStore } from "../src/store.mjs";

const repo = "mgoin/pingboard";
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "pingboard-store-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("pingboard-store-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "board.json");
  return { filePath, store: new BoardStore(filePath) };
}

test("concurrent stores persist unique pins; removals preserve groups and preferences", async (t) => {
  const { filePath, store } = await setup(t);
  const other = new BoardStore(filePath);
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    (i % 2 ? other : store).track({ repo, number: i + 1, group: "Release" })));
  const saved = await new BoardStore(filePath).read();
  assert.equal(saved.board.pins.length, 8);
  assert.equal(new Set(saved.board.pins.map((pin) => pin.key)).size, 8);
  assert.deepEqual(saved.board.groups.map((group) => group.name), ["Tracking", "Release"]);
  assert.equal((await store.track({ repo, number: 1, group: "Other" })).added, false);
  assert.deepEqual(await store.read(), saved);
  assert.equal((await store.untrack({ repo, number: 1 })).removed, 1);
  await assert.rejects(store.clear({ scope: "selected" }), /explicit/);
  assert.equal((await store.clear({ scope: "selected", keys: [`${repo}#2`] })).removed, 1);
  assert.equal((await store.clear()).removed, 6);
  assert.deepEqual(await store.read(), { ...saved, board: { ...saved.board, pins: [] } });
});

test("imports merge groups and pins, roundtrip exports, and exclude secret fields", async (t) => {
  const { filePath, store } = await setup(t);
  const original = await store.track({ repo, number: 1, group: "Release" });
  const backup = {
    pingboard: 1,
    board: {
      groups: [{ id: "external", name: "RELEASE" }],
      pins: [1, 2].map((number) => ({ repo, number, group: "external", addedAt: 123, token: "secret" }))
    },
    prefs: { interval: 120, sort: "status", filter: "requested", owner: "others", token: "secret" }
  };
  const merged = await store.importBoard(backup);
  assert.deepEqual(merged.board.groups.map((group) => group.name), ["Tracking", "Release"]);
  assert.deepEqual(merged.board.pins[0], original.pin);
  assert.equal(merged.board.pins[1].group, original.pin.group);
  const exported = await store.exportBoard();
  assert.equal(exported.pingboard, 1);
  assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
  assert.equal(exported.prefs.interval, 120);
  assert.equal(exported.prefs.sort, "status");
  assert.equal(exported.prefs.filter, "requested");
  assert.equal(exported.prefs.owner, "others");
  assert.deepEqual(await new BoardStore(filePath).read(), merged);
  assert.ok(!JSON.stringify(exported).includes("secret"));
  assert.ok(!(await readFile(filePath, "utf8")).includes("secret"));
  await store.clear();
  assert.deepEqual(await store.importBoard(exported, { mode: "replace" }), merged);
  await assert.rejects(store.importBoard({ ...backup, pingboard: 2 }), /Unsupported/);
});

test("corrupt files reject writes without losing data, and the queue recovers", async (t) => {
  const { filePath, store } = await setup(t);
  const saved = await store.exportBoard();
  const malformed = { ...saved, board: { ...saved.board, pins: [{ repo: "invalid", number: 1 }] } };
  for (const bad of ["{invalid JSON", JSON.stringify(malformed)]) {
    await writeFile(filePath, bad);
    await assert.rejects(store.track({ repo, number: 1 }), /original file was left unchanged/);
    assert.equal(await readFile(filePath, "utf8"), bad);
  }
  await writeFile(filePath, JSON.stringify(saved));
  assert.equal((await store.track({ repo, number: 1 })).added, true);
});

test("default repository switches preserve mixed pins and independent repository profiles", async (t) => {
  const { filePath, store } = await setup(t);
  await store.track({ repo: "vllm-project/vllm", number: 1 });
  await store.track({ repo, number: 2, group: "Release" });
  await store.setProfile(repo, { ciPrefix: "custom/", ciCommands: { run: "/test" } });
  const before = await store.read();
  const switched = await store.setDefaultRepo(repo);
  assert.equal(switched.previousDefaultRepo, "vllm-project/vllm");
  assert.equal(switched.profile.ciCommands.run, "/test");
  assert.equal(switched.profile.ciPrefix, "custom/");
  assert.deepEqual(await new BoardStore(filePath).read(), { ...before, prefs: { ...before.prefs, defaultRepo: repo } });
  const generic = await store.setDefaultRepo("other/repo");
  assert.equal(generic.previousDefaultRepo, repo);
  assert.equal(generic.profile.ciPrefix, null);
  assert.equal(generic.profile.ciCommands, null);
  const expected = { ...before, prefs: { ...before.prefs, defaultRepo: "other/repo" } };
  await assert.rejects(store.setDefaultRepo("invalid"), /owner\/repo/);
  assert.deepEqual(await new BoardStore(filePath).read(), expected);
});
