// Piano engine backed by js-synthesizer (a WASM build of FluidSynth) plus a
// real multi-sampled piano soundfont, replacing the old WebAudioFont-based
// engine. External shape is unchanged: createPianoSynth(audioContext) ->
// { loadPiano, playNote, stopAll }.
//
// API usage below was verified directly against the vendored
// frontend/vendor/js-synthesizer.min.js (v1.13.0), not just against research
// notes, because a couple of details in early drafts of this integration
// turned out to be wrong:
//
//   - JSSynth.Synthesizer.createSequencer() is a STATIC method (called on
//     the class, not on a synth instance) for the plain (non-AudioWorklet)
//     Synthesizer. It is linked to a synth afterwards via
//     sequencer.registerSynthesizer(synth).
//   - sequencer.getTick() returns a Promise<number> (`getTick(){return
//     Promise.resolve(...)}` in the vendored source) -- it cannot be read
//     synchronously inside playNote().
//   - sendEventAt(event, tick, isAbsolute): isAbsolute must be true when
//     `tick` is an already-computed absolute tick (which is what
//     ticksForFutureTime produces). Passing false would make FluidSynth
//     treat the value as a further *offset* from "now", scheduling notes
//     far later than intended.
//   - The sequencer returned by createSequencer() is created with
//     FluidSynth's internal system timer disabled, so its tick clock does
//     NOT advance on its own -- something has to call
//     sequencer.processSequencer(msElapsed) periodically or every note
//     after the first would be scheduled against a clock that never moves.
//   - The combined `{ type: 'note', channel, key, vel, duration }` event
//     (duration in ms) is confirmed real: the vendored source's event
//     dispatcher has `case 0: case "note":
//     _fluid_event_note(e, t.channel, t.key, t.vel, t.duration)`.
//     removeAllEvents() and midiAllNotesOff(chan) are also confirmed to
//     exist with those exact names.
function createPianoSynth(audioContext) {
  const ticksPerSecond = 1000; // 1 tick == 1 ms, matching note "duration" units.

  let synth = null;
  let sequencer = null;

  // Reference pair used to compute the sequencer's current tick
  // synchronously inside playNote() (getTick() itself is async and can't be
  // awaited there). Refreshed on every audioprocess callback below, so
  // extrapolation error never grows beyond a single audio buffer's worth of
  // time.
  let lastKnownTick = 0;
  let lastKnownTickTime = 0;

  // Cumulative milliseconds of audio rendered so far. processSequencer(msec)
  // advances FluidSynth's sequencer clock TO an absolute value, not BY a
  // relative delta (confirmed against the vendored lib: it maps straight to
  // fluid_sequencer_process(seq, msec)) -- so this must be a running total,
  // never reset per-callback, or the clock gets pinned at one buffer's worth
  // of ticks forever and every note fires immediately instead of on time.
  let renderedMs = 0;

  async function loadPiano() {
    // The ~570KB base64-embedded WASM module in libfluidsynth-2.4.6.js
    // instantiates asynchronously after the script tag parses. Calling
    // `new JSSynth.Synthesizer()` / `synth.init()` before it's ready throws
    // "TypeError: _new_fluid_settings is not a function" (confirmed). This
    // static method resolves once the WASM module has finished loading.
    await JSSynth.Synthesizer.waitForWasmInitialized();

    // Re-entrancy guard: if loadPiano() is somehow called twice (e.g. a fast
    // double-click racing ensureAudio()'s guard), don't double-register the
    // audioprocess listener or double-initialize the synth/sequencer.
    if (sequencer) return;

    synth = new JSSynth.Synthesizer();
    synth.init(audioContext.sampleRate);
    // FluidSynth's default master gain (0.5, confirmed via synth.getGain())
    // is deliberately conservative to leave headroom for dense orchestral
    // patches with many simultaneous voices. For a solo piano practice tool
    // that's too quiet by default, so boost it -- still well under clipping
    // range for realistic piano chord density.
    synth.setGain(1.5);
    const node = synth.createAudioNode(audioContext, 4096);
    node.connect(audioContext.destination);

    const response = await fetch('vendor/piano.sf2');
    const sfontData = await response.arrayBuffer();
    await synth.loadSFont(sfontData);

    sequencer = await JSSynth.Synthesizer.createSequencer();
    await sequencer.registerSynthesizer(synth);
    sequencer.setTimeScale(ticksPerSecond);

    // Drive the sequencer's tick clock from the same audioprocess callback
    // that already renders audio (createAudioNode wired its own listener to
    // this event for rendering; ScriptProcessorNode supports multiple
    // listeners on the same event). Each callback reports exactly how much
    // real playback time it covered; accumulating that into renderedMs and
    // feeding the cumulative total into processSequencer keeps the tick
    // clock tied to actual audio time instead of a separately-drifting JS
    // timer -- and, critically, keeps it advancing at all (see comment on
    // renderedMs above). setTimeScale(1000) above means 1 tick == 1 ms, so
    // renderedMs IS the tick count directly; no async getTick() round-trip
    // is needed to know the current tick.
    node.addEventListener('audioprocess', (event) => {
      renderedMs += event.outputBuffer.duration * 1000;
      sequencer.processSequencer(renderedMs);
      lastKnownTick = renderedMs;
      lastKnownTickTime = event.playbackTime + event.outputBuffer.duration;
    });
  }

  function playNote(pitch, when, durationSeconds, velocity) {
    if (!sequencer) return;

    const elapsedSinceSync = audioContext.currentTime - lastKnownTickTime;
    const currentTick = lastKnownTick + elapsedSinceSync * ticksPerSecond;
    const targetTick = ticksForFutureTime(currentTick, ticksPerSecond, audioContext.currentTime, when);
    const durationMs = Math.round(durationSeconds * 1000);

    sequencer.sendEventAt(
      { type: 'note', channel: 0, key: pitch, vel: velocity, duration: durationMs },
      targetTick,
      true // targetTick is an absolute tick value; see file header note above.
    );
  }

  function stopAll() {
    // removeAllEvents() clears events already queued with sendEventAt that
    // have not fired yet -- without this, notes scheduled just before a
    // stop/restart would still sound later on their original schedule.
    if (sequencer) {
      sequencer.removeAllEvents();
    }
    // midiAllNotesOff silences anything already sounding right now.
    if (synth) {
      synth.midiAllNotesOff(0);
    }
  }

  return { loadPiano, playNote, stopAll };
}
