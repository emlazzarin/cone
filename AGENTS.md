---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

<!-- hob:managed-agent-cli:start -->
## hob CLI

hob maintains this section automatically — it is on by default; turn it off in Settings → Agent → Managed hob instructions. Do not edit inside the markers.

When you are running inside hob, `HOB_PANE_ID` is set, along with `HOB_PROJECT_DIR` and the local API context variables needed by the CLI. The `hob` CLI is for hob-specific surfaces and user-visible collaboration; it supplements normal shell commands rather than replacing them.

Use ordinary shell commands directly for normal repo work such as inspecting files, searching text, running tests/builds, and package-manager commands. **When you are running inside hob (`HOB_PANE_ID` is set), this excludes Git: bare `git` is always wrong — prefix every Git command with `hob`, including read-only ones (`hob git status`, `hob git diff`, `hob git log`). No exceptions, even for inspection.** Bare `git` bypasses hob, so its changes never surface in hob and the turn loses provenance; on read-only subcommands the prefix behaves identically to system git, so there is no reason to skip it — make it automatic. Use `hob` for hob surfaces too (panes, panels, workspaces, issues, PRs, commits). `hob git commit` links the commit to the current agent turn; add repeatable `--link-pane <pane-id>` flags when another agent pane's completed turn is relevant.

- `hob list [panels|panes|workspaces]` - inspect available panels, panes, workspaces, caller identity, and pane spatial relationships.
- `hob open file <path>` - show a file in a render pane. Use `--placement right|left|above|below` only when the user asks for a direction.
- `hob open pane <type>` - open `agent`, `terminal`, `selection`, `render`, or `web` panes. Agent panes accept `--backend`/`--agent-type`, `--model`, and `--effort`, and inherit the source agent pane's permission mode. Use `--model` only with a configured model picker value unless the user explicitly asks for a custom model string. Render panes require `--file <path>`; web panes require `--url <url>`.
- `hob open panel <name>` - open tool panels such as `home`, `files`, `issue`, `history`, `workflows`, `bookmarks`, `shares`, `sourcecontrol`, or `stats`.
- `hob open workspace <number|name|id>` and `hob open workspace --new [--title <title>]` - switch or create workspaces.
- `hob close panel|pane|workspace ...` - close visible hob surfaces after listing targets when needed.
- `hob input pane <pane-id> <text> [--submit] [--wait]` - enter text into another open agent or terminal pane in the same project/window. Without `--submit`, it sets the target pane's draft input; use `--append` to add to an existing draft, with spacing inserted between agent-pane chunks. With `--submit`, agent panes receive an attributed user message (`Message from <source-pane-id>:` followed by a blank line) and terminal panes run a block-mode command. Use `--wait` only for terminal pane submits when you need the exit code and output before continuing. After submitting to an agent pane, do not use `--wait`, do not poll panes or storage, and do not resubmit the same message; stop and wait for hob to deliver the peer agent's final response back into your conversation automatically. Agents cannot input into their own pane.
- `hob terminal last <pane-id> [--wait]` and `hob terminal command <pane-id> <command-id> [--wait]` - inspect terminal command status, exit code, and output after submitting commands.
- `hob git status|diff|log|add|restore|commit|...` - when running inside hob, run every Git command through hob using standard Git syntax; never bare `git`. Non-commit subcommands behave identically to system Git, so there is no reason to skip the prefix; `hob git commit` additionally records provenance for the current agent turn.
- `hob git commit [--link-pane <pane-id> ...] <commit-options-and-pathspecs>` - create a git commit linked to the current agent turn. Use this for every commit you make from a hob-spawned agent instead of `git commit`; hob supports the common commit forms agents need, including messages, amend/no-edit, and pathspec-limited commits like `hob git commit -m "update renderer" -- frontend/src/lib/RenderPane.svelte`. Use repeatable `--link-pane <pane-id>` before the commit options when another agent pane's latest completed turn is also relevant to the commit, such as a planning or review pane you spawned.
- `hob issue create|comment|close|delete|complete ...` and `hob issue list|start ...` - list/start/complete local hob issues, create local or remote issues, comment on remote issues, close remote issues, or permanently delete issues. Local issues live in hob's database; do not edit legacy `.hob/**/issues*.md` files. Use `hob issue create --local --title <text> [--body <text>|--body-file <path>]` when creating a local issue from an agent pane so hob links it to the current turn. `hob issue delete` is destructive and requires explicit `--local` or `--remote` scope.
- `hob pr create|comment|close ...` - create a pull request for the current branch, comment on a remote PR, or close a remote PR when the user asks you to do so. `hob mr ...` is an alias for merge-request terminology.
- Issue and PR bodies/comments should be readable multi-line text that summarizes context, changes, verification, and any important caveats.

Successful `hob open` commands print resource ids such as `paneId=...` or `workspaceId=...`. Preserve those ids when you will need to refer to the opened surface later. Use `--json` when you need structured output.

If hob cannot resolve the current project/window/pane, the command exits with an error and does not change the UI. Report that limitation to the user instead of retrying blindly. Run `hob list --help`, `hob open --help`, `hob close --help`, `hob input --help`, `hob terminal --help`, `hob git commit --help`, `hob issue --help`, or `hob pr --help` for details.
<!-- hob:managed-agent-cli:end -->
