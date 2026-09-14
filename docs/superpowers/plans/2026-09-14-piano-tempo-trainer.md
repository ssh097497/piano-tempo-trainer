# Piano Tempo Trainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal, LAN-only web tool that lets the user upload a MusicXML piano score, play it back through a piano-sample synth at any BPM (adjustable live with a slider), toggle a uniform-strength metronome, and loop a measure-snapped section for practice.

**Architecture:** A small FastAPI backend does score analysis only (music21 parses the uploaded MusicXML, reconstructs sustain-pedal spans, and emits a tempo-independent JSON description of notes/pedal/beats). A static single-page frontend (vanilla JS, no build step) does all real-time playback: it loads the JSON once, then schedules note and metronome-click events against a live BPM using the Web Audio API, so tempo changes take effect instantly without re-rendering audio.

**Tech Stack:** Python 3 + FastAPI + music21 (backend); vanilla HTML/CSS/JS + WebAudioFont (frontend, loaded from CDN); Node.js built-in test runner for the one piece of pure frontend logic worth unit-testing (tempo/loop math); pytest for the backend.

**Spec:** `docs/superpowers/specs/2026-09-14-piano-tempo-trainer-design.md`

## Global Constraints

- No accounts, no external hosting — server binds to the LAN so a phone on the same Wi-Fi can reach it (spec §3).
- MusicXML (`.musicxml`/`.mxl`) upload only in v1; other extensions are rejected with a Korean error message "MusicXML(.musicxml/.mxl) 파일만 지원해요" (spec §2, §7).
- The server never renders audio; it only emits the JSON schema in spec §4. All playback/tempo/metronome logic lives in the browser (spec §3, §5).
- Metronome clicks are **uniform** in pitch and volume across all beats — no downbeat accent (explicit user correction to the original spec draft).
- Loop region snapping: "구간 시작" snaps to the start of the containing measure; "구간 끝" snaps to the start of the *next* measure, so the loop always covers whole measures (spec §6).
- JSON wire format uses the exact camelCase keys from spec §4 (`timeSignature`, `totalQuarterLength`, `startQL`, `durationQL`, `onQL`, `offQL`, `offsetQL`) — Python code stays snake_case internally and converts at the serialization boundary.

---

### Task 1: Backend scaffolding

**Files:**
- Create: `server/requirements.txt`
- Create: `server/app.py`
- Test: manual (`curl`), no automated test framework needed for this trivial health check

**Interfaces:**
- Produces: a running FastAPI app object named `app` in `server/app.py`, importable as `app.app` for later tasks and for `uvicorn app:app`.

- [ ] **Step 1: Create the requirements file**

`server/requirements.txt`:
```
fastapi>=0.110
uvicorn[standard]>=0.29
music21>=9.1
python-multipart>=0.0.9
pytest>=8.0
httpx>=0.27
```

- [ ] **Step 2: Install dependencies**

Run (from `server/`):
```bash
pip install -r requirements.txt
```
Expected: no errors.

- [ ] **Step 3: Write a minimal FastAPI app with a health check**

`server/app.py`:
```python
from fastapi import FastAPI

app = FastAPI()


@app.get("/api/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 4: Run the server and verify the health check**

Run (from `server/`):
```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```
In another terminal:
```bash
curl http://127.0.0.1:8000/api/health
```
Expected: `{"status":"ok"}`. Stop the server (Ctrl+C) before continuing.

- [ ] **Step 5: Commit**

```bash
git add server/requirements.txt server/app.py
git commit -m "feat: scaffold FastAPI backend with health check"
```

---

### Task 2: Score parsing + pedal reconstruction (`score_parser.py`)

**Files:**
- Create: `server/score_parser.py`
- Test: `server/tests/test_score_parser.py`

**Interfaces:**
- Consumes: `music21` (already in requirements from Task 1).
- Produces (used by Task 3):
  - `class NoteEvent`, `class PedalEvent`, `class BeatEvent`, `class ScoreData` (dataclasses)
  - `extract_score_data(score: music21.stream.Score) -> ScoreData`
  - `parse_score_file(path: str) -> ScoreData`
  - `to_json_dict(score_data: ScoreData) -> dict` — converts to the exact camelCase wire format from spec §4.

This task rebuilds, as unit-testable code, the parsing/pedal-reconstruction logic already validated by hand earlier (against a real Moszkowski score, 40/41 pedal marks recovered, 4/4 fallback behavior). The automated tests here use a small **synthetic** score built directly with `music21` objects instead of a checked-in copy of that copyrighted arrangement — this keeps the test suite fast, deterministic, and free of any licensing question, while exercising the same logic paths.

- [ ] **Step 1: Write the failing tests**

`server/tests/test_score_parser.py`:
```python
import music21 as m21
from server.score_parser import extract_score_data, to_json_dict


