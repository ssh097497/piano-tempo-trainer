# WASM 신디사이저 교체 + 부가 기능 — 설계 문서

- 날짜: 2026-09-15
- 작성자: Seolhee Sun (Claude Code와 협업)
- 상태: 설계 승인됨, 구현 계획 작성 대기
- 이전 스펙: `docs/superpowers/specs/2026-09-14-piano-tempo-trainer-design.md` (v1, 이미 구현·병합 대기 중인 `worktree-piano-tempo-trainer` 브랜치)
- 이 브랜치: `wasm-synth-features` (`worktree-piano-tempo-trainer`에서 분기)

## 1. 배경

v1을 실제로 써보니 두 가지 문제가 나왔다.

1. **피아노 음색이 로봇음처럼 들림**: 지금 쓰는 WebAudioFont + 무료 GM 사운드폰트(GeneralUserGS)는 88개 건반을 25개 샘플로만 커버해서, 단음을 칠 때 피치를 심하게 늘리고 줄이는 티가 난다 (직접 파일을 뜯어서 확인: 저음/고음역은 한 샘플이 22~28반음을 커버). WebAudioFont가 제공하는 다른 무료 프리셋들(Aspirin 22개, JCLive 20개, FluidR3_GM 20개, SBLive 17개, Chaos 11개, SoundBlasterOld 8개)도 전부 이보다 적어서, 이 방식 안에서는 개선할 여지가 없다.
2. **메트로놈이 안 들림 / 소리 선택 불가 / 음량 조절 불가**: v1은 클릭 소리 하나만 고정이었고, 곡 소리와 별도로 음량을 조절할 수 없었다.

## 2. 목표

1. **신디사이저 교체**: WebAudioFont → `js-synthesizer`(WASM 컴파일된 FluidSynth) + 실제 멀티샘플 피아노 사운드폰트(`yamaha-grand-lite.sf2`, 이미 검증됨 — 오프라인 렌더링 프로토타입에서 자연스럽게 들렸던 그 파일). 외부 인터페이스(`createPianoSynth(audioContext)` → `{loadPiano, playNote, stopAll}`)는 그대로 유지해서 `app.js`의 나머지 코드는 손대지 않는다.
2. **메트로놈 소리 선택**: 최소 3가지 클릭 사운드 중 선택 가능 (노이즈 틱 / 사인 비프 / 우드블록).
3. **음량 분리 조절**: 곡(피아노) 음량과 메트로놈 음량을 각각 독립적으로 조절.
4. **최근 파일 기억**: File System Access API로 마지막에 연 파일의 핸들을 기억해두고, "이전 파일 불러오기" 버튼 하나로 파일 선택 창 없이 바로 다시 로드. (Chrome/Edge 전용, Safari 등 미지원 브라우저에서는 이 버튼 자체를 숨김)

## 3. 신디사이저 교체 — 기술 설계

**사용 라이브러리**: `js-synthesizer` (npm, 최신 1.13.0) + `fluidsynth-emscripten`의 WASM glue 파일.

**로드할 스크립트 (index.html에 vendor로 내장)**:
- `frontend/vendor/libfluidsynth-2.4.6.js` (WASM 바이너리가 base64로 내장된 emscripten glue, 약 570KB) — 원본: `https://github.com/jet2jet/fluidsynth-emscripten/releases/download/v2.4.6-em-2/libfluidsynth-2.4.6.js`
- `frontend/vendor/js-synthesizer.min.js` (수십 KB) — 원본: `https://cdn.jsdelivr.net/npm/js-synthesizer@1.13.0/dist/js-synthesizer.min.js`
- `frontend/vendor/piano.sf2` (약 20.8MB, `yamaha-grand-lite.sf2`를 리네임) — 이미 이번 세션에서 다운로드해서 검증한 파일 재사용

원본 서버의 Content-Type/CSP 헤더는 상관없다 — 어차피 우리 서버(`server/app.py`의 `StaticFiles`)가 `.js`/`.sf2` 파일로 서빙하므로 우리 쪽에서 올바른 타입으로 나간다 (v1에서 이 부분을 놓쳐서 한 번 실패한 적이 있어서 명시).

**API 사용 패턴** (js-synthesizer README 기준):
```js
const synth = new JSSynth.Synthesizer();
synth.init(audioContext.sampleRate);
const node = synth.createAudioNode(audioContext, 8192); // ScriptProcessorNode 기반
node.connect(audioContext.destination);
await synth.loadSFont(sfontArrayBuffer); // fetch(url).then(r => r.arrayBuffer())
const seq = await synth.createSequencer();
await seq.registerSynthesizer(synth);
seq.setTimeScale(1000); // 1000 tick = 1초
```

**미래 시각 스케줄링**: 지금 스케줄러는 "이 음을 audioContext 기준 몇 초 후에 내라"는 방식으로 동작한다. js-synthesizer의 `noteOn`은 즉시 실행이라 이대로는 못 쓰고, `ISequencer.sendEventAt(event, tickOffset, relative)`를 써서 미래 tick에 이벤트를 예약해야 한다. 변환 공식:
```
targetTick = currentTick + (when - audioContext.currentTime) * ticksPerSecond
```
`currentTick`은 시퀀서에서 매번 읽어와야 하고(고정된 기준점이 아니라 렌더링과 함께 흘러가는 값), `ticksPerSecond`는 `setTimeScale`로 설정한 값(1000)과 일치해야 한다.

