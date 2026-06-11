# Pingboard

Pingboard is a static, keyboard-first triage console for GitHub notifications, built for maintainers who are oversubscribed. It runs entirely in your browser against the GitHub REST API — no server, no build step, no dependencies.

It does three things hard:

1. **Sweep fast.** Gmail-style keyboard triage (`j`/`k`/`e`/`m`/`t`) with auto-advance, bulk select, "Done all" for a whole filtered view, and a 5-second undo buffer before anything actually hits GitHub.
2. **Track what matters.** Pin priority PRs/issues to a watchlist. Items with new activity float up; merged/closed work files itself into a **Shipped** section that you clear when acknowledged.
3. **Kill noise.** Mute whole repositories, hide bot traffic, isolate "stale" notifications whose PR/issue is already merged or closed, and slice by repo facets or lanes (Direct / Review / Ambient / System).

## Keyboard shortcuts

Press `?` in the app for this list.

| Key | Action |
| --- | --- |
| `j` / `k` | move cursor down / up |
| `o` / `Enter` | open on GitHub (marks read) |
| `e` | mark done · in Tracked: mark seen / clear shipped |
| `r` | mark read |
| `m` | mute thread (unsubscribe + done) |
| `shift+m` | mute repository |
| `t` | track / untrack the PR or issue |
| `p` | priority-track · toggle priority flag |
| `x` / `shift+x` | select thread / select everything in view |
| `u` | undo pending actions |
| `s` | toggle stale filter (merged/closed threads) |
| `i` | cycle type filter: all · PRs · issues |
| `1`–`5` | lanes: all · direct · review · ambient · system |
| `6` | tracked view |
| `/` | focus search |
| `shift+r` | refresh now |
| `Esc` | clear selection / search / filters |

Mark done / read / mute actions are optimistic: they leave the screen immediately, wait 5 seconds, then commit to GitHub. `u` (or the Undo toast) takes them back. Closing the tab flushes pending actions immediately.

## GitHub token

GitHub's notifications REST endpoint requires a **classic** personal access token (fine-grained tokens are not supported for it).

- Public-only notifications: `notifications` scope
- Private repository notifications and context: `notifications` + `repo`

The token is sent only from your browser to `api.github.com`. With "Keep token after closing this tab" unchecked it lives in `sessionStorage`; checked, in `localStorage`. Everything else Pingboard remembers (tracked threads, muted repos, preferences, the enrichment cache) is stored in `localStorage`, namespaced per GitHub login — so the deployed site works for anyone with their own token.

## Speed & rate limits

- Each notification is enriched (subject, latest comment, PR state) with a small worker pool, then cached in `localStorage` keyed by the thread's `updated_at` — refreshes and reloads only re-fetch what changed.
- Background polling honors GitHub's `X-Poll-Interval` and uses `If-Modified-Since`, so an idle tab consumes almost no rate limit (304s are free).
- Remaining API quota is always visible in the top bar.

## Run locally

Open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8080
```

## Publish to GitHub Pages

1. Push this folder to a repository.
2. In settings, enable Pages with "GitHub Actions" as the source.
3. The included workflow publishes the static site. The site is subpath-safe (`https://<user>.github.io/pingboard/`).

## Classification notes

Pingboard lanes notifications by GitHub's thread-level `reason`, upgraded with thread context once enriched:

- **Direct** — `mention`, `team_mention`, `assign`, `author`, or your @login appearing in the latest visible comment.
- **Review** — `review_requested` where you are individually listed as a requested reviewer, plus deployment approvals.
- **Ambient** — watch traffic, comment follow-ups, manual subscriptions, and team review requests (likely CODEOWNERS — GitHub doesn't label these explicitly).
- **System** — CI activity, security alerts, invitations, state changes.

Bot detection covers `[bot]` accounts, common CI/dependency bots, and dependabot-style titles.

Author standing comes from `author_association` on the thread itself (no extra API calls): owner/member/collaborator threads get a `core` pill, first-time contributors a `first-time` pill, with the full value shown in the detail pane.
