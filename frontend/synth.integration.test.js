// Regression test for the sequencer-clock bug found in the whole-branch
// review (see synth.js's audioprocess listener history): FluidSynth's
// sequencer.processSequencer(msec) advances the tick clock TO an absolute
// value, not BY a relative delta. The old code recomputed the SAME constant
// (one ScriptProcessorNode buffer's duration in ms) on every audioprocess
// callback and fed that same constant to processSequencer() every time,
// which pins the tick clock forever at "one buffer's worth of ticks" instead
// of letting it advance with real elapsed time.
//
// This test loads the REAL vendored WASM libraries (frontend/vendor/
// libfluidsynth-2.4.6.js + frontend/vendor/js-synthesizer.min.js) and the
// real vendored piano.sf2 soundfont in Node -- the same combination the
// reviewer used to find the bug in the first place -- rather than mocking
// the sequencer API, so it exercises the actual native semantics of
// processSequencer()/getTick() plus the actual synth.js source file.
//
// Part A exercises the raw sequencer API directly to document the exact bug
// class in isolation (no dependency on synth.js's current state).
// Part B loads the real frontend/synth.js source via vm and drives its
// loadPiano()'s audioprocess listener with a fake Web Audio harness,
// asserting the sequencer tick it produces matches accumulated elapsed
// time. Part B fails against the old delta-based listener and passes
// against the fixed accumulator-based listener.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VENDOR_DIR = path.join(__dirname, 'vendor');
const LIBFLUIDSYNTH_PATH = path.join(VENDOR_DIR, 'libfluidsynth-2.4.6.js');
const JSSYNTHESIZER_PATH = path.join(VENDOR_DIR, 'js-synthesizer.min.js');
const SOUNDFONT_PATH = path.join(VENDOR_DIR, 'piano.sf2');
const SYNTH_JS_PATH = path.join(__dirname, 'synth.js');

// Chosen so a 4096-frame ScriptProcessorNode buffer (the size synth.js
// requests from createAudioNode) covers exactly 100ms of audio, giving us
// clean integer tick arithmetic instead of having to fuzzy-match floats.
const FAKE_SAMPLE_RATE = 40960;
const BUFFER_FRAMES = 4096;
const MS_PER_BUFFER = (BUFFER_FRAMES / FAKE_SAMPLE_RATE) * 1000; // 100

let JSSynth;

test('setup: load real vendored WASM libraries and wait for init', async () => {
  const FluidSynthModule = require(LIBFLUIDSYNTH_PATH);
  JSSynth = require(JSSYNTHESIZER_PATH);
  JSSynth.Synthesizer.initializeWithFluidSynthModule(FluidSynthModule);
  await JSSynth.Synthesizer.waitForWasmInitialized();
  assert.ok(JSSynth.Synthesizer, 'JSSynth.Synthesizer should be available after wasm init');
});

test('Part A (direct API): processSequencer(sameConstant) repeatedly pins the tick, but processSequencer(accumulatedTotal) advances it monotonically', async () => {
  // --- Reproduce the bug class directly against the real sequencer ---
  const buggySeq = await JSSynth.Synthesizer.createSequencer();
  buggySeq.setTimeScale(1000); // 1 tick == 1 ms
  const constantMs = 93;
  for (let i = 0; i < 5; i++) {
    buggySeq.processSequencer(constantMs); // same value every call -- the bug
  }
  const frozenTick = await buggySeq.getTick();
  assert.strictEqual(
    frozenTick,
    constantMs,
    'feeding processSequencer() the same constant every call must pin the tick at that constant -- ' +
      'this is exactly the bug that was in the old synth.js audioprocess listener'
  );
  assert.notStrictEqual(
    frozenTick,
    constantMs * 5,
    'the frozen tick must NOT equal what 5 real buffers of elapsed time would actually add up to'
  );

  // --- Confirm the fix pattern (cumulative total) behaves correctly ---
  const goodSeq = await JSSynth.Synthesizer.createSequencer();
  goodSeq.setTimeScale(1000);
  let running = 0;
  const ticks = [];
  for (let i = 0; i < 5; i++) {
    running += constantMs; // accumulate -- the fix
    goodSeq.processSequencer(running);
    ticks.push(await goodSeq.getTick());
  }
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(
      ticks[i] > ticks[i - 1],
      `tick must strictly increase call-over-call when fed a growing cumulative total (got ${ticks.join(', ')})`
    );
  }
  assert.strictEqual(ticks[ticks.length - 1], constantMs * 5, 'final tick must equal the full accumulated total');
});

