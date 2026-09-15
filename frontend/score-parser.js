// Orchestrates client-side score parsing: MusicXML/MXL -> Verovio -> MIDI -> scoreData.
//
// Depends on globals loaded by <script> tags before this file:
//   fflate                                   (vendor/fflate.js)
//   verovio                                  (vendor/verovio-toolkit-wasm.js)
//   parseMidi                                (midi-parser.js)
//   extractMeasuresFromDocument,
//   computeTimeSignatureAndPedalSpans        (xml-score-reader.js)

const MXL_MAGIC_BYTES = [0x50, 0x4b]; // "PK" -- ZIP local file header signature

// Verified against verovio-toolkit-wasm.js 6.3.0 (see below): the Emscripten module only gains
// its `_vrvToolkit_*` exports once the WASM runtime is initialized. Constructing a toolkit before
// that point throws "getToolkitFunction(...) is not a function", so readiness must be awaited.
const VEROVIO_READY_PROBE = '_vrvToolkit_constructor';
const VEROVIO_READY_TIMEOUT_MS = 30000;
const VEROVIO_READY_POLL_MS = 50;

let verovioReadyPromise = null;
let verovioToolkit = null;

function isVerovioRuntimeReady() {
  return (
    typeof verovio !== 'undefined' &&
    verovio.module &&
    typeof verovio.module[VEROVIO_READY_PROBE] === 'function'
  );
}

// Resolves once the Verovio WASM runtime is usable.
//
// `verovio.module.onRuntimeInitialized` is the documented hook, but it is a one-shot callback: if
// the runtime finished initializing before this function runs (e.g. the user picks a file seconds
// after page load) the callback would never fire. So the hook is used as the fast path and a poll
// on the export probe covers the already-initialized case.
function ensureVerovioReady() {
  if (verovioReadyPromise) return verovioReadyPromise;

  verovioReadyPromise = new Promise((resolve, reject) => {
    if (typeof verovio === 'undefined' || !verovio.module) {
      reject(new Error('악보 변환 모듈(Verovio)을 불러오지 못했어요.'));
      return;
    }
    if (isVerovioRuntimeReady()) {
      resolve();
      return;
    }

    const module = verovio.module;
    const previousHandler = module.onRuntimeInitialized;
    let settled = false;
    let timer = null;

    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearInterval(timer);
      if (error) reject(error);
      else resolve();
    };

    module.onRuntimeInitialized = () => {
      if (typeof previousHandler === 'function') previousHandler();
      settle(null);
    };

    const startedAt = Date.now();
    timer = setInterval(() => {
      if (isVerovioRuntimeReady()) {
        settle(null);
      } else if (Date.now() - startedAt > VEROVIO_READY_TIMEOUT_MS) {
        settle(new Error('악보 변환 모듈(Verovio)을 준비하는 데 너무 오래 걸렸어요.'));
      }
    }, VEROVIO_READY_POLL_MS);
  });

  // A failed readiness attempt (e.g. a slow first load that timed out) should not poison later
  // attempts -- drop the cached rejection so a retry can start fresh.
  verovioReadyPromise.catch(() => {
    verovioReadyPromise = null;
  });

  return verovioReadyPromise;
}

// Verovio's own comment in the bundle: "only one instance can be created for now", so the toolkit
// is created once and reused across calls.
async function getVerovioToolkit() {
  await ensureVerovioReady();
  if (!verovioToolkit) {
    verovioToolkit = new verovio.toolkit();
  }
  return verovioToolkit;
}

// `renderToMIDI()` returns a standard MIDI file as a base64-encoded string.
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function readFileAsMusicXmlText(file) {
  const buffer = await file.arrayBuffer();
  const firstBytes = new Uint8Array(buffer.slice(0, 2));
  const isZip = firstBytes[0] === MXL_MAGIC_BYTES[0] && firstBytes[1] === MXL_MAGIC_BYTES[1];
  if (!isZip) {
    return new TextDecoder('utf-8').decode(buffer);
  }
  const unzipped = fflate.unzipSync(new Uint8Array(buffer));
  const entryName = Object.keys(unzipped).find(
    (name) => name.toLowerCase().endsWith('.xml') && name.toLowerCase() !== 'meta-inf/container.xml'
  );
  if (!entryName) throw new Error('.mxl 파일 안에서 악보 XML을 찾지 못했어요.');
  return new TextDecoder('utf-8').decode(unzipped[entryName]);
}

