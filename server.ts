import express, { Request, Response } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { PORT } from './config.js';
import healthRouter from './routes/health.js';
import staticRouter from './routes/static.js';
import tasksRouter from './routes/tasks.js';
import githubRouter from './routes/github.js';
import whatsappRouter from './routes/whatsapp.js';

// Configure global HTTP proxy dispatcher for undici / native fetch in proxy environments
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
  try {
    const proxyAgent = new EnvHttpProxyAgent();
    setGlobalDispatcher(proxyAgent);
    console.log('[Network] Configured undici EnvHttpProxyAgent for global outbound proxy support.');
  } catch (err) {
    console.warn('[Network] Could not set global proxy dispatcher:', err);
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    }
  }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // API Routes
  app.use('/api', healthRouter);
  app.use('/api', tasksRouter);

  // WhatsApp Gateway routes & webhook aliases
  app.use('/api/whatsapp', whatsappRouter);
  app.use('/whatsapp', whatsappRouter);
  app.use('/webhook', whatsappRouter);
  app.use('/api/webhook', whatsappRouter);
  app.use('/v1', whatsappRouter);

  app.use(githubRouter);

  // Static files & PWA manifests
  app.use('/', staticRouter);

  // Serve public assets explicitly
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Vite development middleware or static production serving
  if (process.env.NODE_ENV !== 'production') {
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Awais Codex server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
