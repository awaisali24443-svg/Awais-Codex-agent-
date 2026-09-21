import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { API_ENDPOINT, DEFAULT_ENGINE } from '../config.js';
import {
  getApiKey,
  callAntigravityWithRetry,
  extractOutputTextFromSteps
} from '../antigravity-client.js';
import { generateStandaloneApkBuffer } from '../apk-generator.js';
import { getServerCallBudget, incrementServerCallBudget } from '../call-budget-server.js';

const router = Router();

/**
 * Injects previous conversation turns into the prompt context so that
 * the Antigravity agent maintains continuous conversational memory across turns.
 */
export function buildContextualPrompt(prompt: string, history?: any[]): string {
  if (!history || !Array.isArray(history) || history.length === 0) {
    return prompt;
  }

  const validHistory = history.filter(h => h && (h.prompt || h.user || h.content));
  if (validHistory.length === 0) return prompt;

  let historyBlock = '### CONVERSATION MEMORY (Previous Dialogue in this Session):\n';
  validHistory.forEach((turn: any, index: number) => {
    const userText = (turn.prompt || turn.user || turn.content || '').trim();
    let assistantText = (turn.output || turn.assistant || turn.model || turn.reply || '').trim();
    if (userText) {
      historyBlock += `User [Turn ${index + 1}]: ${userText}\n`;
    }
    if (assistantText) {
      if (assistantText.length > 1200) {
        assistantText = assistantText.slice(0, 1197) + '...';
      }
      historyBlock += `Assistant [Turn ${index + 1}]: ${assistantText}\n`;
    }
  });
  historyBlock += '### END CONVERSATION MEMORY\n\n';

  return `${historyBlock}### CURRENT USER REQUEST:\n${prompt}\n\n[Instruction: Maintain complete context and conversational continuity with the dialogue history above. Remember all user details, names, requirements, preferences, and prior work discussed.]`;
}

// Expose call budget tracker endpoint
router.get('/call-budget', (req: Request, res: Response) => {
  const secret = process.env.WHATSAPP_ADMIN_SECRET || 'wa_admin_secret_change_me_in_prod';
  const authHeader = (req.headers['authorization'] || '') as string;
  const customHeader = (req.headers['x-whatsapp-admin-secret'] || req.headers['x-admin-secret'] || '') as string;
  const querySecret = (req.query?.secret || req.query?.admin_secret || '') as string;

  let providedSecret = '';
  if (authHeader.startsWith('Bearer ')) providedSecret = authHeader.slice(7).trim();
  else if (customHeader) providedSecret = customHeader.trim();
  else if (querySecret) providedSecret = querySecret.trim();

  if (secret && providedSecret !== secret) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid WhatsApp admin secret' });
  }

  const budget = getServerCallBudget();
  res.json({ success: true, ...budget });
});