async function parseScoreFile(file) {
  const xmlText = await readFileAsMusicXmlText(file);

  const xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserError = xmlDoc.querySelector('parsererror');
  if (parserError) throw new Error('악보 XML을 해석하지 못했어요.');

  const titleNode = xmlDoc.querySelector('work-title, movement-title');
  const titleText = titleNode ? titleNode.textContent.trim() : '';
  const title = titleText || 'Untitled';

  const measures = extractMeasuresFromDocument(xmlDoc);
  const { timeSignature, pedalEvents, warnings } = computeTimeSignatureAndPedalSpans(measures);

  // --- Verovio: render to MIDI (repeats expanded by default) ---
  const toolkit = await getVerovioToolkit();
  // `loadData` auto-detects the input format, so plain MusicXML text needs no `inputFrom` option.
  // It returns a truthy value on success.
  if (!toolkit.loadData(xmlText)) {
    throw new Error('악보를 Verovio로 불러오지 못했어요.');
  }
  const midiArrayBuffer = base64ToArrayBuffer(toolkit.renderToMIDI());

  const { ticksPerQuarter, tracks } = parseMidi(midiArrayBuffer);

  const notes = [];
  for (const track of tracks) {
    const openNotes = new Map(); // note number -> {startTicks, velocity}
    for (const event of track) {
      if (event.type === 'noteOn') {
        openNotes.set(event.note, { startTicks: event.ticks, velocity: event.velocity });
      } else if (event.type === 'noteOff') {
        const open = openNotes.get(event.note);
        if (open) {
          notes.push({
            pitch: event.note,
            startQL: open.startTicks / ticksPerQuarter,
            durationQL: (event.ticks - open.startTicks) / ticksPerQuarter,
            velocity: open.velocity,
          });
          openNotes.delete(event.note);
        }
      }
    }
  }
  notes.sort((a, b) => a.startQL - b.startQL);

  let totalQuarterLength = 0;
  for (const track of tracks) {
    for (const event of track) {
      totalQuarterLength = Math.max(totalQuarterLength, event.ticks / ticksPerQuarter);
    }
  }

  const beats = [];
  // A malformed <time> element (e.g. an empty <beats></beats>) yields NaN -- or 0, or a negative
  // number -- here. Left unguarded, a non-positive `beatsPerMeasure` makes the inner loop push
  // nothing and never advance `offsetQL`, so the outer `while` spins forever and freezes the tab
  // with no error. Fall back to a 4/4 grid instead. This is scoped to the beat grid only: the
  // `timeSignature` returned to the caller is still whatever the XML reader produced.
  let beatSpacingQL = 4.0 / timeSignature.denominator;
  let beatsPerMeasure = timeSignature.numerator;
  const beatGridIsUsable =
    Number.isFinite(beatsPerMeasure) && beatsPerMeasure >= 1 &&
    Number.isFinite(beatSpacingQL) && beatSpacingQL > 0;
  if (!beatGridIsUsable) {
    beatsPerMeasure = 4;
    beatSpacingQL = 1.0;
    warnings.push('박자표가 올바르지 않아서 박 계산에는 4/4로 가정했어요.');
  }
  let measureNumber = 1;
  let offsetQL = 0;
  while (offsetQL < totalQuarterLength) {
    for (let b = 0; b < beatsPerMeasure && offsetQL < totalQuarterLength; b++) {
      beats.push({ offsetQL, measure: measureNumber });
      offsetQL += beatSpacingQL;
    }
    measureNumber += 1;
  }

  return { title, timeSignature, totalQuarterLength, notes, pedalEvents, beats, warnings };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseScoreFile, readFileAsMusicXmlText };
}