test('Part B (real synth.js): loadPiano()\'s audioprocess listener must drive the sequencer tick from accumulated elapsed time, not a repeated per-callback delta', async (t) => {
  const audioContext = createFakeAudioContext(FAKE_SAMPLE_RATE);
  const sfontBuffer = fs.readFileSync(SOUNDFONT_PATH);
  const sfontArrayBuffer = sfontBuffer.buffer.slice(sfontBuffer.byteOffset, sfontBuffer.byteOffset + sfontBuffer.byteLength);

  const fetchStub = async () => ({
    ok: true,
    arrayBuffer: async () => sfontArrayBuffer,
  });

  const createPianoSynth = loadCreatePianoSynthFromSource(JSSynth, fetchStub);
  const pianoSynth = createPianoSynth(audioContext);

  // Spy on the static factory so we get a handle to the exact sequencer
  // instance synth.js's audioprocess listener drives internally -- synth.js
  // doesn't expose it on the object it returns, so this is the only way to
  // inspect the real tick clock from outside without changing synth.js's
  // public shape.
  let capturedSequencer = null;
  const originalCreateSequencer = JSSynth.Synthesizer.createSequencer;
  JSSynth.Synthesizer.createSequencer = async function (...args) {
    const seq = await originalCreateSequencer.apply(JSSynth.Synthesizer, args);
    capturedSequencer = seq;
    return seq;
  };
  t.after(() => {
    JSSynth.Synthesizer.createSequencer = originalCreateSequencer;
  });

  await pianoSynth.loadPiano();
  assert.ok(capturedSequencer, 'loadPiano() should have created a sequencer via JSSynth.Synthesizer.createSequencer()');

  const node = audioContext.__scriptNode;
  assert.ok(node, 'loadPiano() should have created a ScriptProcessorNode via createAudioNode()');

  const bufferCount = 5;
  for (let i = 0; i < bufferCount; i++) {
    node.__fireAudioProcess(i * (MS_PER_BUFFER / 1000));
  }

  const tick = await capturedSequencer.getTick();
  const expectedTick = MS_PER_BUFFER * bufferCount; // 500 -- true accumulated elapsed time
  assert.strictEqual(
    tick,
    expectedTick,
    `after ${bufferCount} audioprocess callbacks of ${MS_PER_BUFFER}ms each, the sequencer tick must equal the ` +
      `accumulated total (${expectedTick}), not a single buffer's worth pinned in place. Got ${tick}. ` +
      'This is the exact regression Fix 1 addresses: passing a repeated per-callback delta into ' +
      'processSequencer() instead of a running cumulative total.'
  );
});

// --- Test harness helpers ---

// A minimal fake Web Audio AudioContext -- just enough surface for
// synth.js's loadPiano() to run against: sampleRate/destination/currentTime,
// createScriptProcessor() returning a node with addEventListener('audioprocess', ...)
// support (createAudioNode() in js-synthesizer.min.js registers its own
// listener there for rendering, and synth.js registers a second one for
// tick-clock driving -- both must fire), and connect() as a no-op.
function createFakeAudioContext(sampleRate) {
  const ctx = {
    sampleRate,
    currentTime: 0,
    destination: {},
  };
  ctx.createScriptProcessor = function createScriptProcessor(bufferSize) {
    const listeners = [];
    const node = {
      addEventListener(type, cb) {
        if (type === 'audioprocess') listeners.push(cb);
      },
      connect() {},
      // Test-only helper (not part of the real Web Audio API): synchronously
      // invokes every registered 'audioprocess' listener with a fake event
      // carrying a buffer of the requested size and the given playbackTime.
      __fireAudioProcess(playbackTime) {
        const duration = bufferSize / sampleRate;
        const channelData = [new Float32Array(bufferSize), new Float32Array(bufferSize)];
        const outputBuffer = {
          numberOfChannels: 2,
          length: bufferSize,
          duration,
          getChannelData(ch) {
            return channelData[ch];
          },
        };
        const event = { outputBuffer, playbackTime };
        listeners.forEach((cb) => cb(event));
      },
    };
    ctx.__scriptNode = node;
    return node;
  };
  return ctx;
}

// Loads the real frontend/synth.js source into a sandboxed VM context (it's
// written as a plain browser script -- a top-level function declaration with
// no module.exports -- so it can't be require()'d directly) and returns its
// createPianoSynth function. The only globals synth.js's source references
// are `JSSynth` and `fetch`, both supplied here.
function loadCreatePianoSynthFromSource(jsSynthGlobal, fetchStub) {
  const source = fs.readFileSync(SYNTH_JS_PATH, 'utf8');
  const sandbox = { JSSynth: jsSynthGlobal, fetch: fetchStub, console };
  vm.createContext(sandbox);
  // Appending the bare identifier makes it the script's completion value,
  // the same way a trailing expression is the return value of `eval()`.
  return vm.runInContext(`${source}\n;createPianoSynth;`, sandbox, { filename: 'synth.js' });
}