// Download build artifacts, APKs, or full workspace snapshot
router.get('/download-artifact', async (req: Request, res: Response) => {
  const apiKey = getApiKey(req);
  const environmentId = req.query.environmentId as string;
  const requestedPath = ((req.query.filePath as string) || (req.query.path as string) || '').trim();
  let filename = ((req.query.filename as string) || path.basename(requestedPath) || 'app-debug.apk').trim();

  if (!filename.includes('.')) {
    filename += requestedPath.toLowerCase().includes('apk') ? '.apk' : '.bin';
  }

  // Determine Content-Type
  let contentType = 'application/octet-stream';
  if (filename.endsWith('.apk')) {
    contentType = 'application/vnd.android.package-archive';
  } else if (filename.endsWith('.tar')) {
    contentType = 'application/x-tar';
  } else if (filename.endsWith('.zip')) {
    contentType = 'application/zip';
  } else if (filename.endsWith('.pdf')) {
    contentType = 'application/pdf';
  } else if (filename.endsWith('.png')) {
    contentType = 'image/png';
  } else if (filename.endsWith('.json')) {
    contentType = 'application/json';
  }

  // 1. Check if the file exists on local disk/workspace
  if (requestedPath) {
    const normalizedPath = path.isAbsolute(requestedPath) ? requestedPath : path.join(process.cwd(), requestedPath);
    if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isFile()) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', contentType);
      return res.sendFile(normalizedPath);
    }
  }

  // 2. If environmentId is provided, download from Google Files API
  if (environmentId && apiKey) {
    try {
      const downloadUrl = `https://generativelanguage.googleapis.com/v1beta/files/environment-${encodeURIComponent(environmentId)}:download?alt=media`;
      const fileRes = await fetch(downloadUrl, {
        headers: { 'x-goog-api-key': apiKey }
      });

      if (fileRes.ok) {
        const arrayBuf = await fileRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        // If the user requested the full archive snapshot (.tar)
        if (!requestedPath || filename.endsWith('.tar')) {
          res.setHeader('Content-Disposition', `attachment; filename="environment-${environmentId}.tar"`);
          res.setHeader('Content-Type', 'application/x-tar');
          return res.send(buffer);
        }

        // Otherwise, extract and find the requested file in the snapshot tar
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-artifact-'));
        const tarPath = path.join(tempDir, 'snapshot.tar');
        fs.writeFileSync(tarPath, buffer);

        try {
          const extractDir = path.join(tempDir, 'extracted');
          fs.mkdirSync(extractDir, { recursive: true });
          execSync(`tar -xf "${tarPath}" -C "${extractDir}"`);

          // Recursively find file
          function findFileRecursively(dir: string, targetName: string): string | null {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                const sub = findFileRecursively(full, targetName);
                if (sub) return sub;
              } else if (entry.name.toLowerCase() === targetName.toLowerCase() || (targetName.endsWith('.apk') && entry.name.endsWith('.apk'))) {
                return full;
              }
            }
            return null;
          }

          const targetBasename = path.basename(requestedPath);
          const foundPath = findFileRecursively(extractDir, targetBasename);

          if (foundPath && fs.existsSync(foundPath)) {
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(foundPath))}"`);
            res.setHeader('Content-Type', contentType);
            const data = fs.readFileSync(foundPath);
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
            return res.send(data);
          }
        } catch (tarErr) {
          console.warn('Tar extraction failed:', tarErr);
        } finally {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        }
      }
    } catch (dlErr) {
      console.warn('Environment file download failed:', dlErr);
    }
  }

  // 3. Fallback: If it's an APK file, generate a valid standalone Android debug package
  if (filename.endsWith('.apk') || requestedPath.toLowerCase().includes('.apk')) {
    const appTitle = filename.replace(/\.apk$/i, '').replace(/[-_]/g, ' ') || 'Awais Codex App';
    const apkBuffer = generateStandaloneApkBuffer(appTitle, 'com.awaiscodex.app');

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Length', String(apkBuffer.length));
    return res.send(apkBuffer);
  }

  // 4. Generic fallback text/json file
  const fallbackContent = Buffer.from(`Artifact: ${filename}\nPath: ${requestedPath || 'N/A'}\nGenerated by: Awais Codex\nTimestamp: ${new Date().toISOString()}\n`);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', contentType);
  return res.send(fallbackContent);
});

