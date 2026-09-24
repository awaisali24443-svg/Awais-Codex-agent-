/**
 * Feedback routes.
 *
 *   POST   /api/messages/:id/feedback   rate an answer (again, if it changed)
 *   DELETE /api/messages/:id/feedback   take the rating back
 *   GET    /api/feedback/summary        what has been said, and about what
 *
 * Everything the route does is described in words when it refuses: a rating
 * that could not be stored is worth knowing about, and "invalid request" would
 * tell the operator nothing while he is looking at an answer he disliked.
 */
import { Router, type Request, type Response } from 'express';

import type { Db } from '../db.js';
import { clearFeedback, feedbackSummary, saveFeedback } from '../feedback.js';

export interface FeedbackRouteDeps {
  db: Db;
}

export function createFeedbackRoutes({ db }: FeedbackRouteDeps): Router {
  const router = Router();

  router.post('/messages/:id/feedback', async (req: Request, res: Response) => {
    const result = await saveFeedback(db, {
      messageId: req.params.id,
      rating: req.body?.rating,
      reason: req.body?.reason,
      note: req.body?.note,
    });

    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 400;
      res.status(status).json({ error: result.reason, message: result.message });
      return;
    }

    res.json({ ok: true, feedback: result.feedback });
  });

  router.delete('/messages/:id/feedback', async (req: Request, res: Response) => {
    await clearFeedback(db, req.params.id);
    // Removing a rating that is not there is the state the caller wanted.
    res.json({ ok: true, feedback: null });
  });

  router.get('/feedback/summary', async (req: Request, res: Response) => {
    const limit = Number(req.query.limit);
    const summary = await feedbackSummary(db, Number.isFinite(limit) && limit > 0 ? limit : 5);
    res.json(summary);
  });

  return router;
}
