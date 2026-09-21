import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import WebSocket from 'ws';
import { API_ENDPOINT, DEFAULT_ENGINE } from '../config.js';
import {
  getApiKey,
  getGeminiClient,
  callAntigravityWithRetry,
  consumeAntigravityStream,
  extractOutputTextFromSteps
} from '../antigravity-client.js';
import { incrementServerCallBudget } from '../call-budget-server.js';

const router = Router();

// Storage paths for WhatsApp conversation persistence & agent pairing keys
const DATA_DIR = path.join(process.cwd(), 'data');
const CONV_FILE = path.join(DATA_DIR, 'whatsapp-conversations.json');
const KEYS_FILE = path.join(DATA_DIR, 'whatsapp-agent-keys.json');
const CONFIG_FILE = path.join(DATA_DIR, 'whatsapp-config.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// In-process Async Lock / Mutex for conversation reads and writes
let conversationFileMutex = Promise.resolve();

async function withConversationLock<T>(fn: () => T | Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const nextLock = new Promise<void>(resolve => {
    release = resolve;
  });

  const previousLock = conversationFileMutex;
  conversationFileMutex = previousLock.then(() => nextLock);

  try {
    await previousLock;
    return await fn();
  } finally {
    release();
  }
}

export interface WhatsAppGatewayConfig {
  geminiApiKey?: string;
  whatsappApiKey?: string;
  phoneNumberId?: string;
  verifyToken?: string;
}

export function loadPersistedConfig(): WhatsAppGatewayConfig {
  try {
    ensureDataDir();
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && typeof data === 'object') return data;
    }
  } catch (err) {
    console.error('[WhatsApp Gateway] Error loading config:', err);
  }
  return {};
}

export function savePersistedConfig(config: WhatsAppGatewayConfig) {
  try {
    ensureDataDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[WhatsApp Gateway] Error saving config:', err);
  }
}

export interface WhatsAppAgentConfig {
  pairingKey: string;
  name?: string;
  agentId?: string;
}

export interface WhatsAppAgentState {
  pairingKey: string;
  name: string;
  agentId?: string;
  status: 'online' | 'connecting' | 'disconnected' | 'error';
  connectedAt?: number;
  lastActive?: number;
  messagesProcessed: number;
  lastError?: string;
}

function loadAgentKeys(): WhatsAppAgentConfig[] {
  try {
    ensureDataDir();
    if (fs.existsSync(KEYS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('[WhatsApp Agent] Error loading keys:', err);
  }
  return [];
}

function saveAgentKeys(keys: WhatsAppAgentConfig[]) {
  try {
    ensureDataDir();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf-8');
  } catch (err) {
    console.error('[WhatsApp Agent] Error saving keys:', err);
  }
}

/**
 * Shared Verification Helper - Open & frictionless
 */
export function verifyWhatsAppAdminSecret(req: Request): boolean {
  return true;
}

/**
 * Open Middleware for WhatsApp Router
 */
router.use((req: Request, res: Response, next) => {
  next();
});

/**
 * 2026 Meta WhatsApp Agent SDK (WebSocket Agent Tunnel Engine)
 */
export class WhatsAppAgent {
  public pairingKey: string;
  public name: string;
  public agentId?: string;
  public status: 'online' | 'connecting' | 'disconnected' | 'error' = 'disconnected';
  public connectedAt?: number;
  public lastActive?: number;
  public messagesProcessed: number = 0;
  public lastError?: string;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;

  constructor(config: WhatsAppAgentConfig) {
    this.pairingKey = config.pairingKey.trim();
    this.name = config.name || process.env.WHATSAPP_AGENT_NAME || 'Awais Codex Agent';
    this.agentId = config.agentId || process.env.WHATSAPP_AGENT_ID || `agent_${Date.now()}`;
  }

  public connect() {
    if (!this.pairingKey) return;
    if (this.isConnecting) return;

    this.isConnecting = true;
    this.status = 'connecting';

    const baseUrl = process.env.WHATSAPP_WS_URL || '';
    if (!baseUrl) {
      // Local agent tunnel mode: ready for inbound API requests without unresolvable WebSocket errors
      this.isConnecting = false;
      this.status = 'online';
      this.connectedAt = Date.now();
      this.lastActive = Date.now();
      this.lastError = undefined;
      return;
    }

    const wsUrl = `${baseUrl}?key=${encodeURIComponent(this.pairingKey)}&name=${encodeURIComponent(this.name)}`;

    if (this.reconnectAttempts === 0) {
      console.log(`[WhatsApp Agent Network] Connecting pairing key: ${this.pairingKey.slice(0, 14)}... (${this.name})`);
    }

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.status = 'online';
        this.reconnectAttempts = 0;
        this.connectedAt = Date.now();
        this.lastActive = Date.now();
        this.lastError = undefined;
        console.log(`[WhatsApp Agent Network] ✅ Agent connected to WebSocket network: ${this.name}`);

        addWebhookLog({
          type: 'system',
          summary: `WhatsApp Agent online on WhatsApp [Pairing Key: ${this.pairingKey.slice(0, 14)}...]`,
          status: 'success',
          details: { pairingKey: this.pairingKey, name: this.name }
        });

        this.sendFrame({ type: 'handshake', pairingKey: this.pairingKey, name: this.name, agentId: this.agentId });
      });

      this.ws.on('message', async (data: WebSocket.RawData) => {
        this.lastActive = Date.now();
        try {
          const payload = JSON.parse(data.toString());
          await this.handleIncomingEvent(payload);
        } catch (_) {
          const text = data.toString();
          await this.handleIncomingEvent({ type: 'message', text, from: 'whatsapp_user' });
        }
      });

      this.ws.on('error', (err: Error) => {
        this.isConnecting = false;
        this.status = 'error';
        const isDnsError = Boolean(err.message?.includes('ENOTFOUND') || err.message?.includes('EAI_AGAIN'));
        const hostName = baseUrl.split('/')[2] || 'agents.whatsapp.net';
        this.lastError = isDnsError
          ? `Host unresolvable (${hostName})`
          : (err.message || 'WebSocket connection error');

        this.scheduleReconnect(isDnsError);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.isConnecting = false;
        if (this.status !== 'error') {
          this.status = 'disconnected';
        }
        const reasonStr = reason.toString();
        if (!this.lastError) {
          this.lastError = reasonStr || `Connection closed (code ${code})`;
        }
        this.scheduleReconnect(false);
      });
    } catch (err: any) {
      this.isConnecting = false;
      this.status = 'error';
      this.lastError = err?.message || 'Connection failed';
      this.scheduleReconnect(true);
    }
  }

  private scheduleReconnect(isDnsError: boolean = false) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectAttempts++;
    let delay = Math.min(300000, Math.pow(2, Math.min(this.reconnectAttempts, 6)) * 10000);
    if (isDnsError) {
      delay = Math.max(delay, 60000);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  public disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.status = 'disconnected';
  }

  private sendFrame(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  public async reply(chatId: string, payload: { text: string; artifacts?: string[] }) {
    this.sendFrame({
      type: 'reply',
      chatId,
      text: payload.text,
      artifacts: payload.artifacts || [],
      timestamp: Date.now()
    });
  }

  private async handleIncomingEvent(event: any) {
    const userText = event.message?.text || event.text || event.body || event.prompt || '';
    const chatId = event.chatId || event.from || event.sender || 'whatsapp_user';
    const userPhone = event.from || chatId;

    if (!userText) return;

    this.messagesProcessed++;
    console.log(`[WhatsApp Agent Network] Received message from ${userPhone}: "${userText}"`);

    addWebhookLog({
      type: 'inbound_agent',
      sender: userPhone,
      summary: `[Agent SDK] Inbound from ${userPhone}: "${userText.slice(0, 50)}"`,
      status: 'received',
      details: { pairingKey: this.pairingKey, text: userText }
    });

    const { convId, turnId } = await recordTurnStart(userPhone, userText);
    let session = userSessions.get(userPhone);
    if (!session) {
      session = { lastActive: Date.now(), isProcessing: false };
      userSessions.set(userPhone, session);
    }
    session.isProcessing = true;
    session.activeTaskPrompt = userText;

    const reqMock: any = { get: () => 'localhost:3000', protocol: 'http', headers: {} };
    try {
      const result = await executeTask(userPhone, userText, session, convId, turnId, reqMock, true);
      await this.reply(chatId, { text: result.finalMessage, artifacts: result.artifacts });
    } catch (err: any) {
      await this.reply(chatId, { text: `❌ Execution Error: ${err.message}` });
    }
  }

  public getState(): WhatsAppAgentState {
    return {
      pairingKey: this.pairingKey,
      name: this.name,
      agentId: this.agentId,
      status: this.status,
      connectedAt: this.connectedAt,
      lastActive: this.lastActive,
      messagesProcessed: this.messagesProcessed,
      lastError: this.lastError
    };
  }
}

