import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type MemoryCategory = 'preference' | 'fact' | 'project' | 'instruction' | 'learning';

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  key?: string;
  content: string;
  source: 'web' | 'whatsapp' | 'manual' | 'auto_extracted';
  tags: string[];
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastRecalledAt?: number;
}

export interface UserProfileMemory {
  name?: string;
  role?: string;
  preferredLanguage?: string;
  preferredFrameworks?: string[];
  environment?: string;
  customDirectives?: string[];
  attributes: Record<string, any>;
  updatedAt: number;
}

export interface PersistentMemoryStore {
  version: string;
  profile: UserProfileMemory;
  memories: MemoryItem[];
}

const DATA_DIR = path.join(process.cwd(), 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'agent-memory.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// In-process Async Lock / Mutex for atomic memory reads and writes
let memoryFileMutex = Promise.resolve();

async function withMemoryLock<T>(fn: () => T | Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const nextLock = new Promise<void>(resolve => {
    release = resolve;
  });

  const previousLock = memoryFileMutex;
  memoryFileMutex = previousLock.then(() => nextLock);

  try {
    await previousLock;
    return await fn();
  } finally {
    release();
  }
}

function getDefaultStore(): PersistentMemoryStore {
  return {
    version: '1.0.0',
    profile: {
      name: 'Awais Ali',
      role: 'Software Engineer & Project Architect',
      preferredLanguage: 'TypeScript / Python',
      preferredFrameworks: ['React', 'Node.js', 'TailwindCSS', 'Express'],
      environment: 'Full-stack Web & Mobile Android',
      customDirectives: [
        'Write clean, modular, production-ready code with complete implementations',
        'Maintain persistent cross-session awareness of projects and preferences'
      ],
      attributes: {},
      updatedAt: Date.now()
    },
    memories: [
      {
        id: 'mem_core_init',
        category: 'instruction',
        key: 'core_directive',
        content: 'Assistant is Awais Codex, powered exclusively by the Antigravity preview engine, with persistent cross-session memory.',
        source: 'manual',
        tags: ['core', 'identity'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 1
      }
    ]
  };
}

/**
 * Load memory store from disk
 */
export function loadMemoryStore(): PersistentMemoryStore {
  try {
    ensureDataDir();
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.memories)) {
        if (!parsed.profile) parsed.profile = getDefaultStore().profile;
        if (!parsed.profile.attributes) parsed.profile.attributes = {};
        if (!parsed.profile.customDirectives) parsed.profile.customDirectives = [];
        return parsed;
      }
    }
  } catch (err) {
    console.error('[Memory Engine] Failed to load memory store:', err);
  }

  const initial = getDefaultStore();
  saveMemoryStore(initial);
  return initial;
}

/**
 * Save memory store to disk safely
 */
export function saveMemoryStore(store: PersistentMemoryStore) {
  try {
    ensureDataDir();
    const tempFile = `${MEMORY_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(store, null, 2), 'utf-8');
    if (fs.existsSync(MEMORY_FILE)) {
      try { fs.unlinkSync(MEMORY_FILE); } catch (_) {}
    }
    fs.renameSync(tempFile, MEMORY_FILE);
  } catch (err) {
    console.error('[Memory Engine] Failed to save memory store:', err);
  }
}

/**
 * Add a new memory item
 */
export async function addMemoryItem(item: {
  category: MemoryCategory;
  content: string;
  key?: string;
  source?: 'web' | 'whatsapp' | 'manual' | 'auto_extracted';
  tags?: string[];
}): Promise<MemoryItem> {
  return withMemoryLock(() => {
    const store = loadMemoryStore();
    const cleanContent = item.content.trim();
    if (!cleanContent) throw new Error('Memory content cannot be empty');

    // Check for duplicate / existing similar memory
    const existing = store.memories.find(m => 
      (item.key && m.key && m.key.toLowerCase() === item.key.toLowerCase()) ||
      m.content.toLowerCase() === cleanContent.toLowerCase()
    );

    if (existing) {
      existing.content = cleanContent;
      existing.updatedAt = Date.now();
      existing.accessCount = (existing.accessCount || 0) + 1;
      if (item.tags && item.tags.length > 0) {
        existing.tags = Array.from(new Set([...existing.tags, ...item.tags]));
      }
      saveMemoryStore(store);
      return existing;
    }

    const newMemory: MemoryItem = {
      id: `mem_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      category: item.category || 'fact',
      key: item.key?.trim(),
      content: cleanContent,
      source: item.source || 'auto_extracted',
      tags: item.tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0
    };

    store.memories.unshift(newMemory);
    saveMemoryStore(store);
    return newMemory;
  });
}

