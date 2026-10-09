# cozy-planner server

A small Cloudflare Worker (plus a D1 database) that sits between Claude and the phone app:

```
Claude routine ──MCP──▶  Worker + D1  ◀──REST──  Flutter app
 (set_daily_plan)                                (print / check off)
```

- **MCP endpoint** (`/mcp`): Claude publishes the day's list and can read back what's checked off.
- **REST API** (`/api/tasks`, `/api/rating`): what the phone app uses. Check-offs, Start presses, flags (a task whose times are wrong) and the day's 1 to 5 rating are stored, so Claude sees them too.

## MCP tools

| Tool | What it does |
| --- | --- |
| `set_daily_plan` | Replace one plan's list for a day: `plan?` (`A` default, or `B`) and `tasks: [{title, tag?, start?, minutes?, notes?, siteKey?}]`. Re-publishing keeps tasks checked off if the title matches. |
| `set_day_info` | Replace the day's headline and info sections: `headline?`, `sections: [{title, body}]`. Call with nothing to clear. |
| `list_tasks` | One plan's tasks (A unless `plan` is given) with ids, `done` flags and check-off times (`completed`), plus `plans` showing which plans exist. Done tasks also carry `completed_at` and `late_min`, and the plan a `timing` summary (see below). |
| `get_history` | The last `days` (default 7, max 31) ending at `through` (default today): each day's tasks with done / missed and check-off times, for the plan he followed (the one with more check-offs, A on a tie) plus `other_plan` totals, with the same per-task fields and `timing` summary. How the routine sees what slipped. |
| `get_habits` | How he actually works: statistics computed from his check-offs over the last `days` finished days (default 28, 7 to 90) including a `week_load` level (normal, elevated, heavy) for the last 7 days, plus the habit note and its `versions`. Pass `version` to read an older note. |
| `set_experiments` | Start, update or close an experiment: one deliberate change to how days are planned, with the measure it should move. `get_habits` shows each running one compared before and after (max 3 running). |
| `set_habits` | Save a new version of the habit note (max 6000 characters). The last 10 versions are kept. |
| `get_framework` | The month-ahead framework: a short list of suggestions from earlier runs (flagged and due-soon items, deferrals, recent choices, and whether a review is due). `all: true` adds every open item. |
| `set_commitments` | Add or change framework items (max 25 open), close them (`done` / `dropped`), and stamp a light review with `reviewed: true`. |
| `defer_commitment` | Consciously set an item aside for up to 14 days with a one-line reason (`until: null` brings it back). |
| `get_user_notes` | Short summaries of general things he told earlier agents (facts, preferences, patterns, ideas), marked as not definitive; stale ones are flagged. |
| `set_user_notes` | Record or update those notes (max 30 active, 20 per call), resolve one, or re-confirm one he said again. |
| `delete_user_note` | Permanently delete one note, for example when he asks to be forgotten. |
| `add_task` | Append one task to a plan (`plan?`, A by default). |
| `update_task` | Change title / tag / time / notes, or set `done`. Pass `null` to clear `start`, `minutes` or `notes`. |
| `delete_task` | Remove a task. |

