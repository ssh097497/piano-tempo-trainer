const PIANO_VAR_NAME = '_tone_0000_GeneralUserGS_sf2_file';

function createPianoSynth(audioContext) {
  const player = new WebAudioFontPlayer();

  const LOAD_TIMEOUT_MS = 15000;

  function loadPiano() {
    player.loader.decodeAfterLoading(audioContext, PIANO_VAR_NAME);
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = setInterval(() => {
        if (player.loader.loaded(PIANO_VAR_NAME)) {
          clearInterval(check);
          resolve();
        } else if (Date.now() - startedAt > LOAD_TIMEOUT_MS) {
          clearInterval(check);
          reject(new Error(`피아노 음색을 ${LOAD_TIMEOUT_MS}ms 안에 불러오지 못했어요.`));
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
