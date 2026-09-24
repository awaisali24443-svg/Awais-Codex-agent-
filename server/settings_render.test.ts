/**
 * The Settings page, actually rendered.
 *
 * Every other test of this screen reads its source text, which proves the code
 * says the right things and proves nothing about whether it *runs*. The
 * redesign replaced the whole render path — new sections, a filter, pills, an
 * editor — and a screen that throws while building its own HTML shows the
 * operator the previous page or nothing at all, which is indistinguishable from
 * "you didn't change anything".
 *
 * So this file executes the real functions, sliced out of `web/app.js`, against
 * a real `/api/settings` payload: the settings list, the secrets list, the
 * WhatsApp block and the encryption block, with the field names the route
 * actually returns. The DOM is a stub of the four members the render touches
 * (`innerHTML`, `querySelectorAll`, `addEventListener`, `querySelector`); the
 * templates, the escaping, the state pills and the filter are the shipped ones.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

/** A slice of the client, from `start` up to (not including) `end`. */
function slice(start: string, end: string): string {
  const file = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf-8');
  const from = file.indexOf(start);
  const to = file.indexOf(end, from + start.length);
  assert.ok(from >= 0, `web/app.js no longer contains ${JSON.stringify(start)}`);
  assert.ok(to > from, `web/app.js no longer has ${JSON.stringify(end)} after it`);
  return file.slice(from, to);
}

/** Everything `renderSettings` needs, taken from the shipped source. */
const RUNTIME = [
  'let settingsClickBound = false;',
  'function onSettingsClick() {}', // the delegated handler; its own tests cover it
  slice('function escapeHtml(text) {', 'function inline('),
  slice('function relativeTime(iso) {', '/* ============================== the palette'),
  slice('const SECRET_STATE = {', '/** The delegated settings listener'),
  slice('function section(title, body) {', 'function renderSettings() {'),
  slice('async function renderBuildLine() {', '/* The LinkedIn connection card in Settings.'),
  slice('function renderSettings() {', 'async function saveSetting(input) {'),
  'globalThis.__renderSettings = renderSettings;',
].join('\n');

/** The payload `/api/settings` returns, field for field. */
function payload() {
  const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
  return {
    settings: [
      {
        key: 'dailyRunBudget',
        label: 'Daily run budget',
        description: 'Hard cap on agent runs per day, across every channel.',
        envVar: 'DAILY_RUN_BUDGET',
        value: 12,
        defaultValue: 12,
        source: 'environment',
      },
      {
        key: 'antigravityAgent',
        label: 'Agent version',
        description: 'Which managed agent the engine calls.',
        envVar: 'ANTIGRAVITY_AGENT',
        value: 'agent-preview-09-2026',
        defaultValue: 'agent-preview-09-2026',
        source: 'stored',
      },
      {
        key: 'morningDigest',
        label: 'Morning WhatsApp digest',
        description: 'One message each morning with what happened overnight.',
        envVar: 'MORNING_DIGEST',
        value: true,
        defaultValue: true,
        source: 'environment',
      },
    ],
    secrets: [
      {
        name: 'gemini_api_key',
        label: 'Google AI Studio key',
        description: 'Authorises the agent engine.',
        envVar: 'GEMINI_API_KEY',
        usedBy: 'server/engine/antigravity.ts',
        source: 'stored',
        fingerprint: 'a1b2c3d4',
        updatedAt: twoHoursAgo,
      },
      {
        name: 'github_pat',
        label: 'GitHub personal access token',
        description: 'Connects the GitHub integration.',
        envVar: 'GITHUB_TOKEN',
        usedBy: 'server/routes/github.ts',
        source: 'missing',
        fingerprint: null,
        updatedAt: null,
      },
      {
        name: 'google_client_secret',
        label: 'Google OAuth Client Secret',
        description: 'From the same Google Cloud OAuth client.',
        envVar: 'GOOGLE_CLIENT_SECRET',
        usedBy: 'server/routes/google.ts',
        source: 'unreadable',
        fingerprint: 'deadbeef',
        updatedAt: twoHoursAgo,
      },
    ],
    whatsapp: {
      mode: 'connected' as const,
      state: 'running',
      detail: null,
      agentId: 'user:1234',
      lastPollAt: null,
      lastError: null,
    },
    encryption: { available: true, envVar: 'MASTER_KEY', hint: null },
  };
}

