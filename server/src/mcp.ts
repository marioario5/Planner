// Minimal stateless MCP server (Streamable HTTP transport, JSON responses only).
// Stateless is enough here: every tool is a self-contained read or write, so there's
// no session to track and each POST can be answered on its own.

import { buildSchedule, isCalcRestDay } from './calc-source';
import { rowsOf } from './firebase';
import { localTime, plannerToday, plannerTimeToEpoch, resolveDate, shiftDate } from './dates';
import {
  MAX_DEFER_DAYS,
  MAX_OPEN_COMMITMENTS,
  DAILY_KEY,
  PROTECTED_KEY,
  computeFramework,
  computeSlipping,
  deferHistory,
  deferRefusal,
  describeItem,
  parseProtected,
  slippingLines,
  unaddressed,
} from './framework';
import { dayTypeCheck, isCollegeDay } from './daytype';
import { capFromOrders, checkDirectives, loadDirectiveHistory, loadDirectives, parseOrders, saveDirectives, type Order } from './directives';
import { MAX_ACTIVE_NOTES, resolvedToPrune, viewUserNotes } from './user-notes';
import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, computeHabits, evaluateExperiments } from './habits';
import { DEFAULT_PREFIXES, isSyncable, reconcile, type SyncConfig } from './sync';
import { actualMinutes, bulkTickedIds, completedAtLocal, dayTiming, finishedTogether, isBackfilled, isFlagged, lateMinutes, slotLateness, startDelayMinutes, startedMinutes } from './timing';
import {
  COMMITMENT_STATUSES,
  PLANS,
  TAGS,
  EXPERIMENT_MEASURES,
  EXPERIMENT_STATUSES,
  type Experiment,
  USER_NOTE_KINDS,
  USER_NOTE_STATUSES,
  ValidationError,
  parseCommitmentId,
  parseDayInfo,
  parseHabitNotes,
  parseId,
  parseNewTask,
  parseNewTasks,
  parsePatch,
  parsePlan,
  parseStart,
  parseTag,
  parseUserNoteId,
  type Commitment,
  type CommitmentStatus,
  type UserNote,
  type Plan,
  type Task,
  type TaskStore,
} from './tasks';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'cozy-planner', version: '1.0.0' };

const INSTRUCTIONS =
  "Manage the daily task list shown in the user's cozy planner app. " +
  'To publish a day, call set_daily_plan once with the full ordered list. ' +
  'set_day_info publishes the headline and info sections (warnings, pre-start checklist, next PCB work...) that go with the day. ' +
  'list_tasks shows what is on the list and what the user has already checked off. ' +
  'get_habits returns statistics on how he actually works plus the habit notes you keep with set_habits; read it before planning. ' +
  'get_framework returns a short list of SUGGESTIONS from earlier planning runs about what might matter over the next month; ' +
  'you are free to follow, change or ignore them, but do not let a flagged one vanish by accident. ' +
  'get_user_notes returns short summaries of things he told earlier agents that are not tied to one date (context, never definitive). ' +
  'get_directives returns the standing orders the weekly review decided: follow them as written, and set_daily_plan reports any a plan breaks (`directive_check`). Only the weekly review calls set_directives.';

const TAG_HELP =
  'school = general schoolwork; calculus3 = Calculus 3 (homework, studying, quizzes); ' +
  'sat = SAT prep; pcb = PCB design, assembly and debugging; creative = creative practice he chooses to do, such as photography or playing bass; college = college applications, essays, recommenders and other admissions work; other = anything else that fits no subject (dinner, errands, admin). ' +
  "Defaults to school if omitted.";

const dateProp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description:
    'Planner day as YYYY-MM-DD. Defaults to today in the planner time zone. A day runs from 4:00am to 4:00am, ' +
    'so 12:30am still belongs to the day that is ending.',
};
const tagProp = { type: 'string', enum: [...TAGS], description: TAG_HELP };
const titleProp = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Short title that fits on one or two lines. Put the time in start, not here.',
};
const startProp = {
  type: 'string',
  pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
  description: '24-hour start time, e.g. "15:30". Leave out for untimed tasks (shown last).',
};
const minutesProp = { type: 'integer', minimum: 1, maximum: 1440, description: 'Planned length in minutes.' };
const notesProp = {
  type: 'string',
  maxLength: 1000,
  description:
    'Detail shown when he taps the task: start move, if-then cue, method, stop time and break.',
};
const planProp = {
  type: 'string',
  enum: [...PLANS],
  description:
    'A = the normal day (default). B = the backup plan, a complete alternative list for the same day ' +
    '(e.g. a later start). Each plan is replaced independently; publishing one never touches the other.',
};
const commitmentProp = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
  description:
    'Optional: id of the framework commitment this task works on (e.g. "piq-7"), so real progress on it can be counted. ' +
    'It must be an open commitment (see get_framework / set_commitments).',
};
const siteKeyProp = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,80}$',
  description:
    'Id of the matching task on his progress site, e.g. "calc3-t12" (Calc 3 lessons and rest-day rows). ' +
    'Checking the task in the app ticks it on the site and the other way round. ' +
    'Only ids starting with calc3- are mirrored; leave out for everything else.',
};

