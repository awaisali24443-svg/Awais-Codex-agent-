/**
 * Persistent memory — the "it remembers you" system, rebuilt on Postgres.
 *
 * v1 stored this in a JSON file guarded by a hand-rolled promise mutex, and
 * hard-coded the operator's name into the seed. v2 gets the tables from
 * `001_init.sql` and this file gives them behaviour:
 *
 *   `memories`        recalled facts, preferences and standing instructions
 *   `memory_profile`  the single-row profile (name, role, stack, directives)
 *
 * Three rules shape every function here:
 *
 *   MEMORY MUST NEVER BREAK A MISSION
 *     Recall and extraction are best effort and wrapped. A memory failure logs
 *     and returns the prompt unchanged — the agent still runs. Losing a
 *     preference is annoying; losing a ten-minute mission because a SELECT
 *     timed out is not acceptable.
 *
 *   RECALL IS LEXICAL, AND SAYS SO
 *     No embeddings, no vector database, no extra dependency: a token overlap
 *     score with category bias. It is deterministic and fast, and it is blind
 *     to synonyms — "postgres" does not find "database". Standing instructions
 *     are always included, because a directive does not stop applying just
 *     because this prompt happens not to mention it.
 *
 *   THE USER'S WORDS ARE THE ONLY SOURCE
 *     Extraction reads the *prompt* — what the operator actually typed or sent
 *     from their phone — and only for explicit declarations ("remember that",
 *     "my name is", "I prefer"). It never infers from model output. That keeps
 *     the store trustworthy: everything in it was said on purpose.
 */
import type { Db } from './db.js';
import { newId, type RunKind } from './runs.js';

export type MemoryCategory = 'preference' | 'fact' | 'project' | 'instruction' | 'learning';
export type MemorySource = 'web' | 'whatsapp' | 'manual' | 'auto_extracted';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'preference',
  'fact',
  'project',
  'instruction',
  'learning',
];

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export function isMemorySource(value: unknown): value is MemorySource {
  return (
    value === 'web' || value === 'whatsapp' || value === 'manual' || value === 'auto_extracted'
  );
}

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  key: string | null;
  content: string;
  source: MemorySource;
  tags: string[];
  accessCount: number;
  lastRecalledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProfile {
  name: string | null;
  role: string | null;
  preferredLanguage: string | null;
  preferredFrameworks: string[];
  environment: string | null;
  customDirectives: string[];
  attributes: Record<string, unknown>;
  updatedAt: string | null;
}

/** How many memories one prompt may carry. Each one costs tokens in the call. */
export const DEFAULT_RECALL_LIMIT = 6;

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string;
  category: MemoryCategory;
  key: string | null;
  content: string;
  source: MemorySource;
  tags: unknown;
  access_count: number;
  last_recalled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProfileRow {
  name: string | null;
  role: string | null;
  preferred_language: string | null;
  preferred_frameworks: unknown;
  environment: string | null;
  custom_directives: unknown;
  attributes: unknown;
  updated_at: Date | string | null;
}