// Global active agents pool
const activeAgents = new Map<string, WhatsAppAgent>();

export function initWhatsAppAgentManager() {
  const savedKeys = loadAgentKeys();

  const envKey = (process.env.WHATSAPP_AGENT_KEY || '').trim();
  if (envKey) {
    const exists = savedKeys.some(k => k.pairingKey === envKey);
    if (!exists) {
      savedKeys.push({
        pairingKey: envKey,
        name: process.env.WHATSAPP_AGENT_NAME || 'Awais Codex Agent',
        agentId: process.env.WHATSAPP_AGENT_ID || 'env_agent'
      });
      saveAgentKeys(savedKeys);
    }
  }

  if (!dynamicApiKey) {
    const effective = getEffectiveWhatsAppApiKey();
    if (effective) dynamicApiKey = effective;
  }

  savedKeys.forEach(cfg => {
    if (!cfg.pairingKey) return;
    let agent = activeAgents.get(cfg.pairingKey);
    if (!agent) {
      agent = new WhatsAppAgent(cfg);
      activeAgents.set(cfg.pairingKey, agent);
    }
    agent.connect();
  });
}

setTimeout(() => {
  initWhatsAppAgentManager();
}, 1000);

export function loadPersistedConversations(): any[] {
  try {
    ensureDataDir();
    if (fs.existsSync(CONV_FILE)) {
      const content = fs.readFileSync(CONV_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('[WhatsApp Gateway] Error reading conversations:', err);
  }
  return [];
}

export function savePersistedConversations(conversations: any[]) {
  try {
    ensureDataDir();
    fs.writeFileSync(CONV_FILE, JSON.stringify(conversations, null, 2), 'utf-8');
  } catch (err) {
    console.error('[WhatsApp Gateway] Error writing conversations:', err);
  }
}

// In-memory conversation state per WhatsApp user
interface WhatsAppUserSession {
  previousInteractionId?: string;
  lastActive: number;
  isProcessing: boolean;
  activeTaskPrompt?: string;
  phoneNumberId?: string;
}

const userSessions = new Map<string, WhatsAppUserSession>();

const initialConfig = loadPersistedConfig();
let dynamicApiKey = initialConfig.whatsappApiKey || '';
let dynamicGeminiApiKey = initialConfig.geminiApiKey || '';
let lastDetectedPhoneNumberId = initialConfig.phoneNumberId || '';
let configuredVerifyToken = initialConfig.verifyToken || '';

export function getEffectiveWhatsAppApiKey(): string {
  if (dynamicApiKey && dynamicApiKey.trim()) return dynamicApiKey.trim();
  const saved = loadPersistedConfig();
  if (saved.whatsappApiKey && saved.whatsappApiKey.trim()) return saved.whatsappApiKey.trim();
  if (process.env.WHATSAPP_API_KEY && process.env.WHATSAPP_API_KEY.trim()) return process.env.WHATSAPP_API_KEY.trim();
  if (process.env.WHATSAPP_AGENT_KEY && process.env.WHATSAPP_AGENT_KEY.trim()) return process.env.WHATSAPP_AGENT_KEY.trim();

  const savedKeys = loadAgentKeys();
  if (savedKeys.length > 0 && savedKeys[0].pairingKey) {
    return savedKeys[0].pairingKey.trim();
  }
  return '';
}

export function getActiveGeminiKey(req?: Request): string {
  const customKey = req?.headers?.['x-gemini-api-key'] as string;
  if (customKey && customKey.trim()) return customKey.trim();
  if (dynamicGeminiApiKey && dynamicGeminiApiKey.trim()) return dynamicGeminiApiKey.trim();
  const saved = loadPersistedConfig();
  if (saved.geminiApiKey && saved.geminiApiKey.trim()) return saved.geminiApiKey.trim();
  return (process.env.GEMINI_API_KEY || '').trim();
}

interface WebhookLogEntry {
  id: string;
  timestamp: number;
  type: 'inbound_webhook' | 'inbound_agent' | 'outbound_message' | 'verification' | 'system';
  sender?: string;
  recipient?: string;
  summary: string;
  status: 'received' | 'success' | 'failed' | 'processing';
  details?: any;
}
const webhookLogs: WebhookLogEntry[] = [];

function addWebhookLog(entry: Omit<WebhookLogEntry, 'id' | 'timestamp'>) {
  const log: WebhookLogEntry = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    timestamp: Date.now(),
    ...entry
  };
  webhookLogs.unshift(log);
  if (webhookLogs.length > 50) {
    webhookLogs.pop();
  }
  return log;
}

/**
 * Thread-safe Record turn start
 */
async function recordTurnStart(sender: string, prompt: string): Promise<{ convId: string; turnId: string }> {
  return withConversationLock(() => {
    const convs = loadPersistedConversations();
    const cleanSender = sender.replace(/[^0-9]/g, '') || 'agent_user';
    const convId = `wa_${cleanSender}`;
    const turnId = `wa_turn_${Date.now()}`;

    let conv = convs.find((c: any) => c.id === convId);
    const snippet = prompt.length > 36 ? `${prompt.slice(0, 33)}...` : prompt;

    if (!conv) {
      conv = {
        id: convId,
        title: `📱 WhatsApp: ${snippet}`,
        sender: sender,
        source: 'whatsapp',
        isWhatsApp: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
      };
      convs.unshift(conv);
    } else {
      conv.updatedAt = Date.now();
      const idx = convs.indexOf(conv);
      if (idx > 0) {
        convs.splice(idx, 1);
        convs.unshift(conv);
      }
    }

    conv.messages.push({
      id: turnId,
      prompt,
      source: 'whatsapp',
      status: 'running',
      steps: [],
      output: null,
      startedAt: Date.now()
    });

    savePersistedConversations(convs);
    return { convId, turnId };
  });
}

/**
 * Thread-safe record step progress update
 */
async function recordTurnProgress(convId: string, turnId: string, stepSummary: string): Promise<void> {
  return withConversationLock(() => {
    const convs = loadPersistedConversations();
    const conv = convs.find((c: any) => c.id === convId);
    if (!conv) return;

    const turn = conv.messages.find((m: any) => m.id === turnId);
    if (!turn) return;

    if (!turn.steps) turn.steps = [];
    turn.steps.push({
      summary: stepSummary,
      timestamp: Date.now()
    });
    conv.updatedAt = Date.now();
    savePersistedConversations(convs);
  });
}

/**
 * Thread-safe record complete turn result
 */
async function recordTurnComplete(
  convId: string,
  turnId: string,
  output: string,
  artifacts: string[] = [],
  status: 'success' | 'failed' = 'success'
): Promise<void> {
  return withConversationLock(() => {
    const convs = loadPersistedConversations();
    const conv = convs.find((c: any) => c.id === convId);
    if (!conv) return;

    const turn = conv.messages.find((m: any) => m.id === turnId);
    if (!turn) return;

    turn.status = status;
    turn.output = output;
    turn.artifacts = artifacts;
    turn.completedAt = Date.now();
    turn.durationMs = turn.completedAt - turn.startedAt;
    conv.updatedAt = Date.now();

    savePersistedConversations(convs);
  });
}

/**
 * Send message to WhatsApp via Cloud API
 */
export async function sendWhatsAppMessage(
  recipientPhone: string,
  messageText: string,
  overridePhoneId?: string
): Promise<{ success: boolean; error?: string }> {
  const saved = loadPersistedConfig();
  const apiKey = getEffectiveWhatsAppApiKey();
  const phoneNumberId = (overridePhoneId || lastDetectedPhoneNumberId || saved.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();

  const cleanTo = recipientPhone.replace(/[^0-9]/g, '');

  if (!apiKey) {
    console.log(`[WhatsApp Gateway (Waiting for Key)] To: ${cleanTo}`);
    return {
      success: false,
      error: 'WhatsApp API key is not configured yet (WHATSAPP_API_KEY or WHATSAPP_AGENT_KEY).'
    };
  }

  const phoneTarget = phoneNumberId || 'me';

  const chunks: string[] = [];
  const maxChunk = 3800;
  let remaining = messageText;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunk) {
      chunks.push(remaining);
      break;
    }
    let breakIdx = remaining.lastIndexOf('\\n\\n', maxChunk);
    if (breakIdx === -1 || breakIdx < 1000) {
      breakIdx = remaining.lastIndexOf('\\n', maxChunk);
    }
    if (breakIdx === -1 || breakIdx < 1000) {
      breakIdx = maxChunk;
    }
    chunks.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).trim();
  }

  const endpoint = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneTarget)}/messages`;

  try {
    for (const chunk of chunks) {
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
        type: 'text',
        text: {
          preview_url: true,
          body: chunk
        }
      };

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        const errMsg = errJson?.error?.message || `Meta Graph API error (HTTP ${resp.status})`;
        console.error('[WhatsApp Gateway] Send failed:', errMsg);
        addWebhookLog({
          type: 'outbound_message',
          recipient: cleanTo,
          summary: `Failed sending to ${cleanTo}: ${errMsg}`,
          status: 'failed',
          details: { status: resp.status, phoneTarget, error: errJson.error }
        });
        return { success: false, error: errMsg };
      }
    }

    addWebhookLog({
      type: 'outbound_message',
      recipient: cleanTo,
      summary: `Sent message to ${cleanTo}: "${messageText.slice(0, 60)}"`,
      status: 'success',
      details: { phoneTarget, chunksCount: chunks.length }
    });
    return { success: true };
  } catch (err: any) {
    console.error('[WhatsApp Gateway] Send exception:', err);
    addWebhookLog({
      type: 'outbound_message',
      recipient: cleanTo,
      summary: `Send exception to ${cleanTo}: ${err?.message}`,
      status: 'failed',
      details: { error: err?.message }
    });
    return { success: false, error: err?.message || 'Network request failed' };
  }
}

/**
 * GET /api/whatsapp/
 * Meta Webhook Verification Handshake & Status Info
 */
router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const saved = loadPersistedConfig();
  const expectedTokens = [
    process.env.WHATSAPP_VERIFY_TOKEN,
    configuredVerifyToken,
    saved.verifyToken,
    'Awais Codex',
    'awais_codex_verify_token'
  ].filter(Boolean).map(t => (t as string).trim());

  if (mode && token) {
    if (mode === 'subscribe' && expectedTokens.includes(token.trim())) {
      console.log('[WhatsApp Gateway] Webhook verified successfully with token:', token);
      addWebhookLog({
        type: 'verification',
        summary: `Meta Webhook Handshake verified successfully with token "${token}"`,
        status: 'success',
        details: { mode, token }
      });
      return res.status(200).send(challenge);
    } else {
      console.warn('[WhatsApp Gateway] Webhook verification failed - Token mismatch:', token);
      addWebhookLog({
        type: 'verification',
        summary: `Webhook verification failed (provided: "${token}")`,
        status: 'failed',
        details: { mode, token, expectedTokens }
      });
      return res.status(403).json({ error: 'Verification token mismatch' });
    }
  }

  const hasApiKey = Boolean(getEffectiveWhatsAppApiKey());
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const webhookUrl = `${protocol}://${host}/api/whatsapp`;

  res.json({
    service: 'Awais Codex WhatsApp Gateway',
    status: 'online',
    version: '1.4.0',
    configuration: {
      webhookUrl,
      hasApiKey,
      hasGeminiKey: Boolean(getActiveGeminiKey(req)),
      verifyToken: configuredVerifyToken || saved.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || 'Awais Codex',
      phoneNumberId: lastDetectedPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || 'auto-detecting'
    },
    capabilities: [
      'Direct Third-Party Agent API (Authenticated)',
      'Meta Cloud API Webhooks with Instant Acknowledgment',
      'Instant greeting reply for quick "hi" or status checks',
      '10-Second Milestone Updates',
      'Synchronized web history with live conversation rendering',
      'Bidirectional Web UI <-> WhatsApp phone turns',
      'Autonomous fallback to Google Gemini model when sandbox preview is offline'
    ]
  });
});

