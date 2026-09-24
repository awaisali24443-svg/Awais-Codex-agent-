/* ==========================================================================
   The command palette, as data.

   Pure functions only — no DOM, no network. The research on this pattern is
   specific about what separates a real palette from a decoration, and each of
   those rules is a function here:

     * **one box for actions *and* conversations** — "putting everything in one
       place simplifies the mental model of your app";
     * **group it**, and hide a group when nothing in it matches, "so you never
       get an orphan heading floating over nothing";
     * **rank it** — a title match outranks a match in what was said inside the
       task, and a word-start match outranks a match in the middle of a word;
     * **recents at the top**, because "a Recent group does more for perceived
       speed than any animation";
     * **teach the shortcuts inside it**, "so power users graduate off the
       mouse" — every row carries its key.
   ========================================================================== */

/** The things the app can do, whether or not any task exists. */
export const ACTIONS = [
  { id: 'new-task', label: 'New task', hint: 'Start again with an empty screen', keys: ['⌘', '⇧', 'O'], keywords: 'new start fresh compose' },
  { id: 'settings', label: 'Settings', hint: 'Keys, budget, the phone channel', keywords: 'preferences keys api budget' },
  { id: 'theme', label: 'Switch theme', hint: 'Light, dark, or follow the system', keywords: 'dark light appearance colour color' },
  { id: 'drawer', label: 'Recent tasks', hint: 'Open the drawer and search them', keywords: 'history sidebar list conversations' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', hint: 'Everything the keyboard can do', keys: ['?'], keywords: 'help keys bindings cheatsheet' },
  { id: 'signout', label: 'Sign out', hint: 'Forget this browser', keywords: 'log out leave' },
];

/**
 * The cheat sheet, as data.
 *
 * Two rules make a shortcut list worth reading: it only contains keys the app
 * really listens for, and it is grouped by *where you are* — a list of fifteen
 * keys in one column is a list nobody finishes. `web_client.test.ts` walks this
 * array and asserts each shortcut has a handler in the client, so a row cannot
 * outlive the feature it describes.
 */
export const SHORTCUT_GROUPS = [
  {
    label: 'Anywhere',
    rows: [
      { keys: ['⌘', 'K'], label: 'Search tasks and run a command' },
      { keys: ['?'], label: 'Show this list' },
      { keys: ['Esc'], label: 'Close the panel, sheet, drawer or list that is open' },
    ],
  },
  {
    label: 'In the search box',
    rows: [
      { keys: ['↑', '↓'], label: 'Move through the results' },
      { keys: ['↵'], label: 'Open the highlighted one' },
      { keys: ['Tab'], label: 'Keep moving, without leaving the box' },
    ],
  },
  {
    label: 'In the task box',
    rows: [
      { keys: ['↵'], label: 'Send the task' },
      { keys: ['⇧', '↵'], label: 'Start a new line instead' },
    ],
  },
];

/** Actions that only make sense while a task is running. */
export const RUNNING_ACTIONS = [
  { id: 'stop', label: 'Stop the running task', hint: 'Whatever it produced is kept', keywords: 'cancel halt kill abort' },
];

/** Offered when a task is running somewhere this tab cannot see it. */
export const RESUME_ACTIONS = [
  { id: 'resume', label: 'Resume the running task', hint: 'A task is still going — show it live', keywords: 'reconnect stream continue live running' },
];

/**
 * How well a query matches a piece of text.
 *
 * Subsequence matching, so `nwt` finds "New task", with the score tilted by
 * where the match starts and whether it lands on word boundaries — "the same
 * three letters" should not beat "those words".
 *
 * @returns {number} 0 when it does not match at all
 */
export function score(text, query) {
  const haystack = String(text ?? '').toLowerCase();
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return 1;
  if (!haystack) return 0;

  // An exact substring is the strongest signal, and where it starts matters.
  const direct = haystack.indexOf(needle);
  if (direct >= 0) {
    const atWordStart = direct === 0 || /[\s·—(/-]/.test(haystack[direct - 1]);
    return 100 + (atWordStart ? 20 : 0) - Math.min(direct, 20) + needle.length;
  }

  // Otherwise: do the letters appear in order?
  let cursor = 0;
  let points = 0;
  let previous = -1;
  for (const char of needle) {
    const at = haystack.indexOf(char, cursor);
    if (at < 0) return 0;
    const boundary = at === 0 || /[\s·—(/-]/.test(haystack[at - 1]);
    points += boundary ? 3 : 1;
    if (at === previous + 1) points += 2; // consecutive letters are a real word
    previous = at;
    cursor = at + 1;
  }
  return points;
}

/** The best score a set of fields can offer, with the field's own weight. */
function bestOf(fields, query) {
  let best = 0;
  for (const [text, weight] of fields) {
    const points = score(text, query) * weight;
    if (points > best) best = points;
  }
  return best;
}

/**
 * Everything the palette can show, in the order it should be shown.
 *
 * @param {{ actions?: Array<any>, conversations?: Array<any>, query?: string,
 *           activeConversationId?: string | null, limit?: number }} [input]
 */
export function buildResults({ actions = [], conversations = [], query = '', activeConversationId = null, limit = 12 } = {}) {
  const text = String(query ?? '').trim();

  const actionRows = [...ACTIONS, ...actions]
    .map((action) => ({
      kind: 'action',
      id: action.id,
      label: action.label,
      hint: action.hint ?? '',
      keys: action.keys ?? null,
      score: bestOf([[action.label, 1], [action.keywords ?? '', 0.6]], text),
    }))
    // Actions are the floor of the palette: with an empty query they are what
    // is offered, and they never disappear just because a task matched better.
    .filter((row) => row.score > 1 || !text)
    .sort((a, b) => b.score - a.score);

  const taskRows = conversations
    .map((conversation) => {
      const titleScore = score(conversation.title, text);
      const previewScore = score(conversation.preview, text);
      // A title match is what the operator meant; a match in what was said
      // inside the task is a rescue, and is shown with the matching line.
      const matched = titleScore > 0 ? 'title' : previewScore > 0 ? 'preview' : null;
      return {
        kind: 'task',
        id: conversation.id,
        label: conversation.title || 'Untitled task',
        hint: conversation.preview || '',
        matched,
        active: conversation.id === activeConversationId,
        updatedAt: conversation.updatedAt ?? '',
        score: Math.max(titleScore * 1.4, previewScore),
      };
    })
    .filter((row) => (text ? row.matched !== null : true))
    .sort((a, b) => b.score - a.score || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, limit);

  const groups = [];
  const seen = new Set();
  // Recents first while the box is empty: "a Recent group does more for
  // perceived speed than any animation".
  if (!text && taskRows.length > 0) {
    groups.push({ id: 'tasks', label: 'Your tasks', rows: taskRows.slice(0, 5) });
    for (const row of taskRows.slice(0, 5)) seen.add(row.id);
  }
  if (!text && actionRows.length > 0) groups.push({ id: 'actions', label: 'Actions', rows: actionRows });
  if (text) {
    if (taskRows.length > 0) groups.push({ id: 'tasks', label: 'Tasks', rows: taskRows.filter((r) => !seen.has(r.id)) });
    const kept = actionRows.filter((row) => row.score > 1);
    if (kept.length > 0) groups.push({ id: 'actions', label: 'Actions', rows: kept });
  }
  return groups.filter((group) => group.rows.length > 0);
}

/** A flat list of the rows above, in the order they are drawn. */
export function flatten(groups) {
  return groups.flatMap((group) => group.rows);
}

/**
 * Where the highlight goes when an arrow key is pressed.
 * Wraps, because a palette is a list you go round.
 */
export function moveSelection(current, length, delta) {
  if (length <= 0) return -1;
  const next = (current + delta + length) % length;
  return next;
}

/** The row that should be highlighted after the results change. */
export function selectionAfter(current, length) {
  if (length <= 0) return -1;
  if (current < 0) return 0;
  return Math.min(current, length - 1);
}
