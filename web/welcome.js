/* Welcome screen: data and rules for the empty-conversation state.
   Pure functions only — imported by app.js and by the node tests.
   Chips fill the composer as editable text; they never auto-send. */

export const ASSISTANT_NAME = 'Awais Codex';
export const WELCOME_GREETING = 'What should I do for you today?';

/* What the agent actually does, in the operator's words. 4–6 entries,
   short labels, no emoji — the warm minimal design carries itself. */
export const SUGGESTIONS = Object.freeze([
  { label: 'Research a topic', fill: 'Research this topic in depth and summarize it: ' },
  { label: 'Check my email', fill: 'Check my Gmail for unread messages and summarize the important ones' },
  { label: 'My calendar', fill: "What's on my calendar today?" },
  { label: 'Plan a mission', fill: 'Help me plan this mission step by step and estimate its cost: ' },
  { label: 'Summarize a repo', fill: 'Summarize this GitHub repo for me: ' },
]);

/** The welcome screen shows exactly when the conversation has no messages. */
export function isWelcomeVisible(messageCount) {
  return messageCount === 0;
}

/** The text a suggestion chip drops into the composer. */
export function suggestionFill(suggestion) {
  return suggestion.fill;
}

/** Fill-composer wiring, DOM-light so tests can drive it with fakes.
   Mirrors the voice-transcript rule: the operator reviews before sending. */
export function fillComposerFromChip(promptEl, sendEl, fill) {
  promptEl.value = fill;
  sendEl.disabled = false;
}