def build_test_score():
    """A tiny synthetic 3/4 score: 2 measures, one pedal span across the
    barline, and a rest, to exercise the same code paths as the real
    Moszkowski file without depending on a checked-in copyrighted score."""
    part = m21.stream.Part()
    part.append(m21.meter.TimeSignature('3/4'))

    m1 = m21.stream.Measure(number=1)
    n1 = m21.note.Note('C4', quarterLength=1.0)
    n1.volume.velocity = 80
    n2 = m21.note.Note('E4', quarterLength=1.0)
    n2.volume.velocity = 80
    n3 = m21.note.Rest(quarterLength=1.0)
    m1.append([n1, n2, n3])

    m2 = m21.stream.Measure(number=2)
    n4 = m21.note.Note('G4', quarterLength=3.0)
    m2.append(n4)

    part.append([m1, m2])
    score = m21.stream.Score()
    score.metadata = m21.metadata.Metadata(title="Test Piece")
    score.insert(0, part)

    pedal = m21.expressions.PedalMark()
    pedal.addSpannedElements([n2, n4])
    part.insert(0, pedal)

    return score


def test_extracts_time_signature():
    data = extract_score_data(build_test_score())
    assert data.time_signature_numerator == 3
    assert data.time_signature_denominator == 4


def test_extracts_notes_skips_rests():
    data = extract_score_data(build_test_score())
    # 3 real notes (C4, E4, G4); the Rest is excluded
    assert len(data.notes) == 3
    pitches = sorted(n.pitch for n in data.notes)
    assert pitches == [60, 64, 67]  # C4, E4, G4 as MIDI numbers


def test_note_velocity_and_default():
    data = extract_score_data(build_test_score())
    by_pitch = {n.pitch: n for n in data.notes}
    assert by_pitch[64].velocity == 80  # E4, explicit velocity
    assert by_pitch[67].velocity == 64  # G4, no explicit velocity -> default


def test_pedal_span_recovered_across_barline():
    data = extract_score_data(build_test_score())
    assert len(data.pedal_events) == 1
    pedal = data.pedal_events[0]
    assert pedal.on_ql == 1.0   # E4 starts at beat 2 of measure 1 -> offset 1.0
    assert pedal.off_ql == 6.0  # G4 starts at offset 3.0, duration 3.0 -> ends at 6.0


def test_beats_cover_both_measures_in_3_4():
    data = extract_score_data(build_test_score())
    offsets = [b.offset_ql for b in data.beats]
    assert offsets == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]


def test_missing_time_signature_falls_back_to_4_4_with_warning():
    part = m21.stream.Part()
    m1 = m21.stream.Measure(number=1)
    m1.append(m21.note.Note('C4', quarterLength=4.0))
    part.append(m1)
    score = m21.stream.Score()
    score.insert(0, part)

    data = extract_score_data(score)
    assert data.time_signature_numerator == 4
    assert data.time_signature_denominator == 4
    assert any("박자표" in w for w in data.warnings)


def test_to_json_dict_uses_camel_case_keys():
    data = extract_score_data(build_test_score())
    payload = to_json_dict(data)
    assert payload["timeSignature"] == {"numerator": 3, "denominator": 4}
    assert "totalQuarterLength" in payload
    note = payload["notes"][0]
    assert set(note.keys()) == {"pitch", "startQL", "durationQL", "velocity"}
    pedal = payload["pedalEvents"][0]
    assert set(pedal.keys()) == {"onQL", "offQL"}
    beat = payload["beats"][0]
    assert set(beat.keys()) == {"offsetQL", "measure"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from the repo root):
