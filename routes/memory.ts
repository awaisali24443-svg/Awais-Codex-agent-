import { Router, Request, Response } from 'express';
import {
  loadMemoryStore,
  addMemoryItem,
  updateMemoryItem,
  deleteMemoryItem,
  updateUserProfile,
  clearAllMemories,
  retrieveRelevantMemories,
  MemoryCategory
} from '../memory-engine.js';

const router = Router();

// GET all memories & profile
router.get('/', (req: Request, res: Response) => {
  const store = loadMemoryStore();
  res.json({
    success: true,
    count: store.memories.length,
    profile: store.profile,
    memories: store.memories
  });
});

// POST add memory manually
router.post('/', async (req: Request, res: Response) => {
  try {
    const { category, content, key, tags } = req.body || {};
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Memory content is required' });
    }

    const validCategories: MemoryCategory[] = ['preference', 'fact', 'project', 'instruction', 'learning'];
    const assignedCategory = validCategories.includes(category) ? category : 'fact';

    const memory = await addMemoryItem({
      category: assignedCategory,
      content: content.trim(),
      key: typeof key === 'string' ? key.trim() : undefined,
      source: 'manual',
      tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean) : []
    });

    res.json({ success: true, memory });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to add memory' });
  }
});

// PUT update memory by ID
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { category, content, key, tags } = req.body || {};
    const updated = await updateMemoryItem(id, {
      category,
      content,
      key,
      tags
    });

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Memory item not found' });
    }

    res.json({ success: true, memory: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to update memory' });
  }
});

// DELETE memory by ID
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = await deleteMemoryItem(id);
    res.json({ success: true, deleted });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to delete memory' });
  }
});

// PUT update user profile
router.put('/profile/update', async (req: Request, res: Response) => {
  try {
    const profile = await updateUserProfile(req.body || {});
    res.json({ success: true, profile });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to update user profile' });
  }
});

// POST clear all memories
router.post('/clear', async (req: Request, res: Response) => {
  try {
    await clearAllMemories();
    const fresh = loadMemoryStore();
    res.json({ success: true, message: 'All memories cleared', store: fresh });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to clear memories' });
  }
});

// POST search relevant memories
router.post('/search', (req: Request, res: Response) => {
  const query = req.body?.query || req.body?.prompt || '';
  const limit = typeof req.body?.limit === 'number' ? req.body.limit : 8;
  const results = retrieveRelevantMemories(String(query), limit);
  res.json({ success: true, count: results.length, results });
});

export default router;
