'use strict';

/* Pure parser for the Verbose callout stream (no Node deps, unit-testable).
   Pulls complete <<CW_SEGMENT>>{json}<<CW_END>> callouts from a streamed
   string; returns { segments, rest } where rest is the unconsumed tail.
   main.js calls this incrementally, tracking how many it has emitted. */

const SEGMENT_RE = /<<CW_SEGMENT>>([\s\S]*?)<<CW_END>>/g;

function parseSegments(text) {
  const src = String(text == null ? '' : text);
  const segments = [];
  let lastEnd = 0;

  SEGMENT_RE.lastIndex = 0;
  let m;
  while ((m = SEGMENT_RE.exec(src)) !== null) {
    const inner = m[1];
    let seg;
    try {
      const obj = JSON.parse(inner);
      seg = {
        label: typeof obj.label === 'string' ? obj.label : '',
        snippet: typeof obj.snippet === 'string' ? obj.snippet : '',
        detail: typeof obj.detail === 'string' ? obj.detail : ''
      };
    } catch (_) {
      // Bad JSON: best-effort title from the inner text.
      seg = { label: inner.trim().slice(0, 80), snippet: '', detail: '' };
    }
    segments.push(seg);
    lastEnd = SEGMENT_RE.lastIndex;
  }

  // Everything after the last <<CW_END>> is an incomplete tail; hold it.
  const rest = src.slice(lastEnd);
  return { segments, rest };
}

module.exports = { parseSegments };