const TOOLS = [
  {
    name: 'set_daily_plan',
    description:
      "Replace one plan's task list for a day with the given tasks. Use this to publish a day's plan: call it once for Plan A and, if the day has a backup, once more with plan B. " +
      'Timed tasks are shown in clock order, then untimed ones in the order given. ' +
      'Tasks the user already checked off stay checked if they appear again with the same title. ' +
      'Pass an empty array to clear that plan.',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        plan: planProp,
        tasks: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              title: titleProp,
              tag: tagProp,
              start: startProp,
              minutes: minutesProp,
              notes: notesProp,
              siteKey: siteKeyProp,
              commitment: commitmentProp,
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'set_day_info',
    description:
      "Replace the info that goes with a day's plan: a one-line headline plus titled sections of text. " +
      'The headline is shown at the top of the receipt. Every section becomes its own button in the app, in the order given ' +
      '(e.g. warnings, pre-start checklist, next PCB work, at school, deviations, if you drift), so put the ones he should read first up front. ' +
      'Section bodies are plain text; start lines with "- " for bullets. ' +
      'Call with no arguments to clear the day. Separate from set_daily_plan, so call both.',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        headline: {
          type: 'string',
          maxLength: 300,
          description: 'One or two lines: the most important thing today and days to the next deadline.',
        },
        sections: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 60 },
              body: { type: 'string', minLength: 1, maxLength: 4000 },
            },
            required: ['title', 'body'],
          },
        },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'list_tasks',
    description:
      'List one plan\'s tasks for a day (Plan A unless you pass plan) with their ids and whether each is done. ' +
      '`plans` shows which plans exist for the day and how many tasks are done in each. ' +
      'Done tasks carry `completed_at` and `late_min`, and the plan carries a `timing` summary (see get_history).',
    inputSchema: { type: 'object', properties: { date: dateProp, plan: planProp } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_history',
    description:
      'What was planned and what he actually checked off over the last several days, oldest first. ' +
      'Each day lists its tasks with done true/false, when each was checked off (`completed_at`, local) and `late_min` ' +
      '(minutes after its planned slot ended that he ticked it; negative = early; the k-th block he finished is compared with the k-th planned end, so doing blocks in a different order is not lateness, and `late_own_min` shows the old per-block figure when it differs), plus a `timing` summary: first and last check-off, ' +
      'average and worst lateness, and which tasks were done out of order. Ticks that say nothing about when the work happened are ' +
      'flagged and left out of those figures (the rest of the day still counts): `bulk_ticked` lists tasks ticked in a batch ' +
      '(3+ within 10 minutes; their times show when he ticked, not when he worked). ' +
      'When work is split into blocks ("Chem POGIL: part 1", "Chem POGIL: finish") and a later block with no Start press was ticked within minutes of an earlier one he started, he finished it all in one sitting: that block has `finished_with`, and `timing.finished_together` gives the planned vs real time for the whole piece. ' +
      'Tasks ticked after their planner day ended are `backfilled` (carried over and finished on a later day, or recorded late): they are listed in `timing.backfilled` and left out of every figure. ' +
      'If a day had both Plan A and Plan B, the day shows the one he followed (the plan with more tasks checked off, A on a tie) ' +
      'and `other_plan` gives the other one\'s totals. ' +
      '`latest_day_info` is the notes the planner wrote for the most recent earlier day (headline and sections such as "Next PCB work"), so promises made then can be read without any saved plan file. `last_next_pcb_work` is the newest "Next PCB work" section from the last 14 days, because a later update can replace a day notes. ' +
      'Days with no tasks are left out. Use it to see what slipped and what to carry forward. ' +
      'A task not checked off may still have been done: he has to tick it in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 31,
          description: 'How many days to look at, counting back from `through`. Default 7.',
        },
        through: {
          ...dateProp,
          description: 'Last day to include, YYYY-MM-DD. Defaults to today in the planner time zone.',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_server_status',
    description:
      'Whether the planner server is healthy: which database migrations are missing (with the exact npm command to run for each, oldest first), ' +
      'and whether the progress-site sync is configured. A missing migration otherwise fails quietly (for example the change log stays empty), so check this after a deploy.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_site_progress',
    description:
      "His progress site's exact check-off state, read straight from the site's database (not a summary): `tasks` are the site's task rows " +
      '(id, done, when it was last changed), `calc3_rest` are the Calc 3 rest-day slot numbers, and `cal` are his calendar items with dates and whether they are checked. ' +
      'Use it as the source of truth for Calc 3 (it replaces fetching the site data by URL). An item is done if it is checked as a task or as a calendar item with the same wording. ' +
      'Optional `prefix` keeps only task ids starting with it (default "calc3-"; pass "" for every task) and `cal_from` / `cal_to` (YYYY-MM-DD) bound the calendar items (default today to 45 days ahead).',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string', maxLength: 40, description: 'Only task ids starting with this. Default "calc3-"; "" = all.' },
        cal_from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First calendar date to include. Default today.' },
        cal_to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last calendar date to include. Default 45 days from today.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_gym_sessions',
    description:
      "Time he spent at the gym, from the switch on his phone app (it works offline and syncs later). Each session has local date, start, end and minutes; `open: true` means he is there now or forgot to switch it off. " +
      "It is real, deliberate time away from the desk: never read it as wasted time or as a gap in his work, and don't plan work over it. Optional `days` (default 14, max 60) looks back from today.",
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 60 } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_directives',
    description:
      'The standing orders the weekly review decided from the data (for example "weekday Plan A starts at 17:00", "normal-day work cap 120 minutes", "dinner 20:30"). They are decided facts: apply them as written without re-deriving them. ' +
      'Each has an id, the instruction, where it applies (weekday = Mon to Fri, weekend = Sat and Sun, all), one line of evidence, a review-by date, and sometimes an automatic `check` that set_daily_plan verifies on every plan (reported as `directive_check`). ' +
      '`review_overdue` lists orders past their review date (still in force until the weekly review reissues them). `history: true` also returns every earlier version, so the weekly review can see its own past decisions.',
    inputSchema: { type: 'object', properties: { history: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_directives',
    description:
      'ONLY the weekly review calls this; the daily planner never does. Replaces the whole set of standing orders (pass every order you want kept; at most 15) and saves it as a new version. ' +
      'Each order needs an id (slug), `text` (the concrete instruction, with a number or clock time), `applies` (weekday | weekend | all), `evidence` (one line with the n), and `review_by` (YYYY-MM-DD). ' +
      'Add `check` only for what can be verified automatically: {kind: "start_not_before", time}, {kind: "cap_minutes", minutes}, {kind: "no_block_window", from, to}, {kind: "min_gap_after_tag", tag, minutes}, {kind: "dinner_at", time, tolerance_min?}. ' +
      'Optional `note` says what changed and why.',
    inputSchema: {
      type: 'object',
      properties: {
        orders: { type: 'array', maxItems: 15, items: { type: 'object' } },
        note: { type: 'string', maxLength: 500 },
      },
      required: ['orders'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'get_week_export',
    description:
      'Raw rows for the weekly review: for each finished planner day in the range, the plan he followed with every task and all its timing fields (same fields as list_tasks), the other plan\'s totals, his rating, and the headline the planner wrote; plus gym sessions, YouTube-mode sessions (no under-30-second blips) and the current commitments. ' +
      'Optional `from` and `to` (YYYY-MM-DD; default the last 28 finished days, up to 90). Read-only. Bigger than get_history, so use it with code, not by eye.',
    inputSchema: { type: 'object', properties: { from: dateProp, to: dateProp } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_task_log',
    description:
      'The most recent changes to tasks, newest first, each with when, which task, what sent it (website, phone app, progress-site sync, ' +
      'or the planner tool) and what it asked for. For tracing a task that changed unexpectedly (done, started or paused when he did not do it). ' +
      'Optional `task` keeps only events whose task title contains that text.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many events. Default 40.' },
        task: { type: 'string', maxLength: 100, description: 'Only events for tasks whose title contains this (case-insensitive).' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_habits',
    description:
      'How he actually works. `stats` are computed from his check-offs over the last `days` finished days (default 28): ' +
      'lateness by subject, when check-offs happen on weekdays vs weekends, and what carries over or gets missed ' +
      '(by subject and by where a block sits in the day). Figures with too few samples are withheld and listed under ' +
      '`insufficient`, and `confidence` is "low" until there are 5 finished days, so do not write habits from thin data. ' +
      '`notes` is the habit note you maintain with set_habits (null if none yet) and `versions` lists the saved versions; ' +
      'pass `version` to read an older note instead. `stats.capacity` is what a day of his can actually hold (plan to it); ' +
      '`stats.duration_by_tag` and `stats.start_delay` come from blocks where he pressed Start; `stats.week_load` says how heavy the last 7 days were (level normal/elevated/heavy, with reasons); `stats.transitions` is what he does between blocks (the rest before and after each subject, which subject follows which, how often the order changes, and the latest transitions with titles); `stats.ratings` is how draining his days felt (1 drained, 5 good with energy left; strain and energy, not grades or mood); ' +
      '`experiments` are the deliberate changes being tried, each compared before and after (see set_experiments).',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 7,
          maximum: MAX_WINDOW_DAYS,
          description: `How many finished days back to measure. Default ${DEFAULT_WINDOW_DAYS}.`,
        },
        version: { type: 'integer', minimum: 1, description: 'Return just this saved version of the notes.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_habits',
    description:
      'Save a new version of the habit notes: a short note (max 6000 characters) about how he works, used to schedule more ' +
      'efficiently. It replaces the whole note; the last 10 versions are kept so a bad rewrite can be undone. ' +
      'Write only habits the get_habits stats support, cite the numbers and the window, drop habits the data no longer ' +
      'supports, and keep it short enough to read at the start of every plan. He can read it in the app.',
    inputSchema: {
      type: 'object',
      properties: { notes: { type: 'string', minLength: 1, maxLength: 6000 } },
      required: ['notes'],
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'set_experiments',
    description:
      'Start, update or close experiments: one deliberate change to how his days are planned (for example "Calc 3 at 8pm instead of 4pm"), ' +
      'with the number it should move. The server compares the finished days before the start date with the days after, and get_habits ' +
      'shows that under `experiments`, so a later run can see whether it helped. Change one thing at a time (at most 3 running). ' +
      'New experiments need an id (a short slug), a title, the change, and a measure: done_pct (share of blocks done on their day), ' +
      'lateness (median minutes late), blocks_done (blocks finished per day) or rating (how draining the day felt: 1 drained, 5 good with energy left). Set `tag` to look only at one subject. ' +
      'Close one by setting status to "kept" or "dropped" with a short result. Existing ids take partial updates.',
    inputSchema: {
      type: 'object',
      properties: {
        experiments: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'Short slug, e.g. calc-late-evening.' },
              title: { type: 'string', maxLength: 100 },
              change: { type: 'string', maxLength: 300, description: 'What exactly is different, in a sentence.' },
              measure: { type: 'string', enum: [...EXPERIMENT_MEASURES] },
              tag: { type: ['string', 'null'], enum: [...TAGS, null], description: 'Only look at this subject; null = all work blocks.' },
              started_on: { ...dateProp, description: 'First day the change applies. Defaults to today.' },
              status: { type: 'string', enum: [...EXPERIMENT_STATUSES] },
              result: { type: ['string', 'null'], maxLength: 400, description: 'What was concluded; required when closing.' },
            },
            required: ['id'],
          },
        },
      },
      required: ['experiments'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'get_framework',
    description:
      'A short list of SUGGESTIONS from earlier planning runs about what might matter over the next month: each has a due date, ' +
      'a rough size and the earlier agent\'s reasoning. They are forecasts made with less information than you have now. You are free to ' +
      'follow, resize, split, defer or drop any of them, and to disagree with the whole framework. The server adds plain-language ' +
      '`signals` when one seems to be slipping (no work logged yet, behind a steady pace, stalled, overdue). `worth_a_look` are the ones ' +
      'not to lose by accident; `deferred` were set aside on purpose by an earlier run (with the reason); `recent_choices` shows what ' +
      'earlier runs decided. It says WHAT might matter, never WHEN. Small by design: read it every run.',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'Also include every open item, not just the flagged and due-soon ones.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_commitments',
    description:
      `Add or change suggestions in the framework (at most ${MAX_OPEN_COMMITMENTS} open). Keep them rough on purpose: a short slug id, ` +
      'a title, a due date, a rough size in minutes, and a short `note` with your reasoning and assumptions ("assumed 3 sessions of ~60 min, ' +
      'outline first") so the next planner can disagree with you intelligently. It says WHAT, never WHEN. Existing ids take partial ' +
      "updates (null clears due, start, target_minutes or note). Set status to 'done' or 'dropped' to close one. Pass reviewed: true " +
      'after a light review so it is not asked for again for a week.',
    inputSchema: {
      type: 'object',
      properties: {
        commitments: {
          type: 'array',
          maxItems: MAX_OPEN_COMMITMENTS,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'Short slug, e.g. "piq-7".' },
              title: { type: 'string', minLength: 1, maxLength: 80 },
              due: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              start: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'When the work could begin; used for the pace signal.' },
              target_minutes: { type: ['integer', 'null'], minimum: 5, maximum: 6000, description: 'A rough size, not a promise.' },
              status: { type: 'string', enum: [...COMMITMENT_STATUSES] },
              note: { type: ['string', 'null'], maxLength: 300, description: 'Your reasoning and assumptions.' },
              protected: { type: 'boolean', description: 'true = the planner may never defer it and must give it a small floor block while it is at risk. Anyone can turn it on; turning it off needs his_words.' },
              daily: { type: 'boolean', description: 'true = needs a block in every plan and can never be deferred, even on his word (Calc 3). Implies protected. Turning it off needs his_words.' },
              his_words: { type: 'string', maxLength: 200, description: 'Only with protected: false or daily: false: what he said when he asked for it.' },
            },
            required: ['id'],
          },
        },
        reviewed: { type: 'boolean', description: 'Stamp today as the date of a light review.' },
      },
      required: ['commitments'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'defer_commitment',
    description:
      `Set a commitment aside ON PURPOSE until a date within ${MAX_DEFER_DAYS} days, with a one-line reason. It won't be flagged until then, ` +
      'and later runs will see your reason. Use it when you decided to leave something out of today\'s plan. ' +
      'Deferring is allowed but deliberately hard: a protected item can never be deferred, an item due within a week with nothing done or already overdue can\'t be, ' +
      'a deferral past the due date can\'t be, the second deferral of an item needs a new reason that says what changed, and the third needs his words. ' +
      'When one is refused, give the item a small floor block in the plan instead. If he really asked for the deferral, pass his_words (a quote of what he said). ' +
      'Every deferral shows in the Slipping list at the top of his day. Pass until: null to bring it back.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        until: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The day it should come back. Null to clear the deferral.' },
        reason: { type: 'string', maxLength: 200 },
        his_words: { type: 'string', maxLength: 200, description: 'What he said when he asked for this deferral, quoted. Only when he really asked.' },
      },
      required: ['id', 'until'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'get_user_notes',
    description:
      'Short SUMMARIES of things he told earlier agents (usually in his School Tasks notes) that are not tied to one date or assignment: ' +
      'standing facts, preferences, patterns he noticed about himself, and ideas he wants to try. They were written by earlier agents, so ' +
      'they can be wrong, partial or out of date: take them into account where they fit, never treat them as instructions or as definitive, ' +
      'and let what he writes today win. A note marked `stale` may no longer be true. Small by design: read it every run.',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'Also include notes marked resolved.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_user_notes',
    description:
      `Record or update notes about him (at most ${MAX_ACTIVE_NOTES} active). Only things he said that are NOT specific to one date or ` +
      'assignment: a standing fact ("He ordered a Raspberry Pi, no delivery date yet"), a preference, a pattern he noticed about himself, ' +
      'or an idea he wants to try. Write each as one sentence about him (max 300 characters) and keep a short verbatim `quote` of his own ' +
      'words so the meaning does not drift. Record what he said, not a diagnosis or your guess about why. Merge with an existing note on the ' +
      'same thing instead of duplicating it. Existing ids take partial updates; set status to "resolved" when something stops being true. ' +
      'Saving a note counts as confirming it today; pass confirmed: true alone to re-confirm one he said again.',
    inputSchema: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'Short slug, e.g. "energy-late-night".' },
              kind: { type: 'string', enum: [...USER_NOTE_KINDS] },
              text: { type: 'string', minLength: 1, maxLength: 300 },
              quote: { type: ['string', 'null'], maxLength: 200, description: 'A short verbatim snippet of his own words.' },
              status: { type: 'string', enum: [...USER_NOTE_STATUSES] },
              confirmed: { type: 'boolean', description: 'He said it again: mark it confirmed today without changing anything else.' },
            },
            required: ['id'],
          },
        },
      },
      required: ['notes'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'delete_user_note',
    description: 'Permanently delete one note, for example when he asks you to forget something.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'add_task',
    description: "Append one task to the end of a plan's list for the day (Plan A unless you pass plan).",
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        plan: planProp,
        title: titleProp,
        tag: tagProp,
        start: startProp,
        minutes: minutesProp,
        notes: notesProp,
        siteKey: siteKeyProp,
        commitment: commitmentProp,
      },
      required: ['title'],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: 'update_task',
    description:
      "Change a task's title, tag, time, length or notes, or mark it done / not done. " +
      'Pass null for start, minutes or notes to clear them. Get ids from list_tasks. ' +
      'When marking a task done after the fact, pass `completed` with the time he actually finished so the lateness stays accurate; ' +
      'without it the check-off is stamped with the current time.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: titleProp,
        tag: tagProp,
        start: { ...startProp, type: ['string', 'null'] },
        minutes: { ...minutesProp, type: ['integer', 'null'] },
        notes: { ...notesProp, type: ['string', 'null'] },
        siteKey: { ...siteKeyProp, type: ['string', 'null'] },
        done: { type: 'boolean' },
        completed: {
          ...startProp,
          description:
            "When he actually finished, 24-hour HH:MM on the task's planner day (00:00 to 03:59 means after midnight, the next morning). " +
            'Only with done: true, and not in the future.',
        },
        paused_at: {
          ...startProp,
          description:
            'Pause a task that is running as of this time (24-hour HH:MM on its planner day): the time since then is not counted in how long it took. Only for a task that is started and not finished; resume it in the app.',
        },
        started_at: {
          ...startProp,
          description:
            "Fixes when he actually pressed Start, 24-hour HH:MM on the task's planner day. With done: true it corrects a finished task (pair it with `completed` to keep the finish time); with done: false or alone it starts or re-times an unfinished one, so a task can be reopened as running since then.",
        },
        paused_min: {
          type: 'integer',
          minimum: 0,
          maximum: 1440,
          description: 'Fixes the total minutes already spent paused (taken off how long it took). Use with started_at to rebuild a task\'s timer by hand, e.g. done: false, started_at 19:19, paused_min 91.',
        },
      },
      required: ['id'],
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'delete_task',
    description: 'Delete one task. Get ids from list_tasks.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
];

