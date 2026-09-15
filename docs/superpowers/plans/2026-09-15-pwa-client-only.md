# PWA Client-Only Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the FastAPI/music21 backend entirely and replace it with a pure client-side MusicXML analysis pipeline (Verovio for repeat-expanded MIDI rendering + a hand-written MIDI parser + a hand-written MusicXML pedal/time-signature reader), producing the exact same `scoreData` JSON shape the already-working playback engine expects, then add PWA installability.

**Architecture:** A new `frontend/score-parser.js` orchestrates: (1) unzip `.mxl` via `fflate` if needed, (2) read pedal spans + time signature directly from the raw MusicXML via a small hand-written reader (`frontend/xml-score-reader.js`), (3) feed the same MusicXML into Verovio (WASM, vendored) and call its MIDI export (which expands repeats by default), (4) parse that MIDI with a hand-written binary reader (`frontend/midi-parser.js`) to get notes/beats. The output feeds directly into the unchanged `scheduler.js`/`synth.js`/`metronome.js`/`app.js` playback engine — only `app.js`'s upload handler changes, swapping a `fetch('/api/parse')` call for a local function call.

**Tech Stack:** Verovio (WASM, LGPL-3.0, vendored), `fflate` (MIT, vendored, for `.mxl` unzip), vanilla JS (MIDI parsing and MusicXML reading are hand-written — no bundler, matching this project's zero-build-step convention throughout).

**Spec:** `docs/superpowers/specs/2026-09-15-pwa-client-only-design.md`

## Global Constraints

- `scheduler.js`, `synth.js`, `metronome.js` are NOT modified by this plan — only `app.js`'s upload-handling code and `index.html`'s script tags/markup change on the playback side.
- The final `scoreData` object's shape must exactly match what `app.js` already consumes: `{ title, timeSignature: {numerator, denominator}, totalQuarterLength, notes: [{pitch, startQL, durationQL, velocity}], pedalEvents: [{onQL, offQL}], beats: [{offsetQL, measure}], warnings: [] }`.
- Pedal spans are read directly from the raw (non-repeat-expanded) MusicXML — this is a known, documented limitation for pedal spans that fall inside a repeated section (spec §3 non-goals) — do not attempt to fix this in this plan.
- Real MIDI CC64 sustain-pedal events from Verovio's output are NOT required or used this round (spec §3) — pedal is still applied client-side as the existing "extend note duration" mechanism in `scheduler.js`'s `effectiveDurationQL` (already implemented, unchanged).
- All third-party assets are vendored locally under `frontend/vendor/` and referenced by relative path only — never a live CDN URL in `index.html` (this project has been burned by exactly this mistake once already).
- Actual GitHub Pages deployment (creating a public repo, pushing, enabling Pages) is OUT OF SCOPE for this plan. The plan's last task ends with locally-verified code; publishing is a separate, explicitly-confirmed follow-up action.

---

### Task 1: Vendor Verovio and fflate

**Files:**
- Create: `frontend/vendor/verovio-toolkit-wasm.js`
- Create: `frontend/vendor/fflate.js`

**Interfaces:**
- Produces: two static files under `frontend/vendor/` that Task 4 (score-parser.js) will load via `<script>` tags. This task does NOT touch `index.html` or any other code — scaffolding only, matching the pattern already used for `js-synthesizer` in an earlier round of this project.

- [ ] **Step 1: Download Verovio's WASM toolkit bundle**

```bash
curl -sL "https://cdn.jsdelivr.net/npm/verovio@latest/dist/verovio-toolkit-wasm.js" -o frontend/vendor/verovio-toolkit-wasm.js
```
Verify: `ls -la frontend/vendor/verovio-toolkit-wasm.js` shows a file at least 5MB (it was ~7.3MB when checked during design). If the download is suspiciously small (under 1MB) or `head -c 200 frontend/vendor/verovio-toolkit-wasm.js` shows an HTML error page instead of JavaScript, stop and report rather than proceeding with a bad file.

- [ ] **Step 2: Download fflate**

```bash
curl -sL "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js" -o frontend/vendor/fflate.js
```
Verify: `node --check frontend/vendor/fflate.js` exits 0 (valid JS syntax), and `head -c 200 frontend/vendor/fflate.js` looks like real minified/readable JS, not an error page.

- [ ] **Step 3: Confirm both files are requireable in Node (sanity check only, not a real test)**

```bash
node -e "require('./frontend/vendor/fflate.js'); console.log('fflate loaded OK')"
```
Expected: prints "fflate loaded OK" with no error. (Verovio's file is NOT expected to fully initialize cleanly in a plain Node `require()` in this quick check — its real initialization is verified properly in Task 4, in a browser. Do not spend time debugging Verovio's Node behavior in this task; this step is just confirming the file downloaded intact enough to be syntactically loadable.)

```bash
node --check frontend/vendor/verovio-toolkit-wasm.js
```
Expected: exits 0 (valid JS syntax — this confirms the download isn't corrupted/truncated, without needing it to fully run).

- [ ] **Step 4: Commit**

```bash
git add frontend/vendor/verovio-toolkit-wasm.js frontend/vendor/fflate.js
git commit -m "chore: vendor Verovio (WASM MusicXML/MIDI engine) and fflate (zip extraction)"
```

---

### Task 2: MIDI binary parser (`midi-parser.js`)

**Files:**
- Create: `frontend/midi-parser.js`
- Create: `frontend/midi-parser.test.js`

**Interfaces:**
- Produces (used by Task 4): `parseMidi(arrayBuffer) -> { ticksPerQuarter: number, tracks: Array<Array<MidiEvent>> }` where each `MidiEvent` is one of:
  - `{ ticks, type: 'noteOn', channel, note, velocity }`
  - `{ ticks, type: 'noteOff', channel, note }`
  - `{ ticks, type: 'timeSignature', numerator, denominator }`
  - `{ ticks, type: 'controlChange', channel, controller, value }`
  - `{ ticks, type: 'endOfTrack' }`
  - (Other event types — e.g. tempo, program change, pitch bend — are correctly consumed byte-for-byte to keep the parse position accurate, but are NOT emitted as events; this project doesn't need them.)

This is a standard Structured MIDI File (SMF) reader. It's pure, DOM-free, browser-free — testable directly in Node exactly like `scheduler.js`'s pure functions.

- [ ] **Step 1: Write the failing tests**

`frontend/midi-parser.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { parseMidi } = require('./midi-parser.js');

function encodeVLQ(value) {
  const bytes = [value & 0x7f];
  value = value >> 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value = value >> 7;
  }
  return bytes;
}

function buildTestMidi() {
  const trackEvents = [];
  // Time signature 3/4 at tick 0 (meta type 0x58: numerator, denom-as-power-of-2, clocks/click, 32nds/quarter)
  trackEvents.push(...encodeVLQ(0), 0xff, 0x58, 0x04, 3, 2, 24, 8);
  // Note On pitch 60 velocity 80 at tick 0
  trackEvents.push(...encodeVLQ(0), 0x90, 60, 80);
  // Note Off pitch 60 at tick 480 (one quarter note later, division = 480)
  trackEvents.push(...encodeVLQ(480), 0x80, 60, 0);
  // Note On pitch 64 velocity 80 at the same tick (delta 0)
  trackEvents.push(...encodeVLQ(0), 0x90, 64, 80);
  // Note Off pitch 64 at tick 960
  trackEvents.push(...encodeVLQ(480), 0x80, 64, 0);
  // End of track
  trackEvents.push(...encodeVLQ(0), 0xff, 0x2f, 0x00);

  const trackLength = trackEvents.length;
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length 6
    0x00, 0x00,             // format 0
    0x00, 0x01,             // 1 track
    0x01, 0xe0,             // division = 480
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (trackLength >> 24) & 0xff, (trackLength >> 16) & 0xff, (trackLength >> 8) & 0xff, trackLength & 0xff,
    ...trackEvents,
  ];
  return new Uint8Array(bytes).buffer;
}

test('parseMidi reads ticksPerQuarter from the header division field', () => {
  const result = parseMidi(buildTestMidi());
  assert.strictEqual(result.ticksPerQuarter, 480);
});

test('parseMidi decodes the time signature meta event', () => {
  const result = parseMidi(buildTestMidi());
  const ts = result.tracks[0].find((e) => e.type === 'timeSignature');
  assert.ok(ts, 'expected a timeSignature event');
  assert.strictEqual(ts.ticks, 0);
  assert.strictEqual(ts.numerator, 3);
  assert.strictEqual(ts.denominator, 4);
});

test('parseMidi extracts noteOn/noteOff pairs at correct absolute tick positions', () => {
  const result = parseMidi(buildTestMidi());
  const notes = result.tracks[0]
    .filter((e) => e.type === 'noteOn' || e.type === 'noteOff')
    .map((e) => [e.type, e.ticks, e.note]);
  assert.deepStrictEqual(notes, [
    ['noteOn', 0, 60],
    ['noteOff', 480, 60],
    ['noteOn', 480, 64],
    ['noteOff', 960, 64],
  ]);
});

test('parseMidi includes an endOfTrack event at the final tick', () => {
  const result = parseMidi(buildTestMidi());
  const eot = result.tracks[0].find((e) => e.type === 'endOfTrack');
  assert.ok(eot);
  assert.strictEqual(eot.ticks, 960);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `node --test midi-parser.test.js`
Expected: FAIL — `Cannot find module './midi-parser.js'`.

- [ ] **Step 3: Implement**

`frontend/midi-parser.js`:
```js
function parseVLQ(bytes, offset) {
  let value = 0;
  let pos = offset;
  for (;;) {
    const byte = bytes[pos];
    value = (value << 7) | (byte & 0x7f);
    pos++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, nextOffset: pos };
}

function parseMidi(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let offset = 0;

  function readUint32() {
    const v = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    offset += 4;
    return v;
  }
  function readUint16() {
    const v = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    return v;
  }
  function readAscii(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
    offset += len;
    return s;
  }

  if (readAscii(4) !== 'MThd') throw new Error('Not a valid MIDI file: missing MThd header');
  readUint32(); // header length, always 6, not needed
  readUint16(); // format, not needed
  const numTracks = readUint16();
  const division = readUint16();
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  const ticksPerQuarter = division;

  const tracks = [];
  for (let t = 0; t < numTracks; t++) {
    if (readAscii(4) !== 'MTrk') throw new Error('Expected MTrk chunk');
    const trackLength = readUint32();
    const trackEnd = offset + trackLength;
    const events = [];
    let absoluteTicks = 0;
    let runningStatus = null;

    while (offset < trackEnd) {
      const deltaResult = parseVLQ(bytes, offset);
      absoluteTicks += deltaResult.value;
      offset = deltaResult.nextOffset;

      let statusByte = bytes[offset];
      if (statusByte < 0x80) {
        statusByte = runningStatus; // running status: reuse previous, don't consume a byte
      } else {
        offset++;
        runningStatus = statusByte;
      }

      if (statusByte === 0xff) {
        const metaType = bytes[offset];
        offset++;
        const lenResult = parseVLQ(bytes, offset);
        offset = lenResult.nextOffset;
        const data = bytes.slice(offset, offset + lenResult.value);
        offset += lenResult.value;
        if (metaType === 0x58 && data.length >= 4) {
          events.push({
            ticks: absoluteTicks,
            type: 'timeSignature',
            numerator: data[0],
            denominator: Math.pow(2, data[1]),
          });
        } else if (metaType === 0x2f) {
          events.push({ ticks: absoluteTicks, type: 'endOfTrack' });
        }
        // Other meta types (tempo, key signature, text, ...) are intentionally not emitted.
      } else if (statusByte === 0xf0 || statusByte === 0xf7) {
        const lenResult = parseVLQ(bytes, offset);
        offset = lenResult.nextOffset + lenResult.value; // skip sysex payload
      } else {
        const eventType = statusByte & 0xf0;
        const channel = statusByte & 0x0f;
        if (eventType === 0xc0 || eventType === 0xd0) {
          offset += 1; // program change / channel pressure: 1 data byte
        } else {
          const d1 = bytes[offset];
          const d2 = bytes[offset + 1];
          offset += 2;
          if (eventType === 0x90 && d2 > 0) {
            events.push({ ticks: absoluteTicks, type: 'noteOn', channel, note: d1, velocity: d2 });
          } else if (eventType === 0x80 || (eventType === 0x90 && d2 === 0)) {
            events.push({ ticks: absoluteTicks, type: 'noteOff', channel, note: d1 });
          } else if (eventType === 0xb0) {
            events.push({ ticks: absoluteTicks, type: 'controlChange', channel, controller: d1, value: d2 });
          }
          // 0xa0 (poly aftertouch) and 0xe0 (pitch bend) bytes are consumed above but not emitted.
        }
      }
    }
    tracks.push(events);
    offset = trackEnd;
  }

  return { ticksPerQuarter, tracks };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMidi };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test midi-parser.test.js`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/midi-parser.js frontend/midi-parser.test.js
git commit -m "feat: add standalone MIDI file parser with tests"
```

---

### Task 3: MusicXML pedal/time-signature reader (`xml-score-reader.js`)

**Files:**
- Create: `frontend/xml-score-reader.js`
- Create: `frontend/xml-score-reader.test.js`

**Interfaces:**
- Produces (used by Task 4):
  - `computeTimeSignatureAndPedalSpans(measures) -> { timeSignature: {numerator, denominator} | null, pedalEvents: [{onQL, offQL}], warnings: string[] }` — a PURE function, no DOM dependency, taking a plain-object `measures` array (shape below). This is the function that gets unit tests.
  - `extractMeasuresFromDocument(xmlDocument) -> measures` — a thin adapter that walks a real MusicXML DOM `Document` (as produced by the browser's native `DOMParser`) and produces the same plain-object `measures` shape. This function is NOT unit-tested (it's a thin, low-logic DOM-walking adapter, browser-only — the same division of labor this project already used for `music21`-facing code vs. pure logic in earlier rounds).

**The `measures` plain-object shape** (this is what `computeTimeSignatureAndPedalSpans` consumes, and what `extractMeasuresFromDocument` produces):
```js
[
  {
    number: 1,
    divisions: 2,                         // MusicXML <divisions> value active in this measure (ticks per quarter note, XML's own units — unrelated to MIDI's PPQ)
    timeSignature: { numerator: 3, denominator: 4 } | null,  // only set if this measure has a new <attributes><time>
    positionEvents: [
      { advance: 2 },                     // a note/rest/forward advances the running position within the measure, in <divisions> units
      { advance: -2 },                    // a <backup> moves position backward
      { pedal: 'start' },                 // a <direction><pedal type="start"> at the CURRENT position (advance: 0, implicitly)
      { pedal: 'stop' },
    ],
  },
  // ...
]
```

- [ ] **Step 1: Write the failing tests**

`frontend/xml-score-reader.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { computeTimeSignatureAndPedalSpans } = require('./xml-score-reader.js');

test('computeTimeSignatureAndPedalSpans finds the time signature from the first measure that declares one', () => {
  const measures = [
    { number: 1, divisions: 2, timeSignature: { numerator: 3, denominator: 4 }, positionEvents: [{ advance: 6 }] },
    { number: 2, divisions: 2, timeSignature: null, positionEvents: [{ advance: 6 }] },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.timeSignature, { numerator: 3, denominator: 4 });
  assert.deepStrictEqual(result.warnings, []);
});

test('computeTimeSignatureAndPedalSpans falls back to 4/4 with a warning if no measure declares a time signature', () => {
  const measures = [{ number: 1, divisions: 1, timeSignature: null, positionEvents: [{ advance: 4 }] }];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.timeSignature, { numerator: 4, denominator: 4 });
  assert.strictEqual(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('박자표'));
});

test('computeTimeSignatureAndPedalSpans pairs a pedal start/stop within one measure into a quarterLength span', () => {
  // divisions=2 means 2 divisions per quarter note. Measure has: advance 2 (1 QL), pedal start,
  // advance 2 (1 QL), pedal stop, advance 2 (1 QL) -- so pedal starts at QL 1.0, stops at QL 2.0.
  const measures = [
    {
      number: 1,
      divisions: 2,
      timeSignature: { numerator: 3, denominator: 4 },
      positionEvents: [{ advance: 2 }, { pedal: 'start' }, { advance: 2 }, { pedal: 'stop' }, { advance: 2 }],
    },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.pedalEvents, [{ onQL: 1.0, offQL: 2.0 }]);
});

test('computeTimeSignatureAndPedalSpans converts measure-local divisions into absolute quarterLength across measures', () => {
  // Measure 1 is 3 QL long (divisions=2, total advance=6 -> 3.0 QL). Measure 2's pedal start at
  // local position 2 divisions (1.0 QL) must land at absolute QL 3.0 + 1.0 = 4.0.
  const measures = [
    { number: 1, divisions: 2, timeSignature: { numerator: 3, denominator: 4 }, positionEvents: [{ advance: 6 }] },
    {
      number: 2,
      divisions: 2,
      timeSignature: null,
      positionEvents: [{ advance: 2 }, { pedal: 'start' }, { advance: 2 }, { pedal: 'stop' }, { advance: 2 }],
    },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.pedalEvents, [{ onQL: 4.0, offQL: 5.0 }]);
});

test('computeTimeSignatureAndPedalSpans warns and skips an unmatched pedal stop with no preceding start', () => {
  const measures = [
    { number: 1, divisions: 2, timeSignature: { numerator: 3, denominator: 4 }, positionEvents: [{ pedal: 'stop' }, { advance: 6 }] },
  ];
  const result = computeTimeSignatureAndPedalSpans(measures);
  assert.deepStrictEqual(result.pedalEvents, []);
  assert.strictEqual(result.warnings.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `node --test xml-score-reader.test.js`
Expected: FAIL — `Cannot find module './xml-score-reader.js'`.

- [ ] **Step 3: Implement `computeTimeSignatureAndPedalSpans`**

`frontend/xml-score-reader.js`:
```js
function computeTimeSignatureAndPedalSpans(measures) {
  const warnings = [];
  let timeSignature = null;
  for (const measure of measures) {
    if (measure.timeSignature) {
      timeSignature = measure.timeSignature;
      break;
    }
  }
  if (!timeSignature) {
    timeSignature = { numerator: 4, denominator: 4 };
    warnings.push('박자표를 찾을 수 없어서 4/4로 가정했어요.');
  }

  const pedalEvents = [];
  let measureStartQL = 0;
  let openPedalStartQL = null;

  for (const measure of measures) {
    const divisions = measure.divisions || 1;
    let localDivisions = 0;
    for (const event of measure.positionEvents) {
      if ('advance' in event) {
        localDivisions += event.advance;
        continue;
      }
      const currentQL = measureStartQL + localDivisions / divisions;
      if (event.pedal === 'start') {
        if (openPedalStartQL !== null) {
          warnings.push('이전 페달이 안 닫힌 채로 새 페달이 시작돼서, 이전 페달은 건너뜀.');
        }
        openPedalStartQL = currentQL;
      } else if (event.pedal === 'stop') {
        if (openPedalStartQL === null) {
          warnings.push('시작 없이 끝나는 페달 지시를 건너뜀.');
        } else {
          pedalEvents.push({ onQL: openPedalStartQL, offQL: currentQL });
          openPedalStartQL = null;
        }
      }
    }
    // A measure's total duration in quarterLength, for advancing to the next measure's start.
    let measureTotalDivisions = 0;
    for (const event of measure.positionEvents) {
      if ('advance' in event) measureTotalDivisions += event.advance;
    }
    measureStartQL += measureTotalDivisions / divisions;
  }

  return { timeSignature, pedalEvents, warnings };
}

function extractMeasuresFromDocument(xmlDocument) {
  const measures = [];
  let currentDivisions = 1;
  const measureNodes = xmlDocument.querySelectorAll('part:first-of-type > measure');
  for (const measureNode of measureNodes) {
    const number = parseInt(measureNode.getAttribute('number'), 10);
    let timeSignature = null;
    const divisionsNode = measureNode.querySelector('attributes > divisions');
    if (divisionsNode) currentDivisions = parseInt(divisionsNode.textContent, 10);
    const timeNode = measureNode.querySelector('attributes > time');
    if (timeNode) {
      const beats = timeNode.querySelector('beats');
      const beatType = timeNode.querySelector('beat-type');
      if (beats && beatType) {
        timeSignature = { numerator: parseInt(beats.textContent, 10), denominator: parseInt(beatType.textContent, 10) };
      }
    }

    const positionEvents = [];
    for (const child of measureNode.children) {
      if (child.tagName === 'note') {
        const isChord = !!child.querySelector('chord');
        const isGrace = !!child.querySelector('grace');
        const durationNode = child.querySelector('duration');
        const duration = durationNode ? parseInt(durationNode.textContent, 10) : 0;
        if (!isChord && !isGrace) positionEvents.push({ advance: duration });
      } else if (child.tagName === 'backup') {
        const duration = parseInt(child.querySelector('duration').textContent, 10);
        positionEvents.push({ advance: -duration });
      } else if (child.tagName === 'forward') {
        const duration = parseInt(child.querySelector('duration').textContent, 10);
        positionEvents.push({ advance: duration });
      } else if (child.tagName === 'direction') {
        const pedalNode = child.querySelector('pedal');
        if (pedalNode) {
          const pedalType = pedalNode.getAttribute('type');
          if (pedalType === 'start') positionEvents.push({ pedal: 'start' });
          else if (pedalType === 'stop') positionEvents.push({ pedal: 'stop' });
        }
      }
    }

    measures.push({ number, divisions: currentDivisions, timeSignature, positionEvents });
  }
  return measures;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeTimeSignatureAndPedalSpans, extractMeasuresFromDocument };
}
```

Note: `extractMeasuresFromDocument` only reads the FIRST part (`part:first-of-type`) — matching v1's behavior of deriving beats/time-signature from one part (documented limitation already accepted in the prior round's final review, not something to fix here).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test xml-score-reader.test.js`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/xml-score-reader.js frontend/xml-score-reader.test.js
git commit -m "feat: add MusicXML pedal/time-signature reader with tests"
```

---

### Task 4: Score parser orchestrator (`score-parser.js`) — Verovio integration

**Files:**
- Create: `frontend/score-parser.js`

**Interfaces:**
- Consumes: `parseMidi` (Task 2), `computeTimeSignatureAndPedalSpans` + `extractMeasuresFromDocument` (Task 3), the global `fflate` and `verovio` objects (Task 1's vendored scripts, loaded via `<script>` tags — wiring those tags happens in Task 5).
- Produces (used by Task 5's `app.js`): `async function parseScoreFile(file) -> scoreData` where `file` is a browser `File` object (from an `<input type="file">` or drag-and-drop) and `scoreData` matches the exact shape in this plan's Global Constraints section.

**This is the highest-risk task in this plan — verify the real Verovio API before writing the final integration, don't guess.**

During this plan's design phase, a spike attempt to instantiate Verovio's `verovio-toolkit-wasm.js` bundle directly in Node failed with `TypeError: getToolkitFunction(...) is not a function` when calling `new verovio.toolkit(vrvModule)` after awaiting what appeared to be the module object — the exact initialization sequence needed in Node (if any works at all) was not resolved. **The real target environment for this app is a browser, not Node** — Emscripten/WASM bundles like this are typically built and tested primarily for browser main-thread use, and may behave correctly there even if the exact Node incantation is unclear. Do not spend excessive time trying to force this to work in Node; that failure does not mean the browser path is broken.

Before writing the final version of `parseScoreFile`, do this verification, in order:
1. Read Verovio's official documentation for the correct browser initialization sequence (check `https://book.verovio.org/toolkit-reference/toolkit-methods.html` and `https://book.verovio.org/first-steps/instantiate-in-javascript.html` or equivalent "getting started" pages for the exact incantation — the class name, whether `new verovio.toolkit()` needs an argument or not in the browser build, and whether there's an async "wait until ready" step).
2. Confirm whether `loadData()` auto-detects plain MusicXML text, or whether an explicit option (e.g. something like `setOptions({inputFrom: 'musicxml'})`) must be set first — check the same docs, and if genuinely unclear, test empirically in a browser rather than guessing.
3. Confirm the exact base64-or-binary shape `renderToMIDI()` returns (base64 string vs. raw bytes) so decoding it into an `ArrayBuffer` for `parseMidi()` is correct.
4. If any headless/programmatic browser tooling is available to you in this environment, use it to actually load `verovio-toolkit-wasm.js` on a real page and confirm `loadData()` + `renderToMIDI()` works end to end on a small real MusicXML sample before wiring it into `score-parser.js`. If no such tooling is available, implement your best-verified understanding from the documentation, and say explicitly in your report that end-to-end browser confirmation still needs the user's own machine — this project has consistently treated "needs a real browser to fully verify" as an expected, honest limitation, not a failure, as long as the code is built from verified documentation rather than guesses.

**Implement `frontend/score-parser.js`** following this outline (fill in the exact Verovio calls per your verification above — the surrounding structure is fixed, the Verovio-specific lines are what you must confirm):

```js
const MXL_MAGIC_BYTES = [0x50, 0x4b]; // "PK" -- ZIP local file header signature

async function readFileAsMusicXmlText(file) {
  const buffer = await file.arrayBuffer();
  const firstBytes = new Uint8Array(buffer.slice(0, 2));
  const isZip = firstBytes[0] === MXL_MAGIC_BYTES[0] && firstBytes[1] === MXL_MAGIC_BYTES[1];
  if (!isZip) {
    return new TextDecoder('utf-8').decode(buffer);
  }
  const unzipped = fflate.unzipSync(new Uint8Array(buffer));
  const entryName = Object.keys(unzipped).find(
    (name) => name.toLowerCase().endsWith('.xml') && name.toLowerCase() !== 'meta-inf/container.xml'
  );
  if (!entryName) throw new Error('.mxl 파일 안에서 악보 XML을 찾지 못했어요.');
  return new TextDecoder('utf-8').decode(unzipped[entryName]);
}

async function parseScoreFile(file) {
  const xmlText = await readFileAsMusicXmlText(file);

  const xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserError = xmlDoc.querySelector('parsererror');
  if (parserError) throw new Error('악보 XML을 해석하지 못했어요.');

  const titleNode = xmlDoc.querySelector('work-title, movement-title');
  const title = titleNode ? titleNode.textContent : 'Untitled';

  const measures = extractMeasuresFromDocument(xmlDoc);
  const { timeSignature, pedalEvents, warnings } = computeTimeSignatureAndPedalSpans(measures);

  // --- Verovio: render to MIDI (repeats expanded by default) ---
  // FILL IN based on your verified understanding of the real API:
  //   - how to construct/await-ready the toolkit
  //   - how to load `xmlText` (loadData, possibly after setting an input-format option)
  //   - how to call the MIDI-export method and decode its result into an ArrayBuffer
  const midiArrayBuffer = /* ... verified Verovio calls ... */;

  const { ticksPerQuarter, tracks } = parseMidi(midiArrayBuffer);

  const notes = [];
  for (const track of tracks) {
    const openNotes = new Map(); // note number -> {startTicks, velocity}
    for (const event of track) {
      if (event.type === 'noteOn') {
        openNotes.set(event.note, { startTicks: event.ticks, velocity: event.velocity });
      } else if (event.type === 'noteOff') {
        const open = openNotes.get(event.note);
        if (open) {
          notes.push({
            pitch: event.note,
            startQL: open.startTicks / ticksPerQuarter,
            durationQL: (event.ticks - open.startTicks) / ticksPerQuarter,
            velocity: open.velocity,
          });
          openNotes.delete(event.note);
        }
      }
    }
  }
  notes.sort((a, b) => a.startQL - b.startQL);

  let totalQuarterLength = 0;
  for (const track of tracks) {
    for (const event of track) {
      totalQuarterLength = Math.max(totalQuarterLength, event.ticks / ticksPerQuarter);
    }
  }

  const beats = [];
  const beatSpacingQL = 4.0 / timeSignature.denominator;
  const beatsPerMeasure = timeSignature.numerator;
  let measureNumber = 1;
  let offsetQL = 0;
  while (offsetQL < totalQuarterLength) {
    for (let b = 0; b < beatsPerMeasure && offsetQL < totalQuarterLength; b++) {
      beats.push({ offsetQL, measure: measureNumber });
      offsetQL += beatSpacingQL;
    }
    measureNumber += 1;
  }

  return { title, timeSignature, totalQuarterLength, notes, pedalEvents, beats, warnings };
}
```

Note on the `notes` extraction: MIDI note-on/note-off pairing here assumes no overlapping notes of the *same pitch* on the same track play simultaneously without an intervening note-off (true for normal piano notation; if it ever isn't, the `Map` simply keeps the most recent unmatched note-on for that pitch, which is an acceptable simplification). Also note this does not filter by MIDI channel — if Verovio's export uses multiple channels for multiple staves/parts, this naively merges all channels into one `notes` list, matching v1's own behavior of merging both hands into one flat notes array.

- [ ] **Step 1: Do the verification described above.**

- [ ] **Step 2: Implement `frontend/score-parser.js`** per the outline, with the Verovio-specific lines filled in from your verified understanding.

- [ ] **Step 3: Manual verification, as far as your environment allows**

If any headless/programmatic browser tooling is available: load a page with `score-parser.js` and its dependencies, call `parseScoreFile()` on a small real MusicXML file (a synthetic one is fine — e.g. 2 measures, 3/4, one pedal span, one repeat barline — construct it by hand as a `.musicxml` text file if you don't have a real sample handy), and confirm the returned `scoreData` has plausible values (correct time signature, at least one note, a `totalQuarterLength` that reflects the repeat being expanded if you included one). If no such tooling is available, report exactly what you verified via documentation/code-reading vs. what still needs the user's own browser to confirm.

- [ ] **Step 4: Commit**

```bash
git add frontend/score-parser.js
git commit -m "feat: add client-side score-parser.js orchestrating Verovio + MIDI/XML readers"
```

---

### Task 5: Wire the frontend to local parsing, remove the backend fetch

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

**Interfaces:**
- Consumes: `parseScoreFile(file)` from Task 4.

- [ ] **Step 1: Add script tags to `frontend/index.html`**

Add, before `scheduler.js`'s existing `<script>` tag (order matters — these must load before `score-parser.js`, which must load before `app.js`):
```html
<script src="vendor/fflate.js"></script>
<script src="vendor/verovio-toolkit-wasm.js"></script>
<script src="midi-parser.js"></script>
<script src="xml-score-reader.js"></script>
<script src="score-parser.js"></script>
```

- [ ] **Step 2: Replace the backend fetch in `frontend/app.js`**

Find `handleFile(file)` (it currently builds a `FormData`, does `fetch('/api/parse', { method: 'POST', body: formData })`, and handles the JSON response). Read the current implementation carefully — you are replacing the network call with a local call while preserving everything else about how `scoreData` is used afterward (measureStarts computation, screen switching, title display, warnings display). Replace the network-specific portion with:

```js
async function handleFile(file) {
  errorBanner.hidden = true;
  let parsedScoreData;
  try {
    parsedScoreData = await parseScoreFile(file);
  } catch (err) {
    showError(err.message || '악보 파일을 분석하지 못했어요.');
    return;
  }

  scoreData = parsedScoreData;
  measureStarts = computeMeasureStarts(scoreData.beats);
  titleEl.textContent = scoreData.title;
  uploadScreen.hidden = true;
  practiceScreen.hidden = false;

  if (scoreData.warnings && scoreData.warnings.length) {
    showError(scoreData.warnings.join(' / '));
  }
}
```

Keep everything else in `app.js` (the `dropZone`/`fileInput` listeners that call `handleFile`, the File-System-Access-API picker path, `saveFileHandle`, etc.) exactly as it is — none of that depends on how `handleFile` gets its data.

- [ ] **Step 3: Manual verification**

If a headless/programmatic browser is available: simulate picking a file and confirm `handleFile` reaches the practice screen with a populated `scoreData` and no network request is made (no `/api/parse` call exists anywhere in the code after this change — confirm with `grep -rn "api/parse" frontend/` returning nothing). If no such tooling is available, confirm via code reading that the control flow after `parseScoreFile()` resolves is unchanged from before, and note that a real end-to-end check needs the user's own browser.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: replace backend /api/parse fetch with local score-parser.js call"
```

---

### Task 6: PWA manifest and service worker

**Files:**
- Create: `frontend/manifest.json`
- Create: `frontend/service-worker.js`
- Modify: `frontend/index.html`

**Interfaces:**
- Produces: an installable, offline-capable page. No code interface consumed by other tasks.

- [ ] **Step 1: Create `frontend/manifest.json`**

```json
{
  "name": "피아노 템포 트레이너",
  "short_name": "템포트레이너",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#4a7ec9",
  "icons": []
}
```
(An empty `icons` array is acceptable for this task — the browser will fall back to a generic icon. Adding real icon image files is out of scope for this plan; note it as a follow-up if asked.)

- [ ] **Step 2: Create `frontend/service-worker.js`**

```js
const CACHE_NAME = 'piano-tempo-trainer-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './scheduler.js',
  './synth.js',
  './metronome.js',
  './file-memory.js',
  './score-parser.js',
  './midi-parser.js',
  './xml-score-reader.js',
  './manifest.json',
  './vendor/fflate.js',
  './vendor/verovio-toolkit-wasm.js',
  './vendor/libfluidsynth-2.4.6.js',
  './vendor/js-synthesizer.min.js',
  './vendor/piano.sf2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
```

- [ ] **Step 3: Register the service worker and link the manifest in `frontend/index.html`**

Add inside `<head>`:
```html
<link rel="manifest" href="manifest.json">
```

Add near the end of the `<body>`, after the existing script tags:
```html
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
        console.warn('서비스 워커 등록 실패:', err);
      });
    });
  }
