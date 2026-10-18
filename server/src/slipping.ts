// The "Slipping" section at the top of today's plan, built live from the framework so it shows on the phone app and the website
// whatever the planner wrote. Nothing here can be skipped or forgotten by a planning run.

import { PROTECTED_KEY, computeSlipping, parseProtected, slippingLines } from './framework';
import type { InfoSection, Task, TaskStore } from './tasks';

export async function slippingSection(store: TaskStore, today: string, todaysTasks: Task[]): Promise<InfoSection | null> {
  try {
    const [commitments, work, log, protectedRaw] = await Promise.all([
      store.listCommitments(),
      store.commitmentWork(),
      store.listFrameworkLog(200),
      store.getMeta(PROTECTED_KEY),
    ]);
    const planned = new Set(todaysTasks.map((t) => t.commitmentId).filter((i): i is string => !!i));
    const items = computeSlipping(commitments, work, log, parseProtected(protectedRaw), today, planned);
    if (items.length === 0) return null;
    return { title: 'Slipping', body: slippingLines(items).join('\n') };
  } catch (err) {
    console.error('could not build the slipping list', err);
    return null; // never break the day for this
  }
}
