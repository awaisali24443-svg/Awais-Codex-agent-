import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { API_ENDPOINT, DEFAULT_ENGINE } from '../config.js';
import {
  getApiKey,
  getGeminiClient,
  callAntigravityWithRetry,
  extractOutputTextFromSteps
} from '../antigravity-client.js';
import { generateStandaloneApkBuffer } from '../apk-generator.js';
import { getServerCallBudget, incrementServerCallBudget } from '../call-budget-server.js';
import { injectMemoryIntoPrompt, extractAndStoreMemories } from '../memory-engine.js';

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

  // 1. Check if the file exists on local disk/workspace (Safe Sandbox Traversal Protection)
  if (requestedPath) {
    if (requestedPath.includes("..") || requestedPath.includes("\0")) {
      return res.status(403).json({ error: "Forbidden: Invalid file path." });
    }

    const forbiddenPatterns = [
      /\/etc\//i, /\/proc\//i, /\/sys\//i, /\/root\//i, /\/var\//i, /\/home\//i,
      /^\.env/i, /\.env$/i, /\.env\./i,
      /\.git/i, /\.npmrc/i, /whatsapp-config\.json/i, /whatsapp-agent-keys\.json/i
    ];
    if (forbiddenPatterns.some(p => p.test(requestedPath))) {
      return res.status(403).json({ error: "Forbidden: Access to system configuration files is denied." });
    }

    const normalizedPath = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(process.cwd(), requestedPath);

    const allowedWorkspace = path.resolve(process.cwd());
    const allowedTmp = path.resolve(os.tmpdir());

    const isInsideAllowed = normalizedPath.startsWith(allowedWorkspace) || normalizedPath.startsWith(allowedTmp);
    if (isInsideAllowed && fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isFile()) {
      const base = path.basename(normalizedPath);
      if (base.startsWith(".env") || base === ".npmrc" || base.includes("secret") || base.includes("keys.json")) {
        return res.status(403).json({ error: "Forbidden: Protected file." });
      }
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

        // Full archive snapshot (.tar)
        if (!requestedPath || filename.endsWith('.tar')) {
          res.setHeader('Content-Disposition', `attachment; filename="environment-${environmentId}.tar"`);
          res.setHeader('Content-Type', 'application/x-tar');
          return res.send(buffer);
        }

        // Extract and find requested file in snapshot tar
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-artifact-'));
        const tarPath = path.join(tempDir, 'snapshot.tar');
        fs.writeFileSync(tarPath, buffer);

        try {
          const extractDir = path.join(tempDir, 'extracted');
          fs.mkdirSync(extractDir, { recursive: true });
          execSync(`tar -xf "${tarPath}" -C "${extractDir}"`);

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

  // 3. Fallback: If it's an APK file, generate a valid standalone Android debug package with valid CRC32
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

// Helper to stream Gemini fallback when Antigravity engine is offline or unavailable
async function streamGeminiFallback(
  rawPrompt: string,
  augmentedPrompt: string,
  files: any[],
  apiKey: string,
  res: Response,
  abortSignal: AbortSignal
): Promise<void> {
  try {
    const ai = getGeminiClient(apiKey);
    const stepId = `step_fb_${Date.now()}`;
    const interactionId = `inter_fb_${Date.now()}`;

    // Send interaction created
    res.write(`event: interaction.created\ndata: ${JSON.stringify({
      interaction: { id: interactionId, status: 'in_progress' }
    })}\n\n`);

    // Send step start
    res.write(`event: step.start\ndata: ${JSON.stringify({
      step: { id: stepId, type: 'model_output', summary: 'Generating response with Gemini Engine...' },
      index: 0
    })}\n\n`);

    let fullOutput = '';
    const contentParts: any[] = [];
    if (augmentedPrompt) contentParts.push({ text: augmentedPrompt });

    if (files && files.length > 0) {
      files.forEach((f: any) => {
        if (f.base64 && f.type) {
          contentParts.push({
            inlineData: {
              data: f.base64,
              mimeType: f.type
            }
          });
        }
      });
    }

    const streamResult = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: contentParts.length > 0 ? contentParts : augmentedPrompt
    });

    for await (const chunk of streamResult) {
      if (abortSignal.aborted) break;
      const text = chunk.text || '';
      if (text) {
        fullOutput += text;
        res.write(`event: step.delta\ndata: ${JSON.stringify({
          index: 0,
          delta: { type: 'text', text }
        })}\n\n`);
        if (typeof (res as any).flush === 'function') (res as any).flush();
      }
    }

    // Step stop
    res.write(`event: step.stop\ndata: ${JSON.stringify({
      index: 0,
      step: { id: stepId, status: 'completed' }
    })}\n\n`);

    // Interaction completed
    res.write(`event: interaction.completed\ndata: ${JSON.stringify({
      interaction: {
        id: interactionId,
        status: 'completed',
        output_text: fullOutput,
        steps: [
          { id: stepId, type: 'model_output', summary: 'Completed', text: fullOutput }
        ]
      }
    })}\n\n`);

    res.write(`event: done\ndata: [DONE]\n\n`);
    res.end();

    // Trigger persistent memory extraction in background
    extractAndStoreMemories(rawPrompt, fullOutput, apiKey, 'web').catch(() => {});
  } catch (err: any) {
    console.error('Gemini fallback stream error:', err);
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'agent_unavailable',
      message: `Execution failed: ${err?.message || 'Gemini model error'}`
    })}\n\n`);
    res.end();
  }
}

// Real-time SSE streaming endpoint with Persistent Memory & Antigravity/Gemini Failover
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

  // 1. Inject within-session dialogue memory
  const contextualPrompt = buildContextualPrompt(rawPrompt, history);
  // 2. Augment with cross-session persistent agent memory
  const augmentedPrompt = contextualPrompt ? injectMemoryIntoPrompt(contextualPrompt) : '';

  let inputPayload: any = augmentedPrompt || contextualPrompt;
  if (files && files.length > 0) {
    const parts: any[] = [];
    if (augmentedPrompt) parts.push({ type: 'text', text: augmentedPrompt });
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

    if (!upstreamRes.ok) {
      const errData = await upstreamRes.json().catch(() => ({}));
      const statusCode = upstreamRes.status;
      const rawMsg = errData.error?.message || errData.message || `HTTP ${statusCode}`;

      // If Antigravity interactions endpoint returns 404, 400, or model unavailable, seamlessly fallback to Gemini
      if (statusCode === 404 || statusCode === 400 || rawMsg.toLowerCase().includes('not found') || rawMsg.toLowerCase().includes('invalid')) {
        console.log(`[Stream Task] Antigravity endpoint returned HTTP ${statusCode}. Falling back to Gemini model with Persistent Memory...`);
        clearInterval(keepAliveInterval);
        incrementServerCallBudget('website');
        return streamGeminiFallback(rawPrompt, augmentedPrompt, files, apiKey, res, abortController.signal);
      }

      clearInterval(keepAliveInterval);
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
      return streamGeminiFallback(rawPrompt, augmentedPrompt, files, apiKey, res, abortController.signal);
    }

    incrementServerCallBudget('website');

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let accumulatedOutput = '';

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

          if (delta.text) accumulatedOutput += delta.text;

          // Ensure output_text is populated on completion
          if (eventType === 'interaction.completed' && eventData.interaction) {
            const inter = eventData.interaction;
            if (!inter.output_text && Array.isArray(inter.steps)) {
              const extracted = extractOutputTextFromSteps(inter.steps);
              if (extracted) inter.output_text = extracted;
            }
            if (inter.output_text) accumulatedOutput = inter.output_text;

            // Trigger background persistent memory extraction
            extractAndStoreMemories(rawPrompt, accumulatedOutput, apiKey, 'web').catch(() => {});
          }

          res.write(`event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`);
          if (typeof (res as any).flush === 'function') (res as any).flush();
          continue;
        } catch (_) {}

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
    console.error('Antigravity streaming error, checking fallback:', err);
    try {
      return streamGeminiFallback(rawPrompt, augmentedPrompt, files, apiKey, res, abortController.signal);
    } catch (_) {
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'agent_unavailable',
        message: `Antigravity model is not available: ${err?.message || 'Stream connection dropped'}`
      })}\n\n`);
      res.end();
    }
  }
});