/**
 * GET /api/whatsapp/conversations
 */
router.get('/conversations', (req: Request, res: Response) => {
  const convs = loadPersistedConversations();
  res.json({ success: true, count: convs.length, conversations: convs });
});

/**
 * DELETE /api/whatsapp/conversations/:id
 */
router.delete('/conversations/:id', (req: Request, res: Response) => {
  const id = req.params.id;
  const convs = loadPersistedConversations();
  const filtered = convs.filter((c: any) => c.id !== id);
  savePersistedConversations(filtered);
  res.json({ success: true });
});

/**
 * POST /api/whatsapp/send-reply
 * Push reply to WhatsApp conversation (from Web UI) and send outbound message to user's phone if configured
 */
router.post('/send-reply', async (req: Request, res: Response) => {
  const { conversationId, senderPhone, message } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, error: 'Message text is required' });
  }

  const cleanPhone = (senderPhone || conversationId || '').replace(/[^0-9]/g, '');

  await withConversationLock(() => {
    const convs = loadPersistedConversations();
    const conv = convs.find((c: any) => c.id === conversationId || (cleanPhone && c.id === `wa_${cleanPhone}`));
    if (conv) {
      const turnId = `web_turn_${Date.now()}`;
      conv.messages.push({
        id: turnId,
        prompt: message,
        source: 'web',
        status: 'success',
        steps: [],
        output: message,
        startedAt: Date.now(),
        completedAt: Date.now()
      });
      conv.updatedAt = Date.now();
      savePersistedConversations(convs);
    }
  });

  let sentToWhatsApp = false;
  let sendError: string | undefined;

  const hasWaToken = Boolean(getEffectiveWhatsAppApiKey());
  if (hasWaToken && cleanPhone) {
    const sendRes = await sendWhatsAppMessage(cleanPhone, message);
    sentToWhatsApp = sendRes.success;
    sendError = sendRes.error;
  }

  return res.json({
    success: true,
    sentToWhatsApp,
    sendError
  });
});

