import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import core from "../../core.js";

const { cleanBoard, normalizePrefs, pinKey, profileFor } = core;
const pending = new Map();
const LOCK_TIMEOUT_MS = 5_000;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function emptyState() {
  return {
    board: { groups: [{ id: "g1", name: "Tracking", collapsed: false }], pins: [] },
    prefs: normalizePrefs({})
  };
}

function validateRef(repo, number) {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("Repository must be in owner/repo form.");
  }
  if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0)) {
    throw new Error("Pull request number must be a positive safe integer.");
  }
}

function parseBackup(payload) {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("The board import is not valid JSON.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The import is not a Pingboard backup.");
  }
  if (hasOwn(value, "pingboard") && value.pingboard !== 1) {
    throw new Error("Unsupported Pingboard backup version; expected pingboard: 1.");
  }
  const board = cleanBoard(value.board || value);
  if (!board) throw new Error("The import is not a Pingboard backup with valid groups and pins.");
  if (new Set(board.groups.map((group) => group.id)).size !== board.groups.length
    || board.groups.some((group) => !group.id)
    || board.pins.some((pin) => !Number.isSafeInteger(pin.number))) {
    throw new Error("The backup contains invalid group IDs or pull request numbers.");
  }
  return { board, prefs: hasOwn(value, "prefs") ? normalizePrefs(value.prefs) : null };
}

function enqueue(filePath, operation) {
  const previous = pending.get(filePath) || Promise.resolve();
  const task = previous.then(operation);
  // Rejections must not poison the queue or become an unhandled rejection.
  const completed = task.then(() => {}, () => {});
  pending.set(filePath, completed);
  completed.then(() => {
    if (pending.get(filePath) === completed) pending.delete(filePath);
  });
  return task;
}

function ensureGroup(board, nameOrId, matchIds = true) {
  if (nameOrId === undefined) return board.groups[0];
  const existing = (matchIds && board.groups.find((group) => group.id === nameOrId))
    || board.groups.find((group) => group.name.toLowerCase() === nameOrId.toLowerCase());
  if (existing) return existing;
  const group = { id: `g${randomUUID().replaceAll("-", "")}`, name: nameOrId, collapsed: false };
  board.groups.push(group);
  return group;
}