export interface McpContext {
  store: TaskStore;
  timeZone: string;
  now?: Date;
  /** Mirrors check-offs with the progress site; absent = feature off. */
  sync?: SyncConfig;
}

export type Json = Record<string, unknown>;

/** YYYY-MM-DD of an ISO time in the planner time zone. */
const localDate = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

const view = (t: Task, timeZone: string, bulk?: Set<string>, together?: Map<string, Task>, slot?: Map<string, number>) => ({
  id: t.id,
  plan: t.plan,
  title: t.title,
  tag: t.tag,
  start: t.start,
  minutes: t.minutes,
  notes: t.notes,
  siteKey: t.siteKey,
  commitment: t.commitmentId,
  done: t.done,
  // Local HH:MM he checked it off; null while it's not done.
  completed: t.done && t.completedAt ? localTime(t.completedAt, timeZone) : null,
  // Same moment with its date ("2026-10-02 00:30"), so a tick after midnight isn't ambiguous.
  completed_at: completedAtLocal(t, timeZone),
  // Minutes after its planned end (start + minutes) that he ticked it; negative = early. Null for backfilled or batch-ticked tasks.
  late_min: slot ? slot.get(t.id) ?? null : lateMinutes(t, timeZone, bulk),
  // Only when it differs: lateness against the block's own planned end, before doing blocks in another order was taken into account.
  ...(slot && slot.has(t.id) && slot.get(t.id) !== lateMinutes(t, timeZone, bulk) ? { late_own_min: lateMinutes(t, timeZone, bulk) } : {}),
  // Ticked after its planner day ended, so the time isn't when the work happened (no lateness is reported).
  backfilled: isBackfilled(t, timeZone),
  // Ticked in a batch (3+ within 10 minutes), so the time is when he ticked, not when he worked (no lateness is reported).
  bulk_ticked: (bulk?.has(t.id) ?? false) && !together?.has(t.id),
  // Title of the block he finished this one together with (no Start press, ticked within minutes of it), else null. Its times are left out.
  finished_with: together?.get(t.id)?.title ?? null,
  // Local HH:MM he pressed Start (null if he didn't, or flagged it).
  started: startedMinutes(t, timeZone) === null ? null : localTime(t.startedAt!, timeZone),
  // How long the block really took (Start to tick) and how long after its planned start he began. Null unless trustworthy.
  actual_min: actualMinutes(t, timeZone, bulk),
  start_delay_min: startDelayMinutes(t, timeZone),
  // Minutes he spent paused (already taken off `actual_min`), and whether it is paused right now. Absent if he never paused it.
  ...(t.pausedMs > 0 || t.pausedAt ? { paused_min: Math.round(t.pausedMs / 60_000), ...(t.pausedAt ? { paused_now: true } : {}) } : {}),
  // He held the flag on it: his start or finish time for this block is unreliable, so no timing is reported for it.
  flagged: isFlagged(t),
});

function summarize(date: string, plan: Plan, tasks: Task[], timeZone: string): Json {
  const timing = dayTiming(tasks, timeZone);
  const bulk = bulkTickedIds(tasks, timeZone);
  const together = finishedTogether(tasks, timeZone);
  const slot = slotLateness(tasks, timeZone, bulk);
  return {
    date,
    plan,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    ...(timing ? { timing } : {}),
    tasks: tasks.map((t) => view(t, timeZone, bulk, together, slot)),
  };
}

/** Which plans exist among these tasks, with how many are done in each. */
function planTotals(all: Task[]): { plan: Plan; done: number; total: number }[] {
  return PLANS.filter((p) => all.some((t) => t.plan === p)).map((p) => {
    const mine = all.filter((t) => t.plan === p);
    return { plan: p, done: mine.filter((t) => t.done).length, total: mine.length };
  });
}

function parseDays(value: unknown): number {
  if (value === undefined || value === null) return 7;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    throw new ValidationError('days must be a whole number from 1 to 31');
  }
  return value;
}

/** A siteKey must be one we actually mirror, so a typo fails loudly instead of silently never syncing. */
function checkSiteKeys(keys: (string | null | undefined)[], ctx: McpContext): void {
  const prefixes = ctx.sync?.prefixes ?? DEFAULT_PREFIXES;
  for (const key of keys) {
    if (key && !isSyncable(key, prefixes)) {
      throw new ValidationError(
        `siteKey "${key}" is not mirrored: only ids starting with ${prefixes.join(', ')} sync with the site`,
      );
    }
  }
}