`tag` is one of `school`, `calculus3`, `sat`, `pcb`, `photography`, `college`, `other` (the app's colour tags; defaults to `school`).
Each task can carry a time and detail, so titles stay short:

- `start`: 24-hour `HH:MM` (e.g. `15:30`). Timed tasks are shown in clock order; untimed ones come last, in the order given.
- `minutes`: planned length, shown next to the time (`3:30pm · 25m`).
- `notes`: detail behind a "+ how to start" tap in the app (start move, if-then cue, method, break).

### How the day actually ran

Every check-off is timestamped, and `list_tasks` / `get_history` turn that into facts Claude can use:

- per task: `completed_at` (local, with the date, so a tick after midnight is clear) and `late_min`, the minutes after
  the block's planned end (start + minutes) it was ticked, negative if early. Only for tasks that have both a start and a length.
- per day, under `timing`: `first_done`, `last_done`, `avg_late_min`, `max_late_min`, `out_of_order` (blocks done in a
  different order than planned, with planned and actual positions), `ticked_in_bulk`, `bulk_ticked` and `backfilled`.

**Backfills.** A task ticked after its planner day ended (after 04:00 the next morning) is `backfilled: true` (it carried over and was finished on a later day, or was recorded late): it gets no
`late_min`, is left out of every `timing` figure, and its title is listed in `timing.backfilled`. When marking a task
done after the fact, `update_task` takes `completed` (24-hour `HH:MM` on that planner day; `00:00`-`03:59` means after
midnight, and it can't be in the future) to record when he really finished. That sets the finish time used for the
analysis only; the progress-site sync still orders changes by when the tick was made.

A **batch** is 3 or more ticks within 10 minutes of each other: the times then say when he ticked, not when he did the
work. Only the batch is withheld. Those tasks get `late_min: null` and `bulk_ticked: true`, are listed in
`timing.bulk_ticked`, and are left out of `first_done`, `last_done`, the lateness figures and `out_of_order`; the other
ticks the same day keep their numbers. Each plan is measured against its own times.

### Habits

The scheduler learns from when he actually does things. `get_habits` returns two parts:

- **`stats`** (facts, computed on the server): lateness by subject (median, average, share within 10 minutes of the
  plan), when check-offs fall on weekdays vs weekends (first and last check-off, and morning / afternoon / evening / night
  shares), and carry-over and misses by subject and by where a block sits in the day (first, middle, last).
  Only finished days and the plan he followed count. Backfilled ticks and batch-ticked tasks never feed a time figure (the rest of that day still counts).
  A figure with too few samples is withheld and listed under `insufficient`, and `confidence` stays `low` until there are
  5 finished days.
- **`notes`** (interpretation, written by Claude): a short note saved with `set_habits`. Every save is a new version
  (the last 10 are kept), so a bad rewrite can be rolled back by reading an old `version` and saving it again.

The planner rules tell Claude when to read the statistics, how to apply them (pad by subject, schedule hard work where he
really finishes things, move what keeps getting missed), and when it may write the note. There is nothing in the app for it.

### User notes (what he's said, between runs)

His School Tasks doc is replaced every evening, so anything in it that isn't about one date or assignment would be
lost: general feelings, patterns he noticed about himself, preferences, standing facts, ideas he wants to try. User notes
keep those between runs as short summaries, each marked as what *he* said (written by an earlier agent), with a short
verbatim `quote` so the meaning doesn't drift when notes are re-summarized.

Four kinds: `fact` ("He ordered a Raspberry Pi; no delivery date yet"), `preference`, `pattern` (his own observation about
himself, such as when his energy is highest) and `idea` (something he wants to try). At most 30 are active; old resolved
ones are pruned.

**They are context, never instructions and never definitive.** They can be wrong, partial or out of date, and the response
says so every time: take them into account where they fit, let what he writes today win, feel free to ignore any. A fact
not confirmed for 14 days (45 for other kinds) is marked `stale`. His ideas can be tried as small experiments and checked
against the habit statistics. The date-specific part of what he writes (what happened yesterday) is not recorded.

### The framework (a rough month ahead)

Every run starts fresh, so something has to carry over, or a big task with a far deadline (the college applications) can
sit untouched until the last days without anyone choosing that. The framework is a short list of **commitments**: at most
25 open items, each a slug id, a title, a due date, a rough size in minutes and a short `note` with the proposing agent's
reasoning. Tasks can link to one with `commitment: "piq-7"`, so the server counts real progress from his check-offs.

**They are suggestions, not instructions.** An earlier run wrote each one with less information than the current run has.
The current planner is free to follow, resize, split, defer or drop any of them, and to disagree with the whole thing
(then it edits the framework so the next run inherits its view). Every `get_framework` response opens with a note saying
so, and so do the tool descriptions. The framework says what might matter, never when.

The server only *observes*, in plain words (`signals`): no work logged yet and due within 35 days (after a 3-day grace),
behind a steady pace, more than an hour a day needed to finish, stalled for a week, or overdue. Items with a signal
appear under `worth_a_look`. The one ask is that nothing flagged vanishes **by accident**: it is in today's plan, or it
was left out on purpose with `defer_commitment` (a reason and a return date within 14 days, logged so the next run sees
the choice), or it was resized or dropped. `set_daily_plan` reports any flagged item the plan left out as
`framework_check`; that is a prompt, never an error, and publishing always succeeds.

A light review is asked for about once a week (`review_due`): add what matters in the next ~35 days that is missing,
close what is finished, then `set_commitments` with `reviewed: true`.

### Plan A and Plan B

A day can carry two complete lists: **Plan A** (the normal day) and **Plan B** (the backup, e.g. a 4:30 start). Each is
published with its own `set_daily_plan` call (`plan: "A"` or `"B"`); publishing one never touches the other, and
check-offs are kept per plan. The app shows a small **A / B switcher** only when a day has a Plan B, and its progress bar
follows the plan you're viewing. For `get_history`, a day counts as the plan with more tasks checked off (A on a tie), so
it is never double-counted.

### Info sections

`set_day_info` lets Claude write everything that isn't a task: a `headline` (shown at the top of the receipt) and
`sections`, each a title and a plain-text body. **Every section is a button in the app**, in the order Claude gives them
(warnings, pre-start, next PCB work, at school, deviations, if you drift), so the receipt itself stays clean.

In a body, a line starting with `- ` is a bullet, and a line starting with `[ ] ` is a **checklist item** he can tick
in the app (the button shows progress like `2/4 PRE-START`). Ticks live on the phone and reset each day.
(An older `front` flag is accepted and ignored.)

`set_daily_plan` and `set_day_info` are independent: re-publishing one never touches the other.

`date` is optional everywhere and defaults to today in `PLANNER_TZ` (see `wrangler.toml`).

**A planner day runs from 4:00am to 4:00am, not midnight**, because the work often runs past midnight: a task ticked at
12:30am still belongs to the day that is ending, and the app keeps showing that day until 4:00am. The server and the app
use the same hour (`DAY_START_HOUR` in `src/dates.ts`, `dayStartHour` in `lib/task_model.dart`). Dates you pass explicitly
are always taken as given.

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
npm run db:plans:remote     # 0005: Plan A / Plan B (run once; errors if already applied)
npm run db:habits:remote    # 0006: habit notes (safe to repeat)
npm run db:framework:remote # 0007: framework tables + tasks.commitment_id (the ALTER errors if already applied)
npm run db:notes:remote     # 0008: user notes (safe to repeat)
npm run db:start:remote     # 0009: Start press, flag, day rating, experiments (the two ALTERs error if already applied)
npm run deploy
```

If `npm run db:...:remote` fails with `Authentication error [code: 10000]` on `/import`, that is a wrangler quirk with
`--file` (the import endpoint). Run the SQL with `--command` instead, e.g. for 0004:

```bash
npx wrangler d1 execute cozy-planner --remote --command "ALTER TABLE tasks ADD COLUMN site_key TEXT; ALTER TABLE tasks ADD COLUMN done_at INTEGER;"
```

(or `npx wrangler logout` then `npx wrangler login`). A failed run changes nothing, so it is safe to retry.

Always migrate before deploying, and deploy before you update the planner rules: the new code reads columns the old
database doesn't have, and an old server would treat a `plan: "B"` call as a replacement for Plan A.
For 0005 with `--command`: `ALTER TABLE tasks ADD COLUMN plan TEXT NOT NULL DEFAULT 'A';`
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