/** A local board only: no store operation can mutate a GitHub pull request. */
export class BoardStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("A board file path is required.");
    this.filePath = resolve(filePath);
  }

  async _read() {
    let raw;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !hasOwn(parsed, "board")) {
        throw new Error("Missing board object.");
      }
      const { board, prefs } = parseBackup(parsed);
      // Imports may clean up old browser data, but a damaged store must never
      // lose entries merely because the next write passed through a normalizer.
      const groupIds = new Set(board.groups.map((group) => group.id));
      if (parsed.board.groups.length !== board.groups.length
        || parsed.board.pins.length !== board.pins.length
        || groupIds.size !== board.groups.length
        || board.groups.some((group) => !group.id)
        || parsed.board.pins.some((pin) => !Number.isSafeInteger(pin.number) || !groupIds.has(pin.group))) {
        throw new Error("Stored board contains invalid or duplicate groups or pins.");
      }
      if (hasOwn(parsed, "prefs") && (!parsed.prefs || typeof parsed.prefs !== "object" || Array.isArray(parsed.prefs))) {
        throw new Error("Stored preferences must be an object.");
      }
      return { board, prefs: prefs || normalizePrefs({}) };
    } catch (error) {
      const reason = error instanceof SyntaxError ? "Invalid JSON." : error.message;
      throw new Error(`Cannot read Pingboard store ${this.filePath}: ${reason} The original file was left unchanged.`, { cause: error });
    }
  }

  async _lock() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Pingboard store lock ${lockPath}. Another process may be updating this board. If it has stopped, remove the lock only after confirming no process is writing the board.`);
        }
        await delay(25 + Math.floor(Math.random() * 50));
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error) {
        await handle.close();
        await unlink(lockPath);
        throw error;
      }
      return async () => {
        await handle.close();
        await unlink(lockPath);
      };
    }
  }

  async _write(state) {
    // Same-directory rename makes readers see either complete version of the file.
    const tempPath = resolve(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pingboard: 1, board: cleanBoard(state.board), prefs: normalizePrefs(state.prefs) }, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, this.filePath);
    } finally {
      if (handle) await handle.close();
      await unlink(tempPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  _mutate(operation) {
    return enqueue(this.filePath, async () => {
      const release = await this._lock();
      try {
        // Always reload under the lock, including when another instance last wrote.
        const state = await this._read();
        const result = operation(state);
        await this._write(state);
        return result;
      } finally {
        await release();
      }
    });
  }

  read() {
    return enqueue(this.filePath, () => this._read());
  }

  async track({ repo, number, group } = {}) {
    validateRef(repo, number);
    if (number === undefined) throw new Error("A pull request number is required.");
    if (group !== undefined && (typeof group !== "string" || !group.trim())) {
      throw new Error("Group must be a non-empty group name or ID.");
    }
    return this._mutate(({ board }) => {
      const key = pinKey(repo, number);
      const existing = board.pins.find((pin) => pin.key === key);
      if (existing) return { added: false, pin: existing, board };
      const target = ensureGroup(board, group?.trim());
      const pin = { key, repo, number, group: target.id, addedAt: Date.now() };
      board.pins.push(pin);
      target.collapsed = false;
      return { added: true, pin, board };
    });
  }

  async untrack({ repo, number } = {}) {
    validateRef(repo, number);
    if (number === undefined) throw new Error("A pull request number is required.");
    return this._mutate(({ board }) => {
      const before = board.pins.length;
      board.pins = board.pins.filter((pin) => pin.key !== pinKey(repo, number));
      return { removed: before - board.pins.length, board };
    });
  }

  async clear({ scope = "all", keys } = {}) {
    if (scope !== "all" && scope !== "selected") throw new Error("Clear scope must be all or selected.");
    if (scope === "selected" && (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string" || !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(key)))) {
      throw new Error("Clearing selected pins requires a non-empty array of explicit owner/repo#number keys.");
    }
    const selected = new Set(scope === "selected" ? keys : []);
    return this._mutate(({ board }) => {
      const before = board.pins.length;
      board.pins = scope === "all" ? [] : board.pins.filter((pin) => !selected.has(pin.key));
      return { removed: before - board.pins.length, board };
    });
  }

  async importBoard(payload, { mode = "merge" } = {}) {
    if (mode !== "merge" && mode !== "replace") throw new Error("Import mode must be merge or replace.");
    const imported = parseBackup(payload);
    return this._mutate((state) => {
      if (mode === "replace") {
        state.board = imported.board;
      } else {
        // Browser imports match groups by name, case-insensitively.
        const groupIds = new Map(imported.board.groups.map((group) => {
          const existing = state.board.groups.find((item) => item.name.toLowerCase() === group.name.toLowerCase());
          const target = existing || ensureGroup(state.board, group.name, false);
          if (group.query && !target.query) Object.assign(target, { query: group.query, dismissed: group.dismissed });
          return [group.id, target.id];
        }));
        const pinned = new Set(state.board.pins.map((pin) => pin.key));
        for (const pin of imported.board.pins) {
          if (pinned.has(pin.key)) continue;
          state.board.pins.push({
            ...pin,
            group: groupIds.get(pin.group),
            ...(pin.via ? { via: groupIds.get(pin.via) } : {})
          });
          state.board.groups.find((group) => group.id === groupIds.get(pin.group)).collapsed = false;
          pinned.add(pin.key);
        }
      }
      if (imported.prefs) state.prefs = imported.prefs;
      return state;
    });
  }

  async exportBoard() {
    const { board, prefs } = await this.read();
    return { pingboard: 1, exportedAt: new Date().toISOString(), board, prefs };
  }

  async setDefaultRepo(repo) {
    validateRef(repo);
    return this._mutate((state) => {
      const previousDefaultRepo = state.prefs.defaultRepo;
      state.prefs.defaultRepo = repo;
      return { previousDefaultRepo, defaultRepo: repo, profile: profileFor(repo, state.prefs.repoProfiles) };
    });
  }

  async setProfile(repo, profile) {
    validateRef(repo);
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("Repository profile must be an object.");
    }
    // Normalizing before queueing also prevents callers from mutating this input.
    const normalized = normalizePrefs({ repoProfiles: { [repo]: profile } }).repoProfiles[repo];
    return this._mutate((state) => {
      state.prefs = normalizePrefs({ ...state.prefs, repoProfiles: { ...state.prefs.repoProfiles, [repo]: normalized } });
      return { repo, profile: profileFor(repo, state.prefs.repoProfiles), prefs: state.prefs };
    });
  }
}
