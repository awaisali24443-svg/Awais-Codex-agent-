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
    assert.ok(wired.includes('UI Craft Guide'), 'the craft guide is the file that rides along');
    assert.ok(wired.includes('Craft guide'), 'and it announces what it is');
    assert.ok(wired.includes('var(--paper)'), 'guide carries the arena token rule');
    assert.ok(wired.length > prompt.length);
  });

  it('returns the identical string for non-UI missions — zero extra tokens', () => {
    const prompt = 'Summarize this article about AI agents';
    assert.equal(withDesignGuide(prompt), prompt);
  });
});

describe('withDesignGuide — the art direction rides on the wire too', () => {
  it('injects the chosen direction, its recipe, and the craft guide', () => {
    const prompt = 'Design a landing page for a jewellery atelier';
    const wired = withDesignGuide(prompt, 'atelier');
    assert.ok(wired.endsWith(prompt), 'the operator prompt is still the last thing the model reads');
    assert.ok(wired.includes('ART DIRECTION — Atelier'), 'the direction is named');
    assert.ok(wired.includes('PALETTE'), 'and specified, not described');
    assert.ok(wired.includes('PREFS') === false, 'no stray placeholders');
    // The recipe and the craft guide are separate jobs: one decides how the
    // page looks, the other whether it is any good.
    assert.ok(wired.includes('Craft guide'), 'the craft floor still rides along');
    assert.ok(wired.indexOf('ART DIRECTION') < wired.indexOf('Craft guide'), 'direction first, craft second');
  });

  it('the asset kit travels with the direction, and arrives before the self-check', () => {
    // Imagery is the gap a generated page falls into: without a photograph and
    // without a technique, the page becomes text on a coloured rectangle.
    const prompt = 'Design a landing page for a jewellery atelier';
    const wired = withDesignGuide(prompt, 'atelier');
    assert.ok(wired.includes('Asset kit'), 'the kit is on the wire');
    assert.ok(wired.includes('Mesh gradient field'), 'with the universal techniques');
    assert.ok(wired.includes('Duotone treatment'), 'and the ones this direction needs');
    assert.ok(!wired.includes('Halftone dots'), 'and none it does not');
    assert.ok(wired.includes('no stock library'), 'and the reason it exists');
    assert.ok(wired.indexOf('Asset kit') < wired.indexOf('Self-check'), 'imagery decides, then the check confirms');
  });

  it('the self-check travels with the direction, because only the builder can run it', () => {
    // The built files live in the engine's own sandbox and the server can only
    // read them when someone downloads one, so the checks have to reach the
    // model that wrote the page — and they have to be the last instruction
    // before the operator's own words.
    const prompt = 'Design a landing page for a music festival';
    const wired = withDesignGuide(prompt, 'kinetic');
    assert.ok(wired.includes('SELF-CHECK'), 'the checklist is on the wire');
    assert.ok(wired.includes('at least 2.2rem'), 'with the direction-specific threshold');
    assert.ok(wired.indexOf('SELF-CHECK') < wired.indexOf(prompt), 'and before the operator prompt');
    assert.ok(wired.indexOf('ART DIRECTION') < wired.indexOf('SELF-CHECK'), 'direction, craft, then the check');
  });

  it('a task that is not building a UI gets the identical string back, direction or not', () => {
    const prompt = 'Summarize this article about AI agents';
    assert.equal(withDesignGuide(prompt, 'kinetic'), prompt);
  });

  it('a direction nobody defined is ignored rather than guessed at', () => {
    // A page built in an undefined direction would disagree with the plan that
    // named it, so the recipe is dropped and the craft guide still applies.
    const prompt = 'Design a landing page for my portfolio';
    const wired = withDesignGuide(prompt, 'brutalist-vaporwave');
    assert.ok(!wired.includes('ART DIRECTION'), 'no recipe for an unknown direction');
    assert.ok(wired.includes('Craft guide'), 'but the craft floor is not lost');
  });

  it('the direction survives into the wire prompt without the operator prompt being rewritten', () => {
    const prompt = 'Build a docs website for our developer API';
    const wired = withDesignGuide(prompt, 'blueprint');
    assert.ok(wired.includes('mono microtype'), 'the direction the brief points at is the one injected');
    assert.equal(wired.slice(-prompt.length), prompt);
  });
});

describe('designGuideText — the guide stopped prescribing one house style', () => {
  it('no longer tells every task to be warm, minimal and quiet', () => {
    // The whole diagnosis: one house style applied to every brief is why all
    // the output looked the same, and "quiet" is why none of it had a moment.
    const text = designGuideText().toLowerCase();
    assert.ok(!text.includes('warm, minimal, quiet'), 'the single house style is gone');
    assert.ok(!text.includes('house style'), 'and so is the idea of one');
    assert.ok(text.includes('direction'), 'a direction is what decides the look now');
  });

  it('still carries the bans that made a page look generated, as defects', () => {
    const text = designGuideText();
    assert.ok(text.includes('centred hero, three equal cards, one gradient'), 'the shape is named');
    assert.ok(/headings? barely larger than body text/i.test(text), 'so is the type tell');
    assert.ok(text.includes('tokens.css'), 'tokens come first');
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