/**
 * Update memory item by ID
 */
export async function updateMemoryItem(id: string, updates: Partial<MemoryItem>): Promise<MemoryItem | null> {
  return withMemoryLock(() => {
    const store = loadMemoryStore();
    const idx = store.memories.findIndex(m => m.id === id);
    if (idx === -1) return null;

    const item = store.memories[idx];
    if (updates.content !== undefined) item.content = updates.content.trim();
    if (updates.category !== undefined) item.category = updates.category;
    if (updates.key !== undefined) item.key = updates.key.trim();
    if (updates.tags !== undefined) item.tags = updates.tags;
    item.updatedAt = Date.now();

    store.memories[idx] = item;
    saveMemoryStore(store);
    return item;
  });
}

/**
 * Delete a memory item
 */
export async function deleteMemoryItem(id: string): Promise<boolean> {
  return withMemoryLock(() => {
    const store = loadMemoryStore();
    const initLen = store.memories.length;
    store.memories = store.memories.filter(m => m.id !== id);
    const deleted = store.memories.length < initLen;
    if (deleted) saveMemoryStore(store);
    return deleted;
  });
}

/**
 * Update user profile
 */
export async function updateUserProfile(updates: Partial<UserProfileMemory>): Promise<UserProfileMemory> {
  return withMemoryLock(() => {
    const store = loadMemoryStore();
    if (!store.profile) store.profile = getDefaultStore().profile;

    if (updates.name !== undefined) store.profile.name = updates.name.trim();
    if (updates.role !== undefined) store.profile.role = updates.role.trim();
    if (updates.preferredLanguage !== undefined) store.profile.preferredLanguage = updates.preferredLanguage.trim();
    if (updates.preferredFrameworks !== undefined) store.profile.preferredFrameworks = updates.preferredFrameworks;
    if (updates.environment !== undefined) store.profile.environment = updates.environment.trim();
    if (updates.customDirectives !== undefined) store.profile.customDirectives = updates.customDirectives;
    if (updates.attributes !== undefined) {
      store.profile.attributes = { ...store.profile.attributes, ...updates.attributes };
    }
    store.profile.updatedAt = Date.now();

    saveMemoryStore(store);
    return store.profile;
  });
}

/**
 * Clear all memories
 */
export async function clearAllMemories(): Promise<void> {
  return withMemoryLock(() => {
    const fresh = getDefaultStore();
    saveMemoryStore(fresh);
  });
}

/**
 * Score relevance of a memory item against user prompt
 */
function scoreRelevance(memory: MemoryItem, promptTokens: string[]): number {
  let score = 0;
  const contentLower = memory.content.toLowerCase();
  const keyLower = (memory.key || '').toLowerCase();
  const tagsLower = memory.tags.map(t => t.toLowerCase());

  for (const token of promptTokens) {
    if (token.length < 3) continue;
    if (contentLower.includes(token)) score += 3;
    if (keyLower.includes(token)) score += 4;
    if (tagsLower.includes(token)) score += 5;
  }

  // Categories like instruction and preference are inherently higher value
  if (memory.category === 'instruction') score += 2;
  if (memory.category === 'preference') score += 1.5;

  return score;
}

/**
 * Retrieve memories relevant to the query
 */
export function retrieveRelevantMemories(prompt: string, limit = 8): MemoryItem[] {
  const store = loadMemoryStore();
  if (store.memories.length === 0) return [];

  const cleanPrompt = prompt.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ');
  const tokens = Array.from(new Set(cleanPrompt.split(/\s+/).filter(Boolean)));

  const scored = store.memories.map(m => ({
    memory: m,
    score: scoreRelevance(m, tokens)
  }));

  // Sort by score descending, then by updated date
  scored.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);

  // Take top items
  const results = scored.slice(0, limit).map(s => s.memory);

  // Update access metadata asynchronously
  withMemoryLock(() => {
    const s = loadMemoryStore();
    results.forEach(res => {
      const match = s.memories.find(m => m.id === res.id);
      if (match) {
        match.accessCount = (match.accessCount || 0) + 1;
        match.lastRecalledAt = Date.now();
      }
    });
    saveMemoryStore(s);
  }).catch(() => {});

  return results;
}