async function loadFramework(ctx: McpContext, includeAll = false) {
  const { store, timeZone, now } = ctx;
  const today = plannerToday(timeZone, now);
  const [commitments, work, log, reviewedOn] = await Promise.all([
    store.listCommitments(),
    store.commitmentWork(),
    store.listFrameworkLog(200),
    store.getMeta('framework_reviewed_on'),
  ]);
  const protectedIds = parseProtected(await store.getMeta(PROTECTED_KEY));
  const dailyIds = parseProtected(await store.getMeta(DAILY_KEY));
  return { today, commitments, work, log, protectedIds, dailyIds, framework: computeFramework(commitments, work, log, reviewedOn, today, includeAll) };
}

/** A task may only point at a commitment that exists and is still open. */
async function checkCommitments(ids: (string | null | undefined)[], ctx: McpContext): Promise<void> {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (wanted.length === 0) return;
  const byId = new Map((await ctx.store.listCommitments()).map((c) => [c.id, c]));
  for (const id of wanted) {
    const c = byId.get(id);
    if (!c) throw new ValidationError(`unknown commitment "${id}": create it first with set_commitments, or leave commitment out`);
    if (c.status !== 'open') throw new ValidationError(`commitment "${id}" is ${c.status}; leave commitment out or reopen it with set_commitments`);
  }
}

/** After publishing today's plan: which flagged suggestions did the plan leave out? (Reported, never enforced.) */
async function frameworkCheck(ctx: McpContext, date: string, todaysTasks: Task[]): Promise<Json | null> {
  const { today, framework, commitments, work, log, protectedIds, dailyIds } = await loadFramework(ctx);
  if (date !== today) return null;
  const scheduled = new Set(todaysTasks.map((t) => t.commitmentId).filter((i): i is string => !!i));
  const left = unaddressed(framework, scheduled);
  // On a rest day of the site's Calc 3 plan nothing is due for the daily item, so it needs no block.
  const restToday = dailyIds.size > 0 && (await isCalcRestDay(ctx.sync, date));
  const floor = computeSlipping(commitments, work, log, protectedIds, today, scheduled, dailyIds).filter((s) => s.floor_needed && !s.in_todays_plan && !(restToday && s.daily));
  if (left.length === 0 && floor.length === 0 && !framework.review_due) return null;
  return {
    ...(floor.length
      ? {
          floor_blocks_missing: floor.map((s) => ({ id: s.id, title: s.title, daily: s.daily, deferred: s.times_deferred, done_minutes: s.done_minutes })),
          floor_rule:
            'These are protected and at risk, and none has a block in this plan. Add a small floor block (15 to 25 minutes) for each, unless he told you not to study today ' +
            '(illness, injury, a day off), and then say so in Warnings. If the day cannot hold them, name what you are dropping or what he must renegotiate; never quietly push them later.',
        }
      : {}),
    ...(left.length ? { not_in_todays_plan: left.map((i) => ({ id: i.id, title: i.title, signals: i.signals })) } : {}),
    ...(framework.review_due ? { review_due: true } : {}),
    hint:
      "These are earlier agents' suggestions and the call is yours. If you leave one out on purpose, say so with defer_commitment " +
      '(a one-line reason) or change it with set_commitments; there is no penalty for disagreeing. ' +
      (framework.review_due ? 'A light review is due: see get_framework.' : ''),
  };
}

/** After publishing a plan for today or later: does a normal day (Mon to Fri) stay under his cap and keep college work for the weekend? */
async function dayTypeFor(ctx: McpContext, date: string, planTasks: Task[], orders: Order[] = []): Promise<Json | null> {
  const today = plannerToday(ctx.timeZone, ctx.now);
  if (date < today || isCollegeDay(date)) return null;
  // A standing order that sets the cap is the decided number; otherwise fall back to his typical finished weekday.
  const ordered = capFromOrders(orders, date);
  if (ordered !== null) return dayTypeCheck(date, planTasks, ordered);
  const all = await ctx.store.listRange(shiftDate(today, -DEFAULT_WINDOW_DAYS), today);
  const cap = computeHabits(all, ctx.timeZone, today).capacity.weekday?.median_done_minutes ?? null;
  return dayTypeCheck(date, planTasks, cap);
}

