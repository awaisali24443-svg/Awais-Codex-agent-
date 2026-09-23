import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeUiMission, withDesignGuide, designGuideText } from './design.js';

const GUIDE_PATH = path.join(process.cwd(), 'server', 'ui-design-guide.md');

describe('looksLikeUiMission — UI intent detection', () => {
  const uiMissions = [
    'Design a landing page for my portfolio',
    'Build a dashboard for my quiz scores',
    'Make an app screen for the expo app',
    'Redesign the settings page with a dark theme',
    'Create a website for my college project',
    'Prototype a mockup of the chat UI',
    'Code the front-end for the student mart',
  ];
  for (const prompt of uiMissions) {
    it(`triggers for: ${prompt.slice(0, 40)}`, () => {
      assert.equal(looksLikeUiMission(prompt), true);
    });
  }

  const nonUiMissions = [
    'Summarize this article about AI agents',
    'Check my email for the electricity bill',
    'What is the capital of France?',
    'Research the best phone under 30000 rupees',
    'Check ticket prices on the PIA website',
    'Fix the login bug in the auth module',
    'Make a plan for my expo preparation',
    '',
    '   ',
  ];
  for (const prompt of nonUiMissions) {
    it(`does not trigger for: ${JSON.stringify(prompt.slice(0, 40))}`, () => {
      assert.equal(looksLikeUiMission(prompt), false);
    });
  }
});

describe('withDesignGuide — wire-only injection', () => {
  it('prepends the guide for UI missions', () => {
    const prompt = 'Design a landing page for my portfolio';
    const wired = withDesignGuide(prompt);
    assert.ok(wired.endsWith(prompt), 'operator prompt stays intact at the end');
    assert.ok(wired.includes('UI Design Guide') || wired.includes('Design guide'));
    assert.ok(wired.includes('var(--paper)'), 'guide carries the arena token rule');
    assert.ok(wired.length > prompt.length);
  });

  it('returns the identical string for non-UI missions — zero extra tokens', () => {
    const prompt = 'Summarize this article about AI agents';
    assert.equal(withDesignGuide(prompt), prompt);
  });
});

describe('designGuideText — guide file sanity', () => {
  it('loads the guide from disk', () => {
    assert.ok(fs.existsSync(GUIDE_PATH), 'server/ui-design-guide.md exists');
    const text = designGuideText();
    assert.ok(text.length > 500, 'guide is substantive');
  });

  it('stays under the token budget (~120 lines)', () => {
    const lines = fs.readFileSync(GUIDE_PATH, 'utf8').split('\n').length;
    assert.ok(lines <= 120, `guide is ${lines} lines, budget is 120`);
  });

  it('covers the required sections', () => {
    const text = designGuideText().toLowerCase();
    for (const section of ['layout', 'spacing', 'typography', 'color', 'mobile', 'restraint']) {
      assert.ok(text.includes(section), `guide covers ${section}`);
    }
  });
});