</script>
```

- [ ] **Step 4: Manual verification**

If a headless/programmatic browser is available, load the page and confirm the service worker registers without error and `caches.keys()` reports the `piano-tempo-trainer-v1` cache after the `install` event fires. If not available, note this needs the user's own browser (DevTools → Application → Service Workers is the usual way to confirm this by eye).

- [ ] **Step 5: Commit**

```bash
git add frontend/manifest.json frontend/service-worker.js frontend/index.html
git commit -m "feat: add PWA manifest and offline-caching service worker"
```

---

### Task 7: Open-source license credits

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Add a credits section**

Add inside `#upload-screen`, after the existing `#drop-zone` div:
```html
<p id="license-credits">
  이 앱은 다음 오픈소스를 사용해요:
  <a href="https://github.com/rism-digital/verovio" target="_blank" rel="noopener">Verovio</a> (LGPL-3.0),
  <a href="https://github.com/jet2jet/js-synthesizer" target="_blank" rel="noopener">js-synthesizer</a> (BSD-3-Clause),
  <a href="https://github.com/jet2jet/fluidsynth-emscripten" target="_blank" rel="noopener">FluidSynth (WASM build)</a> (LGPL-2.1),
  <a href="https://github.com/101arrowz/fflate" target="_blank" rel="noopener">fflate</a> (MIT),
  피아노 사운드폰트 (GPL-3.0, 원본: <a href="https://sites.google.com/site/soundfonts4u/" target="_blank" rel="noopener">soundfonts4u</a>)
</p>
```

