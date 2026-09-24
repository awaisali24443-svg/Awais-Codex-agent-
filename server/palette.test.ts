/**
 * The command palette's brain.
 *
 * The rules under test are the ones the research names, each of which is a
 * function in web/palette.js: one box that holds actions *and* tasks, grouped
 * with empty groups dropped, ranked so that a title match beats a match in what
 * was said inside the task, recents first while the box is empty, and a
 * highlight that wraps.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIONS,
  RUNNING_ACTIONS,
  SHORTCUT_GROUPS,
  buildResults,
  flatten,
  moveSelection,
  score,
  selectionAfter,
} from '../web/palette.js';

const tasks = [
  { id: 'cnv_1', title: 'Fix the login screen', preview: 'the button did nothing', updatedAt: '2026-09-20T10:00:00Z' },
  { id: 'cnv_2', title: 'Research the market', preview: 'three competitors, all cheaper', updatedAt: '2026-09-19T10:00:00Z' },
  { id: 'cnv_3', title: 'Build the pricing page', preview: 'a page with the right numbers', updatedAt: '2026-09-18T10:00:00Z' },
];

describe('scoring', () => {
  test('a whole word beats the same letters scattered through a longer string', () => {
    assert.ok(score('New task', 'task') > score('Untranslatable mask', 'task'));
  });

  test('a match at a word start beats one in the middle of a word', () => {
    assert.ok(score('Build the pricing page', 'pricing') > score('Surprising', 'pricing'));
  });

  test('letters in order are enough — a palette is not a spell-checker', () => {
    assert.ok(score('New task', 'nwt') > 0, 'a abbreviation finds its command');
    assert.ok(score('Build the pricing page', 'btpp') > 0);
  });

  test('nonsense scores nothing, and an empty query matches everything equally', () => {
    assert.equal(score('New task', 'qqqq'), 0);
    assert.equal(score('anything', ''), 1);
    assert.equal(score('', 'task'), 0);
  });
});

describe('one box, two kinds of thing', () => {
  test('an empty box offers the things to do, then the tasks', () => {
    const groups = buildResults({ conversations: tasks });
    assert.deepEqual(groups.map((g) => g.id), ['tasks', 'actions']);
    const rows = flatten(groups) as Array<{ kind: string }>;
    assert.equal(rows.filter((r) => r.kind === 'action').length, ACTIONS.length, 'every action is reachable');
  });

  test('typing a word the tasks contain finds the task, with the line it matched', () => {
    const rows = flatten(buildResults({ conversations: tasks, query: 'cheaper' })) as Array<{ id: string; kind: string; matched: string | null }>;
    const found = rows.find((r) => r.id === 'cnv_2');
    assert.ok(found, 'a word said inside a task finds that task');
    assert.equal(found.matched, 'preview', 'and is labelled as an inside match, not a title match');
  });

  test('a title match outranks an inside match', () => {
    const groups = buildResults({
      conversations: [
        { id: 'cnv_a', title: 'Something else', preview: 'mentions the login screen once' },
        { id: 'cnv_b', title: 'Login screen fixes', preview: 'unrelated words' },
      ],
      query: 'login',
    });
    const rows = (flatten(groups) as Array<{ id: string; kind: string }>).filter((r) => r.kind === 'task');
    assert.equal(rows[0].id, 'cnv_b', 'the task about it comes first');
  });

  test('a group with nothing in it is dropped, heading and all', () => {
    const groups = buildResults({ conversations: tasks, query: 'zzzznothing' });
    assert.equal(groups.length, 0, 'no orphan headings over empty lists');
    const onlyActions = buildResults({ conversations: [], query: 'settings' });
    assert.deepEqual(onlyActions.map((g) => g.id), ['actions']);
  });

  test('while a task is running, stopping it is one of the things to do', () => {
    const withStop = (flatten(buildResults({ actions: RUNNING_ACTIONS })) as Array<{ id: string }>).map((r) => r.id);
    assert.ok(withStop.includes('stop'));
    const idle = (flatten(buildResults({})) as Array<{ id: string }>).map((r) => r.id);
    assert.ok(!idle.includes('stop'), 'and it is not offered when nothing is running');
  });

  test('the same task is never listed twice', () => {
    const rows = flatten(buildResults({ conversations: tasks })) as Array<{ id: string; kind: string }>;
    assert.equal(new Set(rows.filter((r) => r.kind === 'task').map((r) => r.id)).size, 3);
  });
});

describe('moving through the list', () => {
  test('the highlight wraps at both ends', () => {
    assert.equal(moveSelection(0, 3, -1), 2);
    assert.equal(moveSelection(2, 3, 1), 0);
    assert.equal(moveSelection(1, 3, 1), 2);
  });

  test('an empty list has no highlight, and a shorter list keeps it in range', () => {
    assert.equal(moveSelection(0, 0, 1), -1);
    assert.equal(selectionAfter(-1, 4), 0, 'something is always selected when there is something to select');
    assert.equal(selectionAfter(9, 3), 2, 'and it can never point past the end');
  });
});

describe('the cheat sheet is data, and it is honest', () => {
  test('it is grouped, and every row says something', () => {
    assert.ok(SHORTCUT_GROUPS.length >= 3, 'more than one group, because one column of keys is unreadable');
    for (const group of SHORTCUT_GROUPS) {
      assert.ok(group.label, 'every group is named');
      assert.ok(group.rows.length > 0, `${group.label} has rows`);
      for (const row of group.rows) {
        assert.ok(row.keys.length > 0, `"${row.label}" shows its keys`);
        assert.ok(row.label.length > 8, 'and says what they do in words');
      }
    }
  });

  test('the palette can open it, because a phone has no ? key', () => {
    const row = ACTIONS.find((action) => action.id === 'shortcuts');
    assert.ok(row, 'there is a row for it');
    assert.equal(row?.keys?.[0], '?', 'showing the key that opens it');
  });
});
