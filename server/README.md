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
| `set_daily_plan` | Replace a day's list with `tasks: [{title, tag?, start?, minutes?, notes?, siteKey?}]`. Re-publishing keeps tasks checked off if the title matches. |
| `set_day_info` | Replace the day's headline and info sections: `headline?`, `sections: [{title, body, front?}]`. Call with nothing to clear. |
| `list_tasks` | The day's tasks with ids, `done` flags and the local time each was checked off (`completed`). |
| `get_history` | The last `days` (default 7, max 31) ending at `through` (default today): each day's tasks with done / missed and check-off times. How the routine sees what slipped. |
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
npm run db:sync:remote      # 0004: site sync columns (run once; errors if already applied)
npm run deploy
```

If `npm run db:...:remote` fails with `Authentication error [code: 10000]` on `/import`, that is a wrangler quirk with
`--file` (the import endpoint). Run the SQL with `--command` instead, e.g. for 0004:

```bash
npx wrangler d1 execute cozy-planner --remote --command "ALTER TABLE tasks ADD COLUMN site_key TEXT; ALTER TABLE tasks ADD COLUMN done_at INTEGER;"
```

(or `npx wrangler logout` then `npx wrangler login`). A failed run changes nothing, so it is safe to retry.

Always migrate before deploying; the new code reads columns and a table the old database doesn't have.
A brand-new database only needs `db:init:remote`.

Until `API_TOKEN` is set (16+ characters) every endpoint except `/` answers 500, so a half-deployed
server is never open.

Check it:

```bash
curl -H "Authorization: Bearer <token>" https://cozy-planner.<you>.workers.dev/api/tasks
```

## Mirror Calc 3 with the progress site (optional)

Tasks that carry a `siteKey` (the site's task id, e.g. `calc3-t12`, rest-day rows included) are kept in step with the
progress site's Firebase state, **both ways**. This uses the rule the site already uses between its own devices: every
check-off has a timestamp, and the **newest change wins** per task. Ticking *and* unticking sync.

- Tick in the app: a `["calc3-t12", 1, <time>]` entry is written to the site, which picks it up on its next sync (~45 s or on focus).
- Tick on the site: the next print in the app, `list_tasks` or `get_history` brings it across.
- Only ids starting with `calc3-` are mirrored (`SYNC_PREFIXES` in `wrangler.toml` changes that). Other site tasks, the
  calendar entries and the Calc 3 rest-day *arrangement* (`days`) are never modified; the rest of the state is written back byte for byte.
- Writes are conditional on Firebase's ETag, so an edit the site makes at the same moment is never overwritten; the server re-reads and retries.
- If Firebase is unreachable the planner keeps working, and the next sync catches up.

Setup, once (the value is the progress site's `state.json` URL):

```bash
npm run db:sync:remote                      # adds site_key and done_at (errors if already applied)
npx wrangler secret put FIREBASE_STATE_URL  # paste the state.json URL
npm run deploy
```

Leave `FIREBASE_STATE_URL` unset to keep the feature off; `siteKey`s are then just stored.

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