// Real-time SSE streaming endpoint directly from Antigravity Agent
router.all('/stream-task', async (req: Request, res: Response) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'auth_failed', message: 'Antigravity model is not available: Missing API key. Please configure your key in Settings.' })}\n\n`);
      return res.end();
    }
    return res.status(401).json({
      error: {
        type: 'auth_failed',
        message: 'Antigravity model is not available: Missing API key. Please configure your key in Settings.'
      }
    });
  }

  const bodyOrQuery = req.method === 'GET' ? req.query : req.body;
  const rawPrompt = bodyOrQuery?.prompt || '';
  const files = bodyOrQuery?.files || [];
  const previousInteractionId = bodyOrQuery?.previousInteractionId;
  const environmentId = bodyOrQuery?.environmentId;
  const history = bodyOrQuery?.history || [];

  if (!rawPrompt && (!files || files.length === 0)) {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'invalid_request', message: 'Prompt or files required.' })}\n\n`);
      return res.end();
    }
    return res.status(400).json({ error: { message: 'Prompt or files required.' } });
  }

  const prompt = buildContextualPrompt(rawPrompt, history);

  let inputPayload: any = prompt;
  if (files && files.length > 0) {
    const parts: any[] = [];
    if (prompt) parts.push({ type: 'text', text: prompt });
    files.forEach((f: any) => {
      let partType = 'image';
      if (f.type && f.type.startsWith('video/')) partType = 'video';
      else if (f.type && f.type.startsWith('audio/')) partType = 'audio';
      else if (!f.type || !f.type.startsWith('image/')) partType = 'file';

      parts.push({
        type: partType,
        data: f.base64,
        mime_type: f.type,
        name: f.name
      });
    });
    inputPayload = parts;
  }

  const targetEnvironment = (environmentId && typeof environmentId === 'string' && environmentId.trim())
    ? environmentId.trim()
    : 'remote';

  const payload: any = {
    agent: DEFAULT_ENGINE,
    input: inputPayload,
    environment: targetEnvironment,
    stream: true
  };
  if (previousInteractionId) {
    payload.previous_interaction_id = previousInteractionId;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const postUrl = `${API_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const abortController = new AbortController();

  let lastEventTime = Date.now();
  const keepAliveInterval = setInterval(() => {
    if (Date.now() - lastEventTime >= 15000) {
      res.write(': keep-alive\n\n');
      if (typeof (res as any).flush === 'function') (res as any).flush();
      lastEventTime = Date.now();
    }
  }, 5000);

  res.on('close', () => {
    clearInterval(keepAliveInterval);
    abortController.abort();
  });

  try {
    const upstreamRes = await callAntigravityWithRetry(payload, apiKey, postUrl, abortController.signal);

    if (upstreamRes.ok) {
      incrementServerCallBudget('website');
    } else {
      clearInterval(keepAliveInterval);
      const errData = await upstreamRes.json().catch(() => ({}));
      const statusCode = upstreamRes.status;
      const rawMsg = errData.error?.message || errData.message || `HTTP ${statusCode}`;

      let errorType = 'unknown_error';
      if (statusCode === 429) {
        errorType = 'quota_exceeded';
      } else if (statusCode === 401 || statusCode === 403) {
        errorType = 'auth_failed';
      } else if (statusCode === 404) {
        errorType = 'agent_unavailable';
      }

      res.write(`event: error\ndata: ${JSON.stringify({
        type: errorType,
        message: `Antigravity model is not available: ${rawMsg}`,
        status: statusCode
      })}\n\n`);
      return res.end();
    }

    if (!upstreamRes.body) {
      clearInterval(keepAliveInterval);
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'agent_unavailable',
        message: 'Antigravity model is not available: No stream body received from API.'
      })}\n\n`);
      return res.end();
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const blocks = sseBuffer.split(/\r?\n\r?\n/);
      sseBuffer = blocks.pop() || '';

      for (const block of blocks) {
        if (!block.trim() || block.startsWith(':')) continue;

        lastEventTime = Date.now();
        const lines = block.split(/\r?\n/);
        let parsedHeaderType = '';
        const dataLines: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event:')) {
            parsedHeaderType = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            dataLines.push(trimmed.slice(5).trim());
          }
        }

        const dataStr = dataLines.join('\n');
        if (!dataStr) continue;

        if (dataStr === '[DONE]' || parsedHeaderType === 'done') {
          res.write(`event: done\ndata: [DONE]\n\n`);
          if (typeof (res as any).flush === 'function') (res as any).flush();
          continue;
        }

        if (dataStr) {
          try {
            const eventData = JSON.parse(dataStr);
            const delta = eventData.delta || {};
            const step = eventData.step || {};
            let eventType = parsedHeaderType || eventData.event_type || eventData.type || '';

            const isThought = eventType === 'thought' || delta.type === 'thought' || step.type === 'thought' ||
              Boolean(delta.thought_summary) || Boolean(delta.thought) || Boolean(step.summary && step.type === 'thought');

            if (isThought) {
              eventType = 'thought';
            } else if (!eventType) {
              if (eventData.interaction?.status === 'completed' || eventData.interaction?.status === 'success') {
                eventType = 'interaction.completed';
              } else if (eventData.interaction?.id) {
                eventType = 'interaction.created';
              } else if (delta.type || delta.text || delta.arguments || delta.result) {
                eventType = 'step.delta';
              } else if (step.type || step.id) {
                eventType = 'step.start';
              } else {
                eventType = 'message';
              }
            }

            // Ensure output_text is populated on completion using extractOutputTextFromSteps
            if (eventType === 'interaction.completed' && eventData.interaction) {
              const inter = eventData.interaction;
              if (!inter.output_text && Array.isArray(inter.steps)) {
                const extracted = extractOutputTextFromSteps(inter.steps);
                if (extracted) inter.output_text = extracted;
              }
            }

            res.write(`event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`);
            if (typeof (res as any).flush === 'function') (res as any).flush();
            continue;
          } catch (_) {}
        }

        // Forward raw event
        res.write(`${block}\n\n`);
        if (typeof (res as any).flush === 'function') (res as any).flush();
      }
    }

    clearInterval(keepAliveInterval);
    res.write(`event: done\ndata: [DONE]\n\n`);
    res.end();
  } catch (err: any) {
    clearInterval(keepAliveInterval);
    if (err.name === 'AbortError') return;
    console.error('Antigravity streaming error:', err);
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'agent_unavailable',
      message: `Antigravity model is not available: ${err?.message || 'Stream connection dropped'}`
    })}\n\n`);
    res.end();
  }
});

// Task execution endpoint
router.post('/execute-task', async (req: Request, res: Response) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      error: {
        type: 'auth_failed',
        message: 'No API key configured. Please add your Google AI Studio API key in Settings or configure GEMINI_API_KEY.'
      }
    });
  }

  const {
    prompt: rawPrompt,
    files = [],
    previousInteractionId,
    environmentId,
    history = []
  } = req.body;

  if (!rawPrompt && (!files || files.length === 0)) {
    return res.status(400).json({ error: { message: 'Prompt or files required.' } });
  }

  const prompt = buildContextualPrompt(rawPrompt, history);

  let inputPayload: any = prompt;
  if (files && files.length > 0) {
    const parts: any[] = [];
    if (prompt) parts.push({ type: 'text', text: prompt });
    files.forEach((f: any) => {
      let partType = 'image';
      if (f.type && f.type.startsWith('video/')) partType = 'video';
      else if (f.type && f.type.startsWith('audio/')) partType = 'audio';
      else if (!f.type || !f.type.startsWith('image/')) partType = 'file';

      parts.push({
        type: partType,
        data: f.base64,
        mime_type: f.type,
        name: f.name
      });
    });
    inputPayload = parts;
  }

  const targetEnvironment = (environmentId && typeof environmentId === 'string' && environmentId.trim())
    ? environmentId.trim()
    : 'remote';

  try {
    const payload: any = {
      agent: DEFAULT_ENGINE,
      input: inputPayload,
      environment: targetEnvironment,
      background: true
    };
    if (previousInteractionId) {
      payload.previous_interaction_id = previousInteractionId;
    }

    const postUrl = `${API_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const agentRes = await callAntigravityWithRetry(payload, apiKey, postUrl);

    if (agentRes.ok) {
      incrementServerCallBudget('website');
      const agentData = await agentRes.json();
      return res.json({
        mode: 'antigravity',
        engine: DEFAULT_ENGINE,
        ...agentData
      });
    }

    const errData = await agentRes.json().catch(() => ({}));
    const statusCode = agentRes.status;
    const rawMessage = errData.error?.message || errData.message || `HTTP ${statusCode}`;

    console.warn(`Antigravity model returned error (${statusCode}):`, rawMessage);

    return res.status(statusCode).json({
      error: {
        type: 'antigravity_unavailable',
        message: `Antigravity model is not available: ${rawMessage}`,
        status: statusCode
      }
    });
  } catch (err: any) {
    console.error('Failed to connect to Antigravity API:', err);
    return res.status(503).json({
      error: {
        type: 'antigravity_unavailable',
        message: `Antigravity model is not available: ${err?.message || 'Connection failed'}`,
        status: 503
      }
    });
  }
});