const MEMORY_COLUMNS = `id, category, key, content, source, tags,
                        access_count, last_recalled_at, created_at, updated_at`;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * jsonb arrives parsed from `pg` and from PGlite, but a driver change — or a
 * row written by hand as a JSON string — should not turn tags into `"[object"`.
 */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }
  return [];
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function mapMemory(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    category: row.category,
    key: row.key,
    content: row.content,
    source: row.source,
    tags: toStringArray(row.tags),
    accessCount: Number(row.access_count ?? 0),
    lastRecalledAt: toIso(row.last_recalled_at),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

function mapProfile(row: ProfileRow | undefined): MemoryProfile {
  return {
    name: row?.name ?? null,
    role: row?.role ?? null,
    preferredLanguage: row?.preferred_language ?? null,
    preferredFrameworks: toStringArray(row?.preferred_frameworks),
    environment: row?.environment ?? null,
    customDirectives: toStringArray(row?.custom_directives),
    attributes: toRecord(row?.attributes),
    updatedAt: toIso(row?.updated_at ?? null),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listMemories(db: Db, limit = 200): Promise<MemoryItem[]> {
  const rows = await db.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(mapMemory);
}

export async function countMemories(db: Db): Promise<number> {
  const rows = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM memories');
  return Number(rows[0]?.count ?? 0);
}

export async function getMemory(db: Db, id: string): Promise<MemoryItem | null> {
  const rows = await db.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapMemory(rows[0]) : null;
}

export interface AddMemoryInput {
  category?: MemoryCategory;
  content: string;
  key?: string | null;
  source?: MemorySource;
  tags?: string[];
}

/**
 * Add or merge one memory.
 *
 * v1's rule, kept because it is the right one: an item with the same `key`, or
 * the same content, is *the same fact* — so it is updated and its tags merged
 * rather than stored twice. Without this the store fills with a dozen copies of
 * "prefers TypeScript" and recall returns nothing but duplicates.
 *
 * The unique indexes are the real guarantee; the pre-read exists to produce the
 * merge behaviour rather than a conflict error.
 */
export async function addMemory(
  db: Db,
  input: AddMemoryInput,
): Promise<{ item: MemoryItem; created: boolean }> {
  const content = input.content.trim();
  if (!content) throw new Error('addMemory: content is empty');

  const category = isMemoryCategory(input.category) ? input.category : 'fact';
  const source = isMemorySource(input.source) ? input.source : 'manual';
  const key = (input.key ?? '').trim() || null;
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))];

  const existing = await findExisting(db, key, content);
  if (existing) {
    const mergedTags = [...new Set([...existing.tags, ...tags])];
    const rows = await db.query<MemoryRow>(
      `UPDATE memories
          SET content = $2, category = $3, tags = $4::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING ${MEMORY_COLUMNS}`,
      [existing.id, content, category, JSON.stringify(mergedTags)],
    );
    return { item: rows[0] ? mapMemory(rows[0]) : existing, created: false };
  }

  const id = newId('mem');
  const rows = await db.query<MemoryRow>(
    `INSERT INTO memories (id, category, key, content, source, tags)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT DO NOTHING
       RETURNING ${MEMORY_COLUMNS}`,
    [id, category, key, content, source, JSON.stringify(tags)],
  );

  if (rows[0]) return { item: mapMemory(rows[0]), created: true };

  // Lost a race with a simultaneous insert of the same fact: merge into theirs.
  const raced = await findExisting(db, key, content);
  if (raced) return { item: raced, created: false };
  throw new Error('addMemory: insert conflicted but the existing row could not be read');
}

async function findExisting(db: Db, key: string | null, content: string): Promise<MemoryItem | null> {
  const rows = key
    ? await db.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM memories
          WHERE lower(key) = lower($1) OR lower(content) = lower($2)
          ORDER BY (lower(key) = lower($1)) DESC
          LIMIT 1`,
        [key, content],
      )
    : await db.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM memories WHERE lower(content) = lower($1) LIMIT 1`,
        [content],
      );
  return rows[0] ? mapMemory(rows[0]) : null;
}

/**
 * Patch one memory.
 *
 * Absent fields keep their value — `key` included, which needs an explicit flag
 * rather than COALESCE because clearing a key is a legitimate edit and "set it
 * to null" is indistinguishable from "do not touch it" in a plain parameter.
 */
export async function updateMemory(
  db: Db,
  id: string,
  patch: { category?: MemoryCategory; content?: string; key?: string | null; tags?: string[] },
): Promise<MemoryItem | null> {
  const hasKey = Object.prototype.hasOwnProperty.call(patch, 'key');

  const rows = await db.query<MemoryRow>(
    `UPDATE memories
        SET category   = COALESCE($2, category),
            content    = COALESCE($3, content),
            key        = CASE WHEN $4 THEN $5 ELSE key END,
            tags       = CASE WHEN $6::jsonb IS NULL THEN tags ELSE $6::jsonb END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${MEMORY_COLUMNS}`,
    [
      id,
      isMemoryCategory(patch.category) ? patch.category : null,
      patch.content?.trim() || null,
      hasKey,
      hasKey ? patch.key?.trim() || null : null,
      patch.tags ? JSON.stringify(patch.tags) : null,
    ],
  );
  return rows[0] ? mapMemory(rows[0]) : null;
}

