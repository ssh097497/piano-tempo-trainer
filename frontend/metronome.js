function playClick(audioContext, when) {
  const duration = 0.04;

  // Short filtered white-noise burst instead of a pure tone: a broadband
  // "tick" cuts through a sustained/pitched piano chord far better than a
  // single sine frequency, which can get masked by the chord's harmonics.
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
  gain.gain.setValueAtTime(2.5, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  noise.start(when);
  noise.stop(when + duration);
}
