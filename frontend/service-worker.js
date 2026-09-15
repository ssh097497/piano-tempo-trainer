const CACHE_NAME = 'piano-tempo-trainer-v9';
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
