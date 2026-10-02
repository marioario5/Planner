# cozy-planner server

A small Cloudflare Worker (plus a D1 database) that sits between Claude and the phone app:

```
Claude routine ──MCP──▶  Worker + D1  ◀──REST──  Flutter app
 (set_daily_plan)                                (print / check off)
```

- **MCP endpoint** (`/mcp`): Claude publishes the day's list and can read back what's checked off.
- **REST API** (`/api/tasks`): what the phone app uses. Check-offs are stored, so Claude sees them too.

## MCP tools

| Tool | What it does |
| --- | --- |
| `set_daily_plan` | Replace a day's list with `tasks: [{title, tag?}]`. Re-publishing keeps tasks checked off if the title matches. |
| `list_tasks` | The day's tasks with ids and `done` flags. |
| `add_task` | Append one task. |
| `update_task` | Change title / tag, or set `done`. |
| `delete_task` | Remove a task. |

`tag` is one of `school`, `calculus3`, `sat`, `pcb`, `photography` (the app's colour tags; defaults to `school`).
`date` is optional everywhere and defaults to today in `PLANNER_TZ` (see `wrangler.toml`).

## Deploy

You need a free Cloudflare account.

```bash
cd server
npm install
npx wrangler login
npx wrangler d1 create cozy-planner     # copy the printed database_id into wrangler.toml
npm run db:init:remote                  # creates the tasks table
npm run deploy                          # prints https://cozy-planner.<you>.workers.dev
openssl rand -hex 24                    # your token — save it somewhere
npx wrangler secret put API_TOKEN       # paste the token
```

Until `API_TOKEN` is set (16+ characters) every endpoint except `/` answers 500, so a half-deployed
server is never open.

Check it:

```bash
curl -H "Authorization: Bearer <token>" https://cozy-planner.<you>.workers.dev/api/tasks
```

## Connect Claude

claude.ai custom connectors can't send an `Authorization` header, so the token goes in the URL.
In claude.ai: **Settings → Connectors → Add custom connector** and use

```
https://cozy-planner.<you>.workers.dev/mcp/<token>
```

Then enable that connector on the routine and tell it to publish with `set_daily_plan`.
Treat that URL like a password. Anything that can send headers (Claude Code, scripts) can use
`POST /mcp` with `Authorization: Bearer <token>` instead.

To rotate the token: `npx wrangler secret put API_TOKEN`, then update the connector URL and the app.

## Connect the app

Tap **CONNECT & PRINT** (or long-press the printer any time) and enter the worker address and the token.

## Develop

```bash
npm test                 # vitest, in-memory store
npm run typecheck
echo "API_TOKEN=dev-token-0123456789abcdef" > .dev.vars   # gitignored
npm run db:init:local
npm run dev              # http://localhost:8787
```