- [ ] **Step 2: Add minimal styling to `frontend/style.css`**

Add:
```css
#license-credits {
  font-size: 0.75em;
  color: #888;
  margin-top: 24px;
}
#license-credits a {
  color: #888;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: add open-source license credits to the upload screen"
```

---

### Task 8: Remove the backend, update the README

**Files:**
- Delete: `server/` (entire directory: `app.py`, `score_parser.py`, `requirements.txt`, `tests/`, `__init__.py`)
- Modify: `README.md`

- [ ] **Step 1: Delete the backend**

```bash
git rm -r server/
```

- [ ] **Step 2: Rewrite `README.md`**

Replace its contents with:
```markdown
# 피아노 템포 트레이너

개인 연습용 도구: MusicXML 악보를 업로드하면 원하는 BPM으로, 피치 왜곡 없이
피아노 음색으로 재생하고, 메트로놈과 구간 반복 연습을 지원한다. 서버 없이
브라우저에서만 동작하는 PWA(설치형 웹앱)다.

## 사용 방법

이 폴더(`frontend/`) 전체를 정적 웹 호스팅(예: GitHub Pages)에 올리거나,
휴대폰에 그대로 복사해서 `index.html`을 브라우저로 열면 된다. 별도의 서버
실행이 필요 없다.

접속 후 "홈 화면에 추가"(또는 "설치")를 하면 오프라인에서도 계속 쓸 수
있는 앱처럼 동작한다.

## 사용법

1. MusicXML(.musicxml/.mxl) 파일을 업로드 (Chrome/Edge에서는 클릭 시 파일
   선택창 대신 브라우저 자체 피커가 뜨고, 다음에 "이전 파일 불러오기"로
   바로 다시 열 수 있음)
2. ▶ 버튼으로 재생 시작 (모바일 브라우저는 자동재생이 막혀 있어 반드시
   직접 눌러야 함)
3. BPM 슬라이더로 속도 조절 (재생 중에도 즉시 반영됨)
4. 🎹 곡 음량 / 🔔 메트로놈 음량 슬라이더로 각각 따로 조절
5. 메트로놈 소리는 노이즈 틱 / 사인 비프 / 우드블록 중 선택 가능
6. 어려운 구간은 "구간 시작 지정" → "구간 끝 지정" → 🔁 반복 켜기로 반복 연습
7. 도돌이표(`|: :|`) 반복 구간은 자동으로 재생에 반영됨

## 테스트

```bash
node --test frontend/scheduler.test.js
node --test frontend/synth.integration.test.js
node --test frontend/midi-parser.test.js
node --test frontend/xml-score-reader.test.js
```

## 알려진 한계

- 반복 구간 안에 있는 페달(서스테인) 지시는 반복의 두 번째 이후 통과에는
  적용되지 않을 수 있음 (반복 자체는 정상적으로 재생됨).
- iOS Safari는 오래 사용하지 않은 PWA의 캐시를 지울 수 있어서, 그런 경우
  다시 열 때 음원 파일(약 30MB)을 한 번 더 받아야 할 수 있음.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for server-free PWA; remove backend"
```