```bash
pytest server/tests/test_score_parser.py -v
```
Expected: `ModuleNotFoundError: No module named 'server.score_parser'` (or similar import failure) — the module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`server/score_parser.py`:
```python
from dataclasses import dataclass, field
from typing import List, Optional

import music21 as m21

DEFAULT_VELOCITY = 64


@dataclass
class NoteEvent:
    pitch: int
    start_ql: float
    duration_ql: float
    velocity: int


@dataclass
class PedalEvent:
    on_ql: float
    off_ql: float


@dataclass
class BeatEvent:
    offset_ql: float
    measure: int


@dataclass
class ScoreData:
    title: str
    time_signature_numerator: int
    time_signature_denominator: int
    total_quarter_length: float
    notes: List[NoteEvent] = field(default_factory=list)
    pedal_events: List[PedalEvent] = field(default_factory=list)
    beats: List[BeatEvent] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


def _abs_offset(note, score) -> Optional[float]:
    """Walk the site chain up to the enclosing Measure and add offsets,
    instead of calling note.getOffsetInHierarchy(score) directly — that
    call fails for notes reached through a PedalMark spanner when the note
    sits inside a Voice, or when the spanner's element is orphaned
    (activeSite is None). Returns None if no Measure is found within 10
    hops or the site chain is broken."""
    total = 0.0
    current = note
    for _ in range(10):
        site = current.activeSite
        if site is None:
            return None
        try:
            off = current.getOffsetBySite(site)
        except Exception:
            return None
        total += off
        if isinstance(site, m21.stream.Measure):
            return site.getOffsetInHierarchy(score) + total
        current = site
    return None


def extract_score_data(score: m21.stream.Score) -> ScoreData:
    warnings: List[str] = []

    title = "Untitled"
    if score.metadata and score.metadata.title:
        title = score.metadata.title

    ts = score.recurse().getElementsByClass('TimeSignature').first()
    if ts is None:
        numerator, denominator = 4, 4
        warnings.append("박자표를 찾을 수 없어서 4/4로 가정했어요.")
    else:
        numerator, denominator = ts.numerator, ts.denominator

    total_ql = float(score.duration.quarterLength)

    notes: List[NoteEvent] = []
    for part in score.parts:
        for n in part.flatten().notesAndRests:
            if n.isRest:
                continue
            velocity = n.volume.velocity
            if velocity is None:
                velocity = DEFAULT_VELOCITY
            pitches = n.pitches if hasattr(n, 'pitches') else [n.pitch]
            for p in pitches:
                notes.append(NoteEvent(
                    pitch=int(p.midi),
                    start_ql=float(n.offset),
                    duration_ql=float(n.duration.quarterLength),
                    velocity=int(velocity),
                ))

    pedal_events: List[PedalEvent] = []
    skipped_pedals = 0
    for pm in score.recurse().getElementsByClass('PedalMark'):
        first, last = pm.getFirst(), pm.getLast()
        if first is None or last is None:
            skipped_pedals += 1
            continue
        on_ql = _abs_offset(first, score)
        off_ql = _abs_offset(last, score)
        if on_ql is None or off_ql is None:
            skipped_pedals += 1
            continue
        off_ql = off_ql + float(last.duration.quarterLength)
        pedal_events.append(PedalEvent(on_ql=on_ql, off_ql=off_ql))
    pedal_events.sort(key=lambda e: e.on_ql)
    if skipped_pedals:
        warnings.append(f"페달 지시 {skipped_pedals}개를 위치 정보 부족으로 건너뜀")

    beats: List[BeatEvent] = []
    part0 = score.parts[0]
    for measure in part0.getElementsByClass('Measure'):
        m_offset = measure.getOffsetInHierarchy(score)
        measure_ts = measure.timeSignature or ts
        beats_in_measure = measure_ts.numerator if measure_ts else numerator
        for b in range(beats_in_measure):
            beats.append(BeatEvent(offset_ql=m_offset + b, measure=measure.number))

    return ScoreData(
        title=title,
        time_signature_numerator=numerator,
        time_signature_denominator=denominator,
        total_quarter_length=total_ql,
        notes=notes,
        pedal_events=pedal_events,
        beats=beats,
        warnings=warnings,
    )


def parse_score_file(path: str) -> ScoreData:
    score = m21.converter.parse(path)
    return extract_score_data(score)


def to_json_dict(score_data: ScoreData) -> dict:
    return {
        "title": score_data.title,
        "timeSignature": {
            "numerator": score_data.time_signature_numerator,
            "denominator": score_data.time_signature_denominator,
        },
        "totalQuarterLength": score_data.total_quarter_length,
        "notes": [
            {"pitch": n.pitch, "startQL": n.start_ql, "durationQL": n.duration_ql, "velocity": n.velocity}
            for n in score_data.notes
        ],
        "pedalEvents": [
            {"onQL": p.on_ql, "offQL": p.off_ql} for p in score_data.pedal_events
        ],
        "beats": [
            {"offsetQL": b.offset_ql, "measure": b.measure} for b in score_data.beats
        ],
        "warnings": score_data.warnings,
    }
```