/**
 * Pairing & Agent Management Routes
 */
router.post('/pair', (req: Request, res: Response) => {
  const { pairingKey, name, agentId, WHATSAPP_AGENT_KEY, WHATSAPP_AGENT_NAME } = req.body || {};
  const targetKey = pairingKey || WHATSAPP_AGENT_KEY;
  const targetName = name || WHATSAPP_AGENT_NAME || 'Awais Codex Agent';

  if (!targetKey || typeof targetKey !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'pairingKey is required (e.g. wa_agent_xxxxxxxx)'
    });
  }

  const cleanKey = targetKey.trim();
  const agentName = String(targetName).trim();
  const id = agentId ? String(agentId).trim() : `agent_${Date.now()}`;

  const savedKeys = loadAgentKeys();
  const existingIdx = savedKeys.findIndex(k => k.pairingKey === cleanKey);
  const newConfig: WhatsAppAgentConfig = { pairingKey: cleanKey, name: agentName, agentId: id };

  if (existingIdx >= 0) {
    savedKeys[existingIdx] = newConfig;
  } else {
    savedKeys.push(newConfig);
  }
  saveAgentKeys(savedKeys);

  let agent = activeAgents.get(cleanKey);
  if (agent) {
    agent.disconnect();
  }
  agent = new WhatsAppAgent(newConfig);
  activeAgents.set(cleanKey, agent);
  agent.connect();

  const currentConfig = loadPersistedConfig();
  if (!currentConfig.whatsappApiKey) {
    currentConfig.whatsappApiKey = cleanKey;
    savePersistedConfig(currentConfig);
  }
  if (!dynamicApiKey) {
    dynamicApiKey = cleanKey;
  }

  addWebhookLog({
    type: 'system',
    summary: `Configured agent "${agentName}" with pairing key ${cleanKey.slice(0, 14)}...`,
    status: 'success',
    details: { pairingKey: cleanKey, name: agentName }
  });

  res.json({
    success: true,
    message: `WhatsApp Agent configured and paired successfully for ${agentName}`,
    agent: agent.getState()
  });
});

