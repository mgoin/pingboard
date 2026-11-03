# Pingboard MCP

A local stdio MCP server for the pull requests you are shepherding. It shares repository profiles, check normalization, failure correlation and status judgments with the static Pingboard dashboard.

## Setup

Keep this directory inside the Pingboard checkout: it imports `../core.js`. Requires Node.js 22 or newer.

```bash
npm ci --prefix mcp
```

Configure your MCP client to launch `node` with the absolute path to `mcp/src/cli.mjs`. For clients using the common JSON configuration format:

```json
{
  "mcpServers": {
    "pingboard": {
      "command": "node",
      "args": ["/absolute/path/to/pingboard/mcp/src/cli.mjs"],
      "env": {
        "GITHUB_TOKEN": "YOUR_GITHUB_TOKEN",
        "PINGBOARD_STATE_FILE": "/absolute/path/to/private/pingboard-board.json"
      }
    }
  }
}
```

On Windows use an absolute path with forward slashes, such as `C:/projects/pingboard/mcp/src/cli.mjs`, or escape backslashes in JSON. Use your client's secret/environment facility for the token when available. Launch the Node entrypoint directly so stdout contains only MCP protocol messages.

`GITHUB_TOKEN` takes precedence over `GH_TOKEN`. Credentials are read from the process environment, never saved in the board or exported. GitHub enforces the authenticated user's repository permissions. As with the browser, a classic PAT with `public_repo` works for public-repository operations; private repositories require `repo`. Organization policies may impose additional restrictions.

`PINGBOARD_STATE_FILE` defaults to `~/.pingboard/board.json`. Keep it outside a publicly served checkout. Use a different state file for each account if running multiple identities. Local board tools work without a token; GitHub reads and actions require one. This version targets github.com.

## Tools

| Tool | Behavior |
| --- | --- |
| `get_board` | Refresh tracked PRs, CI state, review decisions, blockers and evidence. `refresh:false` reads local pins only. |
| `inspect_pr` | Detailed current-head checks, requested reviewers, reviews, recent comments, branch status and failure comparisons. Does not pin the PR. |
| `compare_failures` | Match failing jobs against recent base commits and other tracked PRs in the same repository. |
| `list_review_requests` | Open PRs requesting your review, including requests to teams GitHub associates with you. |
| `find_prs` | Views: `review_requested`, `mine`, `reviewed`, `involved`, `ready` (the `ready` label), and `recent`. |
| `set_default_repo` | Persist the repository used by searches when `repo` is omitted; returns its effective CI profile. |
| `track_pr` | Pin a PR, optionally choosing an existing group ID or creating a named group. |
| `untrack_pr` | Remove one local pin. |
| `clear_board` | Required scope: `all`, `closed` (closed and merged), or `merged`. Optional `dry_run:true` previews removals. |
| `import_board` | Import browser backup JSON with `merge` or `replace` mode. |
| `export_board` | Return a browser-compatible backup containing groups, pins and non-secret preferences. |
| `get_repo_profile` | Read effective repository workflow settings. |
| `set_repo_profile` | Replace an override; omitted fields use built-in defaults. |
| `run_ci` | Post the configured run command. `allow_stale:true` selects the configured stale command explicitly. |
| `retry_ci` | Post the configured retry command. |
| `cancel_ci` | Post the configured cancel command. |
| `update_branch` | Ask GitHub to merge the base branch into the PR. |
| `update_branch_and_run_ci` | Update, wait for a changed head caught up to base, then post the run command. |

