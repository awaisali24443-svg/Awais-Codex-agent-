/* ==========================================================================
   Voice helpers — pure functions only, no DOM, no browser APIs.

   The rule: everything in here must be unit-testable under tsx with zero
   browser globals. The browser-specific wiring (SpeechRecognition,
   speechSynthesis) lives in app.js and calls into these.
   ========================================================================== */

/**
 * Strip markdown down to plain speakable text for speechSynthesis.
 * Fenced code blocks are dropped (reading code aloud is noise); inline code
 * keeps its content; links keep their text; headings and list markers go.
 */
export function stripMarkdownForSpeech(source) {
  return String(source || '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks → silence
    .replace(/`([^`]*)`/g, '$1') // inline code → its content
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/^#{1,6}\s+/gm, '') // headings → text
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(^|\W)\*(\S(?:[^*]*\S)?)\*(?=\W|$)/g, '$1$2') // italic *
    .replace(/(^|\W)_(\S(?:[^_]*\S)?)_(?=\W|$)/g, '$1$2') // italic _
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, '') // numbered markers
    .replace(/^\s*>\s?/gm, '') // quote markers
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Combine a SpeechRecognition onresult event's results into the current
 * transcript. `results` is an array of { transcript, isFinal } — the interim
 * (non-final) tail is included so the composer shows live text while the
 * operator is still talking.
 */
export function combineTranscripts(results) {
  return (results || []).map((r) => r.transcript || '').join('');
}

/**
 * Plain-language explanation for a SpeechRecognition onerror code.
 * Never auto-sends anything; the operator always reviews the transcript.
 */
export function recognitionErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone is blocked — allow it in the browser to use voice input.';
    case 'no-speech':
      return 'Did not hear anything — try again.';
    case 'audio-capture':
      return 'No microphone found on this device.';
    case 'network':
      return 'Voice input needs a data connection right now.';
    default:
      return 'Voice input failed — you can type instead.';
  }
}
