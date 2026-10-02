// Minimal stateless MCP server (Streamable HTTP transport, JSON responses only).
// Stateless is enough here: every tool is a self-contained read or write, so there's
// no session to track and each POST can be answered on its own.

import { resolveDate } from './dates';
import {
  TAGS,
  ValidationError,
  parseId,
  parseNewTask,
  parseNewTasks,
  parsePatch,
  type Task,
  type TaskStore,
} from './tasks';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'cozy-planner', version: '1.0.0' };

const INSTRUCTIONS =
  "Manage the daily task list shown in the user's cozy planner app. " +
  'To publish a day, call set_daily_plan once with the full ordered list. ' +
  'list_tasks shows what is on the list and what the user has already checked off.';

const TAG_HELP =
  'school = general schoolwork; calculus3 = Calculus 3 (homework, studying, quizzes); ' +
  'sat = SAT prep; pcb = PCB design, assembly and debugging; photography = photography. ' +
  "Defaults to school if omitted.";

const dateProp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'Planner day as YYYY-MM-DD. Defaults to today in the planner time zone.',
};
const tagProp = { type: 'string', enum: [...TAGS], description: TAG_HELP };
const titleProp = { type: 'string', minLength: 1, maxLength: 200 };

const TOOLS = [
  {
    name: 'set_daily_plan',
    description:
      "Replace the whole task list for a day with the given tasks, in order. Use this to publish a day's plan. " +
      'Tasks the user already checked off stay checked if they appear again with the same title. ' +
      'Pass an empty array to clear the day.',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateProp,
        tasks: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: { title: titleProp, tag: tagProp },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'list_tasks',
    description: 'List the tasks for a day with their ids and whether each is done.',
    inputSchema: { type: 'object', properties: { date: dateProp } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_task',
    description: "Append one task to the end of a day's list.",
    inputSchema: {
      type: 'object',
      properties: { date: dateProp, title: titleProp, tag: tagProp },
      required: ['title'],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: 'update_task',
    description: "Change a task's title or tag, or mark it done / not done. Get ids from list_tasks.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: titleProp,
        tag: tagProp,
        done: { type: 'boolean' },
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
}

type Json = Record<string, unknown>;

const view = (t: Task) => ({ id: t.id, title: t.title, tag: t.tag, done: t.done });

function summarize(date: string, tasks: Task[]): Json {
  return {
    date,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    tasks: tasks.map(view),
  };
}

async function callTool(name: string, args: Json, ctx: McpContext): Promise<Json> {
  const { store, timeZone, now } = ctx;
  switch (name) {
    case 'set_daily_plan': {
      const date = resolveDate(args.date, timeZone, now);
      const tasks = await store.replaceDay(date, parseNewTasks(args.tasks));
      return summarize(date, tasks);
    }
    case 'list_tasks': {
      const date = resolveDate(args.date, timeZone, now);
      return summarize(date, await store.list(date));
    }
    case 'add_task': {
      const date = resolveDate(args.date, timeZone, now);
      return { added: view(await store.add(date, parseNewTask(args))), date };
    }
    case 'update_task': {
      const id = parseId(args.id);
      const { id: _id, ...rest } = args;
      const task = await store.update(id, parsePatch(rest));
      if (!task) throw new ValidationError(`no task with id ${id}`);
      return { updated: view(task) };
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