**알려진 불확실성**: 이 tick↔실제시간 동기화가 얼마나 정밀한지 문서에 수치로 안 나와 있다. 구현 후 실제로 들어보면서 "박자가 밀리거나 튀는지" 확인이 필요하다 — 이건 내가(Claude) 소리를 들을 수 없어서 사용자가 직접 확인해줘야 하는 부분이다.

**서스테인 페달**: js-synthesizer는 진짜 CC64 신호(`midiControl(chan, 64, val)` 또는 시퀀서의 `controlchange` 이벤트)를 지원한다. 이번 교체에서는 범위를 좁혀서 **기존의 "음 길이 늘리기" 방식(v1의 `effectiveDurationQL`)을 그대로 유지**한다 — 신디사이저 교체만으로 소리가 얼마나 나아지는지 먼저 확인하고, 그래도 아쉬우면 진짜 페달 신호로 바꾸는 걸 다음 라운드로 미룬다 (YAGNI: 한 번에 두 가지를 바꾸면 문제가 생겼을 때 원인 분리가 안 됨).

## 4. 메트로놈 — 소리 선택 + 음량 분리

**클릭 사운드 3종** (모든 박이 여전히 동일한 세기 — v1에서 사용자가 명시적으로 요구한 "강박 없음" 원칙 유지):
1. **노이즈 틱** (지금 것 유지): 하이패스 필터링된 화이트노이즈 버스트
2. **사인 비프**: 순수 톤 (v1 최초 버전과 비슷하되 음량은 새로 조정)
3. **우드블록**: 밴드패스 필터링된 노이즈 버스트 (더 낮은 중심주파수, 나무 두드리는 느낌)

`metronome.js`의 `playClick(audioContext, when)`을 `playClick(audioContext, when, soundType, volume)`으로 확장한다 (soundType: `'noise' | 'beep' | 'woodblock'`, volume: 0.0~1.0).

**음량 분리**: `app.js`에 두 개의 볼륨 슬라이더를 추가 — 곡 음량(피아노 `playNote`의 volume 계산에 곱해지는 배수)과 메트로놈 음량(`playClick`에 넘기는 volume). 둘 다 0~100% 슬라이더, 기본값 100%.

## 5. 최근 파일 기억 (File System Access API)

- 파일을 성공적으로 열면(`showOpenFilePicker()`로 열었을 때), 그 `FileSystemFileHandle`을 브라우저의 IndexedDB에 저장한다 (구조적으로 복제 가능한 객체라 `structuredClone` 저장이 표준적으로 지원됨).
- 페이지를 다시 열었을 때, 저장된 핸들이 있으면 "이전 파일 불러오기" 버튼을 업로드 화면에 노출한다.
- 그 버튼을 누르면: `handle.queryPermission({mode:'read'})`으로 권한을 확인하고, 필요하면 `handle.requestPermission({mode:'read'})`으로 재요청(사용자 클릭이 있어야 가능 — 버튼 클릭 자체가 그 제스처가 됨). 권한이 있으면 `handle.getFile()`로 파일을 읽어서 기존 업로드 플로우(`/api/parse`로 전송)에 그대로 넣는다.
- **브라우저 미지원 대응**: `window.showOpenFilePicker`가 없는 브라우저(Safari 등)에서는 이 기능 전체(버튼 노출, 핸들 저장)를 건너뛴다 — 기존의 일반 `<input type="file">` 업로드는 모든 브라우저에서 그대로 동작한다.
- 파일이 사라졌거나 이동됐으면(`getFile()` 실패) "이전 파일을 찾을 수 없어요" 안내 후 일반 업로드 화면으로 돌아간다.

## 6. 비목표 (이번 라운드에서 제외)

- 진짜 MIDI 서스테인 페달 신호로 교체 (3장에서 설명 — 다음 라운드로 미룸)
- 메트로놈 강박 추가 (v1에서 이미 사용자가 거부한 사항, 재검토 없음)
- 여러 파일 기억(최근 목록) — 딱 1개(마지막 파일)만 기억

## 7. 테스트

- `js-synthesizer` 통합은 실제 오디오 출력 확인이 필요해서 이번에도 자동화 테스트는 스케줄링 수학(시각→tick 변환 함수)에 대한 순수 함수 테스트로 한정하고, 나머지는 사용자의 수동 확인에 의존한다.
- 메트로놈 3종 사운드는 각각 코드 상에서 "같은 세기로만 나는지"(강박 없음 유지) 확인하는 정도로 자동화하고, 실제 소리 품질은 수동 확인.
- File System Access API 플로우는 헤드리스 환경에서 테스트가 어려워서, 브라우저 지원 여부 분기(`if ('showOpenFilePicker' in window)`)가 올바른지만 코드 리뷰로 확인하고 실사용은 수동 확인.
