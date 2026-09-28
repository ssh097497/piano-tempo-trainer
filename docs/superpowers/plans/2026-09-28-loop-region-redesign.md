# 구간 반복 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 구간 반복을 시작/끝 한 쌍 + 별도 켜기 토글에서, 파일별로 여러 구간을 저장하고 목록에서 골라 켜고 끄는 방식으로 바꾸고, 탐색(seek)과 반복의 상호작용을 하나의 명확한 규칙("자연스럽게 흘러가다 실제로 구간 끝을 지나가는 순간에만 되돌아감")으로 재정의한다.

**Architecture:** `file-memory.js`에 파일 이름별 구간 목록을 저장/조회하는 IndexedDB 함수를 추가하고, `index.html`/`style.css`의 "구간 반복" 카드를 토글 없는 목록형 UI로 재구성한 뒤, `app.js`의 재생 상태(`loopOn`/`loopStartQL`/`loopEndQL`)를 `regions`/`activeRegionId` 리스트 모델로 교체하고 `schedulerTick`의 반복 판정을 "경계를 넘는 순간" 감지 방식으로 바꾼다.

**Tech Stack:** 순수 브라우저 JS (프레임워크 없음), IndexedDB, 기존 `scheduler.js`의 `TempoClock`/`snapLoopStart`/`snapLoopEnd` 재사용.

**Spec:** docs/superpowers/specs/2026-09-28-loop-region-redesign-design.md

## Global Constraints

- `scheduler.js`(`TempoClock`, `computeMeasureStarts`, `snapLoopStart`, `snapLoopEnd`, `effectiveDurationQL`)는 수정하지 않는다.
- `synth.js`/`metronome.js`는 수정하지 않는다.
- `scoreData`의 반환 필드(스펙 §8)는 바뀌지 않는다.
- 구간 목록은 IndexedDB에 **업로드한 파일의 이름**(`file.name`)을 키로 저장한다 (스펙 §4.1).
- 반복 판정은 "방금 탐색해서 도착한 위치"를 절대 "지나감"으로 치지 않는, 이전 틱 대비 경계를 넘는 순간만 감지하는 방식이어야 한다 (스펙 §5).
- 별도의 🔁 반복 켜기/끄기 토글은 없앤다 — 구간 목록에서 탭으로 활성화/비활성화한다 (스펙 §2, §6.1).
- `app.js`는 이 프로젝트 관례상 DOM 오케스트레이션 코드라 유닛테스트 대상이 아니다 — 각 태스크의 검증은 실제 브라우저에서 수동으로 확인한다 (스펙 §7).

---

### Task 1: 구간 영속성 (`file-memory.js`)

**Files:**
- Modify: `frontend/file-memory.js`

**Interfaces:**
- Produces: `saveRegionsForFile(fileName: string, regions: Array<{id, startQL, endQL}>) -> Promise<void>`, `loadRegionsForFile(fileName: string) -> Promise<Array<{id, startQL, endQL}>>` (파일 이름에 저장된 게 없으면 빈 배열 `[]`을 돌려준다).

지금 `file-memory.js`는 이렇게 시작한다:

```js
const DB_NAME = 'piano-tempo-trainer';
const STORE_NAME = 'last-file';
const FILE_KEY = 'last-opened';
const LEGACY_STORE_NAME = 'file-handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      // Drop the old FileSystemFileHandle-based store from a prior version
      // of this feature -- handles from it are unusable now that we cache
      // file contents directly instead, so there's nothing to migrate.
      if (db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        db.deleteObjectStore(LEGACY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
```

- [ ] **Step 1: DB 버전을 올리고 새 object store를 추가한다**

`openDb()`를 이렇게 바꾼다 (버전 2 → 3, `REGIONS_STORE_NAME` 상수 추가, `onupgradeneeded`에 새 store 생성 추가):

```js
const DB_NAME = 'piano-tempo-trainer';
const STORE_NAME = 'last-file';
const FILE_KEY = 'last-opened';
const LEGACY_STORE_NAME = 'file-handles';
const REGIONS_STORE_NAME = 'loop-regions';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(REGIONS_STORE_NAME)) {
        db.createObjectStore(REGIONS_STORE_NAME);
      }
      // Drop the old FileSystemFileHandle-based store from a prior version
      // of this feature -- handles from it are unusable now that we cache
      // file contents directly instead, so there's nothing to migrate.
      if (db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        db.deleteObjectStore(LEGACY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
```

- [ ] **Step 2: `saveRegionsForFile`/`loadRegionsForFile` 추가**

