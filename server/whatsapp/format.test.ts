/**
 * Markdown → WhatsApp tests.
 *
 * The rule being protected: a reply that looks *right* in the chat. WhatsApp
 * has no escape character and no tables, so the failure modes are visible and
 * embarrassing — literal asterisks around every bold word, code with its `*`
 * eaten, a link the reader cannot tap. Every test here is one of those.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { toWhatsAppText } from './format.js';

describe('inline formatting', () => {
  test('turns double asterisks into WhatsApp bold', () => {
    assert.equal(toWhatsAppText('**Total:** $42'), '*Total:* $42');
  });

  test('turns underscores bold into asterisk bold', () => {
    assert.equal(toWhatsAppText('__Careful__'), '*Careful*');
  });

  test('leaves bold bold — it must not become italic', () => {
    // The bug this guards: once `**x**` becomes `*x*`, a later italic pass
    // would rewrite it again into `_x_` and the emphasis silently changes.
    assert.equal(toWhatsAppText('a **b** c'), 'a *b* c');
    assert.equal(toWhatsAppText('**one** and **two**'), '*one* and *two*');
  });

  test('converts Markdown italic to WhatsApp italic', () => {
    assert.equal(toWhatsAppText('this is *emphasised* text'), 'this is _emphasised_ text');
  });

  test('converts strikethrough', () => {
    assert.equal(toWhatsAppText('~~gone~~'), '~gone~');
  });

  test('leaves arithmetic alone', () => {
    assert.equal(toWhatsAppText('2 * 3 * 4 is 24'), '2 * 3 * 4 is 24');
  });
});

describe('code', () => {
  test('keeps inline code verbatim', () => {
    assert.equal(toWhatsAppText('use `npm run build` now'), 'use `npm run build` now');
  });

  test('keeps a fenced block verbatim, asterisks included', () => {
    const source = 'Try:\n\n```python\ndef f(**kwargs):\n    return kwargs * 2\n```\n';
    const out = toWhatsAppText(source);

    assert.match(out, /def f\(\*\*kwargs\):/, 'code must survive untouched');
    assert.match(out, /kwargs \* 2/);
    assert.match(out, /^```/m, 'the fence itself stays, which is what WhatsApp renders as a block');
  });

  test('drops the language tag WhatsApp cannot render', () => {
    const out = toWhatsAppText('```bash\nls -la\n```');
    assert.equal(out, '```\nls -la\n```');
  });
});

describe('structure', () => {
  test('turns a heading into bold, since WhatsApp has no headings', () => {
    assert.equal(toWhatsAppText('## Results'), '*Results*');
  });

  test('keeps list markers, converting the emphasis inside them', () => {
    assert.equal(toWhatsAppText('- **Fast** build\n- Slow build'), '- *Fast* build\n- Slow build');
  });

  test('keeps numbered lists', () => {
    assert.equal(toWhatsAppText('1. first\n2. second'), '1. first\n2. second');
  });

  test('reduces a link to its text and URL so it stays tappable', () => {
    assert.equal(
      toWhatsAppText('See [the docs](https://example.com/x) for more'),
      'See the docs (https://example.com/x) for more',
    );
  });

  test('does not repeat a URL that is also the link text', () => {
    assert.equal(toWhatsAppText('[https://example.com](https://example.com)'), 'https://example.com');
  });

  test('flattens a table row instead of shipping pipes', () => {
    const out = toWhatsAppText('| Name | Size |\n| --- | --- |\n| app.apk | 4 MB |');

    assert.equal(out.includes('|'), false, 'no pipes survive');
    assert.match(out, /Name · Size/);
    assert.match(out, /app\.apk · 4 MB/);
  });

  test('turns a horizontal rule into a divider', () => {
    assert.equal(toWhatsAppText('above\n\n---\n\nbelow'), 'above\n\n———\n\nbelow');
  });

  test('keeps block quotes, which WhatsApp already understands', () => {
    assert.equal(toWhatsAppText('> quoted line'), '> quoted line');
  });

  test('collapses runs of blank lines a model likes to emit', () => {
    assert.equal(toWhatsAppText('one\n\n\n\n\ntwo'), 'one\n\ntwo');
  });
});

describe('safety', () => {
  test('empty input produces empty output', () => {
    assert.equal(toWhatsAppText(''), '');
    assert.equal(toWhatsAppText('   \n  '), '');
    assert.equal(toWhatsAppText(undefined as unknown as string), '');
  });

  test('plain prose is returned untouched', () => {
    const prose = 'I built the calculator app and left it in /workspace. Want me to package it?';
    assert.equal(toWhatsAppText(prose), prose);
  });

  test('a realistic answer converts in one pass', () => {
    const answer = [
      '## Done',
      '',
      'I built **app-debug.apk**. Steps:',
      '',
      '1. Scaffolded the Gradle project',
      '2. Ran `./gradlew assembleDebug`',
      '',
      '```\nBUILD SUCCESSFUL in 42s\n```',
      '',
      '| File | Size |',
      '| --- | --- |',
      '| app-debug.apk | 4.2 MB |',
      '',
      'See [the build log](https://example.com/log).',
    ].join('\n');

    const out = toWhatsAppText(answer);

    assert.match(out, /^\*Done\*$/m);
    assert.match(out, /I built \*app-debug\.apk\*\./);
    assert.match(out, /`\.\/gradlew assembleDebug`/);
    assert.match(out, /BUILD SUCCESSFUL in 42s/);
    assert.match(out, /app-debug\.apk · 4\.2 MB/);
    assert.match(out, /the build log \(https:\/\/example\.com\/log\)/);
    assert.equal(out.includes('**'), false, 'no Markdown bold is left behind');
    assert.equal(out.includes('##'), false, 'no heading markers are left behind');
  });
});
