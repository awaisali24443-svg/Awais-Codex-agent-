import { Request } from 'express';
import { GoogleGenAI } from '@google/genai';
import { ENV_ENDPOINT } from './config.js';

export function getApiKey(req: Request): string {
  const customKey = req.headers['x-gemini-api-key'] as string;
  return (customKey && customKey.trim()) || process.env.GEMINI_API_KEY || '';
}

export function getGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function cleanupOldEnvironments(apiKey: string, maxToKeep = 2): Promise<number> {
  if (!apiKey) return 0;
  try {
    const listRes = await fetch(`${ENV_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (!listRes.ok) return 0;
    const data = await listRes.json();
    const envs = data.environments || [];
    if (envs.length <= maxToKeep) return 0;

    // Sort by creation date ascending (oldest first)
    envs.sort((a: any, b: any) => new Date(a.created || 0).getTime() - new Date(b.created || 0).getTime());
    const toDelete = envs.slice(0, envs.length - maxToKeep);
    console.log(`Cleaning up ${toDelete.length} old sandbox environments to free storage quota...`);

    let deletedCount = 0;
    await Promise.all(toDelete.map(async (env: any) => {
      try {
        const delRes = await fetch(`${ENV_ENDPOINT}/${encodeURIComponent(env.id)}?key=${encodeURIComponent(apiKey)}`, {
          method: 'DELETE',
          headers: { 'x-goog-api-key': apiKey }
        });
        if (delRes.ok) deletedCount++;
      } catch (_) {}
    }));
    return deletedCount;
  } catch (err) {
    console.warn('Environment cleanup error:', err);
    return 0;
  }
}

export function extractOutputTextFromSteps(steps: any[]): string {
  if (!Array.isArray(steps)) return '';
  let extracted = '';
  for (const s of steps) {
    if (s.type === 'model_output' && s.content) {
      if (Array.isArray(s.content)) {
        for (const c of s.content) {
          if (typeof c === 'string') extracted += c;
          else if (c && c.text) extracted += c.text;
        }
      } else if (typeof s.content === 'string') {
        extracted += s.content;
      } else if (s.content && s.content.text) {
        extracted += s.content.text;
      }
    } else if (s.type === 'model_output' && s.text) {
      extracted += s.text;
    }
  }
  return extracted;
}

export async function callAntigravityWithRetry(
  payload: any,
  apiKey: string,
  postUrl: string,
  signal?: AbortSignal
): Promise<Response> {
  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(payload),
    signal
  };

  let response = await fetch(postUrl, fetchOptions);
  const targetEnv = payload.environment;

  // If environment was stale or expired (HTTP 400/404), auto-fallback to fresh 'remote' sandbox
  if (!response.ok && targetEnv !== 'remote' && (response.status === 400 || response.status === 404)) {
    console.warn(`Environment "${targetEnv}" expired or unavailable (${response.status}). Retrying with fresh remote sandbox...`);
    payload.environment = 'remote';
    delete payload.previous_interaction_id;
    fetchOptions.body = JSON.stringify(payload);
    response = await fetch(postUrl, fetchOptions);
  }

  // If storage quota exceeded (HTTP 429), clean up old environments and retry
  if (!response.ok && response.status === 429) {
    const errData = await response.clone().json().catch(() => ({}));
    const rawMsg = errData.error?.message || '';
    if (rawMsg.toLowerCase().includes('storage quota') || rawMsg.toLowerCase().includes('environment')) {
      console.warn('Environment storage quota exceeded. Auto-cleaning old environments...');
      await cleanupOldEnvironments(apiKey, 1);
      payload.environment = 'remote';
      delete payload.previous_interaction_id;
      fetchOptions.body = JSON.stringify(payload);
      response = await fetch(postUrl, fetchOptions);
    }
  }

  return response;
}

export interface ConsumeStreamOptions {
  onEvent?: (eventType: string, eventData: any) => void;
  onStepProgress?: (step: any, delta: any) => void;
}

export async function consumeAntigravityStream(
  upstreamRes: Response,
  options?: ConsumeStreamOptions
): Promise<{
  finalOutputText: string;
  completedInteractionId: string;
  generatedArtifacts: string[];
  stepsCount: number;
  lastMilestone: string;
}> {
  if (!upstreamRes.body) {
    throw new Error('No data stream received from engine');
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let finalOutputText = '';
  let completedInteractionId = '';
  const generatedArtifacts: string[] = [];
  let stepsCount = 0;
  let lastMilestone = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    const blocks = sseBuffer.split(/\r?\n\r?\n/);
    sseBuffer = blocks.pop() || '';

    for (const block of blocks) {
      if (!block.trim() || block.startsWith(':')) continue;

      const lines = block.split(/\r?\n/);
      let parsedEventType = '';
      const dataLines: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
          parsedEventType = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          dataLines.push(trimmed.slice(5).trim());
        }
      }

      const dataStr = dataLines.join('\n');
      if (!dataStr || dataStr === '[DONE]') continue;

      try {
        const eventData = JSON.parse(dataStr);
        const eventType = parsedEventType || eventData.event_type || eventData.type || '';
        const step = eventData.step || {};
        const delta = eventData.delta || {};
        const inter = eventData.interaction || {};

        if (options?.onEvent) {
          options.onEvent(eventType, eventData);
        }

        if (inter.id) {
          completedInteractionId = inter.id;
        }

        if (step.summary) {
          stepsCount++;
          lastMilestone = step.summary;
        } else if (step.tool_calls?.[0]?.name) {
          stepsCount++;
          const toolName = step.tool_calls[0].name;
          if (toolName === 'create_file' || toolName === 'edit_file') {
            lastMilestone = 'Generating code and assets...';
          } else if (toolName === 'run_command') {
            lastMilestone = 'Executing commands & compiling build...';
          } else {
            lastMilestone = `Executing sub-task (${toolName})...`;
          }
        }

        if (options?.onStepProgress) {
          options.onStepProgress(step, delta);
        }

        if (step.tool_calls) {
          for (const call of step.tool_calls) {
            const argTarget = call.arguments?.TargetFile || call.arguments?.path || '';
            if (argTarget && (argTarget.endsWith('.apk') || argTarget.endsWith('.zip') || argTarget.endsWith('.tar'))) {
              if (!generatedArtifacts.includes(argTarget)) {
                generatedArtifacts.push(argTarget);
              }
            }
          }
        }

        if (inter.output_text) {
          finalOutputText = inter.output_text;
        } else if (Array.isArray(inter.steps)) {
          const extracted = extractOutputTextFromSteps(inter.steps);
          if (extracted) finalOutputText = extracted;
        }

        if (delta.text) {
          finalOutputText += delta.text;
        }
      } catch (_) {}
    }
  }

  return {
    finalOutputText,
    completedInteractionId,
    generatedArtifacts,
    stepsCount,
    lastMilestone
  };
}