파일 끝(`loadLastFile` 함수 뒤)에 추가한다:

```js
// Loop regions are keyed by the uploaded file's own name (file.name), not
// a fixed key -- unlike the single "last file" cache above, each piece
// keeps its own separate list of saved practice regions.
async function saveRegionsForFile(fileName, regions) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGIONS_STORE_NAME, 'readwrite');
    tx.objectStore(REGIONS_STORE_NAME).put(regions, fileName);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRegionsForFile(fileName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGIONS_STORE_NAME, 'readonly');
    const request = tx.objectStore(REGIONS_STORE_NAME).get(fileName);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
```

- [ ] **Step 3: 문법 확인 및 회귀 테스트**

Run: `cd frontend && node --check file-memory.js`
Expected: 아무 출력 없이 종료 (문법 오류 없음).

Run: `cd frontend && node scheduler.test.js && node midi-parser.test.js && node xml-score-reader.test.js && node score-parser.test.js`
Expected: 네 파일 모두 전부 통과 (이 태스크는 순수 로직 테스트에 영향이 없어야 함 — 회귀 확인용).

이 두 함수는 `openDb`/`saveLastFile`/`loadLastFile`처럼 IndexedDB를 직접 감싸는 브라우저 API 래퍼라, 이 파일의 기존 관례대로 별도 유닛테스트는 없다. 실제 동작 확인은 Task 3에서 UI에 연결된 뒤 브라우저로 확인한다.

- [ ] **Step 4: 커밋**

```bash
git add frontend/file-memory.js
git commit -m "feat: add per-file loop region persistence to file-memory.js"
```

---

### Task 2: "구간 반복" 카드 UI 재구성 (`index.html`, `style.css`)

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/style.css`

**Interfaces:**
- Produces: `#region-list`라는 빈 `<ul>` 컨테이너 (Task 3의 JS가 여기에 `<li class="region-item">` 항목들을 채워넣음). CSS 클래스 `region-item`, `region-item.active`, `region-label`, `region-time`, `region-delete`.
-제거: `#loop-toggle` 체크박스(및 그걸 감싸던 `.switch` 마크업), `.row-between`/`.loop-card-head` (다른 곳에서 안 쓰이는 걸 확인함).

지금 `index.html`의 "구간 반복" 카드는 이렇다:

```html
    <div class="card">
      <div class="row-between loop-card-head">
        <p class="card-label">구간 반복</p>
        <div class="switch">
          <input type="checkbox" id="loop-toggle">
          <div class="track"></div>
          <div class="thumb"></div>
        </div>
      </div>
      <div id="progress-bar">
        <div id="progress-fill"></div>
        <div id="loop-range" hidden></div>
      </div>
      <div id="time-label">0:00 / 0:00</div>
      <div class="loop-actions">
        <button id="set-loop-start-btn" class="chip-btn">구간 시작 지정</button>
        <button id="set-loop-end-btn" class="chip-btn">구간 끝 지정</button>
      </div>
    </div>
```

- [ ] **Step 1: 마크업을 토글 없는 목록형으로 바꾼다**

위 블록을 이걸로 통째로 교체한다:

```html
    <div class="card">
      <p class="card-label">구간 반복</p>
      <div id="progress-bar">
        <div id="progress-fill"></div>
        <div id="loop-range" hidden></div>
      </div>
      <div id="time-label">0:00 / 0:00</div>
      <div class="loop-actions">
        <button id="set-loop-start-btn" class="chip-btn">구간 시작 지정</button>
        <button id="set-loop-end-btn" class="chip-btn">구간 끝 지정</button>
      </div>
      <ul id="region-list"></ul>
    </div>
```

- [ ] **Step 2: 브라우저로 확인**

로컬 서버(`python -m http.server 8000` 등)로 열어서, "구간 반복" 카드에 토글 스위치가 없어졌고, 진행바/시간표시/두 버튼이 그대로 보이는지 확인한다. `#region-list`는 비어있어서 아무것도 안 보이는 게 맞다(Task 3 전이므로).

- [ ] **Step 3: 죽은 CSS 제거 + 구간 목록 스타일 추가**

`style.css`에서 이제 아무 데서도 안 쓰는 다음 규칙을 지운다:

```css
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.loop-card-head { margin-bottom: 12px; }
.loop-card-head .card-label { margin: 0; }
```

그 자리에(또는 파일 끝에) 구간 목록 스타일을 추가한다:

