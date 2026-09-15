# 서버 없는 PWA 전환 — 설계 문서

- 날짜: 2026-09-15
- 작성자: Seolhee Sun (Claude Code와 협업)
- 상태: 설계 승인됨, 구현 계획 작성 대기
- 이전 브랜치: `wasm-synth-features` (WASM 신디사이저 교체 + 메트로놈/음량/최근파일 기능, 이미 구현·테스트 완료)
- 이 브랜치: `pwa-client-only`

## 1. 배경

PC에서 파이썬 서버(FastAPI)를 계속 켜둬야 휴대폰으로 연습 도구를 쓸 수 있는 게 사용자에게 실질적인 걸림돌이었다. 원래 이 프로젝트의 설계 원칙("로그인 없이, 사생활 정보가 인터넷에 안 나가게")을 지키면서 "PC가 항상 켜져 있을 필요"를 없애는 방법을 검토한 결과, **서버(백엔드) 자체를 없애고 완전히 브라우저(자바스크립트)에서만 동작하는 PWA(설치형 웹앱)로 전환**하는 방향으로 정했다.

이 전환 과정에서 별도로 발견한 버그(악보의 도돌이표 `|: :|` 반복 구간이 재생에서 무시됨 — 원래 `server/score_parser.py`가 `music21.stream.Score.expandRepeats()`를 호출하지 않아서 생긴 문제)도 이번에 같이 해결된다. 새로 채택하는 라이브러리(Verovio)가 MIDI로 렌더링할 때 반복을 기본적으로 펼쳐주기 때문이다.

## 2. 목표

1. **백엔드 완전 제거**: `server/` 디렉터리(FastAPI, music21 기반 파싱)를 삭제한다. 모든 처리(악보 분석 + 재생)가 브라우저 안에서만 일어난다.
2. **악보 분석을 자바스크립트로 재구현**: 업로드된 MusicXML(.musicxml/.mxl) 파일을 브라우저에서 직접 분석해서, 지금과 동일한 JSON 형태(`title`, `timeSignature`, `totalQuarterLength`, `notes[]`, `pedalEvents[]`, `beats[]`, `warnings[]`)를 만든다. 이 JSON을 소비하는 나머지 코드(`scheduler.js`, `synth.js`, `metronome.js`, `app.js`의 재생 엔진)는 **하나도 바꾸지 않는다** — "scoreData를 어떻게 얻는가"만 바뀐다(서버에 fetch하던 것 → 브라우저에서 직접 계산).
3. **도돌이표(반복) 재생 지원**: Verovio의 MIDI 렌더링이 기본적으로 반복을 펼쳐주는 것을 활용해서, 지금까지 빠져 있던 반복 재생을 지원한다.
4. **PWA로 설치 가능하게 만들기**: `manifest.json` + 서비스 워커를 추가해서, 휴대폰에서 "홈 화면에 추가" 하면 오프라인에서도 동작하는 앱처럼 쓸 수 있게 한다.
5. **오픈소스 라이선스 표시**: 새로 vendoring하는 라이브러리(Verovio, fflate)와 기존 라이브러리(js-synthesizer, FluidSynth, 피아노 사운드폰트)의 라이선스를 화면 한 곳(예: 업로드 화면 하단의 작은 링크)에 정리해서 표시한다.
6. **GitHub Pages에 배포 (별도 확인 후 진행)**: 코드가 완성되고 로컬에서 검증된 다음, 실제로 공개 GitHub 저장소를 만들고 GitHub Pages를 켜는 건 **이 스펙/계획의 구현 범위에는 포함하지 않는다** — 별도로 사용자에게 명시적으로 확인받고 진행하는 마지막 단계로 처리한다(공개 인터넷에 뭔가를 올리는 행위이기 때문).

## 3. 비목표 (이번 라운드에서 제외 — 알려진 한계)

- **반복 구간 안의 페달 정보는 완벽하지 않을 수 있음**: 페달 정보(`<direction><pedal>`)는 원본(반복이 안 펼쳐진) 악보 XML에서 직접 추출한다. Verovio가 만든 MIDI는 반복이 펼쳐져 있어서, 반복되는 마디 구간이 두 번 나오는데 페달 구간은 한 번만 계산돼 있으면, 그 반복의 두 번째 통과에는 페달 효과가 안 걸릴 수 있다. 이건 "반복 자체가 아예 무시되던" 지금 상태보다는 명백한 개선이고, 완벽한 페달 동기화는 추후 라운드로 미룬다.
- **진짜 MIDI 서스테인 페달(CC64) 신호 사용**: Verovio가 만든 MIDI에 CC64가 실제로 포함되는지는 조사 중 확인하지 못했다. 확인되면 보너스로 활용하고, 안 되면 기존처럼(v1과 동일) "음 길이 늘리기" 방식을 그대로 쓴다. 이 선택은 구현 초기 단계에서 실제로 확인하고 정한다.
- iOS Safari의 PWA 오프라인 캐시 정책(오래 안 쓰면 캐시가 지워질 수 있음)은 플랫폼 제약으로 받아들이고 별도 대응하지 않는다.

## 4. 아키텍처