/** Raw rows for the weekly review (see the get_week_export tool). */
async function weekExport(args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  const today = plannerToday(timeZone, now);
  const through = args.to !== undefined && args.to !== null ? resolveDate(args.to, timeZone, now) : shiftDate(today, -1);
  const from = args.from !== undefined && args.from !== null ? resolveDate(args.from, timeZone, now) : shiftDate(through, -27);
  if (from > through) throw new ValidationError('from must not be after to');
  if (shiftDate(from, 90) < through) throw new ValidationError('the range is at most 90 days');
  const all = await store.listRange(from, through);
  await reconcile(store, all, ctx.sync);
  const ratings = await store.listRatings(from, through);
  const byDate = new Map<string, Task[]>();
  for (const t of all) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  const days = [];
  for (const [date, dayTasks] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const totals = planTotals(dayTasks);
    const followed = totals.reduce((best, p) => (p.done > best.done ? p : best));
    const other = totals.find((p) => p.plan !== followed.plan);
    const tasks = dayTasks.filter((t) => t.plan === followed.plan);
    const bulk = bulkTickedIds(tasks, timeZone);
    const together = finishedTogether(tasks, timeZone);
    const slot = slotLateness(tasks, timeZone, bulk);
    const info = await store.getDayInfo(date);
    days.push({
      date,
      weekday: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${date}T12:00:00Z`)),
      plan: followed.plan,
      ...(other ? { other_plan: other } : {}),
      ...(ratings.has(date) ? { rating: ratings.get(date) } : {}),
      headline: info.headline || null,
      // The block's instruction text (notes) is long and useless for analysis, and 90 days of it is most of the payload.
      tasks: tasks.map((t) => {
        const { notes: _notes, ...row } = view(t, timeZone, bulk, together, slot);
        return row;
      }),
    });
  }
  const fromIso = new Date(plannerTimeToEpoch(from, '00:00', timeZone)).toISOString();
  const throughIso = new Date(plannerTimeToEpoch(shiftDate(through, 1), '00:00', timeZone)).toISOString();
  const within = (iso: string) => iso >= fromIso && iso < throughIso;
  const span = (g: { startedAt: string; endedAt: string | null; mode?: string }) => ({
    date: localDate(g.startedAt, timeZone),
    start: localTime(g.startedAt, timeZone),
    end: g.endedAt ? localTime(g.endedAt, timeZone) : null,
    minutes: g.endedAt ? Math.round((Date.parse(g.endedAt) - Date.parse(g.startedAt)) / 60000) : null,
    ...(g.mode ? { mode: g.mode } : {}),
  });
  const gym = (await store.listGym(fromIso)).filter((g) => within(g.startedAt)).map(span);
  const music = (await store.listMusic(fromIso))
    .filter((g) => within(g.startedAt) && (g.endedAt === null || Date.parse(g.endedAt) - Date.parse(g.startedAt) >= 30_000))
    .map((g) => span({ ...g, mode: g.mode ?? 'browsing' }));
  const commitments = (await store.listCommitments()).map((c) => ({ id: c.id, title: c.title, due: c.due, status: c.status, target_minutes: c.targetMinutes, start: c.start }));
  return {
    from,
    through,
    note: 'One entry per day that had tasks: the plan he followed with every task (all timing fields), the other plan\'s totals, his rating (1 drained to 5 good), and the planner\'s headline for the day. Ticks flagged bulk_ticked, backfilled or flagged do not show when he worked; leave them out of timing figures.',
    days,
    gym,
    youtube_mode: music,
    commitments,
  };
}

function strictDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${name} must look like YYYY-MM-DD`);
  return resolveDate(value, 'UTC');
}

async function setCommitments(args: Json, ctx: McpContext): Promise<Json> {
  const { store, now, timeZone } = ctx;
  if (!Array.isArray(args.commitments)) throw new ValidationError('commitments must be an array');
  if (args.commitments.length > MAX_OPEN_COMMITMENTS) throw new ValidationError(`at most ${MAX_OPEN_COMMITMENTS} commitments per call`);
  const today = plannerToday(timeZone, now);
  const stamp = (now ?? new Date()).toISOString();

  // Validate and merge everything first, so a bad entry leaves the framework untouched.
  const existing = new Map((await store.listCommitments()).map((c) => [c.id, c]));
  const merged = new Map(existing);
  const changed: { c: Commitment; closed: 'done' | 'dropped' | null; added: boolean }[] = [];
  const protectedIds = parseProtected(await store.getMeta(PROTECTED_KEY));
  const protectChanges: { id: string; on: boolean; words: string | null }[] = [];
  const dailyIds = parseProtected(await store.getMeta(DAILY_KEY));
  const dailyChanges: { id: string; on: boolean; words: string | null }[] = [];
  for (const raw of args.commitments) {
    if (typeof raw !== 'object' || raw === null) throw new ValidationError('each commitment must be an object with an id');
    const r = raw as Json;
    const id = parseCommitmentId(r.id);
    const old = merged.get(id);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k);
    if (!old && (typeof r.title !== 'string' || r.title.trim() === '')) throw new ValidationError(`new commitment "${id}" needs a title`);

    const next: Commitment = old
      ? { ...old }
      : { id, title: '', due: null, start: null, targetMinutes: null, status: 'open', note: null, deferUntil: null, deferReason: null, createdOn: today, updatedAt: stamp };
    if (has('title')) {
      if (typeof r.title !== 'string' || r.title.trim() === '' || r.title.trim().length > 80) throw new ValidationError(`title for "${id}" must be 1 to 80 characters`);
      next.title = r.title.trim();
    }
    if (has('due')) next.due = r.due === null ? null : strictDate(r.due, `due for "${id}"`);
    if (has('start')) next.start = r.start === null ? null : strictDate(r.start, `start for "${id}"`);
    if (has('target_minutes')) {
      const m = r.target_minutes;
      if (m !== null && (typeof m !== 'number' || !Number.isInteger(m) || m < 5 || m > 6000)) throw new ValidationError(`target_minutes for "${id}" must be a whole number from 5 to 6000, or null`);
      next.targetMinutes = m as number | null;
    }
    if (has('note')) {
      if (r.note !== null && (typeof r.note !== 'string' || r.note.trim().length > 300)) throw new ValidationError(`note for "${id}" must be at most 300 characters`);
      next.note = r.note === null || (r.note as string).trim() === '' ? null : (r.note as string).trim();
    }
    if (has('protected')) {
      if (typeof r.protected !== 'boolean') throw new ValidationError(`protected for "${id}" must be true or false`);
      const isProtected = protectedIds.has(id);
      if (r.protected && !isProtected) {
        protectedIds.add(id);
        protectChanges.push({ id, on: true, words: null });
      } else if (!r.protected && isProtected) {
        const words = typeof r.his_words === 'string' ? r.his_words.trim() : '';
        if (words.length < 8 || words.length > 200) {
          throw new ValidationError(`"${id}" is protected: only he can unprotect it. Pass his_words with what he said (8 to 200 characters).`);
        }
        if (dailyIds.has(id)) throw new ValidationError(`"${id}" is a daily item, so it stays protected; make it not daily first (needs his words).`);
        protectedIds.delete(id);
        protectChanges.push({ id, on: false, words });
      }
    }
    if (has('daily')) {
      if (typeof r.daily !== 'boolean') throw new ValidationError(`daily for "${id}" must be true or false`);
      const isDaily = dailyIds.has(id);
      if (r.daily && !isDaily) {
        dailyIds.add(id);
        if (!protectedIds.has(id)) {
          protectedIds.add(id);
          protectChanges.push({ id, on: true, words: null });
        }
        dailyChanges.push({ id, on: true, words: null });
      } else if (!r.daily && isDaily) {
        const words = typeof r.his_words === 'string' ? r.his_words.trim() : '';
        if (words.length < 8 || words.length > 200) {
          throw new ValidationError(`"${id}" is a daily item: only he can make it stop being one. Pass his_words with what he said (8 to 200 characters).`);
        }
        dailyIds.delete(id);
        dailyChanges.push({ id, on: false, words });
      }
    }
    let closed: 'done' | 'dropped' | null = null;
    if (has('status')) {
      if (typeof r.status !== 'string' || !(COMMITMENT_STATUSES as readonly string[]).includes(r.status)) throw new ValidationError(`status for "${id}" must be one of: ${COMMITMENT_STATUSES.join(', ')}`);
      if (r.status !== next.status && r.status !== 'open') closed = r.status as 'done' | 'dropped';
      next.status = r.status as CommitmentStatus;
      if (next.status !== 'open') {
        next.deferUntil = null;
        next.deferReason = null;
      }
    }
    next.updatedAt = stamp;
    merged.set(id, next);
    changed.push({ c: next, closed, added: !old });
  }
  const open = [...merged.values()].filter((c) => c.status === 'open').length;
  if (open > MAX_OPEN_COMMITMENTS) {
    throw new ValidationError(`that would leave ${open} open commitments; keep at most ${MAX_OPEN_COMMITMENTS} (drop or finish some, and keep them rough)`);
  }

  if (protectChanges.length > 0) {
    await store.setMeta(PROTECTED_KEY, JSON.stringify([...protectedIds].sort()));
    for (const p of protectChanges) {
      await store.addFrameworkLog({ onDate: today, commitmentId: p.id, action: 'review', detail: p.on ? 'protected' : `unprotected (his words: "${p.words}")` });
    }
  }
  if (dailyChanges.length > 0) {
    await store.setMeta(DAILY_KEY, JSON.stringify([...dailyIds].sort()));
    for (const p of dailyChanges) {
      await store.addFrameworkLog({ onDate: today, commitmentId: p.id, action: 'review', detail: p.on ? 'made a daily item' : `no longer daily (his words: "${p.words}")` });
    }
  }
  for (const { c, closed } of changed) {
    await store.saveCommitment(c);
    if (closed) await store.addFrameworkLog({ onDate: today, commitmentId: c.id, action: closed, detail: c.note ?? c.title });
  }
  if (args.reviewed === true) {
    await store.setMeta('framework_reviewed_on', today);
    const added = changed.filter((x) => x.added).length;
    const closedCount = changed.filter((x) => x.closed).length;
    await store.addFrameworkLog({ onDate: today, commitmentId: null, action: 'review', detail: `${added} added, ${closedCount} closed, ${open} open` });
  }
  return { saved: changed.length, open, reviewed_on: (await store.getMeta('framework_reviewed_on')) ?? null };
}

async function deferCommitment(args: Json, ctx: McpContext): Promise<Json> {
  const { store, now, timeZone } = ctx;
  const id = parseCommitmentId(args.id);
  const today = plannerToday(timeZone, now);
  const c = (await store.listCommitments()).find((x) => x.id === id);
  if (!c) throw new ValidationError(`no commitment "${id}"`);
  if (c.status !== 'open') throw new ValidationError(`commitment "${id}" is ${c.status}, so there is nothing to defer`);
  const stamp = (now ?? new Date()).toISOString();

  if (args.until === null) {
    await store.saveCommitment({ ...c, deferUntil: null, deferReason: null, updatedAt: stamp });
    await store.addFrameworkLog({ onDate: today, commitmentId: id, action: 'undefer', detail: typeof args.reason === 'string' ? args.reason.trim() : 'brought back' });
    return { id, deferred_until: null };
  }
  const until = strictDate(args.until, 'until');
  if (until <= today) throw new ValidationError('until must be after today');
  if (until > shiftDate(today, MAX_DEFER_DAYS)) throw new ValidationError(`a deferral can last at most ${MAX_DEFER_DAYS} days; pick an earlier day (you can defer again then)`);
  if (typeof args.reason !== 'string' || args.reason.trim() === '' || args.reason.trim().length > 200) {
    throw new ValidationError('give a one-line reason (at most 200 characters) so later runs understand the choice');
  }
  const reason = args.reason.trim();
  const hisWords = typeof args.his_words === 'string' && args.his_words.trim().length >= 8 ? args.his_words.trim().slice(0, 200) : null;
  const [work, log, protectedRaw, dailyRaw] = await Promise.all([store.commitmentWork(), store.listFrameworkLog(200), store.getMeta(PROTECTED_KEY), store.getMeta(DAILY_KEY)]);
  const refusal = deferRefusal({
    c,
    item: describeItem(c, work, today),
    isProtected: parseProtected(protectedRaw).has(id),
    isDaily: parseProtected(dailyRaw).has(id),
    history: deferHistory(log).get(id) ?? { n: 0, lastReason: null },
    until,
    reason,
    hisWords,
  });
  if (refusal) throw new ValidationError(refusal);
  await store.saveCommitment({ ...c, deferUntil: until, deferReason: reason, updatedAt: stamp });
  await store.addFrameworkLog({ onDate: today, commitmentId: id, action: 'defer', detail: `until ${until}: ${reason}${hisWords ? ` (his words: "${hisWords}")` : ''}` });
  return { id, deferred_until: until, reason };
}

async function setUserNotes(args: Json, ctx: McpContext): Promise<Json> {
  const { store, now, timeZone } = ctx;
  if (!Array.isArray(args.notes)) throw new ValidationError('notes must be an array');
  if (args.notes.length > 20) throw new ValidationError('at most 20 notes per call');
  const today = plannerToday(timeZone, now);
  const stamp = (now ?? new Date()).toISOString();
  const has = (r: Json, k: string) => Object.prototype.hasOwnProperty.call(r, k);

  // Validate and merge everything first, so one bad entry leaves the notes untouched.
  const merged = new Map((await store.listUserNotes()).map((n) => [n.id, n]));
  const touched = new Map<string, UserNote>();
  for (const raw of args.notes) {
    if (typeof raw !== 'object' || raw === null) throw new ValidationError('each note must be an object with an id');
    const r = raw as Json;
    const id = parseUserNoteId(r.id);
    const old = merged.get(id);
    if (!old && (typeof r.text !== 'string' || r.text.trim() === '' || typeof r.kind !== 'string')) {
      throw new ValidationError(`new note "${id}" needs a kind and a text`);
    }
    const next: UserNote = old
      ? { ...old }
      : { id, kind: 'fact', text: '', quote: null, notedOn: today, confirmedOn: today, status: 'active', updatedAt: stamp };

    let reconfirm = !old || r.confirmed === true;
    if (has(r, 'kind')) {
      if (typeof r.kind !== 'string' || !(USER_NOTE_KINDS as readonly string[]).includes(r.kind)) {
        throw new ValidationError(`kind for "${id}" must be one of: ${USER_NOTE_KINDS.join(', ')}`);
      }
      next.kind = r.kind as UserNote['kind'];
      reconfirm = true;
    }
    if (has(r, 'text')) {
      if (typeof r.text !== 'string' || r.text.trim() === '' || r.text.trim().length > 300) {
        throw new ValidationError(`text for "${id}" must be 1 to 300 characters`);
      }
      next.text = r.text.trim();
      reconfirm = true;
    }
    if (has(r, 'quote')) {
      if (r.quote !== null && (typeof r.quote !== 'string' || r.quote.trim().length > 200)) {
        throw new ValidationError(`quote for "${id}" must be at most 200 characters`);
      }
      next.quote = r.quote === null || (r.quote as string).trim() === '' ? null : (r.quote as string).trim();
      reconfirm = true;
    }
    if (has(r, 'status')) {
      if (typeof r.status !== 'string' || !(USER_NOTE_STATUSES as readonly string[]).includes(r.status)) {
        throw new ValidationError(`status for "${id}" must be one of: ${USER_NOTE_STATUSES.join(', ')}`);
      }
      next.status = r.status as UserNote['status'];
    }
    if (reconfirm && next.status === 'active') next.confirmedOn = today;
    next.updatedAt = stamp;
    merged.set(id, next);
    touched.set(id, next);
  }
  const active = [...merged.values()].filter((n) => n.status === 'active').length;
  if (active > MAX_ACTIVE_NOTES) {
    throw new ValidationError(`that would leave ${active} active notes; keep at most ${MAX_ACTIVE_NOTES} (merge duplicates or resolve old ones)`);
  }

  for (const note of touched.values()) await store.saveUserNote(note);
  for (const id of resolvedToPrune([...merged.values()])) await store.deleteUserNote(id);
  return { saved: touched.size, active };
}

function parseWindow(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_WINDOW_DAYS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 7 || value > MAX_WINDOW_DAYS) {
    throw new ValidationError(`days must be a whole number from 7 to ${MAX_WINDOW_DAYS}`);
  }
  return value;
}