```css
#region-list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.region-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--surface);
  cursor: pointer;
}
.region-item.active {
  border-color: var(--accent);
  background: var(--accent-tint);
}
.region-label {
  flex: 1;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--ink-soft);
}
.region-item.active .region-label { color: var(--accent-strong); }
.region-time {
  font-family: "JetBrains Mono", monospace;
  font-size: 0.76rem;
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}
.region-delete {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--ink-faint);
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
  flex: none;
}
.region-delete:hover { color: var(--danger); }
```

- [ ] **Step 4: 커밋**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: restructure loop card markup for a region list (no more toggle)"
```

---

### Task 3: 구간 상태/반복 로직/목록 연동 (`app.js`) + 배포 마무리

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/service-worker.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1의 `saveRegionsForFile(fileName, regions)`/`loadRegionsForFile(fileName)`, Task 2의 `#region-list` 컨테이너와 `region-item`/`region-item.active`/`region-label`/`region-time`/`region-delete` CSS 클래스.

지금 `app.js`의 관련 부분들을 아래 단계별로 바꾼다. (파일 전체는 이미 존재하니, 아래는 "이 문자열을 찾아서 이걸로 바꿔라"는 지시다.)

- [ ] **Step 1: 상태 변수 교체**

찾는다:

```js
  let loopOn = false;
  let loopStartQL = null;
  let loopEndQL = null;
```

이걸로 바꾼다:

```js
  let regions = []; // [{id, startQL, endQL}, ...] for the currently open file
  let activeRegionId = null; // id of the region currently being looped, or null
  let lastTickOffsetQL = null; // set by startPlayback(); distinguishes "just seeked past the loop end" from "played forward past it"
  let pendingStartQL = null; // set by "구간 시작 지정" until paired with an end
  let pendingEndQL = null; // set by "구간 끝 지정" until paired with a start
  let currentFileName = null; // the currently open file's name, for keying saved regions
```

- [ ] **Step 2: DOM 참조 교체**

찾는다:

```js
  const setLoopStartBtn = document.getElementById('set-loop-start-btn');
  const setLoopEndBtn = document.getElementById('set-loop-end-btn');
  const loopToggle = document.getElementById('loop-toggle');
```

이걸로 바꾼다:

```js
  const setLoopStartBtn = document.getElementById('set-loop-start-btn');
  const setLoopEndBtn = document.getElementById('set-loop-end-btn');
  const regionListEl = document.getElementById('region-list');
```

- [ ] **Step 3: `handleFile`에 구간 불러오기 연결**

찾는다:

```js
    // Reset hand selection for every newly loaded file -- a previous
    // file's "왼손만" choice carrying over into a piece the user just
    // opened would be a surprising way to lose the right-hand part.
    handFilter = 'both';
    handButtons.forEach((b) => b.classList.toggle('active', b.dataset.hand === 'both'));
    handSelect.hidden = !scoreData.handSeparationAvailable;

    if (scoreData.warnings && scoreData.warnings.length) {
```

이걸로 바꾼다 (구간 로딩 블록을 hand-filter 리셋과 warnings 사이에 추가):

```js
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
```

- [ ] **Step 4: `loopEndOrInfinity`와 `startPlayback` 수정**

찾는다:

```js
  function loopEndOrInfinity() {
    return (loopOn && loopStartQL != null && loopEndQL != null) ? loopEndQL : Infinity;
  }

  function startPlayback(fromOffsetQL) {
    clock.reset(audioContext.currentTime, fromOffsetQL);
    nextNoteIndex = findNoteIndexAtOrAfter(fromOffsetQL);
    nextBeatIndex = findBeatIndexAtOrAfter(fromOffsetQL);
    isPlaying = true;
```

이걸로 바꾼다:

```js
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
```

- [ ] **Step 5: `schedulerTick`의 반복 판정 수정**

찾는다:

```js
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
```

이걸로 바꾼다:

```js
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
```

- [ ] **Step 6: 구간 목록 렌더링 + 활성화/삭제 함수 추가**

찾는다 (이 파일 끝부분, "--- Loop controls ---" 섹션 전체):