/** Render the page with `query` in the filter box and return the HTML it built. */
function render(query = ''): string {
  const body = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => undefined,
  };
  const context: Record<string, unknown> = {
    state: { settings: payload(), settingsQuery: query },
    el: { settingsBody: body },
    document: { getElementById: () => null },
    console,
    Date,
    Number,
    String,
    Math,
    JSON,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(RUNTIME, context);
  (context.__renderSettings as () => void)();
  const html = body.innerHTML;
  assert.ok(html.length > 0, 'the render produced no HTML at all');
  return html;
}

describe('the Settings page renders what it promises', () => {
  test('it renders the real payload without a single hole in it', () => {
    const html = render();
    assert.ok(!/undefined|NaN|\[object Object\]/.test(html), `a hole in the page: ${html.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)?.[0]}`);
    for (const text of [
      'How it runs · 3',
      'Connections · 1 of 3 set',
      'Everything on this page applies the moment you change it',
      'About this build',
    ]) {
      assert.ok(html.includes(text), `missing from the page: ${text}`);
    }
  });

  test('a setting shows its words, its value and an editor that is closed', () => {
    const html = render();
    assert.ok(html.includes('Hard cap on agent runs per day'), 'the description the server always sent is on the page');
    assert.ok(html.includes('>12<'), 'with the current value beside the label');
    assert.ok(html.includes('value="agent-preview-09-2026"'), 'and the editor prefilled');
    assert.ok(html.includes('class="setting-editor" hidden'), 'closed until it is asked for');
    assert.ok(html.includes('from DAILY_RUN_BUDGET'), 'saying where the value came from');
    assert.ok(html.includes('type="checkbox" checked'), 'a switch is a switch, not a text box');
    assert.ok(html.includes('aria-expanded="false"'), 'and the row is a control a keyboard can open');
  });

  test('a connection is a card with an honest state and one primary action', () => {
    const html = render();
    assert.ok(html.includes('class="pill ok">Connected<'), 'a saved key reads as connected');
    assert.ok(html.includes('class="pill muted">Not set<'), 'a missing one is honest, not alarming');
    assert.ok(html.includes('class="pill bad">Needs attention<'), 'and an undecryptable one is called out');
    assert.ok(html.includes('a1b2c3d4'), 'with the fingerprint, never the key');
    assert.ok(html.includes('2h ago'), 'and when it was last saved');
    assert.ok(html.includes('<button class="primary" data-act="set" data-name="github_pat">Add key</button>'), 'the one action is loud and correctly worded');
    assert.ok(html.includes('<button class="primary" data-act="set" data-name="gemini_api_key">Replace key</button>'), 'and says replace when there is something to replace');
    assert.ok(html.includes('data-act="test" data-name="gemini_api_key"'), 'testing the engine key is offered');
    assert.ok(!html.includes('data-act="test" data-name="github_pat"'), 'and not offered for a key that is not there');
    assert.ok(html.includes('data-act="remove" data-name="gemini_api_key"'), 'removing is offered only for a stored key');
    assert.ok(!html.includes('data-act="remove" data-name="google_client_secret"'), 'including one that cannot be decrypted');
  });

  test('the phone channel says who it is connected as', () => {
    const html = render();
    assert.ok(html.includes('Connected as user:1234'), 'the agent id is shown');
    assert.ok(html.includes('class="pill ok">Connected<'), 'with its state');
  });

  test('the filter narrows the page to what was typed', () => {
    const github = render('github');
    assert.ok(github.includes('GitHub personal access token'), 'the connection that matched is there');
    assert.ok(!github.includes('Daily run budget'), 'and the settings that did not match are gone');
    assert.ok(!github.includes('Hard cap on agent runs'), 'both the label and the description are filtered on');

    const budget = render('budget');
    assert.ok(budget.includes('Daily run budget'), 'a setting is findable by its own name');
    assert.ok(!budget.includes('GitHub personal access token'), 'and the rest of the page goes away');

    const none = render('nothing-like-this-exists');
    assert.ok(none.includes('Nothing matches that.'), 'an empty result says so instead of showing a blank page');
    assert.ok(!none.includes('How it runs'), 'with no section headers left behind');
  });
});
