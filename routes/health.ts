import { Router, Request, Response } from 'express';
import { DEFAULT_ENGINE, ENGINE_NAME } from '../config.js';

const router = Router();

// Health check endpoint (Strictly Antigravity Agent & Gemini)
router.get('/health', (req: Request, res: Response) => {
  const hasEnvKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  res.json({
    status: 'ok',
    hasEnvKey,
    hasApiKey: hasEnvKey,
    memorySystem: 'active',
    defaultEngine: DEFAULT_ENGINE,
    engineName: ENGINE_NAME,
    supportedEngines: [
      { id: DEFAULT_ENGINE, name: ENGINE_NAME, recommended: true }
    ]
  });
});

export default router;
