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
  gain.gain.setValueAtTime(3.2 * volume, when);
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
  gain.gain.setValueAtTime(1.4 * volume, when);
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
  gain.gain.setValueAtTime(3.2 * volume, when);
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