const noteView = (n: { version: number; updatedAt: string; text: string }) => ({
  version: n.version,
  updated_at: n.updatedAt,
  text: n.text,
});

async function habits(args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  if (args.version !== undefined && args.version !== null) {
    if (typeof args.version !== 'number' || !Number.isInteger(args.version) || args.version < 1) {
      throw new ValidationError('version must be a whole number from the versions list');
    }
    const found = await store.getHabitNotes(args.version);
    if (!found) throw new ValidationError(`no habit notes version ${args.version}`);
    return { notes: noteView(found) };
  }
  const days = parseWindow(args.days);
  const today = plannerToday(timeZone, now);
  const experiments = await store.listExperiments();
  // Reach back far enough to compare each running experiment with the 14 days before it started.
  const earliest = experiments.filter((e) => e.status === 'running').map((e) => shiftDate(e.startedOn, -14));
  const from = [shiftDate(today, -days), ...earliest].sort()[0];
  const all = await store.listRange(from, today);
  await reconcile(store, all, ctx.sync); // pick up anything he ticked on the site
  const ratings = await store.listRatings(from, today);
  const [latest, versions] = await Promise.all([store.getHabitNotes(), store.listHabitVersions()]);
  return {
    stats: computeHabits(all, timeZone, today, days, ratings),
    experiments: evaluateExperiments(all, ratings, experiments, timeZone, today),
    notes: latest ? noteView(latest) : null,
    versions: versions.map((v) => ({ version: v.version, updated_at: v.updatedAt, chars: v.chars })),
  };
}

const MAX_RUNNING_EXPERIMENTS = 3;
const MAX_CLOSED_EXPERIMENTS_KEPT = 10;

/** Where a set of experiments is kept: the planner's own, or the music experiment's. */
export interface ExperimentIO {
  list(): Promise<Experiment[]>;
  save(e: Experiment): Promise<void>;
  remove(id: string): Promise<boolean>;
}

export async function setExperiments(
  args: Json,
  ctx: McpContext,
  io: ExperimentIO = {
    list: () => ctx.store.listExperiments(),
    save: (e) => ctx.store.saveExperiment(e),
    remove: (id) => ctx.store.deleteExperiment(id),
  },
): Promise<Json> {
  const { store, now, timeZone } = ctx;
  if (!Array.isArray(args.experiments)) throw new ValidationError('experiments must be an array');
  if (args.experiments.length > 10) throw new ValidationError('at most 10 experiments per call');
  const today = plannerToday(timeZone, now);
  const stamp = (now ?? new Date()).toISOString();
  const has = (r: Json, k: string) => Object.prototype.hasOwnProperty.call(r, k);
  const text = (r: Json, k: string, max: number, id: string): string => {
    const v = r[k];
    if (typeof v !== 'string' || v.trim() === '' || v.trim().length > max) {
      throw new ValidationError(`${k} for "${id}" must be 1 to ${max} characters`);
    }
    return v.trim();
  };

  const merged = new Map((await io.list()).map((e) => [e.id, e]));
  const touched = new Map<string, Experiment>();
  for (const raw of args.experiments) {
    if (typeof raw !== 'object' || raw === null) throw new ValidationError('each experiment must be an object with an id');
    const r = raw as Json;
    const id = parseCommitmentId(r.id); // same short-slug rule
    const old = merged.get(id);
    if (!old && (!has(r, 'title') || !has(r, 'change') || !has(r, 'measure'))) {
      throw new ValidationError(`new experiment "${id}" needs a title, a change and a measure`);
    }
    const next: Experiment = old
      ? { ...old }
      : { id, title: '', change: '', measure: 'done_pct', tag: null, startedOn: today, status: 'running', result: null, updatedAt: stamp };
    if (has(r, 'title')) next.title = text(r, 'title', 100, id);
    if (has(r, 'change')) next.change = text(r, 'change', 300, id);
    if (has(r, 'measure')) {
      if (typeof r.measure !== 'string' || !(EXPERIMENT_MEASURES as readonly string[]).includes(r.measure)) {
        throw new ValidationError(`measure for "${id}" must be one of: ${EXPERIMENT_MEASURES.join(', ')}`);
      }
      next.measure = r.measure as Experiment['measure'];
    }
    if (has(r, 'tag')) next.tag = r.tag === null ? null : parseTag(r.tag);
    if (has(r, 'started_on')) next.startedOn = resolveDate(r.started_on, timeZone, now);
    if (has(r, 'result')) next.result = r.result === null ? null : text(r, 'result', 400, id);
    if (has(r, 'status')) {
      if (typeof r.status !== 'string' || !(EXPERIMENT_STATUSES as readonly string[]).includes(r.status)) {
        throw new ValidationError(`status for "${id}" must be one of: ${EXPERIMENT_STATUSES.join(', ')}`);
      }
      next.status = r.status as Experiment['status'];
    }
    if (next.status !== 'running' && !next.result) {
      throw new ValidationError(`closing "${id}" needs a short result (what you concluded)`);
    }
    next.updatedAt = stamp;
    merged.set(id, next);
    touched.set(id, next);
  }
  const running = [...merged.values()].filter((e) => e.status === 'running').length;
  if (running > MAX_RUNNING_EXPERIMENTS) {
    throw new ValidationError(`that would leave ${running} running experiments; keep at most ${MAX_RUNNING_EXPERIMENTS} (change one thing at a time)`);
  }
  for (const e of touched.values()) await io.save(e);
  const closed = [...merged.values()].filter((e) => e.status !== 'running').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  for (const e of closed.slice(MAX_CLOSED_EXPERIMENTS_KEPT)) await io.remove(e.id);
  return { saved: touched.size, running };
}

async function history(args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  const through = resolveDate(args.through, timeZone, now);
  const days = parseDays(args.days);
  const from = shiftDate(through, -(days - 1));

  const all = await store.listRange(from, through);
  await reconcile(store, all, ctx.sync); // pick up anything he ticked on the site
  const ratings = await store.listRatings(from, through);
  const byDate = new Map<string, Task[]>();
  for (const t of all) {
    byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  }

  let done = 0;
  let total = 0;
  const out = [...byDate.entries()].map(([date, dayTasks]) => {
    // He follows one plan a day. Take the one with more check-offs; A wins a tie.
    const totals = planTotals(dayTasks);
    const followed = totals.reduce((best, p) => (p.done > best.done ? p : best));
    const other = totals.find((p) => p.plan !== followed.plan);
    const tasks = dayTasks.filter((t) => t.plan === followed.plan);
    done += followed.done;
    total += followed.total;
    const timing = dayTiming(tasks, timeZone);
    const bulk = bulkTickedIds(tasks, timeZone);
    const together = finishedTogether(tasks, timeZone);
    const slot = slotLateness(tasks, timeZone, bulk);
    return {
      date,
      plan: followed.plan,
      done: followed.done,
      total: followed.total,
      ...(other ? { other_plan: other } : {}),
      ...(ratings.has(date) ? { rating: ratings.get(date) } : {}),
      ...(timing ? { timing } : {}),
      tasks: tasks.map((t) => ({
        title: t.title,
        tag: t.tag,
        start: t.start,
        minutes: t.minutes,
        done: t.done,
        completed: t.done && t.completedAt ? localTime(t.completedAt, timeZone) : null,
        completed_at: completedAtLocal(t, timeZone),
        late_min: slot.get(t.id) ?? null,
        ...(slot.has(t.id) && slot.get(t.id) !== lateMinutes(t, timeZone, bulk) ? { late_own_min: lateMinutes(t, timeZone, bulk) } : {}),
        backfilled: isBackfilled(t, timeZone),
        bulk_ticked: bulk.has(t.id) && !together.has(t.id),
        finished_with: together.get(t.id)?.title ?? null,
        started: startedMinutes(t, timeZone) === null ? null : localTime(t.startedAt!, timeZone),
        actual_min: actualMinutes(t, timeZone, bulk),
        start_delay_min: startDelayMinutes(t, timeZone),
        ...(t.pausedMs > 0 || t.pausedAt ? { paused_min: Math.round(t.pausedMs / 60_000) } : {}),
        flagged: isFlagged(t),
      })),
    };
  });
  // Yesterday's notes (headline and sections such as "Next PCB work"): this is what the saved plan files used to be read for.
  let latestInfo: Json | null = null;
  let pcbPromise: Json | null = null; // a later chat update can replace a day's notes, so look further back for the last "Next PCB work"
  const today = plannerToday(timeZone, now);
  for (let back = 1; back <= 14 && (latestInfo === null || pcbPromise === null); back++) {
    const date = shiftDate(today, -back);
    const info = await store.getDayInfo(date);
    if (latestInfo === null && (info.headline || info.sections.length > 0)) {
      latestInfo = { date, headline: info.headline, sections: info.sections.map((s) => ({ title: s.title, body: s.body })) };
    }
    const pcb = info.sections.find((s) => s.title.trim().toLowerCase() === 'next pcb work');
    if (pcbPromise === null && pcb) pcbPromise = { date, body: pcb.body };
  }
  return { from, through, done, total, days: out, latest_day_info: latestInfo, last_next_pcb_work: pcbPromise };
}

