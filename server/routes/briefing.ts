/** Read-only: GET /api/briefing. Nothing here schedules or sends anything. */
import { Router, type Request, type Response } from 'express';

import type { Db } from '../db.js';
import { getBriefing } from '../briefing.js';

export function createBriefingRoutes(deps: { db: Db }): Router {
  const { db } = deps;
  const router = Router();

  router.get('/briefing', async (req: Request, res: Response) => {
    const hours = Number(req.query.hours ?? 12);
    const windowHours = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 168) : 12;
    res.json({ briefing: await getBriefing(db, windowHours) });
  });

  return router;
}