/**
 * Formats long-term memories and profile into a system prompt augmentation block
 */
export function formatMemoryContextBlock(prompt: string): string {
  const store = loadMemoryStore();
  const relevant = retrieveRelevantMemories(prompt, 6);
  const profile = store.profile || {};

  const lines: string[] = [];
  lines.push('### [PERSISTENT MEMORY SYSTEM - CROSS-SESSION CONTEXT]');
  lines.push('You have long-term persistent memory across all conversations. The following context is retrieved from previous interactions:');

  if (profile.name || profile.role || profile.preferredLanguage || (profile.customDirectives && profile.customDirectives.length > 0)) {
    lines.push('\n**User Profile & Directives:**');
    if (profile.name) lines.push(`- User Name: ${profile.name}`);
    if (profile.role) lines.push(`- User Role: ${profile.role}`);
    if (profile.preferredLanguage) lines.push(`- Preferred Language: ${profile.preferredLanguage}`);
    if (profile.preferredFrameworks && profile.preferredFrameworks.length > 0) {
      lines.push(`- Preferred Frameworks / Tools: ${profile.preferredFrameworks.join(', ')}`);
    }
    if (profile.customDirectives && profile.customDirectives.length > 0) {
      profile.customDirectives.forEach(d => lines.push(`- Directive: ${d}`));
    }
  }

  if (relevant.length > 0) {
    lines.push('\n**Recalled Cross-Chat Memories:**');
    relevant.forEach(m => {
      const catBadge = `[${m.category.toUpperCase()}]`;
      lines.push(`- ${catBadge} ${m.content}`);
    });
  }

  lines.push('\n*Instruction: Utilize this remembered context naturally to provide tailored, continuous assistance without needing the user to repeat themselves.*');
  lines.push('### [END PERSISTENT MEMORY]\n');

  return lines.join('\n');
}

/**
 * Injects memory context into an incoming task prompt
 */
export function injectMemoryIntoPrompt(userPrompt: string): string {
  const memoryBlock = formatMemoryContextBlock(userPrompt);
  return `${memoryBlock}\n${userPrompt}`;
}

/**
 * Autonomous Memory Extractor
 * Automatically extracts facts, preferences, and project updates from a completed interaction
 */
export async function extractAndStoreMemories(
  prompt: string,
  outputText: string,
  apiKey?: string,
  source: 'web' | 'whatsapp' = 'web'
): Promise<void> {
  const trimmedPrompt = prompt.trim();
  const trimmedOutput = outputText.trim();
  if (!trimmedPrompt || !trimmedOutput) return;

  // 1. Fast Pattern Matching for direct user declarations
  const lower = trimmedPrompt.toLowerCase();

  // Name extraction (strictly explicit name declarations to prevent false positives)
  const nameMatch = trimmedPrompt.match(/(?:my name is|call me)\s+([A-Z][a-zA-Z]{1,15}(?:\s+[A-Z][a-zA-Z]{1,15})?)\b/i);
  if (nameMatch) {
    const candidateName = nameMatch[1].trim();
    if (candidateName.length > 1 && candidateName.length < 25) {
      await updateUserProfile({ name: candidateName });
      await addMemoryItem({
        category: 'preference',
        key: 'user_name',
        content: `User's preferred name is ${candidateName}`,
        source,
        tags: ['profile', 'name']
      });
    }
  }

  // Explicit "Remember:" or "Remember that:" command
  const rememberMatch = trimmedPrompt.match(/(?:remember(?:\s+that)?|note(?:\s+that)?|keep in mind(?:\s+that)?):\s*(.+)/i)
    || trimmedPrompt.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.+)/i);

  if (rememberMatch && rememberMatch[1]) {
    const fact = rememberMatch[1].trim();
    if (fact.length > 5) {
      await addMemoryItem({
        category: 'instruction',
        content: fact,
        source,
        tags: ['explicit_instruction']
      });
    }
  }

  // Preference detection ("I prefer X", "Always use X", "I use X for...")
  const preferMatch = trimmedPrompt.match(/(?:i prefer|always use|i always use|i like using)\s+([a-zA-Z0-9_#+\-\.\s]{3,40})/i);
  if (preferMatch && preferMatch[1]) {
    const pref = preferMatch[1].trim();
    await addMemoryItem({
      category: 'preference',
      content: `User prefers: ${pref}`,
      source,
      tags: ['preference']
    });
  }
}