/** His progress site's state, exactly as stored, shaped for reading (see the get_site_progress tool). */
async function siteProgress(args: Json, ctx: McpContext): Promise<Json> {
  if (!ctx.sync) throw new ValidationError('the progress site is not connected to this server (FIREBASE_STATE_URL is not set)');
  const prefix = typeof args.prefix === 'string' ? args.prefix : 'calc3-';
  const today = plannerToday(ctx.timeZone, ctx.now);
  const from = typeof args.cal_from === 'string' ? resolveDate(args.cal_from, ctx.timeZone, ctx.now) : today;
  const to = typeof args.cal_to === 'string' ? resolveDate(args.cal_to, ctx.timeZone, ctx.now) : shiftDate(today, 45);
  let snap;
  try {
    snap = await ctx.sync.site.read();
  } catch (err) {
    throw new ValidationError(`could not read the progress site: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  const when = (ms: number): string | null => (ms > 0 ? `${localDate(new Date(ms).toISOString(), ctx.timeZone)} ${localTime(new Date(ms).toISOString(), ctx.timeZone)}` : null);
  const state = snap.state;

  // The site's own plan, read from its public page: the dates and the rest days, and when the plan was last rewritten.
  const calcSrc = ctx.sync.calcSource ? await ctx.sync.calcSource().catch(() => null) : null;
  const fixedReset = (ctx.sync.resets ?? []).find((r) => r.prefix === 'calc3-')?.ms ?? 0;
  const resetMs = Math.max(fixedReset, calcSrc?.resetAt ?? 0);
  let droppedNow = 0;
  const live = [...snap.entries.entries()].filter(([id, e]) => {
    if (resetMs > 0 && id.startsWith('calc3-') && e.t < resetMs) {
      droppedNow++;
      return false;
    }
    return true;
  });
  const tasks = live
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, e]) => ({ id, done: e.v, changed: when(e.t) }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  // calendar items are [ "YYYY-M-D|title", 0|1, epochMs ] (the month and day are not zero-padded)
  const cal = rowsOf(state.cal)
    .filter((r): r is [string, number, number] => Array.isArray(r) && typeof r[0] === 'string')
    .map((r) => {
      const bar = r[0].indexOf('|');
      const [y, m, d] = (bar > 0 ? r[0].slice(0, bar) : '').split('-').map(Number);
      const date = y && m && d ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
      return { date, title: bar > 0 ? r[0].slice(bar + 1) : r[0], done: r[1] === 1, changed: when(Number(r[2]) || 0) };
    })
    .filter((c) => c.date !== null && c.date >= from && c.date <= to)
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));

  const daysNode = state.days as { t?: unknown; value?: { calc3?: { rest?: unknown; sig?: unknown; live?: unknown } } } | undefined;
  const days = daysNode?.value?.calc3;
  const restStale = resetMs > 0 && !(typeof daysNode?.t === 'number' && daysNode.t >= resetMs);
  const doneIds = new Map(live.map(([id, e]) => [id, e.v]));
  const schedule = calcSrc ? buildSchedule(calcSrc, { sig: days?.sig, rest: days?.rest, live: days?.live, t: typeof daysNode?.t === 'number' ? daysNode.t : null }) : null;
  const scheduleDays = schedule?.days.map((d) => ({ date: d.date, id: d.id, rest: d.rest, title: d.title, done: doneIds.get(d.id) === true }));
  const todayEntry = scheduleDays?.find((d) => d.date === today) ?? null;
  return {
    ...(restStale || (snap.ignored ?? 0) + droppedNow > 0
      ? {
          stale_state: {
            ignored_entries: (snap.ignored ?? 0) + droppedNow,
            rest_slots_ignored: restStale,
            why: calcSrc
              ? "The site's Calc 3 plan was rewritten after some saved check marks and rest days were stored, so those belong to the old plan and are left out. The dates, rest days and lessons of the CURRENT plan are in `calc3_schedule` (read from the site's own page): use that, and count a lesson as done only if it shows done there. Say in Warnings that he should open the progress site once so it saves its state in the new plan."
              : "The site's Calc 3 plan was rewritten after these check marks were stored, so they belong to the old plan and are left out, and the current plan could not be read from the site's page just now. Treat every Calc 3 lesson as not done, take the dates and rest days from the site source in the prompt, and say in Warnings that he should open the progress site once to sync it.",
          },
        }
      : {}),
    ...(scheduleDays
      ? {
          calc3_schedule: {
            plan: calcSrc!.resetToken,
            signature: calcSrc!.sig,
            rest_days_from: schedule!.rest_days_from,
            note: 'One row per day of the current Calc 3 plan, with its real date. A rest day has no lesson that day. `done` comes from the check marks that belong to this plan.',
            rest_layout_saved_at: typeof daysNode?.t === 'number' ? when(daysNode.t) : null,
            today: todayEntry,
            remaining_lessons: scheduleDays.filter((d) => !d.rest && !d.done && d.date >= today).length,
            days: scheduleDays,
          },
        }
      : {}),
    calc3_sig: typeof days?.sig === 'string' ? days.sig : null,
    site_updated: typeof state.at === 'number' ? when(state.at) : null,
    prefix,
    tasks,
    // A saved layout whose signature is not the current plan's belongs to an older plan: leave it out rather than show rest days that no longer exist.
    calc3_rest: !restStale && Array.isArray(days?.rest) && (!calcSrc || days?.sig === calcSrc.sig) ? days!.rest : [],
    calc3_rest_note: "Rest-day slot numbers, counted from slot 0 = the first day of the Calc 3 plan in the site source (the start of its first week in DAY_GRIDS; see the planner rules for how slots map to lessons). Empty = no rest days.",
    calendar_range: { from, to },
    cal,
  };
}

async function callTool(name: string, args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  switch (name) {
    case 'set_daily_plan': {
      const date = resolveDate(args.date, timeZone, now);
      const plan = parsePlan(args.plan);
      const parsed = parseNewTasks(args.tasks);
      checkSiteKeys(parsed.map((t) => t.siteKey), ctx);
      await checkCommitments(parsed.map((t) => t.commitment), ctx);
      await store.replaceDay(date, plan, parsed);
      await store.logEvent({ taskId: null, title: null, source: 'planner tool (Claude)', change: JSON.stringify({ published: `plan ${plan}`, date, tasks: parsed.length }) });
      const all = await store.list(date);
      await reconcile(store, all, ctx.sync); // a lesson already ticked on the site arrives ticked
      const published = summarize(date, plan, all.filter((t) => t.plan === plan), timeZone);
      const check = await frameworkCheck(ctx, date, all);
      const orders = (await loadDirectives(store)).orders;
      const dayType = await dayTypeFor(ctx, date, all.filter((t) => t.plan === plan), orders);
      const planDirectives = date >= plannerToday(timeZone, now) ? checkDirectives(date, all.filter((t) => t.plan === plan), orders) : null;
      return {
        ...published,
        ...(check ? { framework_check: check } : {}),
        ...(dayType ? { day_type_check: dayType } : {}),
        ...(planDirectives && planDirectives.broken.length
          ? { directive_check: { ...planDirectives, rule: 'These standing orders are decided facts. Fix the plan so none is broken and publish it again, unless his notes for this day override one; then say so in one line.' } }
          : {}),
      };
    }
    case 'set_day_info': {
      const date = resolveDate(args.date, timeZone, now);
      const info = parseDayInfo(args);
      await store.setDayInfo(date, info);
      return {
        date,
        headline: info.headline,
        sections: info.sections.map((s) => ({ title: s.title })),
      };
    }
    case 'list_tasks': {
      const date = resolveDate(args.date, timeZone, now);
      const all = await store.list(date);
      await reconcile(store, all, ctx.sync);
      // No plan asked for: show the one he followed (most checked off, A on a tie), or the only one that exists.
      const totals = planTotals(all);
      const plan = args.plan === undefined || args.plan === null
        ? (totals.length ? totals.reduce((best, p) => (p.done > best.done ? p : best)).plan : 'A')
        : parsePlan(args.plan);
      return { ...summarize(date, plan, all.filter((t) => t.plan === plan), timeZone), plans: planTotals(all) };
    }
    case 'get_history':
      return history(args, ctx);
    case 'get_server_status': {
      const schema = await store.schemaReport();
      return {
        database: schema.ok ? 'ok' : 'needs migration',
        missing: schema.missing,
        run_in_order: schema.run_in_order,
        ...(schema.ok ? {} : { how: 'Run these in server/ (answer yes if asked), oldest first; no deploy is needed afterwards.' }),
        progress_site_sync: ctx.sync ? 'configured' : 'off (FIREBASE_STATE_URL is not set)',
        planner_time_zone: timeZone,
      };
    }
    case 'get_site_progress':
      return siteProgress(args, ctx);
    case 'get_gym_sessions': {
      const days = typeof args.days === 'number' ? Math.min(60, Math.max(1, Math.floor(args.days))) : 14;
      const from = shiftDate(plannerToday(timeZone, now), -days);
      const sessions = await store.listGym(new Date(plannerTimeToEpoch(from, '00:00', timeZone)).toISOString());
      return {
        window_days: days,
        sessions: sessions.map((g) => ({
          date: localDate(g.startedAt, timeZone),
          start: localTime(g.startedAt, timeZone),
          end: g.endedAt ? localTime(g.endedAt, timeZone) : null,
          minutes: g.endedAt ? Math.round((Date.parse(g.endedAt) - Date.parse(g.startedAt)) / 60000) : null,
          open: g.endedAt === null,
        })),
      };
    }
    case 'get_task_log': {
      const limit = typeof args.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(args.limit))) : 40;
      const filter = typeof args.task === 'string' ? args.task.trim().toLowerCase() : '';
      const events = (await store.listEvents(filter ? 500 : limit))
        .filter((ev) => !filter || (ev.title ?? '').toLowerCase().includes(filter))
        .slice(0, limit);
      const schema = await store.schemaReport();
      const logMissing = schema.missing.some((m) => m.what === 'table task_events');
      return {
        ...(logMissing ? { note: 'The change log table does not exist yet, so nothing has been recorded. Run `npm run db:log:remote` in server/.' } : {}),
        events: events.map((ev) => ({
          at: `${localDate(ev.at, timeZone)} ${localTime(ev.at, timeZone)}`,
          task: ev.title,
          task_id: ev.taskId,
          source: ev.source,
          change: ev.change,
        })),
      };
    }
    case 'get_habits':
      return habits(args, ctx);
    case 'get_week_export':
      return weekExport(args, ctx);
    case 'get_directives': {
      const current = await loadDirectives(store);
      const today = plannerToday(timeZone, now);
      return {
        version: current.version,
        updated_at: current.updated_at,
        note: current.note,
        orders: current.orders,
        review_overdue: current.orders.filter((o) => o.review_by < today).map((o) => o.id),
        ...(args.history === true ? { history: await loadDirectiveHistory(store) } : {}),
      };
    }
    case 'set_directives': {
      const orders = parseOrders(args.orders);
      const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 500) : null;
      const saved = await saveDirectives(store, orders, note, (now ?? new Date()).toISOString());
      return { version: saved.version, orders: saved.orders.length };
    }
    case 'get_framework': {
      const f = await loadFramework(ctx, args.all === true);
      const slipping = computeSlipping(f.commitments, f.work, f.log, f.protectedIds, f.today, new Set(), f.dailyIds);
      return { ...f.framework, protected: [...f.protectedIds], daily: [...f.dailyIds], slipping, slipping_lines: slippingLines(slipping) };
    }
    case 'set_commitments':
      return setCommitments(args, ctx);
    case 'defer_commitment':
      return deferCommitment(args, ctx);
    case 'get_user_notes':
      return viewUserNotes(await store.listUserNotes(), plannerToday(timeZone, now), args.all === true);
    case 'set_user_notes':
      return setUserNotes(args, ctx);
    case 'delete_user_note': {
      const id = parseUserNoteId(args.id);
      if (!(await store.deleteUserNote(id))) throw new ValidationError(`no note "${id}"`);
      return { deleted: id };
    }
    case 'set_experiments':
      return setExperiments(args, ctx);
    case 'set_habits': {
      const saved = await store.saveHabitNotes(parseHabitNotes(args.notes));
      return { version: saved.version, updated_at: saved.updatedAt, chars: saved.text.length };
    }
    case 'add_task': {
      const date = resolveDate(args.date, timeZone, now);
      const parsed = parseNewTask(args);
      checkSiteKeys([parsed.siteKey], ctx);
      await checkCommitments([parsed.commitment], ctx);
      const added = await store.add(date, parsePlan(args.plan), parsed);
      await reconcile(store, [added], ctx.sync);
      return { added: view(added, timeZone), date };
    }
    case 'update_task': {
      const id = parseId(args.id);
      const { id: _id, completed, started_at: startedAtArg, paused_at: pausedAtArg, paused_min: pausedMinArg, ...rest } = args;
      const finishedTime = completed === undefined || completed === null ? null : parseStart(completed);
      if (finishedTime && rest.done !== true) throw new ValidationError('completed only goes with done: true');
      const startedTime = startedAtArg === undefined || startedAtArg === null ? null : parseStart(startedAtArg);
      const pausedTime = pausedAtArg === undefined || pausedAtArg === null ? null : parseStart(pausedAtArg);
      const timerFix = startedTime !== null || (pausedMinArg !== undefined && pausedMinArg !== null);
      const patch = pausedTime ? parsePatch({ ...rest, paused: true }) : parsePatch(rest, timerFix);
      if (pausedTime) {
        const existing = await store.get(id);
        if (!existing) throw new ValidationError(`no task with id ${id}`);
        if (!existing.startedAt || existing.done) throw new ValidationError('paused_at only works on a task that is started and not finished');
        const pausedMs = plannerTimeToEpoch(existing.date, pausedTime, timeZone);
        if (pausedMs < Date.parse(existing.startedAt)) throw new ValidationError(`${pausedTime} is before the task was started`);
        if (pausedMs > (now ?? new Date()).getTime() + 60_000) throw new ValidationError(`${pausedTime} on ${existing.date} hasn't happened yet`);
        patch.pausedAtIso = new Date(pausedMs).toISOString();
      }
      if (pausedMinArg !== undefined && pausedMinArg !== null) {
        // some clients send a number as text ("91")
        const minutes = typeof pausedMinArg === 'string' && /^\d{1,4}$/.test(pausedMinArg.trim()) ? Number(pausedMinArg) : pausedMinArg;
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
          throw new ValidationError('paused_min must be a whole number of minutes (0 to 1440)');
        }
        patch.pausedMsSet = minutes * 60_000;
      }
      if (startedTime) {
        const existing = await store.get(id);
        if (!existing) throw new ValidationError(`no task with id ${id}`);
        const startedMs = plannerTimeToEpoch(existing.date, startedTime, timeZone);
        if (startedMs > (now ?? new Date()).getTime() + 60_000) throw new ValidationError(`${startedTime} on ${existing.date} hasn't happened yet`);
        // With done: true it fixes the Start press of a finished task; otherwise it sets (or moves) the Start press of an unfinished one.
        if (rest.done === true) patch.restoreStarted = new Date(startedMs).toISOString();
        else patch.startedAtIso = new Date(startedMs).toISOString();
      }
      checkSiteKeys([patch.siteKey], ctx);

      // "I actually finished at 6:15pm": validate before writing anything, then record that time
      // instead of the moment of ticking. Site sync still uses when it was ticked.
      let finishedAtMs: number | null = null;
      if (finishedTime) {
        const existing = await store.get(id);
        if (!existing) throw new ValidationError(`no task with id ${id}`);
        finishedAtMs = plannerTimeToEpoch(existing.date, finishedTime, timeZone);
        if (finishedAtMs > (now ?? new Date()).getTime() + 60_000) {
          throw new ValidationError(`${finishedTime} on ${existing.date} hasn't happened yet`);
        }
      }

      let task = await store.update(id, patch);
      if (!task) throw new ValidationError(`no task with id ${id}`);
      await store.logEvent({ taskId: id, title: task.title, source: 'planner tool (Claude)', change: JSON.stringify(args) });
      if (finishedAtMs !== null) {
        await store.setCompletedAt(id, finishedAtMs);
        task = (await store.get(id)) ?? task;
      }
      if (patch.done !== undefined || patch.siteKey) await reconcile(store, [task], ctx.sync);
      return { updated: view(task, timeZone) };
    }
    case 'delete_task': {
      const id = parseId(args.id);
      if (!(await store.remove(id))) throw new ValidationError(`no task with id ${id}`);
      return { deleted: id };
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handleRequest(msg: Json, ctx: McpContext): Promise<unknown> {
  const params = (msg.params ?? {}) as Json;
  switch (msg.method) {
    case 'initialize': {
      const wanted = params.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(wanted as string)
        ? (wanted as string)
        : SUPPORTED_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs a name');
      const args = (params.arguments ?? {}) as Json;
      try {
        const result = await callTool(params.name, args, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        // Bad input is reported to the model as a tool error so it can correct itself.
        if (err instanceof ValidationError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${String(msg.method)}`);
  }
}

async function handleOne(msg: unknown, ctx: McpContext): Promise<Json | null> {
  if (typeof msg !== 'object' || msg === null || (msg as Json).jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const m = msg as Json;
  const isRequest = typeof m.method === 'string' && m.id !== undefined && m.id !== null;
  // Notifications (no id) and responses from the client need no reply.
  if (!isRequest) return null;

  try {
    return { jsonrpc: '2.0', id: m.id, result: await handleRequest(m, ctx) };
  } catch (err) {
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', id: m.id, error: { code: err.code, message: err.message } };
    }
    console.error('MCP tool failure', err);
    return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Internal error' } };
  }
}

/** Handles the body of one POST to the MCP endpoint. */
export async function handleMcpPost(request: Request, ctx: McpContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleOne(m, ctx)))).filter(
      (r): r is Json => r !== null,
    );
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }

  const reply = await handleOne(body, ctx);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}