Also create `server/tests/__init__.py` (empty) and `server/__init__.py` (empty) so the `server.score_parser` import path resolves:
```bash
touch server/__init__.py server/tests/__init__.py
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from the repo root):
```bash
pytest server/tests/test_score_parser.py -v
```
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/score_parser.py server/tests/test_score_parser.py server/__init__.py server/tests/__init__.py
git commit -m "feat: add score parsing and pedal-span reconstruction with tests"
```

---

### Task 3: `/api/parse` endpoint

**Files:**
- Modify: `server/app.py`
- Test: `server/tests/test_app.py`

**Interfaces:**
- Consumes: `parse_score_file`, `to_json_dict` from Task 2 (`server/score_parser.py`).
- Produces: `POST /api/parse` returning the JSON schema from spec §4; static file serving of `frontend/` at `/` (used manually from Task 4 onward).

- [ ] **Step 1: Write the failing tests**

`server/tests/test_app.py`:
```python
import io

from fastapi.testclient import TestClient

from server.app import app

client = TestClient(app)


VALID_MUSICXML = b"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>3</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""


def test_rejects_unsupported_extension():
    response = client.post(
        "/api/parse",
        files={"file": ("song.pdf", io.BytesIO(b"not a score"), "application/pdf")},
    )
    assert response.status_code == 400
    assert "MusicXML" in response.json()["detail"]


def test_rejects_unparseable_musicxml():
    response = client.post(
        "/api/parse",
        files={"file": ("song.musicxml", io.BytesIO(b"not valid xml at all"), "application/xml")},
    )
    assert response.status_code == 400
    assert "파싱" in response.json()["detail"]


def test_accepts_valid_musicxml():
    response = client.post(
        "/api/parse",
        files={"file": ("song.musicxml", io.BytesIO(VALID_MUSICXML), "application/xml")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["timeSignature"] == {"numerator": 3, "denominator": 4}
    assert len(body["notes"]) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pytest server/tests/test_app.py -v
```
Expected: FAIL — `/api/parse` doesn't exist yet (404s).

- [ ] **Step 3: Implement the endpoint**

Replace the contents of `server/app.py` with:
```python
import os
import tempfile

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles

from server.score_parser import parse_score_file, to_json_dict

ALLOWED_EXTENSIONS = {".musicxml", ".mxl", ".xml"}

app = FastAPI()


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/parse")
async def parse_endpoint(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="MusicXML(.musicxml/.mxl) 파일만 지원해요")

    data = await file.read()
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        score_data = parse_score_file(tmp_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"악보 파싱에 실패했어요: {exc}")
    finally:
        os.unlink(tmp_path)

    return to_json_dict(score_data)


_FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.isdir(_FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=_FRONTEND_DIR, html=True), name="frontend")
```

