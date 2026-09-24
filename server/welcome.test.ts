import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_NAME,
  WELCOME_GREETING,
  SUGGESTIONS,
  isWelcomeVisible,
  suggestionFill,
  fillComposerFromChip,
} from '../web/welcome.js';

describe('welcome suggestions', () => {
  it('names the assistant and greets in plain words', () => {
    assert.ok(ASSISTANT_NAME.length > 0);
    assert.ok(WELCOME_GREETING.length > 0);
  });

  it('offers 4–6 short, unique, capability-reflecting chips', () => {
    assert.ok(SUGGESTIONS.length >= 4 && SUGGESTIONS.length <= 6);
    const labels = SUGGESTIONS.map((s) => s.label);
    assert.equal(new Set(labels).size, labels.length);
    for (const s of SUGGESTIONS) {
      assert.ok(s.label.length > 0 && s.label.length <= 24, `label too long: ${s.label}`);
      assert.ok(s.fill.length > 0, `empty fill for: ${s.label}`);
    }
  });

  it('covers what the agent actually does', () => {
    const fills = SUGGESTIONS.map((s) => s.fill.toLowerCase()).join(' ');
    assert.ok(fills.includes('gmail'), 'no email suggestion');
    assert.ok(fills.includes('calendar'), 'no calendar suggestion');
    assert.ok(fills.includes('cost'), 'no plan-with-estimate suggestion');
  });

  it('every starter says what it does, in one short line', () => {
    for (const s of SUGGESTIONS) {
      assert.ok(s.hint && s.hint.length > 0, `no hint for: ${s.label}`);
      assert.ok(s.hint.length <= 30, `hint too long for: ${s.label}`);
    }
  });

  it('suggestionFill returns the exact composer text', () => {
    const s = SUGGESTIONS[0];
    assert.equal(suggestionFill(s), s.fill);
  });
});

describe('isWelcomeVisible', () => {
  it('shows for an empty conversation, hides once messages exist', () => {
    assert.equal(isWelcomeVisible(0), true);
    assert.equal(isWelcomeVisible(1), false);
    assert.equal(isWelcomeVisible(42), false);
  });
});

describe('fillComposerFromChip', () => {
  it('fills the composer as editable text and enables send — never auto-sends', () => {
    const prompt = { value: '' };
    const send = { disabled: true };
    fillComposerFromChip(prompt, send, 'Check my Gmail for unread messages');
    assert.equal(prompt.value, 'Check my Gmail for unread messages');
    assert.equal(send.disabled, false);
  });
});
