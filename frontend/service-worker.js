const CACHE_NAME = 'piano-tempo-trainer-v13';
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
  // Without this, a newly installed worker sits in the "waiting" state
  // until every open tab for this site is fully closed -- a plain reload
  // (even a hard one) keeps the OLD worker (and its old cache) in control.
  // That's exactly what made every prior fix here look like it "didn't
  // take" despite deploying correctly. Activate the new worker immediately
  // instead of waiting.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      // Take control of any already-open tabs right away too, so a reload
      // of an already-open tab gets the new worker's cache instead of
      // needing the tab fully closed and reopened first.
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
