/**
 * Reminder routes. Creating a reminder never fires anything by itself — the
 * scheduler that watches the table only exists when REMINDERS_ENABLED=true.
 * Routes are thin: parse, validate, delegate, respond.
 */
import { Router, type Request, type Response } from 'express';

import type { Db } from '../db.js';
import {
  MAX_REMINDER_CHARS,
  cancelReminder,
  createReminder,
  listReminders,
} from '../reminders.js';

export function createReminderRoutes(deps: { db: Db }): Router {
  const { db } = deps;
  const router = Router();

  router.post('/reminders', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { text?: unknown; runAt?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const runAt = typeof body.runAt === 'string' ? new Date(body.runAt) : new Date(NaN);

    if (!text) {
      res.status(400).json({ error: 'text_required', message: 'text must be a non-empty string' });
      return;
    }
    if (text.length > MAX_REMINDER_CHARS) {
      res.status(413).json({
        error: 'text_too_long',
        message: `text is ${text.length} characters; the limit is ${MAX_REMINDER_CHARS}`,
      });
      return;
    }
    if (Number.isNaN(runAt.getTime())) {
      res.status(400).json({ error: 'runAt_invalid', message: 'runAt must be an ISO date string' });
      return;
    }

    try {
      const reminder = await createReminder(db, text, runAt);
      res.status(201).json({ reminder });
    } catch (err) {
      res.status(400).json({ error: 'invalid_reminder', message: (err as Error).message });
    }
  });

  router.get('/reminders', async (req: Request, res: Response) => {
    const all = req.query.all === 'true' || req.query.all === '1';
    res.json({ reminders: await listReminders(db, all) });
  });

  router.delete('/reminders/:id', async (req: Request, res: Response) => {
    const cancelled = await cancelReminder(db, req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: 'reminder_not_found', message: 'No pending reminder with that id' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
