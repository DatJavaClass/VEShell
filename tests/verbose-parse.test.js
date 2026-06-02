'use strict';

// Headless unit test for parseSegments (src/verbose-parse.js). Pure JS, no
// node-pty/Electron deps, so plain `node` works; the .cmd runner mirrors the
// other suites (Electron ABI) for consistency. Covers complete callouts,
// incomplete trailing tails, split-across-chunks streaming, malformed-JSON
// title fallback, and missing optional fields defaulting to ''.

const path = require('path');
const { parseSegments } = require(path.join(__dirname, '..', 'src', 'verbose-parse.js'));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Tiny assert helper that records one PASS/FAIL line per test and captures the
// first failing expectation as detail.
function check(name, fn) {
  try {
    fn();
    record(name, true, '');
  } catch (e) {
    record(name, false, e.message);
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function seg(label, snippet, detail) {
  return JSON.stringify({ label, snippet, detail });
}
function wrap(jsonStr) {
  return `<<CW_SEGMENT>>${jsonStr}<<CW_END>>`;
}

// 1. Two complete callouts in one string -> 2 segments, rest === ''.
check('1. two complete callouts -> 2 segments, rest empty', () => {
  // rest is everything after the LAST <<CW_END>> (contract rule), so the string
  // ends right at the second callout's close marker -> rest must be ''.
  const text =
    'noise before ' +
    wrap(seg('Read CSV', 'open(path)', 'Loads the file.')) +
    ' middle ' +
    wrap(seg('Average', 'sum/len', 'Computes the mean.'));
  const { segments, rest } = parseSegments(text);
  eq(segments.length, 2, 'segment count');
  eq(segments[0], { label: 'Read CSV', snippet: 'open(path)', detail: 'Loads the file.' }, 'segment[0]');
  eq(segments[1], { label: 'Average', snippet: 'sum/len', detail: 'Computes the mean.' }, 'segment[1]');
  eq(rest, '', 'rest');
});

// 2. One complete callout + incomplete trailing <<CW_SEGMENT>>{... (no
//    <<CW_END>>) -> 1 segment, rest === the incomplete tail.
check('2. complete + incomplete tail -> 1 segment, rest is the tail', () => {
  const tail = '<<CW_SEGMENT>>{"label":"Partial","snip';
  const text = wrap(seg('Done', '', 'First part finished.')) + tail;
  const { segments, rest } = parseSegments(text);
  eq(segments.length, 1, 'segment count');
  eq(segments[0], { label: 'Done', snippet: '', detail: 'First part finished.' }, 'segment[0]');
  eq(rest, tail, 'rest holds incomplete tail');
});

// 3. A callout streamed in two halves. First half alone yields 0 segments and
//    rest === firstHalf; rest+secondHalf then yields the full segment.
check('3. split-across-chunks callout assembles on second chunk', () => {
  const full = wrap(seg('Streamed', 'x = 1', 'Built across two reads.'));
  const mid = Math.floor(full.length / 2);
  const firstHalf = full.slice(0, mid);
  const secondHalf = full.slice(mid);

  const r1 = parseSegments(firstHalf);
  eq(r1.segments.length, 0, 'first-half segment count');
  eq(r1.rest, firstHalf, 'first-half rest === firstHalf');

  const r2 = parseSegments(r1.rest + secondHalf);
  eq(r2.segments.length, 1, 'second-pass segment count');
  eq(r2.segments[0], { label: 'Streamed', snippet: 'x = 1', detail: 'Built across two reads.' }, 'assembled segment');
  eq(r2.rest, '', 'second-pass rest empty');
});

// 4. Malformed JSON between markers -> 1 segment via the title fallback:
//    label = trimmed inner truncated to 80 chars, snippet/detail ''.
check('4. malformed JSON -> title fallback (trimmed inner, empty snippet/detail)', () => {
  const inner = '   this is not valid json {oops   ';
  const text = `<<CW_SEGMENT>>${inner}<<CW_END>>`;
  const { segments, rest } = parseSegments(text);
  eq(segments.length, 1, 'segment count');
  eq(segments[0], { label: inner.trim().slice(0, 80), snippet: '', detail: '' }, 'fallback segment');
  eq(rest, '', 'rest');
});

// 4b. Malformed inner longer than 80 chars is truncated to 80 in the label.
check('4b. malformed-JSON fallback truncates label to 80 chars', () => {
  const inner = 'x'.repeat(200) + ' { not json';
  const text = `<<CW_SEGMENT>>${inner}<<CW_END>>`;
  const { segments } = parseSegments(text);
  eq(segments[0].label.length, 80, 'label length capped at 80');
  eq(segments[0].label, inner.trim().slice(0, 80), 'label value');
});

// 5. Missing optional fields (no snippet) default to ''.
check('5. missing optional fields default to empty string', () => {
  const text = '<<CW_SEGMENT>>{"label":"Only label","detail":"Has detail, no snippet."}<<CW_END>>';
  const { segments } = parseSegments(text);
  eq(segments.length, 1, 'segment count');
  eq(segments[0], { label: 'Only label', snippet: '', detail: 'Has detail, no snippet.' }, 'defaults applied');

  // And a JSON object with none of the three fields -> all default to ''.
  const r2 = parseSegments('<<CW_SEGMENT>>{}<<CW_END>>');
  eq(r2.segments[0], { label: '', snippet: '', detail: '' }, 'all fields default');
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== Verbose parse: ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
