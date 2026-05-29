# Pingboard

Pingboard is a static GitHub Pages dashboard for GitHub notifications. It reshapes the inbox into Slack-like activity lanes so direct pings are visually separated from reviewer churn, watch traffic, CI, and security notifications.

## What It Does

- Fetches GitHub notifications in the browser with your own token.
- Classifies notifications by GitHub's `reason` field.
- Highlights direct mentions, team mentions, assignments, authored threads, personal review requests, team review requests, CI, security alerts, and watch noise.
- Enriches each notification with subject details, latest visible comment text, actor avatars, and pull request reviewer shape when GitHub exposes it.
- Lets you open, mark read, mark done, or ignore a notification thread.

## GitHub Token

GitHub's notifications REST endpoint currently requires a classic personal access token. Fine-grained personal access tokens and GitHub App tokens are not supported for the notifications endpoint.

Use the least access that works for your account:

- Public-only notifications: `notifications`
- Private repository notifications: `notifications` plus repository access needed for those private threads

The token is sent directly from your browser to `api.github.com`. If you do not check "Keep token after closing this tab", Pingboard uses `sessionStorage`; otherwise it uses `localStorage`.

Pingboard sends `X-GitHub-Api-Version: 2022-11-28`, which is the version shown in GitHub's current notifications REST docs.

## Codex-Side Report

If the browser app is not the right fit, you can run the same notification classifier from Codex or a terminal:

```bash
GITHUB_TOKEN=ghp_... node tools/codex-notifications.mjs
```

Use `--all` to include read notifications and `--mine` to use GitHub's participating filter.

## Run Locally

Open `index.html` in a browser, or serve the folder with any static file server:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Publish To GitHub Pages

1. Create an empty GitHub repository.
2. Push this folder to it.
3. In the repository settings, enable Pages with "GitHub Actions" as the source.
4. The included workflow publishes the static site.

The site is subpath-safe, so a repository named `pingboard` will work at:

```text
https://<your-user>.github.io/pingboard/
```

## Classification Notes

GitHub notifications expose a thread-level `reason`, and that reason can change if a later event is more direct. Pingboard treats `mention`, `team_mention`, `assign`, and `author` as direct. It treats `review_requested` as personal when the pull request still lists you as an individual requested reviewer, and as ambient/team review when only teams are listed.

CODEOWNERS review requests are not always explicitly labeled by GitHub's REST notification payload. Pingboard surfaces team review requests as "possible CODEOWNERS" when the PR has requested teams but not an individual request.
