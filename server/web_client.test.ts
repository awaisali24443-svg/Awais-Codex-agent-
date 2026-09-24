/**
 * The mobile client's furniture, pinned.
 *
 * Every case here is a bug the operator actually hit on a phone:
 *
 *  - the composer's token-estimate chip sat *after* the send button in a single
 *    line of `nowrap` content, so the row was wider than the phone. That made
 *    the whole page horizontally scrollable, and one sideways pan (or the
 *    keyboard scrolling the focused box into view) slid every message bubble
 *    off the left edge — the screenshots that started this.
 *  - Settings was a collapsible section inside the drawer: not a page, and not
 *    something the phone's back gesture could leave.
 *  - the finished task's action row carried an "Edit prompt" button, which
 *    reads as an action on the *answer*. Editing belongs to the operator's own
 *    message, where it already lives.
 *
 * These are structural assertions on the shipped markup, stylesheet and client,
 * in the same spirit as brand.test.ts: cheap, and they fail the moment someone
 * puts the row back together the way it was.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const html = () => read('web/index.html');
const css = () => read('web/styles.css');
const app = () => read('web/app.js');

describe('the composer fits a phone', () => {
  test('no token cap and no estimate chip', () => {
    for (const marker of ['token-cap', 'estimate-line', 'estimate-text', 'cap-toggle']) {
      assert.ok(!html().includes(marker), `index.html still carries ${marker}`);
      assert.ok(!css().includes(marker), `styles.css still styles ${marker}`);
      assert.ok(!app().includes(marker), `app.js still reads ${marker}`);
    }
  });

  test('no run can be capped: the client never sends a token budget', () => {
    assert.ok(!app().includes('tokenBudget'), 'the client sends no token budget');
  });

  test('the composer row wraps instead of overflowing', () => {
    const row = css().slice(css().indexOf('.composer-row {'));
    const rule = row.slice(0, row.indexOf('}'));
    assert.ok(rule.includes('flex-wrap: wrap'), 'a rigid row is what shoved the page sideways');
  });

  test('the finished-task action row wraps too', () => {
    // Three pills wide on a phone — the other half of the sideways-drift bug.
    const cssText = css();
    const notice = cssText.slice(cssText.indexOf('.notice {'));
    assert.ok(notice.slice(0, notice.indexOf('}')).includes('flex-wrap: wrap'), 'the notice wraps');
    const buttons = cssText.slice(cssText.indexOf('.run-btns {'));
    assert.ok(buttons.slice(0, buttons.indexOf('}')).includes('flex-wrap: wrap'), 'and so do its buttons');
  });

  test('nothing can scroll the page sideways', () => {
    const body = css().slice(css().indexOf('html, body {'));
    assert.ok(
      body.slice(0, body.indexOf('}')).includes('overflow-x: clip'),
      'body clips horizontal overflow (clip, not hidden: hidden breaks the sticky composer)',
    );
  });
});

describe('settings is a page, not a drawer section', () => {
  test('it is a third screen with a back control', () => {
    const page = html();
    assert.ok(page.includes('id="screen-settings"'), 'the settings screen exists');
    assert.ok(page.includes('id="btn-settings-back"'), 'and has a way back');
    assert.ok(page.includes('id="settings-body"'), 'the body kept its id, so the panel code is unchanged');
  });

  test('the drawer links to it rather than expanding in place', () => {
    const page = html();
    assert.ok(page.includes('id="btn-settings"'), 'the drawer has the entry point');
    assert.ok(!page.includes('settings-toggle'), 'the old collapsible toggle is gone');
  });

  test('the back gesture closes it', () => {
    const client = app();
    assert.ok(client.includes("history.pushState({ wais: 'settings' }"), 'opening pushes one history entry');
    assert.ok(client.includes("window.addEventListener('popstate'"), 'and back closes the page');
    assert.ok(client.includes('function closeSettings'), 'closeSettings exists');
  });

  test('showing the app or the login hides the settings page', () => {
    const client = app();
    const showLogin = client.slice(client.indexOf('function showLogin()'), client.indexOf('function showApp()'));
    const showApp = client.slice(client.indexOf('function showApp()'), client.indexOf('function showApp()') + 400);
    assert.ok(showLogin.includes('el.settingsScreen.hidden = true'), 'login hides it');
    assert.ok(showApp.includes('el.settingsScreen.hidden = true'), 'the app screen hides it');
  });
});

describe('actions belong to the operator, not to the answer', () => {
  test('the finished-task row has no Edit prompt button', () => {
    const client = app();
    assert.ok(!client.includes('Edit prompt'), 'the button is gone');
    assert.ok(!client.includes('function editPrompt'), 'and so is its handler');
  });

  test('the operator can still edit their own message', () => {
    // attachMessageActions puts the pencil on the user's bubble — the right
    // place for it; removing the button must not have removed that.
    assert.ok(app().includes("editBtn.textContent = '✎ Edit'"));
    assert.ok(app().includes('openInlineEditor('));
  });
});

describe('the answer is the answer', () => {
  test('plan-protocol lines are stripped before the prose is drawn', () => {
    const client = app();
    assert.ok(client.includes('stripMilestones(card.answerText'), 'drawAnswer filters them');
  });

  test('a long rate-limit wait is visible instead of looking like a hang', () => {
    const client = app();
    assert.ok(/rate limited\|waiting/.test(client), 'the wait is recognised');
    assert.ok(client.includes("addStep(card, 'rate-limit'"), 'and shown as its own running step');
  });
});