---

## Self-Review Notes

- **Spec coverage:** §2.1 (백엔드 제거) → Task 8. §2.2 (악보 분석 JS 재구현, 동일 JSON) → Tasks 2-5. §2.3 (도돌이표 지원) → Task 4 (Verovio's default repeat-expansion) + Task 4's manual-verification step explicitly checks this. §2.4 (PWA) → Task 6. §2.5 (라이선스 표시) → Task 7. §2.6 / §9 (GitHub Pages 배포는 별도) → explicitly excluded from every task, called out in Global Constraints.
- **Type/name consistency check:** `parseMidi`'s event shapes (Task 2) are consumed exactly as defined in Task 4's notes-extraction loop (`event.type === 'noteOn'`, `event.note`, `event.velocity`, `event.ticks`). `computeTimeSignatureAndPedalSpans`'s return shape (Task 3: `{timeSignature, pedalEvents, warnings}`) matches exactly how Task 4 destructures it. The `measures`/`positionEvents` plain-object shape is used identically in Task 3's own two functions and its tests.
- **No placeholders:** every step has real code, except Task 4's Verovio-specific lines, which are deliberately left as an explicit verify-then-fill-in instruction (not a placeholder to skip) because guessing this exact detail has broken this project's audio pipeline once already (the CDN-MIME-type incident) — the surrounding structure, data flow, and every other line are fully specified.