```
[휴대폰/PC 브라우저 — 서버 없음]
 ┌──────────────────────────────────────────────┐
 │  index.html (+ manifest.json, service-worker.js) │
 │                                                 │
 │  업로드된 MusicXML/MXL                             │
 │      ↓                                          │
 │  score-parser.js                                │
 │   ├─ fflate로 .mxl 압축 풀기 (필요시)                │
 │   ├─ DOMParser로 원본 XML 파싱 → 시간표, 페달 위치 추출  │
 │   ├─ Verovio(WASM)에 넘겨서 MIDI로 렌더링 (반복 펼쳐짐)  │
 │   └─ midi-parser.js로 그 MIDI를 읽어서 음표/박 추출     │
 │      ↓                                          │
 │  scoreData (기존과 동일한 JSON 모양)                  │
 │      ↓                                          │
 │  scheduler.js / synth.js / metronome.js / app.js │
 │  (변경 없음 — 기존 재생 엔진 그대로)                     │
 └──────────────────────────────────────────────┘
```

## 5. 악보 분석 파이프라인 상세

### 5.1 파일 열기
- `.mxl` (압축된 MusicXML, ZIP 형식): `fflate`(작고 가벼운 압축 해제 라이브러리, MIT 라이선스, vendoring)로 압축을 풀어서 안의 `.xml` 파일(보통 `META-INF/container.xml`이 아닌 실제 악보 파일) 텍스트를 얻는다.
- `.musicxml`/`.xml`: 압축 없이 그냥 텍스트로 읽는다.

### 5.2 원본 XML에서 직접 뽑는 정보 (Verovio 없이, `DOMParser` 사용)
- 제목, 시간표(박자표), 마디 구조
- 페달 지시(`<direction><pedal type="start"/stop">`)의 위치 — 마디를 순회하면서 `<divisions>` 값을 기준으로 누적 위치(quarterLength)를 계산 (v1의 music21 로직과 같은 개념, XML을 직접 읽는 방식으로 재구현)

### 5.3 Verovio로 MIDI 렌더링
- Verovio(WASM, vendoring, ~7.3MB)에 원본 텍스트(또는 `.mxl`이면 `loadZipDataBase64`)를 넘기고 `renderToMIDI()` 호출 → base64 인코딩된 MIDI 파일을 얻는다. **반복이 기본적으로 펼쳐져 있음** (Verovio 문서 확인됨).

### 5.4 MIDI 직접 파싱
- 표준 MIDI 파일 포맷은 단순해서 별도 라이브러리 없이 직접 읽는다 (`frontend/midi-parser.js`, 순수 함수, Node에서도 테스트 가능).
- 헤더에서 `ticksPerQuarter`(PPQ)를 얻고, 그걸 기준으로 모든 이벤트의 tick 값을 quarterLength로 환산한다 (`quarterLength = ticks / ticksPerQuarter`) — 원곡 템포는 전혀 신경 쓸 필요 없다(사용자가 직접 BPM을 고르는 구조이므로).
- 노트온/노트오프 이벤트 → `notes[]` (pitch, startQL, durationQL, velocity)
- 박자표 메타 이벤트(0x58) → `beats[]` (곡 중간에 박자가 바뀌어도 대응)

### 5.5 최종 조립
- 5.2(페달)와 5.4(음표/박)를 합쳐서 기존과 동일한 JSON 스키마로 반환한다.

## 6. PWA 설정

- `manifest.json`: 앱 이름, 아이콘, `display: "standalone"` (브라우저 주소창 없이 앱처럼 보이게)
- `service-worker.js`: 캐시 우선(cache-first) 전략으로 모든 정적 파일(HTML/CSS/JS + vendor 라이브러리 + 피아노 음원)을 최초 방문 시 캐싱, 이후 오프라인에서도 동작
- `index.html`에 `<link rel="manifest">`와 서비스 워커 등록 스크립트 추가

## 7. 라이선스 표시

업로드 화면 하단에 작은 링크나 텍스트로: js-synthesizer(BSD-3-Clause), FluidSynth/fluidsynth-emscripten(LGPL-2.1), Verovio(LGPL-3.0), 피아노 사운드폰트(GPL v3.0, 원본: soundfonts4u), fflate(MIT) 명시.

## 8. 테스트

- `midi-parser.js`: 순수 함수라 Node에서 유닛 테스트 가능 — 실제로 Verovio가 만들어낸 진짜 MIDI 파일(반복 있는 악보로 생성)을 갖고 회귀 테스트를 만든다.
- 원본 XML에서 페달/시간표 뽑는 로직: 마찬가지로 Node에서 DOMParser 없이도 테스트 가능하도록(또는 가벼운 XML 파서로) 순수 함수로 분리해서 테스트.
- 전체 흐름(업로드 → 재생)의 실제 소리 확인은 이번에도 사용자의 실제 청취로 확인한다 (지금까지 이 프로젝트에서 계속 그래왔던 것과 동일).

## 9. 배포는 별도 단계

이 스펙과 뒤따르는 구현 계획은 **로컬에서 완성되고 검증된 코드**까지를 범위로 한다. 실제로 공개 GitHub 저장소를 만들고 GitHub Pages를 켜는 것은, 구현이 끝나고 로컬 테스트(가능하면 실제 브라우저 확인)까지 마친 다음, **별도로 사용자에게 명시적으로 확인**받고 진행한다.
