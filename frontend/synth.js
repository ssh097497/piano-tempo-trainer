const PIANO_VAR_NAME = '_tone_0000_FluidR3_GM_sf2_file';

function createPianoSynth(audioContext) {
  const player = new WebAudioFontPlayer();

  function loadPiano() {
    player.loader.decodeAfterLoading(audioContext, PIANO_VAR_NAME);
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (player.loader.loaded(PIANO_VAR_NAME)) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  function playNote(pitch, when, durationSeconds, velocity) {
    const volume = Math.min(1, Math.max(0, velocity / 127));
    player.queueWaveTable(
      audioContext, audioContext.destination, window[PIANO_VAR_NAME],
      when, pitch, durationSeconds, volume
    );
  }

  function stopAll() {
    player.cancelQueue(audioContext);
  }

  return { loadPiano, playNote, stopAll };
}
