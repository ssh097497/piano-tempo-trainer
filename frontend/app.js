(function () {
  let scoreData = null;
  let audioContext = null;
  let synth = null;
  let clock = null;
  let isPlaying = false;
  let metronomeOn = false;
  let songVolume = 1.0;
  let metronomeVolume = 1.0;
  let metronomeSoundType = 'beep';
  let handFilter = 'both'; // 'both' | 'right' | 'left'
  let regions = []; // [{id, startQL, endQL}, ...] for the currently open file
  let activeRegionId = null; // id of the region currently being looped, or null
  let lastTickOffsetQL = null; // set by startPlayback(); distinguishes "just seeked past the loop end" from "played forward past it"
  let pendingStartQL = null; // set by "구간 시작 지정" until paired with an end
  let pendingEndQL = null; // set by "구간 끝 지정" until paired with a start
  let currentFileName = null; // the currently open file's name, for keying saved regions
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
  const reloadLastFileBtn = document.getElementById('reload-last-file-btn');
  const errorBanner = document.getElementById('error-banner');
  const titleEl = document.getElementById('title');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const restartBtn = document.getElementById('restart-btn');
  const skipBackBtn = document.getElementById('skip-back-btn');
  const skipForwardBtn = document.getElementById('skip-forward-btn');
  const bpmSlider = document.getElementById('bpm-slider');
  const bpmNumber = document.getElementById('bpm-number');
  const metronomeToggle = document.getElementById('metronome-toggle');
  const songVolumeSlider = document.getElementById('song-volume-slider');
  const metronomeVolumeSlider = document.getElementById('metronome-volume-slider');
  const metronomeSoundSelect = document.getElementById('metronome-sound-select');
  const progressBar = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const loopRangeEl = document.getElementById('loop-range');
  const timeLabel = document.getElementById('time-label');
  const setLoopStartBtn = document.getElementById('set-loop-start-btn');
  const setLoopEndBtn = document.getElementById('set-loop-end-btn');
  const regionListEl = document.getElementById('region-list');
  const pendulumWrap = document.getElementById('pendulum-wrap');
  const handSelect = document.getElementById('hand-select');
  const handButtons = Array.from(handSelect.querySelectorAll('.hand-btn'));
  const metronomeVolumeRow = document.getElementById('metronome-volume-row');
  const playPauseIcon = document.getElementById('play-pause-icon');

  const PLAY_ICON = '<path d="M6 4.5v15l13-7.5-13-7.5Z" fill="currentColor"/>';
  const PAUSE_ICON = '<rect x="5" y="4.5" width="5" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="5" height="15" rx="1.2" fill="currentColor"/>';

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  // Surface otherwise-silent JS errors directly on screen -- there's no
  // devtools console on a phone, so an uncaught error here (e.g. inside an
  // async click handler) would otherwise just vanish with no visible sign
  // playback never started.
  window.addEventListener('error', (e) => {
    showError(`디버그: ${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    showError(`디버그: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
  });

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- Upload flow ---

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

    // Reset hand selection for every newly loaded file -- a previous
    // file's "왼손만" choice carrying over into a piece the user just
    // opened would be a surprising way to lose the right-hand part.
    handFilter = 'both';
    handButtons.forEach((b) => b.classList.toggle('active', b.dataset.hand === 'both'));
    handSelect.hidden = !scoreData.handSeparationAvailable;

    currentFileName = file.name;
    pendingStartQL = null;
    pendingEndQL = null;
    activeRegionId = null;
    try {
      regions = await loadRegionsForFile(file.name);
    } catch (err) {
      regions = []; // non-critical: an unreadable saved list just means starting empty
    }
    renderRegionList();

    if (scoreData.warnings && scoreData.warnings.length) {
      showError(scoreData.warnings.join(' / '));
    }

    try {
      await saveLastFile(file);
    } catch (err) {
      // Non-critical: "재생 last file" is a convenience, not the main flow.
      // A failed cache write (e.g. IndexedDB quota/availability issue)
      // shouldn't block the practice screen that's already showing.
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

  (async function initReloadButton() {
    const cached = await loadLastFile();
    if (cached) {
      reloadLastFileBtn.hidden = false;
    }
  })();

  reloadLastFileBtn.addEventListener('click', async () => {
    try {
      const cached = await loadLastFile();
      if (!cached) return;
      await handleFile(cached);
    } catch (err) {
      showError('이전 파일을 불러오지 못했어요.');
    }
  });

  // --- Audio setup ---

  let audioInitPromise = null;

  async function ensureAudio() {
    if (!audioInitPromise) {
      // A promise-lock, not a plain `if (!audioContext)` check -- loadPiano()
      // is slow (WASM init + a large soundfont fetch), and audioContext gets
      // assigned synchronously before that await. A second overlapping call
      // (e.g. an impatient double-tap on the play button while the first
      // tap is still loading) would otherwise see a truthy audioContext,
      // skip straight past this whole block, and call startPlayback() with
      // `clock` still null -- crashing on clock.reset(). Every concurrent
      // caller now awaits the same in-flight promise instead.
      audioInitPromise = (async () => {
        const AudioContextFunc = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextFunc();
        synth = createPianoSynth(audioContext);
        try {
          await synth.loadPiano();
        } catch (err) {
          showError('피아노 음색을 불러오지 못했어요.');
          // Reset so a later ensureAudio() call retries from scratch instead
          // of being permanently bricked by this one failure.
          audioContext = null;
          synth = null;
          audioInitPromise = null;
          throw err;
        }
        clock = new TempoClock(Number(bpmSlider.value));
      })();
    }
    await audioInitPromise;
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
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

  function activeRegion() {
    return regions.find((r) => r.id === activeRegionId) || null;
  }

  function loopEndOrInfinity() {
    const region = activeRegion();
    if (!region) return Infinity;
    // Once real playback has already carried us past the region's end (not
    // just a fresh seek that landed past it), stop cutting notes there --
    // otherwise a deliberate seek past the loop end to preview later
    // material would play silence until schedulerTick's wrap check yanks
    // playback back to the region's start.
    if (lastTickOffsetQL != null && lastTickOffsetQL >= region.endQL) return Infinity;
    return region.endQL;
  }

  function startPlayback(fromOffsetQL) {
    clock.reset(audioContext.currentTime, fromOffsetQL);
    nextNoteIndex = findNoteIndexAtOrAfter(fromOffsetQL);
    nextBeatIndex = findBeatIndexAtOrAfter(fromOffsetQL);
    lastTickOffsetQL = fromOffsetQL;
    isPlaying = true;
    playPauseIcon.innerHTML = PAUSE_ICON;
    pendulumWrap.classList.remove('paused');
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
    playPauseIcon.innerHTML = PLAY_ICON;
    pendulumWrap.classList.add('paused');
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
      if (handFilter === 'both' || note.hand === handFilter) {
        const durationSec = effectiveDurationQL(note, scoreData.pedalEvents) * clock.secondsPerBeat();
        synth.playNote(note.pitch, when, durationSec, note.velocity * songVolume);
      }
      nextNoteIndex++;
    }

    if (metronomeOn) {
      while (nextBeatIndex < scoreData.beats.length) {
        const beat = scoreData.beats[nextBeatIndex];
        if (beat.offsetQL >= effectiveEnd) break;
        const when = clock.timeAt(beat.offsetQL);
        if (when > lookaheadUntil) break;
        playClick(audioContext, when, metronomeSoundType, metronomeVolume);
        nextBeatIndex++;
      }
    }

    const currentOffset = clock.offsetAt(audioContext.currentTime);
    updateProgressUI(currentOffset);

    const region = activeRegion();
    // An edge-crossing check, not a level check: this only fires the
    // moment playback advances FROM before the region's end TO at/after
    // it. A fresh seek already lands with lastTickOffsetQL reset to that
    // same spot (see startPlayback), so seeking straight to or past the
    // end never triggers this on its own -- only continued forward
    // playback through the boundary does.
    if (region && lastTickOffsetQL < region.endQL && currentOffset >= region.endQL) {
      startPlayback(region.startQL);
      return;
    }
    lastTickOffsetQL = currentOffset;

    if (!region && currentOffset >= scoreData.totalQuarterLength) {
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

  handButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      handFilter = btn.dataset.hand;
      handButtons.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  restartBtn.addEventListener('click', async () => {
    await ensureAudio();
    if (isPlaying) stopInternal();
    pausedOffsetQL = 0;
    startPlayback(0);
  });

  // --- BPM control ---

  function updatePendulumSpeed(bpm) {
    const track = pendulumWrap.querySelector('.pendulum-track');
    track.style.animationDuration = `${(60 / bpm) * 1.6}s`;
  }

  function applyBpm(bpm) {
    updatePendulumSpeed(bpm);
    if (!clock) return;
    if (isPlaying) {
      clock.setBpm(bpm, audioContext.currentTime);
    } else {
      clock.bpm = bpm;
    }
  }

  bpmSlider.addEventListener('input', () => {
    bpmNumber.value = bpmSlider.value;
    applyBpm(Number(bpmSlider.value));
  });
  // Deliberately do NOT write bpmSlider's (clamped) value back into
  // bpmNumber on every keystroke here. bpmSlider.value silently clamps to
  // [20,200] the instant it's assigned, and typing a multi-digit BPM (e.g.
  // "120") passes through in-between values ("1", "12") that are below the
  // slider's min -- feeding those clamped values back into bpmNumber would
  // overwrite what the user just typed before they can finish typing it.
  bpmNumber.addEventListener('input', () => {
    const value = Number(bpmNumber.value);
    if (!Number.isFinite(value)) return; // mid-edit (e.g. field temporarily empty)
    bpmSlider.value = value;
    applyBpm(Number(bpmSlider.value));
  });
  // On blur/enter, snap the displayed number itself to the valid range --
  // type="number" doesn't clamp what's shown the way a range input does.
  bpmNumber.addEventListener('change', () => {
    const clamped = Math.min(200, Math.max(20, Number(bpmNumber.value) || 80));
    bpmNumber.value = clamped;
    bpmSlider.value = clamped;
    applyBpm(clamped);
  });
  applyBpm(Number(bpmSlider.value));

  // --- Seeking (progress bar clicks and the ±10s buttons share this) ---

  function seekTo(targetOffsetQL) {
    const clamped = Math.min(scoreData.totalQuarterLength, Math.max(0, targetOffsetQL));
    pausedOffsetQL = clamped;
    if (isPlaying) {
      stopInternal();
      startPlayback(clamped);
    } else {
      updateProgressUI(clamped);
    }
  }

  progressBar.addEventListener('click', async (e) => {
    await ensureAudio();
    const rect = progressBar.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seekTo(fraction * scoreData.totalQuarterLength);
  });

  skipBackBtn.addEventListener('click', async () => {
    await ensureAudio();
    seekTo(currentLogicalOffset() - 10 / clock.secondsPerBeat());
  });

  skipForwardBtn.addEventListener('click', async () => {
    await ensureAudio();
    seekTo(currentLogicalOffset() + 10 / clock.secondsPerBeat());
  });

  // --- Metronome toggle ---

  metronomeToggle.addEventListener('change', () => {
    metronomeOn = metronomeToggle.checked;
    metronomeVolumeRow.classList.toggle('disabled-fade', !metronomeOn);
    metronomeVolumeSlider.disabled = !metronomeOn;
    metronomeSoundSelect.disabled = !metronomeOn;
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

  // --- Volume controls ---

  songVolumeSlider.addEventListener('input', () => {
    songVolume = Number(songVolumeSlider.value) / 100;
  });
  metronomeVolumeSlider.addEventListener('input', () => {
    metronomeVolume = Number(metronomeVolumeSlider.value) / 100;
  });
  metronomeSoundSelect.addEventListener('change', () => {
    metronomeSoundType = metronomeSoundSelect.value;
  });

  // --- Loop controls ---

  function currentLogicalOffset() {
    if (!clock) return 0;
    return isPlaying ? clock.offsetAt(audioContext.currentTime) : pausedOffsetQL;
  }

  function updateLoopHighlight() {
    const region = activeRegion();
    if (!region) {
      loopRangeEl.hidden = true;
      return;
    }
    loopRangeEl.hidden = false;
    const startPct = (region.startQL / scoreData.totalQuarterLength) * 100;
    const endPct = (region.endQL / scoreData.totalQuarterLength) * 100;
    loopRangeEl.style.left = `${startPct}%`;
    loopRangeEl.style.width = `${endPct - startPct}%`;
  }

  function persistRegions() {
    if (!currentFileName) return;
    saveRegionsForFile(currentFileName, regions).catch(() => {
      // Non-critical: losing a saved region set on a write failure just
      // means it won't be there next time -- it doesn't affect this session.
    });
  }

  function renderRegionList() {
    regionListEl.innerHTML = '';
    const secondsPerBeat = 60 / Number(bpmSlider.value);
    regions.forEach((region, i) => {
      const li = document.createElement('li');
      li.className = 'region-item' + (region.id === activeRegionId ? ' active' : '');

      const label = document.createElement('span');
      label.className = 'region-label';
      label.textContent = `구간 ${i + 1}`;

      const time = document.createElement('span');
      time.className = 'region-time';
      time.textContent = `${formatTime(region.startQL * secondsPerBeat)}–${formatTime(region.endQL * secondsPerBeat)}`;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'region-delete';
      deleteBtn.setAttribute('aria-label', '구간 삭제');
      deleteBtn.textContent = '×';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRegion(region.id);
      });

      li.addEventListener('click', async () => {
        await ensureAudio();
        activateRegion(region.id);
      });

      li.append(label, time, deleteBtn);
      regionListEl.appendChild(li);
    });
    updateLoopHighlight();
  }

  function activateRegion(id) {
    if (activeRegionId === id) {
      activeRegionId = null;
      renderRegionList();
      return;
    }
    activeRegionId = id;
    renderRegionList();
    seekTo(activeRegion().startQL);
  }

  function deleteRegion(id) {
    regions = regions.filter((r) => r.id !== id);
    if (activeRegionId === id) activeRegionId = null;
    persistRegions();
    renderRegionList();
  }

  function maybeCreateRegionFromPending() {
    if (pendingStartQL == null || pendingEndQL == null) return;
    let start = pendingStartQL;
    let end = pendingEndQL;
    if (end <= start) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    const region = { id: String(Date.now()), startQL: start, endQL: end };
    regions.push(region);
    activeRegionId = region.id;
    pendingStartQL = null;
    pendingEndQL = null;
    persistRegions();
    renderRegionList();
  }

  setLoopStartBtn.addEventListener('click', async () => {
    await ensureAudio();
    pendingStartQL = snapLoopStart(currentLogicalOffset(), measureStarts);
    maybeCreateRegionFromPending();
  });

  setLoopEndBtn.addEventListener('click', async () => {
    await ensureAudio();
    pendingEndQL = snapLoopEnd(currentLogicalOffset(), measureStarts, scoreData.totalQuarterLength);
    maybeCreateRegionFromPending();
  });
})();