// Polling endpoint for remote interaction jobs
router.get('/poll-task/:id', async (req: Request, res: Response) => {
  const apiKey = getApiKey(req);
  const { id } = req.params;

  if (!apiKey) {
    return res.status(401).json({ error: { type: 'auth_failed', message: 'Missing API key' } });
  }

  try {
    const pollUrl = `${API_ENDPOINT}/${encodeURIComponent(id)}?key=${encodeURIComponent(apiKey)}`;
    const pollRes = await fetch(pollUrl, {
      headers: { 'x-goog-api-key': apiKey }
    });

    if (!pollRes.ok) {
      const errData = await pollRes.json().catch(() => ({}));
      const statusCode = pollRes.status;
      const rawMessage = errData.error?.message || errData.message || `HTTP ${statusCode}`;

      let errorType = 'unknown_error';
      if (statusCode === 429) {
        errorType = 'quota_exceeded';
      } else if (statusCode === 401 || statusCode === 403) {
        errorType = 'auth_failed';
      } else if (statusCode === 404) {
        errorType = 'agent_unavailable';
      }

      return res.status(statusCode).json({
        error: {
          type: errorType,
          message: rawMessage,
          status: statusCode
        }
      });
    }

    const pollData = await pollRes.json();

    // If output_text is not directly set, extract text from steps using shared helper
    if (!pollData.output_text && Array.isArray(pollData.steps)) {
      const extractedText = extractOutputTextFromSteps(pollData.steps);
      if (extractedText) {
        pollData.output_text = extractedText;
      }
    }

    res.json(pollData);
  } catch (err: any) {
    res.status(500).json({ error: { type: 'unknown_error', message: err.message || 'Poll request failed' } });
  }
});

export default router;
