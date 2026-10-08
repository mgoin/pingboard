# Pingboard

One board for the pull requests you are shepherding through CI. Pin the PRs you care about and each one tells you, in plain words, where it stands and what it needs next — instead of a browser tab per PR. The usual maintainer actions (update branch, run or retry CI, labels, approve, merge) are buttons on the board.

<img width="1668" height="1027" alt="Screenshot 2026-10-08 at 12 57 06 PM" src="https://github.com/user-attachments/assets/458d4cbf-d81b-4962-937f-36c99a792ed9" />

It is a static page that talks to the GitHub API from your browser: no server, no build step, no dependencies. It is tuned for [vllm-project/vllm](https://github.com/vllm-project/vllm) and works for any repository.

## The board

Each row is one pull request with a status and, where there is an obvious next step, a button for it.

| Status | Meaning | Button |
| --- | --- | --- |
| **CI not started** | no build on the latest commit | Run CI, or Update branch & run CI when the branch is behind |
| **CI running** | jobs in progress, with any failures so far | — |
| **N failures to look at** | failing jobs not seen failing anywhere else | — |
| **N failures, likely unrelated** | every failing job also fails on the base branch or on other pinned PRs | Retry failed jobs |
| **CI passed · needs review** | green, waiting on a review | — |
| **Ready to merge** | green and approved | Merge… |
| **Merge conflicts** | the author has to resolve them | — |

A blue dot marks a PR that changed since you last selected it. Drag rows to reorder them or move them between groups, and drag the divider to resize the list.

Selecting a row opens the detail pane: the status with a one-line explanation, the failing and running jobs (each links to its Buildkite job), branch freshness, reviews, labels, and the latest comments — which is where the CI bot answers `/ci` commands.

**+ Add PRs** lists open pull requests in your default repository (yours, review requested, reviewed, involved, `ready`, all recent) and narrows as you type. Click to pin; pasting PR numbers or URLs works too.

## Related or unrelated failures

Pingboard does not read logs — Buildkite logs are not reachable from a static page. It sorts failing jobs using what GitHub already knows:

- **N/M on base** — the same job failed on N of the last M base-branch commits that ran CI.
- **also #123 #456** — the same job is failing on other PRs on your board.

A job with either kind of evidence is listed as "likely unrelated". Everything else is "to look at".

## Actions

Everything is done as you, with your token.

- **Comments** (`/ci run`, `/ci retry`, `/ci cancel`) and **branch updates** wait three seconds behind an Undo bar before they are sent.
- **Update branch & run CI** merges the base branch in, waits for the new commit, then posts `/ci run`.
- **Approve** and **Merge** ask for confirmation. **Labels** apply immediately.

Keyboard shortcuts exist for all of it; press `?` for the list.

## Token

Pingboard takes a **classic** personal access token with the `repo` scope (`public_repo` is enough for public repositories). It is sent only from your browser to `api.github.com`, and is kept in `sessionStorage` — or `localStorage` if you tick "Keep token after closing this tab". The board itself (pins, groups, preferences) lives in `localStorage` per GitHub login.

## Refresh and rate limits

Open PRs refresh every 60 seconds by default (configurable), background tabs five times slower, at one GraphQL request per PR. The base-branch baseline covers the last 30 commits and is re-read every 10 minutes. Remaining API quota is shown in the top bar, and polling pauses if it runs low.

## Other repositories

`owner/repo#123` or a URL pins a PR from anywhere. Repository-specific workflow — which checks count as CI, the comment commands, the quick labels — lives in `REPO_PROFILES` at the top of `app.js`. Repositories without a profile treat every check as CI and have no CI commands.

## Run it

Open `index.html`, or serve the folder:

```bash
python3 -m http.server 8080
```

The included workflow publishes the folder to GitHub Pages on every push to `main`.

## Saved boards and pull requests

Every pull request runs `tests/state-compat.mjs`: it loads boards saved by earlier versions (`tests/fixtures`) into the changed code, with the GitHub API mocked, and fails if any pins, groups or preferences would be lost. It also has the base version write its own state first and checks the change can take that over. To run it locally:

```bash
cd tests && bun install && bunx playwright install chromium && bun state-compat.mjs --head ..
```