PR targets use `{ "repo": "vllm-project/vllm", "number": 123 }`. Search tools default to the board's default repository, accept additional GitHub search text, and return `nextCursor` for pagination. [GitHub's review-request search semantics](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests#search-by-pull-request-review-status-and-reviewer) determine which requests appear.

Examples to ask an assistant:

- “Which tracked PRs need attention?”
- “Show my review requests in vllm-project/vllm.”
- “Switch the default repository to mgoin/pingboard, then show recent PRs.”
- “Track PR 123 under Reviews.”
- “Do PR 123's failing jobs also fail on the base branch?”
- “Clear merged PRs from my board.”
- “Update PR 123's branch and then run CI.”

## Switching repositories

Pass `repo` to a tool for a one-off target, or change the saved default:

```json
{"name":"set_default_repo","arguments":{"repo":"mgoin/pingboard"}}
```

Subsequent `find_prs` and `list_review_requests` calls can omit `repo`. An explicit `repo` still overrides the default for that call. The choice survives server restarts and is included in board exports. Read it through `get_board` (`defaultRepo` on a refreshed board or `prefs.defaultRepo` with `refresh:false`).

The board can contain PRs from several repositories. Switching the search default preserves existing pins and groups; each PR continues to use its own repository's CI profile. PR inspection and mutation tools still require an explicit `repo` and `number`. `clear_board` applies to the whole board, regardless of the search default.

Repositories without a configured profile use all reported checks as CI and have no comment commands. Use `set_repo_profile` to configure that repository's workflow; switching repositories does not copy vLLM's `/ci` commands.

## Board exchange

The browser and MCP maintain separate boards. They exchange snapshots:

1. In the browser, select **Settings → Export board + settings**.
2. Pass the parsed file contents as `import_board.payload`. `mode:"merge"` keeps existing pins and matches group names; `mode:"replace"` replaces the local board. If the backup includes preferences, either mode applies them.
3. To return to the browser, save the JSON object from `export_board` and use **Import board + settings** in the browser.

Clearing or untracking never closes a GitHub PR. Clearing retains groups and preferences, keeps unreadable PRs when filtering by state, and preserves pins added concurrently after the cleanup snapshot. Writes use an atomic file replacement and a cross-process lock. Corrupt state is reported instead of overwritten. If a terminated process leaves a `.lock` file, stop other servers using that board and remove the stale lock before retrying.

## CI behavior

The vLLM profile supplies `/ci run`, `/ci retry`, `/ci cancel` and `/ci run --allow-stale`. Other repositories need their own `ciCommands`, supplied through an imported profile or `set_repo_profile`. A missing command fails before any mutation. Setting `ciCommands:null` disables comment commands; empty `ciPrefix` or `mainPipeline` clears that filter.

CI tools post immediately as the authenticated user. They do not implement the browser's three-second Undo bar. Clients should expose their normal tool-approval controls, and assistants should invoke mutations only for user-authorized actions. This implementation does not submit reviews, request reviewers, merge PRs, or create a background monitor.

Every action reads the current PR first. Pass its observed `headOid` as `expected_head_oid` to reject an action if the head has changed. Branch updates also send GitHub's `expected_head_sha`. Comment commands apply to the PR's current head; GitHub does not offer an atomic head-SHA condition for posting a comment, so a concurrent push can still race a command.

A normal run refuses a behind or unknown branch. An explicit stale run requires a configured stale command. Update-and-run posts only after a new head is visible and caught up to base; an already current branch runs directly. If polling fails or times out after an accepted update, the error states that CI was not posted. An ambiguous network failure during a write requires inspecting the PR before retrying.

Failure correlation is a heuristic, not a log diagnosis. Check pagination errors never become a passing status. Missing baseline or peer data is reported. Baselines examine up to 30 recent base commits and cache successful results for ten minutes per repository, branch and profile. Closed/merged PRs are excluded from peer failure evidence.

## Development

```bash
npm ci --prefix mcp
npm test --prefix mcp
```

The tests cover shared domain logic, browser backup compatibility, concurrent disk writes, mocked GitHub reads and mutations, MCP tool calls, and a real stdio client/server handshake with persistence across restarts. They require no GitHub credentials and perform no live GitHub actions. The repository's `tests/run` separately checks the browser UI and saved-state upgrades.
