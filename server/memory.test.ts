/**
 * Persistent memory tests.
 *
 * Memory is the feature with the worst failure mode in the whole product: a
 * wrong memory follows the operator into every future session, and they will
 * not know why. So the interesting tests here are not "does it store" — they
 * are the ones about *not* storing: dedup, explicit declarations only, and the
 * promise that a memory fault can never fail a mission.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import {
  addMemory,
  applyMemory,
  clearMemories,
  countMemories,
  deleteMemory,
  extractMemories,
  extractAndStoreMemories,
  formatMemoryBlock,
  getProfile,
  listMemories,
  profileIsEmpty,
  recallMemories,
  scoreRelevance,
  sourceForKind,
  tokenize,
  updateMemory,
  updateProfile,
  type MemoryItem,
} from './memory.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await clearMemories(db);
  await db.query('DELETE FROM memory_profile');
});

function memory(partial: Partial<MemoryItem>): MemoryItem {
  return {
    id: 'mem_x',
    category: 'fact',
    key: null,
    content: '',
    source: 'manual',
    tags: [],
    accessCount: 0,
    lastRecalledAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe('the store', () => {
  test('stores and reads back a memory', async () => {
    const { item, created } = await addMemory(db, {
      category: 'preference',
      content: 'The user prefers pnpm over npm',
      tags: ['tooling'],
    });
    assert.equal(created, true);
    assert.equal(item.category, 'preference');
    assert.deepEqual(item.tags, ['tooling']);

    const all = await listMemories(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].content, 'The user prefers pnpm over npm');
    assert.equal(await countMemories(db), 1);
  });

  test('merges a repeated fact instead of storing it twice', async () => {
    const first = await addMemory(db, { content: 'User prefers dark mode', tags: ['ui'] });
    const second = await addMemory(db, { content: 'user prefers dark mode', tags: ['theme'] });

    assert.equal(second.created, false);
    assert.equal(second.item.id, first.item.id);
    assert.deepEqual(second.item.tags.sort(), ['theme', 'ui']);
    assert.equal(await countMemories(db), 1);
  });

  test('merges on a matching key even when the wording changed', async () => {
    await addMemory(db, { key: 'user_name', content: "The user's name is Awais" });
    const renamed = await addMemory(db, { key: 'user_name', content: "The user's name is Awais Ali" });

    assert.equal(renamed.created, false);
    assert.equal(await countMemories(db), 1);
    assert.equal(renamed.item.content, "The user's name is Awais Ali");
  });

  test('refuses empty content rather than storing a blank memory', async () => {
    await assert.rejects(() => addMemory(db, { content: '   ' }), /content is empty/);
  });

  test('updates, deletes, and clears', async () => {
    const { item } = await addMemory(db, { content: 'Uses PostgreSQL 14' });

    const updated = await updateMemory(db, item.id, { content: 'Uses PostgreSQL 17', category: 'fact' });
    assert.equal(updated?.content, 'Uses PostgreSQL 17');

    assert.equal(await deleteMemory(db, item.id), true);
    assert.equal(await deleteMemory(db, item.id), false);

    await addMemory(db, { content: 'one' });
    await addMemory(db, { content: 'two' });
    assert.equal(await clearMemories(db), 2);
    assert.equal(await countMemories(db), 0);
  });

  test('a cleared key actually clears, and an absent one is untouched', async () => {
    const { item } = await addMemory(db, { key: 'user_name', content: 'name' });

    const kept = await updateMemory(db, item.id, { content: 'name v2' });
    assert.equal(kept?.key, 'user_name', 'an omitted key must survive the update');

    const cleared = await updateMemory(db, item.id, { key: null });
    assert.equal(cleared?.key, null);
  });
});

describe('the profile', () => {
  test('starts empty rather than pretending to know you', async () => {
    const profile = await getProfile(db);
    assert.equal(profile.name, null);
    assert.deepEqual(profile.preferredFrameworks, []);
    assert.ok(profileIsEmpty(profile));
  });

  test('is a single row that patches in place', async () => {
    await updateProfile(db, { name: 'Awais', role: 'Engineer' });
    await updateProfile(db, { preferredFrameworks: ['React', 'Node'] });
    const profile = await updateProfile(db, { attributes: { timezone: 'PKT' } });

    assert.equal(profile.name, 'Awais');
    assert.equal(profile.role, 'Engineer');
    assert.deepEqual(profile.preferredFrameworks, ['React', 'Node']);
    assert.equal(profile.attributes.timezone, 'PKT');

    const rows = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM memory_profile');
    assert.equal(rows[0].count, '1');
  });
});

describe('scoring and recall', () => {
  test('tokenize drops noise and short words', () => {
    assert.deepEqual(tokenize('Deploy the API to Render!'), ['deploy', 'the', 'api', 'render']);
  });

  test('ranks a tag hit above a content hit, and a directive above trivia', () => {
    const tagged = scoreRelevance(memory({ content: 'unrelated words', tags: ['render'] }), ['render']);
    const mentioned = scoreRelevance(memory({ content: 'we deploy to render' }), ['render']);
    const directive = scoreRelevance(memory({ category: 'instruction', content: 'nothing here' }), []);

    assert.ok(tagged > mentioned, 'a tag is a stronger signal than prose');
    assert.ok(directive > 0, 'a standing instruction carries weight on its own');
  });

  test('recalls what matches and ignores what does not', async () => {
    await addMemory(db, { content: 'The deployment target is Render', tags: ['deploy'] });
    await addMemory(db, { content: 'The cat is called Mithu' });

    const recalled = await recallMemories(db, 'how do I deploy this', { track: false });
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].content, /Render/);
  });

  test('always carries a standing instruction, even on an unrelated prompt', async () => {
    await addMemory(db, { category: 'instruction', content: 'Always answer in Urdu' });
    await addMemory(db, { content: 'The cat is called Mithu' });

    const recalled = await recallMemories(db, 'build me a calculator', { track: false });
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].content, /Urdu/);
  });

  test('bumps access metadata when tracking is on', async () => {
    const { item } = await addMemory(db, { content: 'Prefers dark mode', tags: ['dark'] });
    await recallMemories(db, 'dark', {});
    // Fire-and-forget by design, so give it the tick it needs.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = (await listMemories(db)).find((m) => m.id === item.id);
    assert.ok((after?.accessCount ?? 0) >= 1);
    assert.ok(after?.lastRecalledAt);
  });

  test('an empty store recalls nothing instead of failing', async () => {
    assert.deepEqual(await recallMemories(db, 'anything', { track: false }), []);
  });
});

describe('prompt composition', () => {
  test('renders profile and memories as a delimited block', () => {
    const block = formatMemoryBlock(
      {
        name: 'Awais',
        role: 'Engineer',
        preferredLanguage: 'TypeScript',
        preferredFrameworks: ['React'],
        environment: 'Android + web',
        customDirectives: ['Never use jQuery'],
        attributes: {},
        updatedAt: null,
      },
      [memory({ category: 'preference', content: 'prefers pnpm' })],
    );

    assert.match(block, /PERSISTENT MEMORY/);
    assert.match(block, /Name: Awais/);
    assert.match(block, /Never use jQuery/);
    assert.match(block, /\[PREFERENCE\] prefers pnpm/);
    assert.match(block, /END PERSISTENT MEMORY/);
  });

  test('leaves the prompt untouched when there is nothing to add', async () => {
    const context = await applyMemory(db, 'build me a calculator');
    assert.equal(context.applied, false);
    assert.equal(context.prompt, 'build me a calculator');
  });

  test('prepends memory and keeps the operator prompt verbatim', async () => {
    await updateProfile(db, { name: 'Awais' });
    await addMemory(db, { content: 'Prefers Tailwind for styling', tags: ['styling'] });

    const context = await applyMemory(db, 'build a styling demo');
    assert.equal(context.applied, true);
    assert.ok(context.prompt.startsWith('### [PERSISTENT MEMORY'));
    assert.ok(context.prompt.endsWith('build a styling demo'));
    assert.equal(context.profile.name, 'Awais');
  });

  test('a broken query degrades to no memory rather than throwing', async () => {
    const broken = {
      query: async () => {
        throw new Error('database is gone');
      },
    } as unknown as Db;

    const context = await applyMemory(broken, 'still works');
    assert.equal(context.applied, false);
    assert.equal(context.prompt, 'still works');
  });
});

describe('extraction — only what the operator actually said', () => {
  test('picks up a name, an instruction, a preference and a project', () => {
    const found = extractMemories(
      'Hi, my name is Awais. Remember that: the API key lives in .env. ' +
        'I prefer pnpm. We are building a calculator app.',
    );

    const byCategory = Object.fromEntries(found.map((m) => [m.category, m.content]));
    assert.match(byCategory.fact ?? '', /name is Awais/);
    assert.match(byCategory.instruction ?? '', /API key lives in \.env/);
    assert.match(byCategory.preference ?? '', /prefers pnpm/);
    assert.match(byCategory.project ?? '', /calculator app/);
  });

  test('finds nothing in an ordinary request', () => {
    assert.deepEqual(extractMemories('build me a landing page with a contact form'), []);
    assert.deepEqual(extractMemories('fix the failing test in auth.ts'), []);
    assert.deepEqual(extractMemories(''), []);
  });

  test('does not mistake a phrase for a name', () => {
    const found = extractMemories('my name is not important');
    assert.deepEqual(found.filter((m) => m.key === 'user_name'), []);
  });

  test('keeps a surname but not the rest of the sentence', () => {
    const surname = extractMemories('my name is Awais Ali').find((m) => m.key === 'user_name');
    assert.equal(surname?.profileName, 'Awais Ali');

    // The bug this guards: "Awais and" as the operator's name, which is only
    // visible later, when the agent greets them by it.
    const withMore = extractMemories('my name is Awais and remember that: deploys use Render');
    assert.equal(withMore.find((m) => m.key === 'user_name')?.profileName, 'Awais');
    assert.ok(withMore.some((m) => m.category === 'instruction'));
  });

  test('stores what it finds, with the channel as the source', async () => {
    const stored = await extractAndStoreMemories(db, 'remember that: deploys go through Render', 'whatsapp');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, 'whatsapp');
    assert.equal(stored[0].category, 'instruction');

    const relisted = await listMemories(db);
    assert.equal(relisted.length, 1);
  });

  test('a name also lands in the profile', async () => {
    await extractAndStoreMemories(db, 'call me Awais', 'web');
    const profile = await getProfile(db);
    assert.equal(profile.name, 'Awais');
  });

  test('learning the same thing twice does not duplicate it', async () => {
    await extractAndStoreMemories(db, 'remember that: deploys go through Render', 'web');
    await extractAndStoreMemories(db, 'remember that: deploys go through Render', 'web');
    assert.equal(await countMemories(db), 1);
  });

  test('a database failure during extraction is swallowed', async () => {
    const broken = {
      query: async () => {
        throw new Error('database is gone');
      },
    } as unknown as Db;

    assert.deepEqual(await extractAndStoreMemories(broken, 'remember that: something', 'web'), []);
  });

  test('maps a run kind to a memory source', () => {
    assert.equal(sourceForKind('whatsapp'), 'whatsapp');
    assert.equal(sourceForKind('chat'), 'web');
    assert.equal(sourceForKind('api'), 'auto_extracted');
  });
});