Note the `_FRONTEND_DIR` mount is guarded with `isdir` so Task 3's tests pass before Task 4 creates the `frontend/` directory.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pytest server/tests/test_app.py -v
pytest server/ -v   # full backend suite, both tasks
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.py server/tests/test_app.py
git commit -m "feat: add /api/parse endpoint with validation and static frontend mount"
```

---

### Task 4: Frontend HTML/CSS skeleton

**Files:**
- Create: `frontend/index.html`
- Create: `frontend/style.css`

**Interfaces:**
- Produces: DOM element IDs that Task 8 wires up: `upload-screen`, `drop-zone`, `file-input`, `error-banner`, `practice-screen`, `title`, `play-pause-btn`, `restart-btn`, `bpm-slider`, `bpm-number`, `metronome-toggle`, `progress-bar`, `progress-fill`, `loop-range`, `time-label`, `set-loop-start-btn`, `set-loop-end-btn`, `loop-toggle`.

- [ ] **Step 1: Write the HTML skeleton**

`frontend/index.html`:
```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>피아노 템포 트레이너</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="error-banner" hidden></div>

  <section id="upload-screen">
    <div id="drop-zone">
      파일을 선택하거나 여기로 드래그하세요<br>
      (.musicxml / .mxl)
      <input type="file" id="file-input" accept=".musicxml,.mxl,.xml">
    </div>
  </section>

  <section id="practice-screen" hidden>
    <h1 id="title"></h1>

    <div class="controls-row">
      <button id="play-pause-btn">▶</button>
      <button id="restart-btn">⏮ 처음부터</button>
    </div>

    <div class="controls-row">
      <label for="bpm-slider">BPM</label>
      <input type="range" id="bpm-slider" min="20" max="200" value="80">
      <input type="number" id="bpm-number" min="20" max="200" value="80">
    </div>

    <div class="controls-row">
      <label><input type="checkbox" id="metronome-toggle"> 🔔 메트로놈</label>
    </div>

    <div id="progress-bar">
      <div id="progress-fill"></div>
      <div id="loop-range" hidden></div>
    </div>
    <div id="time-label">0:00 / 0:00</div>

    <div class="controls-row">
      <button id="set-loop-start-btn">구간 시작 지정</button>
      <button id="set-loop-end-btn">구간 끝 지정</button>
      <label><input type="checkbox" id="loop-toggle"> 🔁 반복</label>
    </div>
  </section>

  <script src="https://cdn.jsdelivr.net/npm/webaudiofont@3.0.4/npm/dist/WebAudioFontPlayer.js"></script>
  <script src="https://surikov.github.io/webaudiofontdata/sound/0000_FluidR3_GM_sf2_file.js"></script>
  <script src="scheduler.js"></script>
  <script src="synth.js"></script>
  <script src="metronome.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write the stylesheet**

`frontend/style.css`:
```css
body {
  font-family: system-ui, sans-serif;
  max-width: 480px;
  margin: 0 auto;
  padding: 16px;
}

#error-banner {
  background: #fdecea;
  color: #611a15;
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 12px;
}

#drop-zone {
  border: 2px dashed #999;
  border-radius: 8px;
  padding: 48px 16px;
  text-align: center;
  position: relative;
}

#file-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.controls-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
}

#bpm-slider {
  flex: 1;
}

#bpm-number {
  width: 4em;
}

#progress-bar {
  position: relative;
  height: 12px;
  background: #ddd;
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
}

#progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 0%;
  background: #4a7ec9;
}

#loop-range {
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(255, 165, 0, 0.4);
}

#time-label {
  font-size: 0.85em;
  color: #555;
  margin-bottom: 12px;
}
```

- [ ] **Step 3: Manually verify layout**

