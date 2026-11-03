# Pingboard MCP

A local stdio MCP server sharing the dashboard's repository profiles, CI status logic and failure comparisons.

## Setup

Requires Node.js 22 or newer. Keep `mcp/` inside the Pingboard checkout because it imports `../core.js`.

```bash
npm ci --prefix mcp
```

Configure your MCP client to launch the entrypoint directly:

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

On Windows, use forward slashes in paths or escape backslashes. Use your client's secret/environment facility for the token when available. `GH_TOKEN` is also accepted; `GITHUB_TOKEN` takes precedence. Tokens are never stored in the board or exported. GitHub permissions apply as usual; a classic PAT needs `public_repo` for public repositories or `repo` for private ones.

The state file defaults to `~/.pingboard/board.json`. Keep it outside a publicly served directory and use separate files for separate accounts. Local board tools work without a token; GitHub operations require one. This server targets github.com.

## Tools

| Tools | Purpose |
| --- | --- |
| `get_board`, `inspect_pr` | Read CI status, reviews, requested reviewers, blockers and failure evidence. `get_board` accepts `refresh:false` for local pins only. |
| `compare_failures` | Match failing jobs against recent base commits and other tracked PRs in the same repository. |
| `list_review_requests`, `find_prs` | Search open PRs. Views: `review_requested`, `mine`, `reviewed`, `involved`, `ready` (the label), `recent`. |
| `set_default_repo` | Save the repository used when searches omit `repo`. |
| `track_pr`, `untrack_pr` | Add or remove a local pin; tracking accepts a group name or ID. |
| `clear_board` | Remove pins with required scope `all`, `closed` (including merged), or `merged`. `dry_run:true` previews removals. |
| `import_board`, `export_board` | Exchange browser-compatible snapshots; import supports `merge` and `replace`. |
| `get_repo_profile`, `set_repo_profile` | Read or replace workflow overrides. Omitted top-level fields use defaults; `ciCommands` replaces the command set. |
| `run_ci`, `retry_ci`, `cancel_ci` | Post the repository's configured CI comment command. |
| `update_branch`, `update_branch_and_run_ci` | Merge the base branch into the PR, optionally waiting for the update before starting CI. |

PR tools require explicit `repo` and `number`, such as `{"repo":"vllm-project/vllm","number":123}`. Search tools accept extra GitHub search text, a limit and a cursor; results include `nextCursor`.

To switch away from vLLM, call `set_default_repo` with `{"repo":"mgoin/pingboard"}`. Subsequent searches use that repository unless overridden. Existing pins retain their repositories and profiles, and `clear_board` still applies to the whole board. The default survives restarts and exports.

## Board exchange

The browser and MCP use separate boards. Export from **Settings → Export board + settings**, then pass the parsed JSON as `import_board.payload`. Merge keeps existing pins and matches group names; replace overwrites the board. Either mode applies preferences included in the backup. Save the JSON returned by `export_board` to import it back into the browser.

Clearing preserves groups and preferences, retains unreadable PRs when filtering by state, and never closes GitHub PRs. Writes use atomic replacement and a process lock. Corrupt state is reported without overwriting it. If a stopped process leaves a `.lock` file, confirm no server is writing that board before removing the lock.

## CI behavior

The vLLM profile provides `/ci run`, `/ci retry`, `/ci cancel` and `/ci run --allow-stale`. Other repositories start with all checks counted as CI and no comment commands. Configure them with `set_repo_profile`; `ciCommands:null` disables commands, and empty `ciPrefix` or `mainPipeline` clears that filter.

CI tools post immediately as the authenticated user, without the browser's Undo delay. Pass an observed `headOid` as `expected_head_oid` to reject actions on a changed PR. Branch updates also send GitHub's head-SHA guard; comment posting cannot atomically guard against a concurrent push.

Normal runs require a branch caught up to base. `allow_stale:true` explicitly selects a configured stale command. Update-and-run waits for a changed head caught up to base before posting CI; it runs directly when already current. Polling failures and timeouts report that CI was not posted. Inspect the PR before retrying an ambiguous write failure.

Failure matching is evidence, not a log diagnosis. Missing baseline or peer data is reported. Baselines examine up to 30 recent base commits and cache successful results for ten minutes. Closed and merged PRs are excluded from peer comparisons.

## Tests

```bash
npm test --prefix mcp
```

Focused tests cover board persistence, CI sequencing and failure handling, shared status logic, and an actual stdio MCP connection. GitHub calls are mocked. The existing `tests/run` checks browser behavior and saved-state upgrades.
