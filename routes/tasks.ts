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
import { getServerCallBudget, incrementServerCallBudget } from '../call-budget-server.js';
import { injectMemoryIntoPrompt, extractAndStoreMemories } from '../memory-engine.js';

const router = Router();

export interface NormalizedMissionActivity {
  phase: 'planning' | 'scaffolding' | 'implementation' | 'build' | 'verification' | 'general';
  title: string;
  detail?: string;
  toolName?: string;
  status: 'running' | 'completed' | 'failed';
  artifact?: string;
}

/**
 * Normalizes low-level Antigravity steps and tool calls into observable, high-level mission activity cards.
 */
export function normalizeMissionActivity(eventData: any, eventType: string): NormalizedMissionActivity | null {
  const step = eventData.step || {};
  const delta = eventData.delta || {};
  const toolCall = step.tool_calls?.[0] || delta.tool_calls?.[0] || null;

  if (toolCall) {
    const name = toolCall.name || '';
    const args = toolCall.arguments || {};
    const targetFile = args.TargetFile || args.path || args.filename || '';
    const command = args.command || args.cmd || '';

    if (name === 'create_file') {
      return {
        phase: 'implementation',
        title: targetFile ? `Creating ${path.basename(targetFile)}` : 'Creating source file',
        detail: targetFile || undefined,
        toolName: name,
        status: step.status === 'completed' ? 'completed' : 'running'
      };
    }

    if (name === 'edit_file' || name === 'replace_file_content') {
      return {
        phase: 'implementation',
        title: targetFile ? `Updating ${path.basename(targetFile)}` : 'Modifying source code',
        detail: targetFile || undefined,
        toolName: name,
        status: step.status === 'completed' ? 'completed' : 'running'
      };
    }

    if (name === 'run_command' || name === 'bash') {
      const isBuild = /gradle|mvn|build|cargo|cmake|assemble/i.test(command);
      const isTest = /test|pytest|jest|check/i.test(command);
      const isInstall = /npm i|pip install|apt|yarn add/i.test(command);

      let phase: NormalizedMissionActivity['phase'] = 'implementation';
      let title = `Executing: ${command.slice(0, 50)}${command.length > 50 ? '...' : ''}`;
      if (isBuild) {
        phase = 'build';
        title = 'Compiling project build...';
      } else if (isTest) {
        phase = 'verification';
        title = 'Running test suite...';
      } else if (isInstall) {
        phase = 'scaffolding';
        title = 'Installing dependencies...';
      }

      return {
        phase,
        title,
        detail: command || undefined,
        toolName: name,
        status: step.status === 'completed' ? 'completed' : 'running'
      };
    }

    return {
      phase: 'implementation',
      title: `Executing ${name}`,
      detail: targetFile || command || undefined,
      toolName: name,
      status: step.status === 'completed' ? 'completed' : 'running'
    };
  }

  if (step.summary) {
    return {
      phase: 'general',
      title: step.summary,
      status: step.status === 'completed' ? 'completed' : 'running'
    };
  }

  if (eventType === 'thought' || delta.type === 'thought') {
    const thoughtText = delta.thought_summary || delta.thought || step.summary || '';
    if (thoughtText) {
      return {
        phase: 'planning',
        title: thoughtText.length > 80 ? `${thoughtText.slice(0, 77)}...` : thoughtText,
        status: 'running'
      };
    }
  }

  return null;
}

/**
 * Injects previous conversation turns into the prompt context for fresh sessions.
 * When hasPreviousInteractionId is true, Antigravity's remote interaction session maintains
 * state natively, so history injection is skipped to optimize token consumption.
 */
export function buildContextualPrompt(prompt: string, history?: any[], hasPreviousInteractionId?: boolean): string {
  if (hasPreviousInteractionId || !history || !Array.isArray(history) || history.length === 0) {
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

// Expose call budget tracker endpoint (open for personal use)
router.get('/call-budget', (_req: Request, res: Response) => {
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

  // 3. Truthful response: If artifact was not produced in the remote sandbox, report truthfully
  return res.status(404).json({
    success: false,
    error: `Artifact "${filename}" was not found in the remote environment sandbox. Ensure build commands (e.g. Gradle, build scripts) completed successfully in the mission.`
  });
});

// Real-time SSE streaming endpoint with Persistent Memory & Antigravity Preview Engine
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

  const hasPreviousInteractionId = Boolean(previousInteractionId && typeof previousInteractionId === 'string' && previousInteractionId.trim());
  // 1. Inject within-session dialogue memory only when starting a fresh session
  const contextualPrompt = buildContextualPrompt(rawPrompt, history, hasPreviousInteractionId);
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
        message: `Antigravity model error (${statusCode}): ${rawMsg}`,
        status: statusCode
      })}\n\n`);
      return res.end();
    }

    if (!upstreamRes.body) {
      clearInterval(keepAliveInterval);
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'agent_unavailable',
        message: 'Antigravity stream error: No response body received from Antigravity engine.'
      })}\n\n`);
      return res.end();
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

          const activity = normalizeMissionActivity(eventData, eventType);
          if (activity) {
            eventData.normalized_activity = activity;
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
    console.error('Antigravity streaming error:', err);
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'agent_unavailable',
      message: `Antigravity model error: ${err?.message || 'Stream connection dropped'}`
    })}\n\n`);
    res.end();
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

  const hasPreviousInteractionId = Boolean(previousInteractionId && typeof previousInteractionId === 'string' && previousInteractionId.trim());
  // 1. Contextual within-session history only if starting fresh
  const contextualPrompt = buildContextualPrompt(rawPrompt, history, hasPreviousInteractionId);
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

    console.warn(`Antigravity model returned error (${statusCode}):`, rawMessage);
    return res.status(statusCode).json({
      error: {
        type: 'antigravity_unavailable',
        message: `Antigravity model error (${statusCode}): ${rawMessage}`,
        status: statusCode
      }
    });
  } catch (err: any) {
    console.error('Failed to connect to Antigravity API:', err);
    return res.status(503).json({
      error: {
        type: 'antigravity_unavailable',
        message: `Antigravity model error: ${err?.message || 'Connection failed'}`,
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
