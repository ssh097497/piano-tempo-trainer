# WASM Synth + Metronome/Volume/Reload Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser piano synth engine (WebAudioFont, which sounds synthetic on solo notes) with `js-synthesizer` (WASM FluidSynth) driving a real multi-sampled piano soundfont, and add three requested UI features: selectable metronome click sounds, independent song/metronome volume, and a one-click reload of the last-opened file via the File System Access API.

**Architecture:** `frontend/synth.js` is rewritten internally (same external `createPianoSynth(audioContext)` interface) to drive `js-synthesizer`'s WASM FluidSynth engine and its `ISequencer` for future-time note scheduling, instead of WebAudioFont. `frontend/metronome.js` grows a `soundType` and `volume` parameter. `frontend/app.js` gains two volume sliders (song volume folded into the existing velocity-scaling call, no synth API change needed) and a new `frontend/file-memory.js` module for persisting a `FileSystemFileHandle` in IndexedDB so a "이전 파일 불러오기" button can reopen it without a picker dialog.

**Tech Stack:** `js-synthesizer` (npm, WASM FluidSynth wrapper) + `fluidsynth-emscripten`'s WASM glue, vendored locally like v1's WebAudioFont assets. IndexedDB (native browser API, no library) for the remembered file handle. Everything else unchanged from v1 (FastAPI backend, vanilla JS frontend, Node's built-in test runner for pure logic).

**Spec:** `docs/superpowers/specs/2026-09-15-wasm-synth-and-features-design.md`

## Global Constraints

- `synth.js`'s external interface must stay `createPianoSynth(audioContext) -> { loadPiano(): Promise<void>, playNote(pitch, when, durationSeconds, velocity): void, stopAll(): void }` — `app.js`'s calling code does not change.
- All third-party assets are vendored under `frontend/vendor/` and served by the app's own static mount — never referenced by a live CDN URL in `index.html` (the origin's Content-Type/CSP headers don't matter once vendored and served by our own FastAPI static mount, but a live CDN reference in the shipped page does — v1 shipped totally silent once before this was caught).
- Metronome clicks stay uniform in pitch/volume across every beat — no downbeat accent, regardless of which of the 3 sound types is selected (v1's explicit user correction still applies).
- The pedal mechanism stays as-is this round: `effectiveDurationQL`'s "extend note duration" workaround, not a real MIDI CC64 signal — do not touch `frontend/scheduler.js`'s `effectiveDurationQL` function's behavior in this plan.
- File System Access API features must feature-detect (`'showOpenFilePicker' in window`) and no-op (hide the button, skip IndexedDB calls) on browsers without it — never throw or break the existing plain `<input type="file">` / drag-and-drop upload path.
- Reuse the already-downloaded, already-verified-good-sounding soundfont at `C:\Users\seolhee.sun\AppData\Local\Temp\claude\C--Users-seolhee-sun-orca-projects-hobby\8a584488-8c37-41be-9b73-e114b520de10\scratchpad\piano.sf2` (21,782,810 bytes) rather than re-downloading — copy it into the repo.

---

### Task 1: Vendor js-synthesizer assets

**Files:**
- Create: `frontend/vendor/libfluidsynth-2.4.6.js`
- Create: `frontend/vendor/js-synthesizer.min.js`
- Create: `frontend/vendor/piano.sf2`
- Delete: `frontend/vendor/WebAudioFontPlayer.js`
- Delete: `frontend/vendor/0000_FluidR3_GM_sf2_file.js`
- Delete: `frontend/vendor/0000_GeneralUserGS_sf2_file.js`

**Interfaces:**
- Produces: three static files under `frontend/vendor/` that Task 3 will reference from `index.html` and load via `synth.js`. No code interface yet — this task is scaffolding only, and deliberately does NOT touch `index.html` or `synth.js`, so nothing is wired up or broken by this task alone.

This task is pure asset staging so the next task's diff is just logic, not also a multi-megabyte binary diff.

- [ ] **Step 1: Download the FluidSynth WASM glue file**

```bash
curl -sL "https://github.com/jet2jet/fluidsynth-emscripten/releases/download/v2.4.6-em-2/libfluidsynth-2.4.6.js" -o frontend/vendor/libfluidsynth-2.4.6.js
```
Verify: `ls -la frontend/vendor/libfluidsynth-2.4.6.js` shows exactly 571798 bytes. If the size differs, the download failed or the release moved — stop and report rather than proceeding with a bad file.

- [ ] **Step 2: Download the js-synthesizer library**

```bash
curl -sL "https://cdn.jsdelivr.net/npm/js-synthesizer@1.13.0/dist/js-synthesizer.min.js" -o frontend/vendor/js-synthesizer.min.js
```
Verify: `head -c 100 frontend/vendor/js-synthesizer.min.js` shows real minified JS (not an HTML error page), and `node --check frontend/vendor/js-synthesizer.min.js` exits 0 (valid JS syntax).

- [ ] **Step 3: Copy the already-verified piano soundfont**

```bash
cp "C:\Users\seolhee.sun\AppData\Local\Temp\claude\C--Users-seolhee-sun-orca-projects-hobby\8a584488-8c37-41be-9b73-e114b520de10\scratchpad\piano.sf2" frontend/vendor/piano.sf2
```
Verify: `ls -la frontend/vendor/piano.sf2` shows exactly 21782810 bytes.

- [ ] **Step 4: Remove the old WebAudioFont vendor assets**

```bash
git rm frontend/vendor/WebAudioFontPlayer.js frontend/vendor/0000_FluidR3_GM_sf2_file.js frontend/vendor/0000_GeneralUserGS_sf2_file.js
```
Do NOT touch `frontend/index.html` or `frontend/synth.js` in this task — they still reference these files by name and will be updated together in Task 3. Leaving them referencing now-deleted files is fine for one task's duration; Task 3 fixes it immediately next.

- [ ] **Step 5: Commit**

```bash
git add frontend/vendor/libfluidsynth-2.4.6.js frontend/vendor/js-synthesizer.min.js frontend/vendor/piano.sf2
git commit -m "chore: vendor js-synthesizer (WASM FluidSynth) assets, remove WebAudioFont assets"
```

---

### Task 2: Pure tick-conversion helper (`scheduler.js`)

**Files:**
- Modify: `frontend/scheduler.js`
- Modify: `frontend/scheduler.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 3): `ticksForFutureTime(currentTick, ticksPerSecond, audioContextNow, when) -> number` — added to the existing `module.exports` guard alongside `TempoClock`/`computeMeasureStarts`/`snapLoopStart`/`snapLoopEnd`/`effectiveDurationQL`.

`js-synthesizer`'s sequencer schedules events by an internal tick counter, not by `audioContext.currentTime` directly. This is the one piece of new math needed to bridge our existing "schedule at a future audioContext-relative time" scheduler design onto that tick-based API — and, like the rest of `scheduler.js`, it's pure arithmetic with no DOM/Web-Audio dependency, so it belongs in the already-established Node-testable module rather than inline in `synth.js`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/scheduler.test.js`:
```js
test('ticksForFutureTime: a "when" equal to now maps to the current tick', () => {
  assert.strictEqual(ticksForFutureTime(1000, 1000, 5.0, 5.0), 1000);
});

test('ticksForFutureTime: 0.5s in the future at 1000 ticks/sec adds 500 ticks', () => {
  assert.strictEqual(ticksForFutureTime(1000, 1000, 5.0, 5.5), 1500);
});

test('ticksForFutureTime: scales correctly at a different ticksPerSecond', () => {
  assert.strictEqual(ticksForFutureTime(0, 500, 0.0, 2.0), 1000);
});

test('ticksForFutureTime: rounds to the nearest integer tick', () => {
  assert.strictEqual(ticksForFutureTime(0, 1000, 0.0, 0.0011), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `node --test scheduler.test.js`
Expected: FAIL — `ticksForFutureTime is not defined`.

- [ ] **Step 3: Implement**

Add to `frontend/scheduler.js`, before the `module.exports` guard:
```js
function ticksForFutureTime(currentTick, ticksPerSecond, audioContextNow, when) {
  return Math.round(currentTick + (when - audioContextNow) * ticksPerSecond);
}
```
Add `ticksForFutureTime` to the existing `module.exports` object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scheduler.test.js`
Expected: all tests pass (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/scheduler.js frontend/scheduler.test.js
git commit -m "feat: add audioContext-time-to-sequencer-tick conversion helper"
```

---

### Task 3: Rewrite `synth.js` on js-synthesizer, update `index.html`

**Files:**
- Modify: `frontend/synth.js` (full rewrite of internals; external interface unchanged)
- Modify: `frontend/index.html` (swap vendor script tags)

**Interfaces:**
- Consumes: `ticksForFutureTime` from Task 2 (`frontend/scheduler.js`, already loaded as a global by the time `synth.js` runs, per `index.html`'s script order).
- Produces (used by existing `app.js`, unchanged from v1): `createPianoSynth(audioContext) -> { loadPiano(): Promise<void>, playNote(pitch, when, durationSeconds, velocity): void, stopAll(): void }`.

**Before writing code — verify the exact `js-synthesizer` sequencer event API.** The primary approach below (a combined `'note'` event carrying its own duration) is the pattern reported by research into the library's README and `src/main/ISequencer.ts`/`SequencerEvent.ts` type definitions, but has not been executed against the real library in this session. Before finalizing, open `frontend/vendor/js-synthesizer.min.js` is minified and unreadable directly — instead fetch the readable source to confirm the exact event shape and method names:
```bash
curl -s "https://raw.githubusercontent.com/jet2jet/js-synthesizer/master/src/main/SequencerEvent.ts" | head -100
curl -s "https://raw.githubusercontent.com/jet2jet/js-synthesizer/master/src/main/ISequencer.ts" | head -100
curl -s "https://raw.githubusercontent.com/jet2jet/js-synthesizer/master/README.md" | head -200
```
If the combined `'note'` event with a `duration` field is confirmed, use the primary approach below. If it is NOT present in the real type definitions, fall back to sending two separate events — a `'noteon'` event at the start tick and a `'noteoff'` event at `start tick + duration in ticks` — using whatever the real confirmed event-type names and field names are (do not guess a name that isn't in the fetched source; if genuinely stuck after checking all three URLs above, report BLOCKED with what you found rather than shipping an unverified guess — this exact category of mistake shipped a silent, totally-broken audio path once already earlier in this project).

- [ ] **Step 1: Implement `frontend/synth.js`**

Primary approach (verify per the above before committing to it):
```js
function createPianoSynth(audioContext) {
  let synth = null;
  let sequencer = null;
  const ticksPerSecond = 1000;

  async function loadPiano() {
    synth = new JSSynth.Synthesizer();
    synth.init(audioContext.sampleRate);
    const node = synth.createAudioNode(audioContext, 8192);
    node.connect(audioContext.destination);

    const response = await fetch('vendor/piano.sf2');
    const sfontData = await response.arrayBuffer();
    await synth.loadSFont(sfontData);

    sequencer = await synth.createSequencer();
    await sequencer.registerSynthesizer(synth);
    sequencer.setTimeScale(ticksPerSecond);
  }

  function playNote(pitch, when, durationSeconds, velocity) {
    const currentTick = sequencer.getTick();
    const targetTick = ticksForFutureTime(currentTick, ticksPerSecond, audioContext.currentTime, when);
    const durationMs = Math.round(durationSeconds * 1000);
    sequencer.sendEventAt(
      { type: 'note', channel: 0, key: pitch, vel: velocity, duration: durationMs },
      targetTick,
      false
    );
  }

  function stopAll() {
    if (sequencer) {
      sequencer.removeAllEvents();
    }
    if (synth) {
      synth.midiAllNotesOff(0);
    }
  }

  return { loadPiano, playNote, stopAll };
}
```
Adjust method names (`removeAllEvents`, `midiAllNotesOff`, `getTick`) to whatever the verification step above actually confirms exists — these three in particular are needed for `stopAll()`'s correctness (Task 8 of v1's fix wave added a `clearInterval`-before-`setInterval` guard specifically because a leaked/uncleared scheduling primitive caused a real bug; don't reintroduce that class of bug here by leaving stale sequencer events uncleared on stop/restart/loop).

- [ ] **Step 2: Update `frontend/index.html`'s script tags**

Replace:
```html
  <script src="vendor/WebAudioFontPlayer.js"></script>
  <script src="vendor/0000_GeneralUserGS_sf2_file.js"></script>
```
with:
```html
  <script src="vendor/libfluidsynth-2.4.6.js"></script>
  <script src="vendor/js-synthesizer.min.js"></script>
```
(keep `scheduler.js`, `synth.js`, `metronome.js`, `app.js` loading after these two, same as before).

- [ ] **Step 3: Manual verification**

Start the backend (`uvicorn server.app:app --host 0.0.0.0 --port 8000` from the repo root — note this plan's repo root already differs from v1's; run it from wherever `server/app.py`'s parent directory is in this worktree). Load the page in whatever browser tooling is available; check the console for load errors from the two new vendor scripts and for `JSSynth` being defined as a global. If no headless browser with audio output is available in this environment, say so explicitly and report exactly what you could confirm (scripts load without console errors, `typeof JSSynth !== 'undefined'`) versus what only a real listen can confirm (does it actually play, does timing hold up) — this needs the user's ears, same as every audio-quality claim in this project so far.

- [ ] **Step 4: Commit**

```bash
git add frontend/synth.js frontend/index.html
git commit -m "feat: switch synth.js to js-synthesizer (WASM FluidSynth) with real piano soundfont"
```

---

### Task 4: Metronome — selectable sound + volume parameter

**Files:**
- Modify: `frontend/metronome.js`

**Interfaces:**
- Produces (used by Task 5's `app.js` wiring): `playClick(audioContext, when, soundType, volume)` where `soundType` is one of `'noise' | 'beep' | 'woodblock'` and `volume` is 0.0-1.0. This replaces the current 2-argument `playClick(audioContext, when)` signature.

All three sound types must remain uniform across every beat (no accent/downbeat branching) — this only adds a *global* sound-type and volume choice, not a per-beat one.

- [ ] **Step 1: Implement**

Replace the contents of `frontend/metronome.js`:
```js
function playNoiseClick(audioContext, when, volume) {
  const duration = 0.04;
  const bufferSize = Math.ceil(audioContext.sampleRate * duration);
  const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const noise = audioContext.createBufferSource();
  noise.buffer = buffer;
  const filter = audioContext.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 2500;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(2.5 * volume, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  noise.start(when);
  noise.stop(when + duration);
}

function playBeepClick(audioContext, when, volume) {
  const duration = 0.03;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = 1500;
  gain.gain.setValueAtTime(1.0 * volume, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(when);
  osc.stop(when + duration);
}

function playWoodblockClick(audioContext, when, volume) {
  const duration = 0.05;
  const bufferSize = Math.ceil(audioContext.sampleRate * duration);
  const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const noise = audioContext.createBufferSource();
  noise.buffer = buffer;
  const filter = audioContext.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 800;
  filter.Q.value = 3;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(2.5 * volume, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  noise.start(when);
  noise.stop(when + duration);
}

function playClick(audioContext, when, soundType, volume) {
  if (soundType === 'beep') {
    playBeepClick(audioContext, when, volume);
  } else if (soundType === 'woodblock') {
    playWoodblockClick(audioContext, when, volume);
  } else {
    playNoiseClick(audioContext, when, volume);
  }
}
```

- [ ] **Step 2: Manual verification**

If Web Audio playback is available: call `playClick(ctx, ctx.currentTime, 'noise', 1.0)`, then `'beep'`, then `'woodblock'`, confirming three audibly distinct sounds and that each sounds identical across repeated calls (no accent variance). If not available in this environment, self-review the code for the uniform-strength invariant (no `beatIndex`/`isDownbeat`-shaped parameter anywhere in any of the three functions) and report that as what you verified.

- [ ] **Step 3: Commit**

```bash
git add frontend/metronome.js
git commit -m "feat: add selectable metronome click sounds (noise/beep/woodblock) and volume parameter"
```

---

### Task 5: Volume controls — UI + wiring

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

**Interfaces:**
- Consumes: `playClick(audioContext, when, soundType, volume)` from Task 4.
- Produces: two new module-level variables in `app.js` (`songVolume`, `metronomeVolume`, both 0.0-1.0, default 1.0) and a `metronomeSoundType` variable (default `'noise'`) that `schedulerTick` reads on every call — no new exported interface for later tasks.

Song volume needs no change to `synth.js`'s interface: `playNote`'s existing `velocity` parameter (0-127) is what controls loudness inside `synth.js`, so scaling it by `songVolume` before the call achieves independent song-volume control with zero synth-side changes.

- [ ] **Step 1: Add UI controls to `frontend/index.html`**

Add inside `#practice-screen`, after the existing `metronome-toggle` row:
```html
    <div class="controls-row">
      <label for="song-volume-slider">🎹 곡 음량</label>
      <input type="range" id="song-volume-slider" min="0" max="100" value="100">
    </div>

    <div class="controls-row">
      <label for="metronome-volume-slider">🔔 메트로놈 음량</label>
      <input type="range" id="metronome-volume-slider" min="0" max="100" value="100">
      <select id="metronome-sound-select">
        <option value="noise" selected>노이즈 틱</option>
        <option value="beep">사인 비프</option>
        <option value="woodblock">우드블록</option>
      </select>
    </div>
```

- [ ] **Step 2: Wire it up in `frontend/app.js`**

Add these DOM references alongside the existing ones near the top of the module:
```js
  const songVolumeSlider = document.getElementById('song-volume-slider');
  const metronomeVolumeSlider = document.getElementById('metronome-volume-slider');
  const metronomeSoundSelect = document.getElementById('metronome-sound-select');
```

Add these state variables alongside the existing ones (`metronomeOn`, `loopOn`, etc.):
```js
  let songVolume = 1.0;
  let metronomeVolume = 1.0;
  let metronomeSoundType = 'noise';
```

Add these listeners near the other control listeners:
```js
  songVolumeSlider.addEventListener('input', () => {
    songVolume = Number(songVolumeSlider.value) / 100;
  });
  metronomeVolumeSlider.addEventListener('input', () => {
    metronomeVolume = Number(metronomeVolumeSlider.value) / 100;
  });
  metronomeSoundSelect.addEventListener('change', () => {
    metronomeSoundType = metronomeSoundSelect.value;
  });
```

In `schedulerTick`, find the line that calls `synth.playNote(note.pitch, when, durationSec, note.velocity);` and change it to:
```js
      synth.playNote(note.pitch, when, durationSec, note.velocity * songVolume);
```

Find the line that calls `playClick(audioContext, when);` and change it to:
```js
        playClick(audioContext, when, metronomeSoundType, metronomeVolume);
```

- [ ] **Step 3: Manual verification**

Drag the song-volume slider to 0 during playback — piano should go silent while the metronome (if on) stays audible. Drag it back up — piano returns. Same test for the metronome-volume slider in the opposite direction. Switch the metronome sound dropdown mid-playback and confirm the *next* click uses the new sound (no restart needed, since `metronomeSoundType` is read fresh on every `schedulerTick` call).

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: add independent song/metronome volume sliders and metronome sound picker"
```

---

### Task 6: Remembered-file reload via File System Access API

**Files:**
- Create: `frontend/file-memory.js`
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

**Interfaces:**
- Produces: `frontend/file-memory.js` exposes four browser-global functions (loaded via `<script src="file-memory.js">`, no module system, same pattern as the rest of `frontend/`):
  - `isFileSystemAccessSupported() -> boolean`
  - `saveFileHandle(handle): Promise<void>`
  - `loadFileHandle(): Promise<FileSystemFileHandle | null>`
  - `clearFileHandle(): Promise<void>`
- Consumes (in `app.js`): the above four functions, plus the existing `handleFile(file)` function that already exists in `app.js` from v1 (it takes a plain `File` object and POSTs it to `/api/parse` — a `File` obtained via `handle.getFile()` is a drop-in match for what it already expects).

- [ ] **Step 1: Implement `frontend/file-memory.js`**

```js
const DB_NAME = 'piano-tempo-trainer';
const STORE_NAME = 'file-handles';
const HANDLE_KEY = 'last-opened';

function isFileSystemAccessSupported() {
  return 'showOpenFilePicker' in window;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFileHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadFileHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function clearFileHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

- [ ] **Step 2: Add the "이전 파일 불러오기" button to `frontend/index.html`**

Inside `#upload-screen`, before the existing `#drop-zone` div:
```html
    <button id="reload-last-file-btn" hidden>이전 파일 불러오기</button>
```
Add the new script tag near the top of the script list (before `app.js`, order relative to the others doesn't matter since it has no dependency on them):
```html
  <script src="file-memory.js"></script>
```

- [ ] **Step 3: Wire it up in `frontend/app.js`**

Add a DOM reference: `const reloadLastFileBtn = document.getElementById('reload-last-file-btn');`

Add this near the top-level setup code (runs once when the page loads, alongside any other page-load-time setup — if there isn't an existing "on load" block, add this as a plain top-level statement inside the module's IIFE, after the DOM references are all defined):
```js
  (async function initReloadButton() {
    if (!isFileSystemAccessSupported()) return;
    const handle = await loadFileHandle();
    if (handle) {
      reloadLastFileBtn.hidden = false;
    }
  })();

  reloadLastFileBtn.addEventListener('click', async () => {
    const handle = await loadFileHandle();
    if (!handle) return;
    try {
      const permission = await handle.queryPermission({ mode: 'read' });
      if (permission !== 'granted') {
        const requested = await handle.requestPermission({ mode: 'read' });
        if (requested !== 'granted') {
          showError('파일 접근 권한이 필요해요.');
          return;
        }
      }
      const file = await handle.getFile();
      await handleFile(file);
    } catch (err) {
      showError('이전 파일을 찾을 수 없어요. 다시 업로드해주세요.');
      await clearFileHandle();
      reloadLastFileBtn.hidden = true;
    }
  });
```

Now change how a fresh file is opened via the picker (not drag-and-drop) so we get a handle to remember. Find `dropZone`'s existing click-to-browse mechanism (v1 used a transparent `<input type="file">` overlaying the drop zone, relying on the browser's native click-to-open-file-picker behavior on that input). Add this instead, so a supporting browser uses the real picker (which yields a handle) while an unsupporting browser keeps using the existing `<input>` unchanged:
```js
  if (isFileSystemAccessSupported()) {
    dropZone.addEventListener('click', async (e) => {
      e.preventDefault();
      let handles;
      try {
        handles = await window.showOpenFilePicker({
          types: [{ description: 'MusicXML', accept: { 'application/xml': ['.musicxml', '.mxl', '.xml'] } }],
        });
      } catch (err) {
        return; // user cancelled the picker — not an error
      }
      const handle = handles[0];
      await saveFileHandle(handle);
      const file = await handle.getFile();
      await handleFile(file);
    });
  }
```
This listener is added in addition to the existing `fileInput`'s `change` listener and `dropZone`'s `dragover`/`drop` listeners from v1 — do not remove those; they still serve drag-and-drop and the non-supporting-browser fallback. In a supporting browser, clicking the drop zone now opens `showOpenFilePicker` instead of the underlying `<input>` (add `e.preventDefault()` as shown to stop the click from also bubbling into the overlaid `<input>` and opening a second, native picker dialog).

Also add, at the end of the existing `handleFile` function (after a successful parse, right before or after `practiceScreen.hidden = false`), nothing — `handleFile` doesn't need to know about handles at all, since the caller (the picker click handler above) already calls `saveFileHandle` before calling `handleFile`. Leave `handleFile` itself unchanged.

- [ ] **Step 4: Manual verification**

In a Chromium-based browser: click the drop zone, pick a MusicXML file via the real OS file picker (not drag-and-drop) — confirm it loads normally. Reload the page — confirm "이전 파일 불러오기" now appears. Click it — confirm the same file loads without any picker dialog appearing. In a non-Chromium browser (or by stubbing `isFileSystemAccessSupported` to return `false` for a quick check), confirm the button never appears and the existing `<input>`/drag-and-drop upload still works exactly as in v1.

- [ ] **Step 5: Commit**

```bash
git add frontend/file-memory.js frontend/index.html frontend/app.js
git commit -m "feat: remember last-opened file via File System Access API, add one-click reload"
```

---

### Task 7: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the usage section**

Add to the numbered usage list (after the existing metronome on/off step), and add a new subsection:
```markdown
6. 🎹 곡 음량 / 🔔 메트로놈 음량 슬라이더로 각각 따로 조절
7. 메트로놈 소리는 노이즈 틱 / 사인 비프 / 우드블록 중 선택 가능
8. (Chrome/Edge) 한 번 연 파일은 "이전 파일 불러오기" 버튼으로 다음 접속 때 바로 다시 열 수 있음 — Safari 등에서는 이 버튼이 보이지 않고 기존 업로드 방식만 사용 가능
```
Add a short note near the top explaining this branch supersedes v1's synth engine:
```markdown
> 이 버전은 피아노 음색을 WebAudioFont 대신 실제 FluidSynth(WASM)+피아노 샘플로 재생해서 v1보다 자연스러운 소리가 납니다.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for WASM synth swap and new metronome/volume/reload features"
```

---

## Self-Review Notes

- **Spec coverage:** §3 (synth swap) → Tasks 1-3. §4 (metronome sound + volume) → Tasks 4-5. §5 (remembered file) → Task 6. §6 non-goals (real pedal signal, metronome accent, multi-file memory) are explicitly not touched by any task, matching the spec. §7 testing → Task 2's Node tests are the only automated-test-bearing task this round, matching the spec's own statement that everything else needs manual/audio verification.
- **Type/name consistency check:** `playClick`'s new 4-argument signature (Task 4) matches its call site in Task 5 exactly (`playClick(audioContext, when, metronomeSoundType, metronomeVolume)`). `ticksForFutureTime`'s signature (Task 2: `(currentTick, ticksPerSecond, audioContextNow, when)`) matches its use in Task 3's `synth.js` (`ticksForFutureTime(currentTick, ticksPerSecond, audioContext.currentTime, when)`) — argument order double-checked to line up. `file-memory.js`'s four function names (Task 6) are used with those exact names in `app.js`'s wiring in the same task.
- **No placeholders:** every step has real code. The one deliberately-flagged uncertainty (Task 3's exact sequencer event field names) is not a placeholder — it's a concrete verification instruction with a primary approach, a fallback strategy, and an explicit BLOCKED-reporting condition, because that specific detail cannot be confirmed without either running the real library or fetching its real source, and guessing it wrong is exactly the mistake that shipped a silently-broken v1 once already.
