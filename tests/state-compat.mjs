/* Would this change lose or mangle a board that people already have saved?

   For every fixture in tests/fixtures (the browser storage of an existing user):
     1. the app under test loads it and shows the same groups, pins and preferences;
     2. a reload gives the same result (what it wrote back is readable);
     3. with --base, the previous version loads the fixture first and writes its own
        state, then the app under test takes over that storage and nothing changes.

   The GitHub API is mocked, so no token or network is needed.

   usage: node state-compat.mjs --head <dir> [--base <dir>] */

import { chromium } from "playwright";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ORIGIN = "http://pingboard.test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const here = path.dirname(fileURLToPath(import.meta.url));

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : path.resolve(process.argv[at + 1]);
}

/* Just enough of api.github.com for the board to load and refresh its pins. */
function mockGitHub(request, login) {
  const url = new URL(request.url());
  if (url.pathname === "/user") return { login };
  if (url.pathname !== "/graphql") return [];
  const { query, variables = {} } = JSON.parse(request.postData() || "{}");
  if (query.includes("pullRequest(number:")) {
    const oid = "a".repeat(40);
    const now = new Date().toISOString();
    return { data: { repository: {
      ref: { compare: { aheadBy: 1, behindBy: 0 } },
      pullRequest: {
        id: `PR_${variables.number}`, number: variables.number, title: `Test pull request ${variables.number}`,
        url: `https://github.com/${variables.owner}/${variables.name}/pull/${variables.number}`,
        state: "OPEN", isDraft: false, updatedAt: now, author: { login: "someone" }, authorAssociation: "MEMBER",
        baseRefName: "main", headRefOid: oid, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
        viewerCanUpdateBranch: true, viewerCanEnableAutoMerge: true, autoMergeRequest: null,
        additions: 1, deletions: 1, changedFiles: 1,
        labels: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, comments: { nodes: [] },
        commits: { nodes: [{ commit: { oid, committedDate: now, statusCheckRollup: null } }] }
      }
    } } };
  }
  if (query.includes("history(first:")) return { data: { repository: { ref: { target: { history: { nodes: [] } } } } } };
  if (query.includes("search(")) return { data: { search: { issueCount: 0, nodes: [] } } };
  return { data: { repository: { object: null } } };
}

async function openSession(browser, login) {
  const context = await browser.newContext();
  const session = { context, dir: null, errors: [] };
  await context.route("**/*", (route) => route.abort());   // fonts and anything else external
  await context.route("https://api.github.com/**", (route) => route.fulfill({
    json: mockGitHub(route.request(), login),
    headers: { "access-control-allow-origin": "*" }   // the app calls the API cross-origin
  }));
  await context.route(`${ORIGIN}/**`, async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname === "/__blank") return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
    const file = path.join(session.dir, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    try {
      await route.fulfill({ contentType: MIME[path.extname(file)] || "application/octet-stream", body: await readFile(file) });
    } catch {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });
  session.page = await context.newPage();
  session.page.on("pageerror", (error) => session.errors.push(error.message));
  return session;
}

async function seed(session, storage) {
  await session.page.goto(`${ORIGIN}/__blank`);
  await session.page.evaluate((entries) => {
    localStorage.clear();
    sessionStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  }, storage);
}

/* Load the app from `dir` on the session's current storage and describe the board it ends up with. */
async function load(session, dir) {
  session.dir = dir;
  session.errors.length = 0;
  await session.page.goto(`${ORIGIN}/`);
  // `state` is the app's top-level state object; signed in means the saved board has been read.
  await session.page.waitForFunction(() => typeof state !== "undefined" && Boolean(state.user), null, { timeout: 15000 });
  await session.page.waitForTimeout(1500);   // let the pin refreshes land and be written back
  const snapshot = await session.page.evaluate(() => JSON.parse(JSON.stringify({ board: state.board, prefs: state.prefs })));
  const groupName = (id) => snapshot.board.groups.find((group) => group.id === id)?.name ?? `<missing group ${id}>`;
  return {
    groups: snapshot.board.groups.map((group) => group.name),
    collapsed: snapshot.board.groups.filter((group) => group.collapsed).map((group) => group.name),
    pins: snapshot.board.pins.map((pin) => `${pin.repo}#${pin.number} in ${groupName(pin.group)}`),
    prefs: snapshot.prefs,
    errors: [...session.errors]
  };
}

const failures = [];
function check(label, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) return;
  failures.push(label);
  console.log(`  FAIL ${label}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
}

function compare(label, result, expected) {
  check(`${label}: groups`, result.groups, expected.groups);
  check(`${label}: collapsed groups`, result.collapsed, expected.collapsed);
  check(`${label}: pins`, result.pins, expected.pins);
  for (const [key, value] of Object.entries(expected.prefs)) check(`${label}: preference ${key}`, result.prefs[key], value);
  check(`${label}: page errors`, result.errors, []);
}

const head = option("head");
const base = option("base");
if (!head) throw new Error("usage: node state-compat.mjs --head <dir> [--base <dir>]");

const browser = await chromium.launch();
const fixtureDir = path.join(here, "fixtures");
for (const name of (await readdir(fixtureDir)).filter((file) => file.endsWith(".json")).sort()) {
  const fixture = JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
  console.log(`\n${name} — ${fixture.description}`);
  const session = await openSession(browser, fixture.login);

  await seed(session, fixture.localStorage);
  compare("saved board loads", await load(session, head), fixture.expect);
  compare("and survives a reload", await load(session, head), fixture.expect);

  if (base) {
    await seed(session, fixture.localStorage);
    let before = null;
    try {
      before = await load(session, base);
    } catch (error) {
      console.log(`  skipped upgrade check: the base version did not load a board (${error.message.split("\n")[0]})`);
    }
    if (before) compare("board written by the base version loads", await load(session, head), { ...before, prefs: fixture.expect.prefs });
  }
  await session.context.close();
}
await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed: this change would lose or alter saved boards.`);
  console.log("If the storage format is meant to change, migrate the old format on load and add a fixture for the new one.");
  process.exit(1);
}
console.log("\nSaved boards load unchanged.");
