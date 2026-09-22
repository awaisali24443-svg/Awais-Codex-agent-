/**
 * Memory routes — what the operator can see and correct.
 *
 * Recall and learning happen automatically inside every mission; these
 * endpoints exist so the store is never a black box. Anything the agent
 * remembers can be read, corrected and deleted here, which is the difference
 * between a feature and a haunting.
 *
 * All of it is behind `requireSession` (mounted in app.ts), so the only caller
 * is the operator.
 */
import { Router, type Request, type Response } from 'express';

import type { Db } from '../db.js';
import {
  MEMORY_CATEGORIES,
  addMemory,
  clearMemories,
  countMemories,
  deleteMemory,
  getProfile,
  isMemoryCategory,
  isMemorySource,
  listMemories,
  recallMemories,
  updateMemory,
  updateProfile,
  type ProfilePatch,
} from '../memory.js';

export interface MemoryRouteDeps {
  db: Db;
}

const MAX_CONTENT_CHARS = 1_000;

export function createMemoryRoutes({ db }: MemoryRouteDeps): Router {
  const router = Router();

  // ---- read ---------------------------------------------------------------

  router.get('/memory', async (_req: Request, res: Response) => {
    const [profile, memories, total] = await Promise.all([
      getProfile(db),
      listMemories(db, 200),
      countMemories(db),
    ]);
    res.json({ profile, memories, total, categories: MEMORY_CATEGORIES });
  });

  /**
   * Ranked recall for a prompt, without storing anything or bumping usage.
   * Useful for answering "why did it think that?" before sending a mission.
   */
  router.post('/memory/search', async (req: Request, res: Response) => {
    const prompt = (req.body as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt_required', message: 'prompt must be a non-empty string' });
      return;
    }
    const limit = Number((req.body as { limit?: unknown }).limit ?? 8);
    const memories = await recallMemories(db, prompt, {
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 25) : 8,
      track: false,
    });
    res.json({ memories });
  });

  // ---- write --------------------------------------------------------------

  router.post('/memory', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      category?: unknown;
      content?: unknown;
      key?: unknown;
      tags?: unknown;
      source?: unknown;
    };

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      res.status(400).json({ error: 'content_required', message: 'content must be a non-empty string' });
      return;
    }
    if (content.length > MAX_CONTENT_CHARS) {
      res.status(413).json({
        error: 'content_too_long',
        message: `content is ${content.length} characters; the limit is ${MAX_CONTENT_CHARS}`,
      });
      return;
    }
    if (body.category !== undefined && !isMemoryCategory(body.category)) {
      res.status(400).json({
        error: 'bad_category',
        message: `category must be one of: ${MEMORY_CATEGORIES.join(', ')}`,
      });
      return;
    }

    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string')
      : undefined;

    const { item, created } = await addMemory(db, {
      category: isMemoryCategory(body.category) ? body.category : 'fact',
      content,
      key: typeof body.key === 'string' ? body.key : null,
      // A hand-written memory is `manual` unless the caller says otherwise.
      source: isMemorySource(body.source) ? body.source : 'manual',
      tags,
    });

    res.status(created ? 201 : 200).json({ memory: item, created });
  });

  router.put('/memory/:id', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      category?: unknown;
      content?: unknown;
      key?: unknown;
      tags?: unknown;
    };

    if (body.category !== undefined && !isMemoryCategory(body.category)) {
      res.status(400).json({
        error: 'bad_category',
        message: `category must be one of: ${MEMORY_CATEGORIES.join(', ')}`,
      });
      return;
    }

    const item = await updateMemory(db, req.params.id, {
      ...(isMemoryCategory(body.category) ? { category: body.category } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'key')
        ? { key: typeof body.key === 'string' ? body.key : null }
        : {}),
      ...(Array.isArray(body.tags)
        ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') }
        : {}),
    });

    if (!item) {
      res.status(404).json({ error: 'memory_not_found' });
      return;
    }
    res.json({ memory: item });
  });

  router.delete('/memory/:id', async (req: Request, res: Response) => {
    const deleted = await deleteMemory(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'memory_not_found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/memory/clear', async (_req: Request, res: Response) => {
    const removed = await clearMemories(db);
    console.log(`[memory] cleared ${removed} item(s) on request`);
    res.json({ ok: true, removed });
  });

  // ---- profile ------------------------------------------------------------

  router.get('/memory/profile', async (_req: Request, res: Response) => {
    res.json({ profile: await getProfile(db) });
  });

  router.put('/memory/profile', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : undefined;

    const patch: ProfilePatch = {};
    if ('name' in body) patch.name = typeof body.name === 'string' ? body.name : null;
    if ('role' in body) patch.role = typeof body.role === 'string' ? body.role : null;
    if ('preferredLanguage' in body) {
      patch.preferredLanguage =
        typeof body.preferredLanguage === 'string' ? body.preferredLanguage : null;
    }
    if ('environment' in body) {
      patch.environment = typeof body.environment === 'string' ? body.environment : null;
    }
    const frameworks = strings(body.preferredFrameworks);
    if (frameworks) patch.preferredFrameworks = frameworks;
    const directives = strings(body.customDirectives);
    if (directives) patch.customDirectives = directives;
    if (body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes)) {
      patch.attributes = body.attributes as Record<string, unknown>;
    }

    res.json({ profile: await updateProfile(db, patch) });
  });

  return router;
}