export async function deleteMemory(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>('DELETE FROM memories WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

/** Forget everything. The profile survives — it is identity, not recollection. */
export async function clearMemories(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>('DELETE FROM memories RETURNING id');
  return rows.length;
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

/**
 * The profile is one row, created on first read.
 *
 * No personal details are seeded. v1 shipped with the operator's name and
 * stack compiled into the source as "defaults", which meant a fresh clone
 * claimed to know a stranger and there was no way to tell seeded data from
 * learned data. An empty profile that fills from what you actually say is both
 * honest and, in the end, more accurate.
 */
export async function getProfile(db: Db): Promise<MemoryProfile> {
  await db.query('INSERT INTO memory_profile (id) VALUES (1) ON CONFLICT DO NOTHING');
  const rows = await db.query<ProfileRow>(
    `SELECT name, role, preferred_language, preferred_frameworks, environment,
            custom_directives, attributes, updated_at
       FROM memory_profile WHERE id = 1`,
  );
  return mapProfile(rows[0]);
}

export interface ProfilePatch {
  name?: string | null;
  role?: string | null;
  preferredLanguage?: string | null;
  preferredFrameworks?: string[];
  environment?: string | null;
  customDirectives?: string[];
  attributes?: Record<string, unknown>;
}

export async function updateProfile(db: Db, patch: ProfilePatch): Promise<MemoryProfile> {
  await getProfile(db); // ensure the row exists

  const clean = (value: string | null | undefined): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

  await db.query(
    `UPDATE memory_profile
        SET name                 = COALESCE($1, name),
            role                 = COALESCE($2, role),
            preferred_language   = COALESCE($3, preferred_language),
            preferred_frameworks = CASE WHEN $4::jsonb IS NULL THEN preferred_frameworks
                                        ELSE $4::jsonb END,
            environment          = COALESCE($5, environment),
            custom_directives    = CASE WHEN $6::jsonb IS NULL THEN custom_directives
                                        ELSE $6::jsonb END,
            attributes           = CASE WHEN $7::jsonb IS NULL THEN attributes
                                        ELSE attributes || $7::jsonb END,
            updated_at           = now()
      WHERE id = 1`,
    [
      clean(patch.name),
      clean(patch.role),
      clean(patch.preferredLanguage),
      patch.preferredFrameworks ? JSON.stringify(patch.preferredFrameworks) : null,
      clean(patch.environment),
      patch.customDirectives ? JSON.stringify(patch.customDirectives) : null,
      patch.attributes ? JSON.stringify(patch.attributes) : null,
    ],
  );

  return getProfile(db);
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

/** Split a prompt into comparable tokens. Exported so the scorer is testable. */
export function tokenize(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ');
  return [...new Set(cleaned.split(/\s+/).filter((token) => token.length >= 3))];
}

/**
 * Score one memory against the prompt's tokens.
 *
 * The weights are v1's, kept because they express a deliberate priority: a tag
 * match means someone filed it under that word, a key match means it is a
 * named fact, a plain content match is weakest, and a standing instruction or
 * preference outranks trivia even before any word matches.
 */
export function scoreRelevance(memory: MemoryItem, tokens: string[]): number {
  let score = 0;
  const content = memory.content.toLowerCase();
  const key = (memory.key ?? '').toLowerCase();
  const tags = memory.tags.map((tag) => tag.toLowerCase());

  for (const token of tokens) {
    if (content.includes(token)) score += 3;
    if (key && key.includes(token)) score += 4;
    if (tags.includes(token)) score += 5;
  }

  if (memory.category === 'instruction') score += 2;
  if (memory.category === 'preference') score += 1.5;
  return score;
}

export interface RecallOptions {
  limit?: number;
  /** Bump access_count / last_recalled_at. Off for read-only probes like /search. */
  track?: boolean;
}

/**
 * The memories that should ride along with this prompt.
 *
 * A directive is always included: "always answer in Urdu" does not stop
 * applying because this particular message never says the word. Everything else
 * must earn its place with a token match, so an unrelated prompt does not drag
 * the whole store into the call.
 */
export async function recallMemories(
  db: Db,
  prompt: string,
  options: RecallOptions = {},
): Promise<MemoryItem[]> {
  const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
  const all = await listMemories(db, 500);
  if (all.length === 0) return [];

  const tokens = tokenize(prompt);
  const scored = all
    .map((memory) => ({ memory, score: scoreRelevance(memory, tokens) }))
    .filter(({ memory, score }) => score > 0 || memory.category === 'instruction')
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.memory.updatedAt).getTime() - new Date(a.memory.updatedAt).getTime(),
    );

  const chosen = scored.slice(0, Math.max(1, limit)).map((entry) => entry.memory);

  if (options.track !== false && chosen.length > 0) {
    // Fire and forget: usage metadata is bookkeeping, and a failure to write it
    // must not cost the mission its memories.
    //
    // Placeholders rather than `= ANY($1::text[])`: node-postgres and PGlite do
    // not agree on array parameters (budget.ts documents the same trap), and a
    // silent no-match here would look like "recall is broken".
    const ids = chosen.map((memory) => memory.id);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
    void db
      .query(
        `UPDATE memories SET access_count = access_count + 1, last_recalled_at = now()
          WHERE id IN (${placeholders})`,
        ids,
      )
      .catch(() => undefined);
  }

  return chosen;
}

// ---------------------------------------------------------------------------
// prompt composition
// ---------------------------------------------------------------------------

/**
 * Render the profile and recalled memories as a delimited prompt block.
 *
 * Exported separately from the injection so it can be tested as text, and so a
 * caller can decide to use it without touching the database.
 */
export function formatMemoryBlock(profile: MemoryProfile, memories: MemoryItem[]): string {
  const lines: string[] = [];
  lines.push('### [PERSISTENT MEMORY — CROSS-SESSION CONTEXT]');
  lines.push(
    'The following is remembered from earlier sessions. Use it naturally; do not recite it back.',
  );

  const profileLines: string[] = [];
  if (profile.name) profileLines.push(`- Name: ${profile.name}`);
  if (profile.role) profileLines.push(`- Role: ${profile.role}`);
  if (profile.preferredLanguage) profileLines.push(`- Preferred language: ${profile.preferredLanguage}`);
  if (profile.preferredFrameworks.length > 0) {
    profileLines.push(`- Preferred stack: ${profile.preferredFrameworks.join(', ')}`);
  }
  if (profile.environment) profileLines.push(`- Working environment: ${profile.environment}`);
  for (const directive of profile.customDirectives) profileLines.push(`- Directive: ${directive}`);

  if (profileLines.length > 0) {
    lines.push('', '**Who you are working for:**', ...profileLines);
  }

  if (memories.length > 0) {
    lines.push('', '**Recalled from memory:**');
    for (const memory of memories) {
      lines.push(`- [${memory.category.toUpperCase()}] ${memory.content}`);
    }
  }

  lines.push('### [END PERSISTENT MEMORY]');
  return lines.join('\n');
}

/** True when the block would carry nothing worth its tokens. */
export function profileIsEmpty(profile: MemoryProfile): boolean {
  return (
    !profile.name &&
    !profile.role &&
    !profile.preferredLanguage &&
    !profile.environment &&
    profile.preferredFrameworks.length === 0 &&
    profile.customDirectives.length === 0
  );
}

export interface MemoryContext {
  /** The prompt to send: memory block prepended, or the original untouched. */
  prompt: string;
  recalled: MemoryItem[];
  profile: MemoryProfile;
  /** False when there was nothing to add, or when memory could not be read. */
  applied: boolean;
}

/**
 * Recall context and prepend it to the prompt.
 *
 * Never throws. This runs inside every mission, so a database blip must
 * degrade to "no memory this time" rather than failing the task.
 */
export async function applyMemory(
  db: Db,
  prompt: string,
  options: RecallOptions = {},
): Promise<MemoryContext> {
  try {
    const profile = await getProfile(db);
    const recalled = await recallMemories(db, prompt, options);

    if (profileIsEmpty(profile) && recalled.length === 0) {
      return { prompt, recalled: [], profile, applied: false };
    }

    return {
      prompt: `${formatMemoryBlock(profile, recalled)}\n\n${prompt}`,
      recalled,
      profile,
      applied: true,
    };
  } catch (err) {
    console.warn('[memory] recall skipped:', (err as Error).message);
    const empty: MemoryProfile = {
      name: null,
      role: null,
      preferredLanguage: null,
      preferredFrameworks: [],
      environment: null,
      customDirectives: [],
      attributes: {},
      updatedAt: null,
    };
    return { prompt, recalled: [], profile: empty, applied: false };
  }
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

export interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
  key?: string;
  tags: string[];
  /** Set only for a name declaration, so the profile can be updated directly. */
  profileName?: string;
}

/** Words that look like a name to a regex and are not one. */
const NOT_A_NAME = new Set([
  'not',
  'no',
  'still',
  'fine',
  'good',
  'ok',
  'okay',
  'sorry',
  'curious',
  'here',
  'back',
  'done',
  'tired',
  'late',
  'busy',
  'sure',
]);

/**
 * Words that cannot be the *second* part of a name.
 *
 * Without this, "my name is Awais and remember that: …" makes the operator's
 * name "Awais and" — a bug that is invisible until the agent greets you by it.
 * A sentence continues; a surname does not start with a conjunction.
 */
const NOT_A_SURNAME = new Set([
  'and',
  'or',
  'but',
  'so',
  'then',
  'now',
  'also',
  'please',
  'thanks',
  'thank',
  'the',
  'a',
  'an',
  'who',
  'which',
  'from',
  'in',
  'at',
  'on',
  'with',
  'for',
  'to',
  'of',
  'is',
  'was',
  'i',
]);

/**
 * Pull explicit declarations out of what the operator wrote.
 *
 * Pure and synchronous so it can be tested exhaustively, and deliberately
 * narrow: only statements where the user is *telling* the agent something. A
 * false positive here is worse than a missed one — a wrong memory follows the
 * user into every future session, and they will not know why.
 */
export function extractMemories(prompt: string): ExtractedMemory[] {
  const found: ExtractedMemory[] = [];
  const text = prompt.trim();
  if (!text) return found;

  // "my name is Awais", "call me Awais"
  const name = text.match(/(?:my name is|call me)\s+([A-Za-z][A-Za-z'’-]{1,20}(?:\s+[A-Za-z][A-Za-z'’-]{1,20})?)/i);
  if (name) {
    const words = name[1].trim().split(/\s+/);
    // The first word decides whether this is a declaration at all: "my name is
    // not important" is a sentence, not a name. The second is kept only when it
    // could plausibly be a surname, so "Awais and remember that: …" yields
    // "Awais" rather than "Awais and".
    const firstWord = words[0].toLowerCase();
    if (!NOT_A_NAME.has(firstWord) && words[0].length > 1) {
      const surname = words[1] && !NOT_A_SURNAME.has(words[1].toLowerCase()) ? words[1] : null;
      const candidate = surname ? `${words[0]} ${surname}` : words[0];
      found.push({
        category: 'fact',
        key: 'user_name',
        content: `The user's name is ${candidate}`,
        tags: ['profile', 'name'],
        profileName: candidate,
      });
    }
  }

  // "remember that: the API key lives in .env" / "note that …" / "keep in mind …"
  const remember =
    text.match(/(?:remember(?:\s+that)?|note(?:\s+that)?|keep in mind(?:\s+that)?)\s*[:\-]\s*(.+)/i) ??
    text.match(/^(?:please\s+)?(?:remember|note)\s+(?:that\s+)?(.+)/i);
  if (remember?.[1]) {
    const fact = remember[1].trim().replace(/\s+/g, ' ').slice(0, 400);
    if (fact.length > 5) {
      found.push({ category: 'instruction', content: fact, tags: ['explicit_instruction'] });
    }
  }

  // "I prefer pnpm", "always use TypeScript", "I like using Tailwind"
  const preference = text.match(
    /(?:i prefer|i always use|always use|i like using|i use)\s+([A-Za-z0-9_#+.\-/ ]{2,40})/i,
  );
  if (preference?.[1]) {
    const value = preference[1].trim().replace(/[.,;:]$/, '').replace(/\s+/g, ' ');
    if (value.length >= 2) {
      found.push({
        category: 'preference',
        content: `The user prefers ${value}`,
        key: `prefers:${value.toLowerCase().slice(0, 40)}`,
        tags: ['preference'],
      });
    }
  }

  // "we're building X" / "the project is called X"
  const project = text.match(/(?:we are building|we're building|the project is called|the project is)\s+(.{3,80})/i);
  if (project?.[1]) {
    const value = project[1].trim().replace(/\s+/g, ' ').replace(/[.,;:]$/, '');
    if (value.length >= 3) {
      found.push({
        category: 'project',
        content: `Project in progress: ${value}`,
        tags: ['project'],
      });
    }
  }

  return found;
}

/** Which channel taught us this. */
export function sourceForKind(kind: RunKind): MemorySource {
  if (kind === 'whatsapp') return 'whatsapp';
  if (kind === 'api') return 'auto_extracted';
  return 'web';
}

/**
 * Learn from a finished mission. Called after the run is closed, never before,
 * so extraction can never delay or fail the run itself.
 */
export async function extractAndStoreMemories(
  db: Db,
  prompt: string,
  source: MemorySource,
): Promise<MemoryItem[]> {
  const stored: MemoryItem[] = [];
  try {
    for (const candidate of extractMemories(prompt)) {
      if (candidate.profileName) {
        await updateProfile(db, { name: candidate.profileName });
      }
      const { item, created } = await addMemory(db, {
        category: candidate.category,
        content: candidate.content,
        key: candidate.key,
        source,
        tags: candidate.tags,
      });
      if (created) stored.push(item);
    }
    if (stored.length > 0) {
      console.log(`[memory] learned ${stored.length} item(s) from a ${source} mission`);
    }
  } catch (err) {
    console.warn('[memory] extraction skipped:', (err as Error).message);
  }
  return stored;
}
