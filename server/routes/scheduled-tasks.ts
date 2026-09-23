/**
 * Scheduled-task routes. Creating a task never fires anything by itself —
 * the loop that watches the table only exists when SCHEDULER_ENABLED=true,
 * and `POST /tick` lets an external cron fire due tasks while the free tier
 * sleeps. Routes are thin: parse, validate, delegate, respond.
 */
import { Router, type Request, type Response } from 'express';

import type { Db } from '../db.js';
import type { AcceptDeps } from '../accept.js';
import {
  MAX_TASK_NAME_CHARS,
  MAX_TASK_PROMPT_CHARS,
  createScheduledTask,
  deleteScheduledTask,
  fireDueScheduledTasks,
  getScheduledTask,
  listScheduledTasks,
  setTaskEnabled,
  type Cadence,
  type CreateTaskInput,
  type Deliver,
} from '../scheduler.js';

function parseTaskInput(body: Record<string, unknown>): CreateTaskInput {
  const cadence = body.cadence as Cadence;
  const deliver = (body.deliver ?? 'web') as Deliver;
  return {
    name: typeof body.name === 'string' ? body.name : '',
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    cadence,
    intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : undefined,
    timeOfDay: typeof body.timeOfDay === 'string' ? body.timeOfDay : undefined,
    weekday: typeof body.weekday === 'number' ? body.weekday : undefined,
    timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
    deliver,
  };
}

export function createScheduledTaskRoutes(deps: { db: Db } & Partial<AcceptDeps>): Router {
  const { db } = deps;
  const router = Router();

  router.post('/scheduled-tasks', async (req: Request, res: Response) => {
    try {
      const task = await createScheduledTask(db, parseTaskInput((req.body ?? {}) as Record<string, unknown>));
      res.status(201).json({ task });
    } catch (err) {
      res.status(400).json({ error: 'invalid_task', message: (err as Error).message });
    }
  });

  router.get('/scheduled-tasks', async (_req: Request, res: Response) => {
    res.json({ tasks: await listScheduledTasks(db) });
  });

  router.patch('/scheduled-tasks/:id', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled_required', message: 'enabled must be true or false' });
      return;
    }
    const updated = await setTaskEnabled(db, req.params.id, body.enabled);
    if (!updated) {
      res.status(404).json({ error: 'task_not_found', message: 'No scheduled task with that id' });
      return;
    }
    res.json({ task: await getScheduledTask(db, req.params.id) });
  });

  router.delete('/scheduled-tasks/:id', async (req: Request, res: Response) => {
    const deleted = await deleteScheduledTask(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'task_not_found', message: 'No scheduled task with that id' });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * Fire whatever is due right now. For an external cron (cron-job.org) that
   * wakes the free tier on a schedule — see DEPLOY.md. Authenticated like the
   * rest of /api; the access key rides in the x-access-key header.
   */
  router.post('/scheduled-tasks/tick', async (_req: Request, res: Response) => {
    if (!deps.executor || !deps.config) {
      res
        .status(503)
        .json({ error: 'scheduler_unavailable', message: 'The scheduler is not wired up' });
      return;
    }
    const summary = await fireDueScheduledTasks({
      db,
      executor: deps.executor,
      config: deps.config,
    });
    res.json(summary);
  });

  return router;
}

/** Limits the UI advertises so the form and the server agree. */
export const TASK_LIMITS = { MAX_TASK_NAME_CHARS, MAX_TASK_PROMPT_CHARS };
