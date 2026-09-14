(function () {
  let scoreData = null;
  let audioContext = null;
  let synth = null;
  let clock = null;
  let isPlaying = false;
  let metronomeOn = false;
  let loopOn = false;
  let loopStartQL = null;
  let loopEndQL = null;
  let measureStarts = [];
  let schedulerHandle = null;
  let nextNoteIndex = 0;
  let nextBeatIndex = 0;
  let pausedOffsetQL = 0;

  const LOOKAHEAD_SEC = 0.15;
  const POLL_MS = 25;

  const uploadScreen = document.getElementById('upload-screen');
  const practiceScreen = document.getElementById('practice-screen');
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const errorBanner = document.getElementById('error-banner');
  const titleEl = document.getElementById('title');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const restartBtn = document.getElementById('restart-btn');
  const bpmSlider = document.getElementById('bpm-slider');
  const bpmNumber = document.getElementById('bpm-number');
  const metronomeToggle = document.getElementById('metronome-toggle');
  const progressBar = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const loopRangeEl = document.getElementById('loop-range');
  const timeLabel = document.getElementById('time-label');
  const setLoopStartBtn = document.getElementById('set-loop-start-btn');
  const setLoopEndBtn = document.getElementById('set-loop-end-btn');
  const loopToggle = document.getElementById('loop-toggle');

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- Upload flow ---

  async function handleFile(file) {
    errorBanner.hidden = true;
    const formData = new FormData();
    formData.append('file', file);

    let response;
    try {
      response = await fetch('/api/parse', { method: 'POST', body: formData });
    } catch (err) {
      showError('서버에 연결할 수 없어요. 서버가 켜져 있는지 확인해주세요.');
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({ detail: '알 수 없는 오류' }));
      showError(body.detail);
      return;
    }

    scoreData = await response.json();
    // The backend emits notes part-by-part (e.g. right hand fully, then
    // left hand), not globally sorted by start time. The scheduler below
    // walks the notes array with a single forward-only index and assumes
    // ascending startQL, so an unsorted array causes later parts' notes
    // to be scheduled after earlier parts' notes have already advanced
    // playback time past them -- they'd fire late/bunched instead of on
    // the beat. Sort once here to give the scheduler the ordering it
    // depends on.
    scoreData.notes.sort((a, b) => a.startQL - b.startQL);
    measureStarts = computeMeasureStarts(scoreData.beats);
    titleEl.textContent = scoreData.title;
    uploadScreen.hidden = true;
    practiceScreen.hidden = false;

    if (scoreData.warnings && scoreData.warnings.length) {
      showError(scoreData.warnings.join(' / '));
    }
  }

  dropZone.addEventListener('dragover', (e) => e.preventDefault());
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  // --- Audio setup ---

  async function ensureAudio() {
    if (!audioContext) {
      const AudioContextFunc = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContextFunc();
      synth = createPianoSynth(audioContext);
      try {
        await synth.loadPiano();
      } catch (err) {
        showError('피아노 음색을 불러오지 못했어요.');
        throw err;
      }
      clock = new TempoClock(Number(bpmSlider.value));
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
  }

  // --- Pedal-aware duration ---

  function effectiveDurationQL(note) {
    let duration = note.durationQL;
    for (const pedal of scoreData.pedalEvents) {
      if (note.startQL >= pedal.onQL && note.startQL < pedal.offQL) {
        duration = Math.max(duration, pedal.offQL - note.startQL);
      }
    }
    return duration;
  }

  // --- Playback engine ---

  function findNoteIndexAtOrAfter(offsetQL) {
    const idx = scoreData.notes.findIndex((n) => n.startQL >= offsetQL);
    return idx === -1 ? scoreData.notes.length : idx;
  }

  function findBeatIndexAtOrAfter(offsetQL) {
    const idx = scoreData.beats.findIndex((b) => b.offsetQL >= offsetQL);
    return idx === -1 ? scoreData.beats.length : idx;
  }

  function loopEndOrInfinity() {
    return (loopOn && loopStartQL != null && loopEndQL != null) ? loopEndQL : Infinity;
  }

  function startPlayback(fromOffsetQL) {
    clock.reset(audioContext.currentTime, fromOffsetQL);
    nextNoteIndex = findNoteIndexAtOrAfter(fromOffsetQL);
    nextBeatIndex = findBeatIndexAtOrAfter(fromOffsetQL);
    isPlaying = true;
    playPauseBtn.textContent = '⏸';
    // Clear any previously running interval before starting a new one.
    // Without this, the loop-restart call to startPlayback() from inside
    // schedulerTick() (below) would stack a second interval on top of the
    // one that is still ticking (the call itself happens from within that
    // tick), doubling up note/click scheduling on every loop iteration.
    clearInterval(schedulerHandle);
    schedulerHandle = setInterval(schedulerTick, POLL_MS);
  }

  function stopInternal() {
    isPlaying = false;
    playPauseBtn.textContent = '▶';
    clearInterval(schedulerHandle);
    synth.stopAll();
  }

  function pausePlayback() {
    pausedOffsetQL = clock.offsetAt(audioContext.currentTime);
    stopInternal();
  }

  function schedulerTick() {
    const lookaheadUntil = audioContext.currentTime + LOOKAHEAD_SEC;
    const effectiveEnd = loopEndOrInfinity();

    while (nextNoteIndex < scoreData.notes.length) {
      const note = scoreData.notes[nextNoteIndex];
      if (note.startQL >= effectiveEnd) break;
      const when = clock.timeAt(note.startQL);
      if (when > lookaheadUntil) break;
      const durationSec = effectiveDurationQL(note) * clock.secondsPerBeat();
      synth.playNote(note.pitch, when, durationSec, note.velocity);
      nextNoteIndex++;
    }

    if (metronomeOn) {
      while (nextBeatIndex < scoreData.beats.length) {
        const beat = scoreData.beats[nextBeatIndex];
        if (beat.offsetQL >= effectiveEnd) break;
        const when = clock.timeAt(beat.offsetQL);
        if (when > lookaheadUntil) break;
        playClick(audioContext, when);
        nextBeatIndex++;
      }
    }

    const currentOffset = clock.offsetAt(audioContext.currentTime);
    updateProgressUI(currentOffset);

    if (loopOn && loopStartQL != null && loopEndQL != null && currentOffset >= loopEndQL) {
      startPlayback(loopStartQL);
      return;
    }
    if (!loopOn && currentOffset >= scoreData.totalQuarterLength) {
      pausedOffsetQL = 0;
      stopInternal();
    }
  }

  function updateProgressUI(offsetQL) {
    const fraction = Math.min(1, Math.max(0, offsetQL / scoreData.totalQuarterLength));
    progressFill.style.width = `${fraction * 100}%`;
    const elapsedSec = offsetQL * clock.secondsPerBeat();
    const totalSec = scoreData.totalQuarterLength * clock.secondsPerBeat();
    timeLabel.textContent = `${formatTime(elapsedSec)} / ${formatTime(totalSec)}`;
  }

  playPauseBtn.addEventListener('click', async () => {
    await ensureAudio();
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback(pausedOffsetQL);
    }
  });

  restartBtn.addEventListener('click', async () => {
    await ensureAudio();
    if (isPlaying) stopInternal();
    pausedOffsetQL = 0;
    startPlayback(0);
  });

  // --- BPM control ---

  bpmSlider.addEventListener('input', () => {
    bpmNumber.value = bpmSlider.value;
    if (!clock) return;
    if (isPlaying) {
      clock.setBpm(Number(bpmSlider.value), audioContext.currentTime);
    } else {
      clock.bpm = Number(bpmSlider.value);
    }
  });
  bpmNumber.addEventListener('input', () => {
    bpmSlider.value = bpmNumber.value;
    bpmSlider.dispatchEvent(new Event('input'));
  });

  // --- Progress bar seek ---

  progressBar.addEventListener('click', async (e) => {
    await ensureAudio();
    const rect = progressBar.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const targetOffset = fraction * scoreData.totalQuarterLength;
    pausedOffsetQL = targetOffset;
    if (isPlaying) {
      stopInternal();
      startPlayback(targetOffset);
    } else {
      updateProgressUI(targetOffset);
    }
  });

  // --- Metronome toggle ---

  metronomeToggle.addEventListener('change', () => {
    metronomeOn = metronomeToggle.checked;
    // nextBeatIndex only advances inside schedulerTick's `if (metronomeOn)`
    // block, so while the metronome is off it stays frozen at whatever
    // offset playback started from. Turning it on mid-playback without
    // resyncing would replay every beat between that frozen index and the
    // current offset in one burst (their `when` is in the past, which Web
    // Audio clamps to "now"). Resync to the next upcoming beat whenever
    // the metronome is switched on, whether playing or paused.
    if (metronomeOn && scoreData) {
      nextBeatIndex = findBeatIndexAtOrAfter(currentLogicalOffset());
    }
  });

  // --- Loop controls ---

  function currentLogicalOffset() {
    if (!clock) return 0;
    return isPlaying ? clock.offsetAt(audioContext.currentTime) : pausedOffsetQL;
  }

  function updateLoopHighlight() {
    if (loopStartQL == null || loopEndQL == null) {
      loopRangeEl.hidden = true;
      return;
    }
    loopRangeEl.hidden = false;
    const startPct = (loopStartQL / scoreData.totalQuarterLength) * 100;
    const endPct = (loopEndQL / scoreData.totalQuarterLength) * 100;
    loopRangeEl.style.left = `${startPct}%`;
    loopRangeEl.style.width = `${endPct - startPct}%`;
  }

  setLoopStartBtn.addEventListener('click', async () => {
    await ensureAudio();
    loopStartQL = snapLoopStart(currentLogicalOffset(), measureStarts);
    updateLoopHighlight();
  });

  setLoopEndBtn.addEventListener('click', async () => {
    await ensureAudio();
    loopEndQL = snapLoopEnd(currentLogicalOffset(), measureStarts, scoreData.totalQuarterLength);
    updateLoopHighlight();
  });

  loopToggle.addEventListener('change', () => {
    loopOn = loopToggle.checked;
  });
})();
