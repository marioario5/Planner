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
| `set_daily_plan` | Replace a day's list with `tasks: [{title, tag?, start?, minutes?, notes?}]`. Re-publishing keeps tasks checked off if the title matches. |
| `set_day_info` | Replace the day's headline and info sections: `headline?`, `sections: [{title, body, front?}]`. Call with nothing to clear. |
| `list_tasks` | The day's tasks with ids and `done` flags. |
| `add_task` | Append one task. |
| `update_task` | Change title / tag / time / notes, or set `done`. Pass `null` to clear `start`, `minutes` or `notes`. |
| `delete_task` | Remove a task. |

`tag` is one of `school`, `calculus3`, `sat`, `pcb`, `photography` (the app's colour tags; defaults to `school`).
Each task can carry a time and detail, so titles stay short:

- `start`: 24-hour `HH:MM` (e.g. `15:30`). Timed tasks are shown in clock order; untimed ones come last, in the order given.
- `minutes`: planned length, shown next to the time (`3:30pm · 25m`).
- `notes`: detail behind a "+ how to start" tap in the app (start move, if-then cue, method, break).

### Info sections

`set_day_info` lets Claude write everything that isn't a task. Each section is a title and a plain-text body
(start a line with `- ` for a bullet):

- `front: true` sections are printed on the **briefing** side of the receipt (headline, warnings, pre-start checklist).
  Tapping the briefing flips the paper over to the task list.
- every other section gets its own **button** in the app (next PCB work, at school, deviations, if you drift).

If a day has no headline and no front sections, the app skips the briefing and prints the tasks directly.
`set_daily_plan` and `set_day_info` are independent: re-publishing one never touches the other.

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

**Upgrading an existing database.** Run only the steps you haven't run yet, then deploy:

```bash
npm run db:migrate:remote   # 0002: time, length and notes on tasks (run once; errors if already applied)
npm run db:info:remote      # 0003: headline + info sections (safe to repeat)
npm run deploy
```

Always migrate before deploying; the new code reads columns and a table the old database doesn't have.
A brand-new database only needs `db:init:remote`.

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
npm run db:init:local     # new local db; `db:migrate:local` upgrades an old one
npm run dev              # http://localhost:8787
```