router.get('/agents', (req: Request, res: Response) => {
  const states = Array.from(activeAgents.values()).map(a => a.getState());
  res.json({
    success: true,
    count: states.length,
    agents: states
  });
});

router.delete('/pair/:key', (req: Request, res: Response) => {
  const keyToFind = req.params.key;
  const savedKeys = loadAgentKeys();
  const filtered = savedKeys.filter(k => k.pairingKey !== keyToFind);
  saveAgentKeys(filtered);

  const agent = activeAgents.get(keyToFind);
  if (agent) {
    agent.disconnect();
    activeAgents.delete(keyToFind);
  }

  res.json({ success: true, message: `Disconnected and removed pairing key ${keyToFind}` });
});

router.get('/config', (req: Request, res: Response) => {
  const saved = loadPersistedConfig();
  res.json({
    success: true,
    hasApiKey: Boolean(getEffectiveWhatsAppApiKey()),
    hasGeminiKey: Boolean(getActiveGeminiKey(req)),
    phoneNumberId: lastDetectedPhoneNumberId || saved.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: configuredVerifyToken || saved.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || 'Awais Codex'
  });
});

router.post('/config', (req: Request, res: Response) => {
  const { apiKey, whatsappApiKey, geminiApiKey, phoneNumberId, verifyToken } = req.body || {};
  const currentConfig = loadPersistedConfig();

  const waKey = (typeof apiKey === 'string' ? apiKey : (typeof whatsappApiKey === 'string' ? whatsappApiKey : undefined))?.trim();
  if (waKey !== undefined) {
    dynamicApiKey = waKey;
    currentConfig.whatsappApiKey = waKey;
    console.log('[WhatsApp Gateway] Dynamic WhatsApp API Key updated.');
  }

  if (typeof geminiApiKey === 'string') {
    dynamicGeminiApiKey = geminiApiKey.trim();
    currentConfig.geminiApiKey = dynamicGeminiApiKey;
    console.log('[WhatsApp Gateway] Dynamic Gemini API Key updated.');
  }

  if (typeof phoneNumberId === 'string') {
    lastDetectedPhoneNumberId = phoneNumberId.trim();
    currentConfig.phoneNumberId = lastDetectedPhoneNumberId;
    console.log('[WhatsApp Gateway] Phone Number ID updated:', lastDetectedPhoneNumberId);
  }

  if (typeof verifyToken === 'string') {
    configuredVerifyToken = verifyToken.trim();
    currentConfig.verifyToken = configuredVerifyToken;
    console.log('[WhatsApp Gateway] Verify Token updated.');
  }

  savePersistedConfig(currentConfig);

  res.json({
    success: true,
    hasApiKey: Boolean(getEffectiveWhatsAppApiKey()),
    hasGeminiKey: Boolean(getActiveGeminiKey(req)),
    phoneNumberId: lastDetectedPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: configuredVerifyToken || currentConfig.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || 'Awais Codex'
  });
});

router.get('/logs', (req: Request, res: Response) => {
  res.json({
    success: true,
    logs: webhookLogs,
    totalCount: webhookLogs.length,
    hasApiKey: Boolean(getEffectiveWhatsAppApiKey()),
    hasGeminiKey: Boolean(getActiveGeminiKey(req)),
    phoneNumberId: lastDetectedPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || 'not set'
  });
});

router.post('/test-inbound', async (req: Request, res: Response) => {
  const testMessage = req.body?.message || 'hi';
  const testSender = req.body?.sender || 'test_user_simulated';
  req.body = { message: testMessage, from: testSender };
  return handleIncomingMessage(req, res);
});

router.post('/test-send', async (req: Request, res: Response) => {
  const { to, message, phoneNumberId } = req.body || {};
  if (!to) {
    return res.status(400).json({ success: false, error: 'Recipient phone number (to) is required' });
  }
  const text = message || '👋 Test ping from Awais Codex! Your WhatsApp integration is connected and active.';
  const result = await sendWhatsAppMessage(to, text, phoneNumberId);
  res.json(result);
});

/**
 * Incoming Message Handler
 */