```js
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

  function ensureLoopOrder() {
    // The two handlers below set loopStartQL/loopEndQL independently, with
    // no ordering guarantee -- the user can mark "구간 끝" before marking
    // "구간 시작" later in the piece. If loopEndQL <= loopStartQL is left
    // as-is, schedulerTick's note/beat loop breaks immediately every tick
    // (nothing satisfies startQL < effectiveEnd) and the wraparound check
    // (currentOffset >= loopEndQL) fires on virtually every tick, calling
    // startPlayback(loopStartQL) in a silent ~25ms spin-lock. Swap so start
    // is always before end.
    if (loopStartQL != null && loopEndQL != null && loopEndQL <= loopStartQL) {
      const tmp = loopStartQL;
      loopStartQL = loopEndQL;
      loopEndQL = tmp;
    }
  }

  setLoopStartBtn.addEventListener('click', async () => {
    await ensureAudio();
    loopStartQL = snapLoopStart(currentLogicalOffset(), measureStarts);
    ensureLoopOrder();
    updateLoopHighlight();
  });

  setLoopEndBtn.addEventListener('click', async () => {
    await ensureAudio();
    loopEndQL = snapLoopEnd(currentLogicalOffset(), measureStarts, scoreData.totalQuarterLength);
    ensureLoopOrder();
    updateLoopHighlight();
  });

  loopToggle.addEventListener('change', () => {
    loopOn = loopToggle.checked;
  });
})();
```

이걸로 통째로 바꾼다:

```js
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
```

- [ ] **Step 7: 문법 확인 및 회귀 테스트**

Run: `cd frontend && node --check app.js`
Expected: 아무 출력 없이 종료.

Run: `cd frontend && node scheduler.test.js && node midi-parser.test.js && node xml-score-reader.test.js && node score-parser.test.js`
Expected: 네 파일 모두 통과 (이 태스크는 `app.js`만 바꾸므로 순수 로직 테스트는 영향 없어야 함).

- [ ] **Step 8: 실제 브라우저로 수동 확인**

로컬 서버로 앱을 열고 (`file://`가 아니라 `http://localhost:8000` 등으로):

1. 악보를 업로드하고 재생 → "구간 시작 지정"을 한 지점에서, "구간 끝 지정"을 몇 초 뒤에서 누른다. 목록에 "구간 1"이 나타나고 자동으로 활성화(강조)되는지 확인.
2. 같은 방식으로 "구간 2"를 다른 위치에 하나 더 만든다. 목록에 둘 다 보이는지, 지금은 구간 2가 활성 상태인지 확인.
3. 재생 중 구간 2를 끝까지 흘러가게 둔다 → 구간 2의 시작 지점으로 자동으로 돌아가서 반복되는지 확인.
4. 진행바를 눌러서 구간 2의 끝보다 뒤쪽으로 이동한다 → 즉시 되돌려지지 않고, 그 지점부터 계속 재생되는지 확인 (미리듣기).
5. 진행바를 눌러서 구간 2 안쪽으로 다시 이동한다 → 거기서부터 재생하다가 구간 끝에 도달하면 다시 정상적으로 구간 2 시작으로 돌아가는지 확인.
6. 구간 1을 탭한다 → 구간 2는 비활성화되고 구간 1이 활성화되며, 재생 위치가 구간 1 시작으로 이동하는지 확인.
7. 활성화된 구간(구간 1)을 다시 탭한다 → 비활성화되고(반복 꺼짐), 재생 위치는 그대로인지 확인.
8. 구간 하나를 × 눌러서 삭제 → 목록과 진행바 강조에서 사라지는지 확인.
9. 페이지를 새로고침(또는 앱을 완전히 재시작)한 뒤 같은 파일을 다시 연다 → 아까 만든 구간들이 그대로 남아있는지 확인 (영속성).
10. 다른 파일을 열어본다 → 구간 목록이 비어있는지(그 파일만의 목록인지) 확인.

- [ ] **Step 9: 서비스워커 캐시 버전 올리기**

`frontend/service-worker.js`에서 `CACHE_NAME` 값을 하나 올린다 (예: `piano-tempo-trainer-v13` → `piano-tempo-trainer-v14` — 실제 현재 값을 확인하고 그다음 번호로).

- [ ] **Step 10: README 갱신**

`README.md`의 사용법 목록에서 구간 반복 관련 항목(현재 6번 "어려운 구간은 '구간 시작 지정' → '구간 끝 지정' → 🔁 반복 켜기로 반복 연습")을 찾아 이렇게 바꾼다:

```
6. "구간 시작 지정" → "구간 끝 지정"으로 어려운 구간을 등록 (여러 개
   등록 가능, 파일별로 저장되어 다시 열어도 남아있음). 목록에서 탭해서
   반복 켜고 끄기
```

- [ ] **Step 11: 커밋 및 배포**

```bash
git add frontend/app.js frontend/service-worker.js README.md
git commit -m "feat: switch loop practice to multiple saved regions with consistent seek behavior"
git push origin pwa-client-only
```

Run: `gh run list --repo ssh097497/piano-tempo-trainer --limit 1`으로 배포 워크플로가 성공했는지 확인한다.