Open `frontend/index.html` directly in a browser (file:// URL is fine for this visual check only). Expected: upload screen shows the drop zone; no console errors about missing scripts other than expected 404s from `scheduler.js`/`synth.js`/`metronome.js`/`app.js` not existing yet (those come in later tasks).

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: add frontend HTML/CSS skeleton for upload and practice screens"
```

---

### Task 5: Tempo/loop math (`scheduler.js`)

**Files:**
- Create: `frontend/scheduler.js`
- Test: `frontend/scheduler.test.js`

**Interfaces:**
- Produces (used by Task 8):
  - `class TempoClock` with `reset(realTime, offsetQL)`, `setBpm(newBpm, realTimeNow)`, `secondsPerBeat()`, `timeAt(offsetQL)`, `offsetAt(realTime)`
  - `computeMeasureStarts(beats) -> [{offsetQL, measure}]`
  - `snapLoopStart(offsetQL, measureStarts) -> number`
  - `snapLoopEnd(offsetQL, measureStarts, totalQuarterLength) -> number`

This is the one piece of frontend logic worth an automated test (per spec §8): it has no DOM/Web Audio dependency, so it can run under plain Node instead of a browser.

- [ ] **Step 1: Write the failing tests**

`frontend/scheduler.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { TempoClock, computeMeasureStarts, snapLoopStart, snapLoopEnd } = require('./scheduler.js');

test('timeAt(0) equals the reference real time', () => {
  const clock = new TempoClock(60);
  clock.reset(10, 0);
  assert.strictEqual(clock.timeAt(0), 10);
});

test('at 60 BPM, 1 quarter length is 1 second', () => {
  const clock = new TempoClock(60);
  clock.reset(0, 0);
  assert.strictEqual(clock.timeAt(1), 1);
});

test('at 50 BPM, 1 quarter length is 1.2 seconds', () => {
  const clock = new TempoClock(50);
  clock.reset(0, 0);
  assert.strictEqual(clock.timeAt(1), 1.2);
});

test('setBpm keeps the current logical position fixed at the moment of change', () => {
  const clock = new TempoClock(60); // 1 sec/beat
  clock.reset(0, 0);
  clock.setBpm(120, 5); // 5 seconds in at 60 BPM = offset 5; now switch to 120 BPM (0.5 sec/beat)
  assert.strictEqual(clock.offsetAt(5), 5);
  assert.strictEqual(clock.timeAt(6), 5.5);
});

test('computeMeasureStarts returns one entry per measure', () => {
  const beats = [
    { offsetQL: 0, measure: 1 }, { offsetQL: 1, measure: 1 }, { offsetQL: 2, measure: 1 },
    { offsetQL: 3, measure: 2 }, { offsetQL: 4, measure: 2 }, { offsetQL: 5, measure: 2 },
  ];
  assert.deepStrictEqual(computeMeasureStarts(beats), [
    { offsetQL: 0, measure: 1 },
    { offsetQL: 3, measure: 2 },
  ]);
});

test('snapLoopStart snaps to the start of the containing measure', () => {
  const starts = [{ offsetQL: 0, measure: 1 }, { offsetQL: 3, measure: 2 }, { offsetQL: 6, measure: 3 }];
  assert.strictEqual(snapLoopStart(4, starts), 3);
  assert.strictEqual(snapLoopStart(3, starts), 3);
  assert.strictEqual(snapLoopStart(0, starts), 0);
});

test('snapLoopEnd snaps to the start of the next measure, or the piece end if in the last measure', () => {
  const starts = [{ offsetQL: 0, measure: 1 }, { offsetQL: 3, measure: 2 }, { offsetQL: 6, measure: 3 }];
  assert.strictEqual(snapLoopEnd(4, starts, 9), 6);
  assert.strictEqual(snapLoopEnd(7, starts, 9), 9);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`):
```bash
node --test scheduler.test.js
```
Expected: FAIL — `Cannot find module './scheduler.js'`. (Requires Node.js 18+.)

- [ ] **Step 3: Implement**

`frontend/scheduler.js`:
```js
class TempoClock {
  constructor(bpm) {
    this.bpm = bpm;
    this.referenceRealTime = 0;
    this.referenceOffsetQL = 0;
  }

  reset(realTime, offsetQL) {
    this.referenceRealTime = realTime;
    this.referenceOffsetQL = offsetQL;
  }

  setBpm(newBpm, realTimeNow) {
    const currentOffsetQL = this.offsetAt(realTimeNow);
    this.bpm = newBpm;
    this.reset(realTimeNow, currentOffsetQL);
  }

  secondsPerBeat() {
    return 60 / this.bpm;
  }

  timeAt(offsetQL) {
    return this.referenceRealTime + (offsetQL - this.referenceOffsetQL) * this.secondsPerBeat();
  }

  offsetAt(realTime) {
    return this.referenceOffsetQL + (realTime - this.referenceRealTime) / this.secondsPerBeat();
  }
}

function computeMeasureStarts(beats) {
  const starts = [];
  let lastMeasure = null;
  for (const b of beats) {
    if (b.measure !== lastMeasure) {
      starts.push({ offsetQL: b.offsetQL, measure: b.measure });
      lastMeasure = b.measure;
    }
  }
  return starts;
}

function snapLoopStart(offsetQL, measureStarts) {
  let result = measureStarts.length ? measureStarts[0].offsetQL : 0;
  for (const m of measureStarts) {
    if (m.offsetQL <= offsetQL) {
      result = m.offsetQL;
    } else {
      break;
    }
  }
  return result;
}

function snapLoopEnd(offsetQL, measureStarts, totalQuarterLength) {
  const start = snapLoopStart(offsetQL, measureStarts);
  for (const m of measureStarts) {
    if (m.offsetQL > start) {
      return m.offsetQL;
    }
  }
  return totalQuarterLength;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TempoClock, computeMeasureStarts, snapLoopStart, snapLoopEnd };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
node --test scheduler.test.js
```
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/scheduler.js frontend/scheduler.test.js
git commit -m "feat: add tempo clock and measure-snapped loop math with tests"
```

---

### Task 6: Piano synth wrapper (`synth.js`)

**Files:**
- Create: `frontend/synth.js`
- Test: manual (browser console)

**Interfaces:**
- Consumes: the global `WebAudioFontPlayer` class and `_tone_0000_FluidR3_GM_sf2_file` object, both loaded by `<script>` tags in `index.html` (Task 4) before this file.
- Produces (used by Task 8): `createPianoSynth(audioContext) -> { loadPiano(): Promise<void>, playNote(pitch, when, durationSeconds, velocity): void, stopAll(): void }`.

- [ ] **Step 1: Implement**

`frontend/synth.js`:
```js
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
```

- [ ] **Step 2: Manually verify sound playback**

Add `<script src="synth.js"></script>` before `app.js` in `index.html` (already present from Task 4). Open the page in a browser, open the dev console, and run:
```js
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const synth = createPianoSynth(ctx);
synth.loadPiano().then(() => synth.playNote(60, ctx.currentTime, 1.0, 90));
```
Expected: a piano middle-C note plays for about 1 second.

- [ ] **Step 3: Commit**

```bash
git add frontend/synth.js
git commit -m "feat: add WebAudioFont piano synth wrapper"
```

---

### Task 7: Metronome click (`metronome.js`)

**Files:**
- Create: `frontend/metronome.js`
- Test: manual (browser console)

**Interfaces:**
- Produces (used by Task 8): `playClick(audioContext, when)` — schedules one short click, same pitch/volume every time (no accent).

- [ ] **Step 1: Implement**

`frontend/metronome.js`:
```js
function playClick(audioContext, when) {
  const duration = 0.03;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = 1500;
  gain.gain.setValueAtTime(0.5, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(when);
  osc.stop(when + duration);
}
```

- [ ] **Step 2: Manually verify sound playback**

In the browser console (same page as Task 6):
```js
playClick(ctx, ctx.currentTime);
playClick(ctx, ctx.currentTime + 0.5);
playClick(ctx, ctx.currentTime + 1.0);
```
Expected: three identical, evenly-spaced clicks — same pitch and loudness each time.

- [ ] **Step 3: Commit**

```bash
git add frontend/metronome.js
git commit -m "feat: add uniform-strength metronome click generator"
```

---

### Task 8: Full playback integration (`app.js`)

**Files:**
- Create: `frontend/app.js`
- Test: manual (browser + phone on the same Wi-Fi)

**Interfaces:**
- Consumes: `TempoClock`, `computeMeasureStarts`, `snapLoopStart`, `snapLoopEnd` (Task 5); `createPianoSynth` (Task 6); `playClick` (Task 7); the DOM element IDs from Task 4; the JSON schema from Task 3 (`timeSignature`, `totalQuarterLength`, `notes[].{pitch,startQL,durationQL,velocity}`, `pedalEvents[].{onQL,offQL}`, `beats[].{offsetQL,measure}`, `warnings`).

This is the integration point where upload, playback, tempo control, metronome, and loop all come together against shared state — none of these pieces are independently useful without the others, so they're one task with several steps rather than split further.

Note on pedal: since the browser plays notes individually (there's no MIDI sustain-pedal concept here), pedal spans are applied by **extending a note's playback duration** up to the pedal-off time when the note starts inside a pedal span — reproducing the "chord keeps ringing" effect that motivated the original pedal-reconstruction fix, without needing real pedal DSP.

- [ ] **Step 1: Implement**

`frontend/app.js`:
```js
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
```

- [ ] **Step 2: Manual QA pass**

With the backend running (`uvicorn server.app:app --host 0.0.0.0 --port 8000` from the repo root) and a real MusicXML file (e.g. the Moszkowski file from earlier testing) at hand:

1. Open `http://127.0.0.1:8000/` in a browser, upload the file → practice screen appears with the correct title.
2. Press ▶ → piano audio plays from the start.
3. Drag the BPM slider mid-playback → tempo changes immediately, no pause/glitch.
4. Toggle 🔔 metronome on → identical clicks on every beat (no accent); off → clicks stop.
5. Tap the progress bar → playback jumps to that point.
6. Press "구간 시작 지정" then "구간 끝 지정" a few beats later, toggle 🔁 반복 on → playback loops between those two measure boundaries indefinitely.
7. Upload a non-MusicXML file (e.g. a `.txt`) → the Korean error banner appears, no crash.

Expected: all seven behaviors work as described.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: wire upload, playback, tempo, metronome, and loop controls together"
```

---

### Task 9: README with run instructions

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

`README.md`:
```markdown
# 피아노 템포 트레이너

개인 연습용 도구: MusicXML 악보를 업로드하면 원하는 BPM으로, 피치 왜곡 없이
피아노 음색으로 재생하고, 메트로놈과 구간 반복 연습을 지원한다.

## 실행 방법 (PC)

1. 의존성 설치 (최초 1회):
   ```bash
   cd server
   pip install -r requirements.txt
   ```
2. 서버 실행 (리포지토리 루트에서):
   ```bash
   uvicorn server.app:app --host 0.0.0.0 --port 8000
   ```
3. PC의 로컬 IP 확인:
   - Windows: `ipconfig` 실행 후 "IPv4 주소" 확인 (예: `192.168.1.23`)
4. 같은 와이파이에 연결된 휴대폰 브라우저에서 `http://<위에서 확인한 IP>:8000` 접속

## 사용법

1. MusicXML(.musicxml/.mxl) 파일을 업로드
2. ▶ 버튼으로 재생 시작 (모바일 브라우저는 자동재생이 막혀 있어 반드시 직접 눌러야 함)
3. BPM 슬라이더로 속도 조절 (재생 중에도 즉시 반영됨)
4. 🔔 메트로놈으로 클릭 켜고 끄기
5. 어려운 구간은 "구간 시작 지정" → "구간 끝 지정" → 🔁 반복 켜기로 반복 연습

## 테스트

```bash
pytest server/ -v          # 백엔드
node --test frontend/scheduler.test.js   # 프론트엔드 템포/반복 로직 (Node 18+)
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with run and usage instructions"
```

---

## Self-Review Notes

- **Spec coverage:** §2 goals (upload, tempo playback, live BPM slider, uniform metronome, measure-snapped loop, LAN access) → Tasks 3–9. §3 architecture (server=analysis only, client=playback) → Tasks 1–3 vs 5–8. §4 JSON schema → Task 2's `to_json_dict` + Task 3's tests. §5 tempo math and lookahead scheduling → Tasks 5 and 8. §6 UI → Task 4 (markup) + Task 8 (behavior). §7 error handling → Task 3 (server-side) + Task 8 (client-side). §8 testing → Task 2 (backend regression test, via a synthetic fixture instead of the literal Moszkowski file — see Task 2's note) and Task 5 (frontend tempo/loop unit tests). §9 is explicitly out of scope for this plan.
- **Type/name consistency check:** JSON keys (`timeSignature`, `totalQuarterLength`, `startQL`, `durationQL`, `onQL`, `offQL`, `offsetQL`, `pitch`, `velocity`, `measure`, `warnings`) are identical across Task 2 (`to_json_dict`), Task 3 (endpoint + tests), and Task 8 (`app.js` field access) — verified by re-reading each usage while writing this plan.
- **No placeholders:** every step above contains complete, runnable code; no "TBD"/"similar to Task N" shortcuts.
