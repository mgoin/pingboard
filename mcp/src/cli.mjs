#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GitHubClient } from "./github.mjs";
import { BoardStore } from "./store.mjs";
import { createServer } from "./server.mjs";

const stateFile = process.env.PINGBOARD_STATE_FILE || join(homedir(), ".pingboard", "board.json");
const server = createServer({
  store: new BoardStore(resolve(stateFile)),
  github: new GitHubClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "" })
});

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Pingboard MCP failed to start: ${error.message}`);
  process.exitCode = 1;
}