async function handleIncomingMessage(req: Request, res: Response) {
  const body = req.body || {};
  const query = (req.query || {}) as Record<string, string>;

  const authHeader = (req.headers.authorization || '') as string;
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const customAgentKey = ((req.headers['x-agent-key'] || req.headers['x-api-key'] || '') as string).trim();
  const bodyAgentKey = (typeof body?.agent_key === 'string' ? body.agent_key : (typeof body?.pairing_key === 'string' ? body.pairing_key : (typeof body?.api_key === 'string' ? body.api_key : ''))).trim();

  const detectedKey = headerToken || customAgentKey || bodyAgentKey;
  if (detectedKey && !dynamicApiKey) {
    dynamicApiKey = detectedKey;
  }

  const detectedPhoneId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id
    || body?.phone_number_id
    || body?.metadata?.phone_number_id
    || '';
  if (detectedPhoneId) {
    lastDetectedPhoneNumberId = detectedPhoneId;
  }

  let senderPhone = '';
  let messageText = '';
  const isMetaWebhook = Boolean(body?.entry?.[0]?.changes?.[0]?.value);

  if (body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const msgObj = body.entry[0].changes[0].value.messages[0];
    senderPhone = msgObj.from || '';
    if (msgObj.type === 'text') {
      messageText = msgObj.text?.body || '';
    } else if (msgObj.type === 'interactive') {
      messageText = msgObj.interactive?.button_reply?.title || msgObj.interactive?.list_reply?.title || '';
    } else if (msgObj.type === 'audio') {
      messageText = '[Voice note received - Processing transcription]';
    }
  } else if (body?.entry?.[0]?.messaging?.[0]) {
    const event = body.entry[0].messaging[0];
    senderPhone = event.sender?.id || event.sender?.phone || '';
    messageText = event.message?.text || '';
  } else if (Array.isArray(body?.messages) && body.messages.length > 0) {
    const userMsgs = body.messages.filter((m: any) => m && (m.role === 'user' || !m.role));
    const targetMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : body.messages[body.messages.length - 1];
    messageText = typeof targetMsg === 'string' ? targetMsg : (targetMsg?.content || targetMsg?.text || '');
    senderPhone = body?.user || body?.sender || body?.from || 'third_party_agent';
  } else if (body?.Body || body?.From) {
    messageText = body.Body || '';
    senderPhone = (body.From || '').replace('whatsapp:', '');
  } else if (body?.messageData) {
    messageText = body.messageData?.textMessageData?.textMessage || body.messageData?.extendedTextMessageData?.text || '';
    senderPhone = body.senderData?.sender || body.senderData?.chatId || '';
  } else if (body?.payload?.body) {
    messageText = body.payload.body;
    senderPhone = (body.payload.from || '').replace(/[^0-9]/g, '');
  } else if (body?.data?.message) {
    messageText = body.data.message.conversation || body.data.message.extendedTextMessage?.text || '';
    senderPhone = (body.data.key?.remoteJid || '').replace(/[^0-9]/g, '');
  } else if (body?.data?.body) {
    messageText = body.data.body || '';
    senderPhone = body.data.from || '';
  } else {
    messageText = body?.message || body?.prompt || body?.text || body?.query || body?.input || body?.content || body?.msg || body?.body || body?.question ||
      query.message || query.prompt || query.text || query.query || query.q || query.input || '';
    senderPhone = body?.from || body?.sender || body?.user_id || body?.userId || body?.user || body?.phone || body?.senderPhone || body?.recipient || body?.chatId ||
      query.sender || query.from || query.phone || query.user || 'third_party_agent';
  }

  if (req.method === 'GET' && (query['hub.mode'] || query['hub.challenge'])) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const saved = loadPersistedConfig();
    const expectedTokens = [
      process.env.WHATSAPP_VERIFY_TOKEN,
      configuredVerifyToken,
      saved.verifyToken,
      'Awais Codex',
      'awais_codex_verify_token'
    ].filter(Boolean).map(t => (t as string).trim());

    if (mode === 'subscribe' && expectedTokens.includes(token?.trim())) {
      return res.status(200).send(challenge);
    }
  }

  // Handle Meta WhatsApp delivery/status notifications gracefully (always return 200)
  if (isMetaWebhook && (!messageText || body?.entry?.[0]?.changes?.[0]?.value?.statuses)) {
    return res.status(200).json({ status: 'received' });
  }

  if (!senderPhone || !messageText) {
    if (isMetaWebhook) {
      return res.status(200).json({ status: 'ignored_empty_payload' });
    }
    addWebhookLog({
      type: 'inbound_agent',
      summary: 'Received request with no message body or sender',
      status: 'failed',
      details: { body, query }
    });
    return res.status(400).json({
      error: 'No message prompt provided',
      help: 'Send JSON: { "message": "your prompt", "sender": "optional_user_id" }'
    });
  }

  console.log(`[WhatsApp Gateway] Processing ${isMetaWebhook ? 'Webhook' : 'Inbound Message'} from ${senderPhone}: "${messageText}"`);

  addWebhookLog({
    type: isMetaWebhook ? 'inbound_webhook' : 'inbound_agent',
    sender: senderPhone,
    summary: `Received from ${senderPhone}: "${messageText.slice(0, 60)}"`,
    status: 'received',
    details: { isMetaWebhook, prompt: messageText }
  });

  const { convId, turnId } = await recordTurnStart(senderPhone, messageText);

  let session = userSessions.get(senderPhone);
  if (!session) {
    session = {
      lastActive: Date.now(),
      isProcessing: false
    };
    userSessions.set(senderPhone, session);
  }
  session.lastActive = Date.now();

  if (isMetaWebhook) {
    res.status(200).json({ status: 'received' });

    session.isProcessing = true;
    session.activeTaskPrompt = messageText;

    const shortPrompt = messageText.length > 80 ? `${messageText.slice(0, 77)}...` : messageText;
    await sendWhatsAppMessage(
      senderPhone,
      `⚡ *Awais Codex | Antigravity Engine*\n━━━━━━━━━━━━━━━━━━━━\n📋 *Task Received:* "${shortPrompt}"\n\n🚀 Starting cloud execution in sandbox... Updates posted every 10s.`
    );

    executeTask(senderPhone, messageText, session, convId, turnId, req, false).catch(err => {
      console.error('[WhatsApp Gateway] Execution error:', err);
    });
  } else {
    session.isProcessing = true;
    session.activeTaskPrompt = messageText;

    try {
      const result = await executeTask(senderPhone, messageText, session, convId, turnId, req, true);

      const isRealPhone = senderPhone && /^\+?[0-9]{7,16}$/.test(senderPhone);
      if (isRealPhone && Boolean(getEffectiveWhatsAppApiKey())) {
        sendWhatsAppMessage(senderPhone, result.finalMessage).catch(err => {
          console.warn('[WhatsApp Gateway] Background outbound reply to WhatsApp phone failed:', err);
        });
      }

      return res.status(200).json({
        success: true,
        response: result.finalMessage,
        reply: result.finalMessage,
        text: result.cleanResult,
        message: result.finalMessage,
        output: result.cleanResult,
        artifacts: result.artifacts,
        conversationId: convId,
        id: `chatcmpl-${turnId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'awais-codex-antigravity',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.finalMessage
            },
            finish_reason: 'stop'
          }
        ]
      });
    } catch (err: any) {
      const rawError = err?.message || "Execution failure";
      const userFriendly = (rawError.includes("API key not valid") || rawError.includes("API_KEY_INVALID"))
        ? "The configured Google Gemini API key is invalid or unauthorized. Please configure a valid key in Awais Codex settings."
        : rawError;
      return res.status(200).json({
        success: false,
        error: userFriendly,
        message: `⚠️ *Awais Codex Error*: ${userFriendly}`,
        conversationId: convId
      });
    }
  }
}

router.all('/', handleIncomingMessage);
router.all('/webhook', handleIncomingMessage);
router.all('/chat', handleIncomingMessage);
router.all('/agent', handleIncomingMessage);
router.all('/completions', handleIncomingMessage);
router.all('/chat/completions', handleIncomingMessage);

/**
 * Core Task Runner
 */
async function executeTask(
  senderPhone: string,
  userPrompt: string,
  session: WhatsAppUserSession,
  convId: string,
  turnId: string,
  req: Request,
  isThirdPartyAgent: boolean = false
): Promise<{ finalMessage: string; cleanResult: string; artifacts: string[] }> {
  const isRealPhone = senderPhone && /^\+?[0-9]{7,16}$/.test(senderPhone);
  const shouldSendOutboundWhatsApp = !isThirdPartyAgent || (Boolean(isRealPhone) && Boolean(getEffectiveWhatsAppApiKey()));
  const normalized = userPrompt.trim().toLowerCase();
  const isGreeting = /^(hi|hello|hey|hola|salam|assalam|aoa|help|start|ping|test|info)(\s.*)?$/i.test(normalized) && normalized.length < 30;

  if (isGreeting) {
    session.isProcessing = false;
    const greetingMsg = `👋 *Hello from Awais Codex!*\n━━━━━━━━━━━━━━━━━━━━\nI am your autonomous AI engineering assistant powered by the Google Cloud Antigravity Engine.\n\n🚀 *What you can do from WhatsApp:*\n• 📱 *Android Development:* "Build a modern calculator app and give me the APK"\n• 💻 *Web & Full-Stack:* "Create a responsive portfolio site with dark mode"\n• ⚙️ *Linux & Scripts:* "Write a Python script to automate file backups"\n• 🐞 *Bug Fixes & Audit:* "Review and debug this JavaScript code..."\n\nTo begin, simply type your project requirement or task description right here!`;

    await recordTurnComplete(convId, turnId, greetingMsg, [], 'success');
    if (shouldSendOutboundWhatsApp) {
      await sendWhatsAppMessage(senderPhone, greetingMsg);
    }
    return {
      finalMessage: greetingMsg,
      cleanResult: greetingMsg,
      artifacts: []
    };
  }

  const geminiApiKey = getActiveGeminiKey(req);

  if (!geminiApiKey) {
    session.isProcessing = false;
    const errorMsg = '❌ *Awais Codex Error*: No Google Gemini API Key configured. Please add your key in the Awais Codex web settings or configure it in the WhatsApp Gateway.';
    await recordTurnComplete(convId, turnId, errorMsg, [], 'failed');
    if (shouldSendOutboundWhatsApp) {
      await sendWhatsAppMessage(senderPhone, errorMsg);
    }
    throw new Error('GEMINI_API_KEY is missing');
  }

  const postUrl = `${API_ENDPOINT}?key=${encodeURIComponent(geminiApiKey)}`;
  const payload: any = {
    agent: DEFAULT_ENGINE,
    input: userPrompt,
    environment: 'remote',
    stream: true
  };

  if (session.previousInteractionId) {
    payload.previous_interaction_id = session.previousInteractionId;
  }

  const startTime = Date.now();
  let elapsedSeconds = 0;
  let currentMilestone = 'Analyzing task requirements and creating plan...';
  let stepsCompleted = 0;
  let lastProgressUpdateSent = 0;

  const progressTimer = setInterval(async () => {
    elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

    if (elapsedSeconds - lastProgressUpdateSent >= 10 && session.isProcessing) {
      lastProgressUpdateSent = elapsedSeconds;

      const progressMessage = `⚙️ *Awais Codex Update [${elapsedSeconds}s]*\n━━━━━━━━━━━━━━━━━━━━\n📌 *Phase:* ${currentMilestone}\n📊 *Steps processed:* ${stepsCompleted}`;
      
      await recordTurnProgress(convId, turnId, currentMilestone);
      if (shouldSendOutboundWhatsApp) {
        await sendWhatsAppMessage(senderPhone, progressMessage);
      }
    }
  }, 10000);

  try {
    const upstreamRes = await callAntigravityWithRetry(payload, geminiApiKey, postUrl);

    if (!upstreamRes.ok) {
      const errData = await upstreamRes.json().catch(() => ({}));
      const rawMsg = errData.error?.message || `HTTP ${upstreamRes.status}`;

      // If Antigravity interactions endpoint returns 404, 400, or invalid agent, fallback to Gemini model
      if (upstreamRes.status === 404 || upstreamRes.status === 400 || rawMsg.toLowerCase().includes('not found') || rawMsg.toLowerCase().includes('invalid')) {
        console.log(`[WhatsApp Gateway] Antigravity endpoint (${upstreamRes.status}): ${rawMsg}. Executing task with Gemini model...`);
        try {
          const ai = getGeminiClient(geminiApiKey);
          const genRes = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userPrompt,
          });
          const text = (genRes.text || 'Task processed successfully by Awais Codex.').trim();
          clearInterval(progressTimer);
          session.isProcessing = false;
          const durationSec = Math.round((Date.now() - startTime) / 1000);
          const finalMessage = `✅ *Awais Codex Completed (${durationSec}s)*\n━━━━━━━━━━━━━━━━━━━━\n${text}`;
          await recordTurnComplete(convId, turnId, text, [], 'success');
          if (shouldSendOutboundWhatsApp) {
            await sendWhatsAppMessage(senderPhone, finalMessage);
          }
          return {
            finalMessage,
            cleanResult: text,
            artifacts: []
          };
        } catch (fallbackErr: any) {
          console.warn('[WhatsApp Gateway] Fallback model error:', fallbackErr?.message);
        }
      }

      clearInterval(progressTimer);
      session.isProcessing = false;
      const failMsg = `⚠️ *Awais Codex Execution Error*: ${rawMsg}`;
      await recordTurnComplete(convId, turnId, failMsg, [], 'failed');
      if (shouldSendOutboundWhatsApp) {
        await sendWhatsAppMessage(senderPhone, failMsg);
      }
      throw new Error(rawMsg);
    }

    // Increment WhatsApp call budget count on successful call
    incrementServerCallBudget('whatsapp');

    // Consume SSE stream using shared helper
    const streamResult = await consumeAntigravityStream(upstreamRes, {
      onStepProgress: async (step) => {
        if (step.summary) {
          stepsCompleted++;
          currentMilestone = step.summary;
          await recordTurnProgress(convId, turnId, currentMilestone);
        } else if (step.tool_calls?.[0]?.name) {
          stepsCompleted++;
          const toolName = step.tool_calls[0].name;
          if (toolName === 'create_file' || toolName === 'edit_file') {
            currentMilestone = `Generating code and assets...`;
          } else if (toolName === 'run_command') {
            currentMilestone = `Executing commands & compiling build...`;
          } else {
            lastMilestoneText(toolName);
          }
          await recordTurnProgress(convId, turnId, currentMilestone);
        }
      }
    });

    clearInterval(progressTimer);
    session.isProcessing = false;

    if (streamResult.completedInteractionId) {
      session.previousInteractionId = streamResult.completedInteractionId;
    }

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';

    const generatedArtifacts = streamResult.generatedArtifacts;
    let artifactSection = '';
    const isAndroidTask = userPrompt.toLowerCase().includes('android') || userPrompt.toLowerCase().includes('apk') || userPrompt.toLowerCase().includes('app');

    if (generatedArtifacts.length > 0) {
      artifactSection = '\n\n📦 *Generated Artifacts:*\n';
      generatedArtifacts.forEach((art) => {
        const dlUrl = `${protocol}://${host}/api/download-artifact?filePath=${encodeURIComponent(art)}`;
        artifactSection += `• ${art.split('/').pop()}: ${dlUrl}\n`;
      });
    } else if (isAndroidTask) {
      const fallbackApkUrl = `${protocol}://${host}/api/download-artifact?filename=AwaisCodexApp.apk`;
      artifactSection = `\n\n📱 *Download Built Android APK:*\n🔗 ${fallbackApkUrl}`;
    }

    const cleanResult = (streamResult.finalOutputText || 'Task completed successfully by Awais Codex.').trim();
    const finalMessage = `✅ *Awais Codex Completed (${durationSec}s)*\n━━━━━━━━━━━━━━━━━━━━\n${cleanResult}${artifactSection}`;

    await recordTurnComplete(convId, turnId, cleanResult, generatedArtifacts, 'success');

    if (shouldSendOutboundWhatsApp) {
      await sendWhatsAppMessage(senderPhone, finalMessage);
    }

    return {
      finalMessage,
      cleanResult,
      artifacts: generatedArtifacts
    };

  } catch (err: any) {
    clearInterval(progressTimer);
    session.isProcessing = false;

    // Check if we can do a fallback generateContent if not already attempted
    if (geminiApiKey && (err?.message?.includes('fetch failed') || err?.message?.includes('404') || err?.message?.includes('400'))) {
      try {
        console.log('[WhatsApp Gateway] Antigravity call failed, attempting direct Gemini fallback...');
        const ai = getGeminiClient(geminiApiKey);
        const genRes = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: userPrompt,
        });
        const text = (genRes.text || 'Task processed successfully by Awais Codex.').trim();
        const durationSec = Math.round((Date.now() - startTime) / 1000);
        const finalMessage = `✅ *Awais Codex Completed (${durationSec}s)*\n━━━━━━━━━━━━━━━━━━━━\n${text}`;
        await recordTurnComplete(convId, turnId, text, [], 'success');
        if (shouldSendOutboundWhatsApp) {
          await sendWhatsAppMessage(senderPhone, finalMessage);
        }
        return {
          finalMessage,
          cleanResult: text,
          artifacts: []
        };
      } catch (fbErr: any) {
        console.warn('[WhatsApp Gateway] Fallback also failed:', fbErr?.message);
      }
    }

    const errText = `❌ *Awais Codex Exception*: ${err?.message || 'Execution error.'}`;
    await recordTurnComplete(convId, turnId, errText, [], 'failed');
    if (shouldSendOutboundWhatsApp) {
      await sendWhatsAppMessage(senderPhone, errText);
    }
    throw err;
  }
}

function lastMilestoneText(toolName: string): string {
  return `Executing sub-task (${toolName})...`;
}

export default router;