// Task execution endpoint with Persistent Memory
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

  // 1. Contextual within-session history
  const contextualPrompt = buildContextualPrompt(rawPrompt, history);
  // 2. Cross-session persistent memory
  const augmentedPrompt = contextualPrompt ? injectMemoryIntoPrompt(contextualPrompt) : '';

  let inputPayload: any = augmentedPrompt || contextualPrompt;
  if (files && files.length > 0) {
    const parts: any[] = [];
    if (augmentedPrompt) parts.push({ type: 'text', text: augmentedPrompt });
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

    // Fallback to direct Gemini generation if Antigravity endpoint 404/400
    if (statusCode === 404 || statusCode === 400 || rawMessage.toLowerCase().includes('not found')) {
      console.log(`[Execute Task] Antigravity unavailable (${statusCode}), executing via Gemini fallback...`);
      const ai = getGeminiClient(apiKey);
      const genRes = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: augmentedPrompt || contextualPrompt
      });
      const outputText = genRes.text || 'Task processed successfully by Awais Codex.';
      incrementServerCallBudget('website');

      // Trigger memory extraction in background
      extractAndStoreMemories(rawPrompt, outputText, apiKey, 'web').catch(() => {});

      return res.json({
        mode: 'gemini-fallback',
        engine: 'gemini-2.5-flash',
        id: `gemini_exec_${Date.now()}`,
        status: 'completed',
        output_text: outputText,
        steps: [
          { type: 'model_output', text: outputText, summary: 'Generated solution with Gemini' }
        ]
      });
    }

    console.warn(`Antigravity model returned error (${statusCode}):`, rawMessage);
    return res.status(statusCode).json({
      error: {
        type: 'antigravity_unavailable',
        message: `Antigravity model is not available: ${rawMessage}`,
        status: statusCode
      }
    });
  } catch (err: any) {
    // Fallback to Gemini if connection failed
    try {
      console.log('[Execute Task] Connection failed, attempting Gemini fallback...');
      const ai = getGeminiClient(apiKey);
      const genRes = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: augmentedPrompt || contextualPrompt
      });
      const outputText = genRes.text || 'Task processed successfully by Awais Codex.';
      incrementServerCallBudget('website');

      extractAndStoreMemories(rawPrompt, outputText, apiKey, 'web').catch(() => {});

      return res.json({
        mode: 'gemini-fallback',
        engine: 'gemini-2.5-flash',
        id: `gemini_exec_${Date.now()}`,
        status: 'completed',
        output_text: outputText,
        steps: [
          { type: 'model_output', text: outputText, summary: 'Generated solution with Gemini' }
        ]
      });
    } catch (_) {}

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
