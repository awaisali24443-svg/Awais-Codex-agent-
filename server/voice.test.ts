import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripMarkdownForSpeech,
  combineTranscripts,
  recognitionErrorMessage,
} from '../web/voice.js';

describe('stripMarkdownForSpeech', () => {
  it('drops fenced code blocks but keeps surrounding prose', () => {
    const out = stripMarkdownForSpeech('Here is the fix:\n```js\nconst x = 1;\n```\nDone.');
    assert.equal(out, 'Here is the fix:\nDone.');
  });

  it('keeps inline code content without backticks', () => {
    assert.equal(stripMarkdownForSpeech('Run `npm test` now.'), 'Run npm test now.');
  });

  it('turns links into their text and strips emphasis', () => {
    const out = stripMarkdownForSpeech('See **bold** and *italic* and [docs](https://x.example).');
    assert.equal(out, 'See bold and italic and docs.');
  });

  it('strips headings, list markers and quotes', () => {
    const out = stripMarkdownForSpeech('# Title\n- one\n- two\n1. first\n2. second\n> quoted');
    assert.equal(out, 'Title\none\ntwo\nfirst\nsecond\nquoted');
  });

  it('handles empty and non-string input', () => {
    assert.equal(stripMarkdownForSpeech(''), '');
    assert.equal(stripMarkdownForSpeech(null), '');
    assert.equal(stripMarkdownForSpeech(undefined), '');
  });

  it('collapses excess whitespace', () => {
    assert.equal(stripMarkdownForSpeech('a   b\n\n\nc'), 'a b\nc');
  });
});

describe('combineTranscripts', () => {
  it('joins interim and final results into live text', () => {
    const out = combineTranscripts([
      { transcript: 'hello ', isFinal: true },
      { transcript: 'world', isFinal: false },
    ]);
    assert.equal(out, 'hello world');
  });

  it('handles empty input', () => {
    assert.equal(combineTranscripts([]), '');
    assert.equal(combineTranscripts(null), '');
  });
});

describe('recognitionErrorMessage', () => {
  it('explains blocked microphone in plain words', () => {
    assert.match(recognitionErrorMessage('not-allowed'), /blocked/i);
  });

  it('explains silence and missing mic', () => {
    assert.match(recognitionErrorMessage('no-speech'), /hear/i);
    assert.match(recognitionErrorMessage('audio-capture'), /microphone/i);
  });

  it('falls back to a typable alternative', () => {
    assert.match(recognitionErrorMessage('weird-code'), /type instead/i);
  });
});
