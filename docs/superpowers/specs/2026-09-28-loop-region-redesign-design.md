# 구간 반복 재설계 — 설계 문서

- 날짜: 2026-09-28
- 작성자: Seolhee Sun (Claude Code와 협업)
- 상태: 설계 승인됨, 구현 계획 작성 대기
- 브랜치: `pwa-client-only` (이미 실제 배포된 앱에 대한 추가 기능 라운드)

## 1. 배경

지금 구간 반복은 시작/끝 딱 한 쌍(`loopStartQL`/`loopEndQL`)과 별도의 🔁 켜기/끄기
토글로만 되어 있다. 사용자가 실제로 연습해보면서 두 가지 문제를 제보했다:

1. 연습 중인 어려운 구간이 여러 개일 때마다 "구간 시작 지정" → "구간 끝
   지정"을 매번 다시 눌러야 해서 불편하다 — 구간을 여러 개 등록해두고
   골라서 쓰고 싶다.
2. 반복이 켜진 상태에서 진행바를 눌러 위치를 옮기면, 다시 구간 안으로
   들어가도 반복이 자연스럽게 재개되지 않는 것처럼 느껴진다 — 탐색(seek)과
   반복의 상호작용이 일관되지 않다.

이 스펙은 이 둘을 한 번에 다시 설계한다.

## 2. 목표

1. **구간을 여러 개 저장**: `{startQL, endQL}` 쌍을 하나만 기억하는 대신,
   목록으로 여러 개 저장하고 다시 열어서 골라 쓸 수 있게 한다.
2. **파일별로 영속**: 앱을 껐다 켜거나 폰을 재부팅해도, 같은 파일을 다시
   열면 그 파일에 등록해둔 구간들이 그대로 남아있게 한다.
3. **탐색과 반복의 일관된 상호작용**: 진행바 클릭이나 ±10초 버튼으로 어디로
   이동하든 항상 자유롭게 이동되고, 반복 동작은 "재생이 실제로 구간 끝을
   지나가는 순간"에만 시작 지점으로 되돌아가는, 하나의 명확한 규칙으로
   정의한다.
3. **UI 단순화**: 별도의 🔁 켜기/끄기 토글을 없애고, 저장된 구간 목록에서
   구간을 탭하는 것 자체가 "이 구간을 반복할지 말지"를 결정하게 한다.

## 3. 비목표

- 구간에 이름을 붙이는 기능은 없다 — "구간 1", "구간 2"처럼 등록한 순서로
  자동 표시되고, 시간(`0:24–0:48`)으로 구분한다.
- 진행바 위에 저장된 모든 구간을 동시에 표시하지 않는다 — 지금처럼 **활성화된
  구간 하나만** 진행바에 강조 표시하고, 전체 목록은 그 아래 별도 리스트로
  보여준다. 여러 구간을 진행바 위에 다 표시하면 폰 화면에서 서로 겹쳐
  보이거나 정확히 탭하기 어려워질 수 있어서, 이번 라운드에서는 뺀다.
- 같은 파일 이름으로 내용이 다른 파일을 올렸을 때 구간이 뒤섞이는 경우는
  다루지 않는다 — "최근 파일 기억하기" 기능도 이미 같은 방식(파일 이름
  기준)으로 동작하고 있어서, 이 프로젝트 규모에서는 합리적인 단순화다.

## 4. 데이터 모델

### 4.1 구간 저장 (IndexedDB)

`file-memory.js`가 이미 쓰고 있는 같은 데이터베이스(`piano-tempo-trainer`)에
새 객체 저장소(object store) `loop-regions`를 추가한다. 키는 **업로드한
파일의 이름**(`file.name`), 값은 그 파일에 등록된 구간 배열이다:

```js
// key: "valse-op-34-no-1-moritz-moszkowski.mxl"
// value:
[
  { id: "r1", startQL: 8, endQL: 16 },
  { id: "r2", startQL: 40, endQL: 56 },
]
```

`id`는 그냥 목록 안에서 각 구간을 구분하기 위한 문자열(추가된 순서 +
타임스탬프 정도면 충분, 예: `String(Date.now())`)이며 화면에 노출되지 않는다.

`file-memory.js`에 다음 함수를 추가한다:

- `saveRegionsForFile(fileName, regions)` — 그 파일 이름의 구간 배열을
  통째로 덮어쓴다 (구간 추가/삭제 시마다 전체 배열을 다시 저장).
- `loadRegionsForFile(fileName)` — 등록된 배열을 돌려주거나, 없으면 빈
  배열 `[]`을 돌려준다.

### 4.2 런타임 상태 (app.js)

기존 `loopOn`, `loopStartQL`, `loopEndQL` 세 변수를 없애고 이렇게 바꾼다:

```js
let regions = [];          // 현재 열린 파일의 구간 목록, [{id, startQL, endQL}, ...]
let activeRegionId = null; // 지금 반복 중인 구간의 id, 없으면 null
```

`activeRegion()` 헬퍼로 `regions.find((r) => r.id === activeRegionId) || null`를
구한다.

## 5. 탐색(seek)과 반복의 일관성

핵심 규칙: **반복은 재생 위치가 "자연스럽게 흘러가다가" 구간의 끝을 실제로
지나가는 순간에만 시작 지점으로 되돌아간다. 방금 막 탐색(seek)해서 도착한
위치 자체는 "지나감"으로 치지 않는다.**

이렇게 하면:
- 진행바나 ±10초 버튼으로 **어디로 이동하든 항상 그대로 이동된다** (막지
  않음, 절대 즉시 튕겨 돌아오지 않음).
- 활성 구간의 끝보다 뒤로 이동해서 다음 부분을 미리 들어봐도, 그 자리에서
  계속 재생된다 — 억지로 되돌려지지 않는다.
- 활성 구간 안으로(또는 그보다 앞으로) 다시 이동한 뒤 재생하면, 거기서부터
  자연스럽게 흘러가다가 구간 끝에 도달하는 순간 다시 정상적으로 시작
  지점으로 반복된다.

### 5.1 구현 방식 — "경계를 넘는 순간"을 감지

지금 `schedulerTick`은 매 틱마다 `currentOffset >= loopEndQL`라는 **절대
비교**로 반복 여부를 판단한다. 이걸 **"방금 전 틱보다 낮았는데 지금 틱에서
넘어갔는가"를 보는 비교**로 바꾼다:

```js
let lastTickOffsetQL = null; // startPlayback()이 재생 시작 지점으로 리셋

function startPlayback(fromOffsetQL) {
  // ...기존 로직...
  lastTickOffsetQL = fromOffsetQL;
}

function schedulerTick() {
  // ...기존 음표/메트로놈 스케줄링...
  const currentOffset = clock.offsetAt(audioContext.currentTime);
  updateProgressUI(currentOffset);

  const region = activeRegion();
  if (region && lastTickOffsetQL < region.endQL && currentOffset >= region.endQL) {
    startPlayback(region.startQL); // 이 안에서 lastTickOffsetQL도 region.startQL로 리셋됨
    return;
  }
  lastTickOffsetQL = currentOffset;

  if (!region && currentOffset >= scoreData.totalQuarterLength) {
    pausedOffsetQL = 0;
    stopInternal();
  }
}
```

탐색(`seekTo`)이 호출되면 항상 `startPlayback(clamped)`(재생 중이었을 때)를
거치거나, 정지 상태면 다음 재생 시작 때 `startPlayback(pausedOffsetQL)`을
거치므로, 두 경우 모두 `lastTickOffsetQL`이 방금 도착한 위치로 다시
리셋된다 — 그래서 "막 도착한 위치"는 절대 "지나감"으로 오인되지 않는다.

### 5.2 음표/메트로놈 스케줄링 범위

지금은 `loopEndOrInfinity()`가 활성 구간이 있을 때 그 구간의 끝을
넘는 음표를 스케줄링 자체에서 걸러낸다. 이 부분은 5.1의 변경과 무관하게
그대로 유지한다 — 활성 구간 끝을 넘어간 위치로 탐색했을 때, 그 뒤쪽 음표들은
자연스럽게 스케줄링돼야 하므로, 이 함수는 **"활성 구간이 있어도, 지금
재생 위치가 이미 구간 끝을 넘었으면 더 이상 자르지 않는다"**로 살짝
바뀐다:

```js
function loopEndOrInfinity() {
  const region = activeRegion();
  if (!region) return Infinity;
  // 이미 구간 끝을 넘어간 위치에서 재생 중이면, 구간 경계로 음표를 자르지
  // 않는다 -- 안 그러면 "미리듣기"가 무음이 되어버린다.
  return lastTickOffsetQL != null && lastTickOffsetQL >= region.endQL ? Infinity : region.endQL;
}
```

## 6. UI

### 6.1 "구간 반복" 카드 재구성

```
┌ 구간 반복 ──────────────────────┐
│ ▬▬▬▬▬▬▬▬▓▓▓▓▓▓▬▬▬▬▬▬▬▬▬▬▬▬▬  │  ← 진행바, 활성 구간만 강조(▓)
│ 0:42 / 3:10                    │
│ [구간 시작 지정] [구간 끝 지정]  │
│ ─────────────────────────────  │
│ 구간 1  0:24–0:48          ×   │  ← 탭하면 활성화(강조), 다시 탭하면 해제
│ 구간 2  1:52–2:10  (활성)   ×   │
└─────────────────────────────────┘
```

- "구간 시작 지정" → "구간 끝 지정"을 누르면(기존과 동일하게 마디 경계에
  스냅) 새 구간이 목록 맨 아래에 추가되고 자동으로 활성화된다.
- 목록의 구간을 탭하면 활성화(다른 구간이 활성화되어 있었으면 그건
  비활성화됨) — 동시에 기존 `seekTo()`를 그대로 호출해서 그 구간의 시작
  지점으로 재생 위치가 이동한다. `seekTo()`는 이미 "재생 중이면 그
  지점에서 이어서 재생, 정지 중이면 위치만 갱신"을 처리하므로 별도 분기가
  필요 없다 — **재생 상태 자체는 건드리지 않는다** (정지해 있었으면 탭
  후에도 정지 상태 그대로, 사용자가 ▶를 따로 눌러야 함).
- 이미 활성화된 구간을 다시 탭하면 비활성화(반복 꺼짐, 재생 위치는
  그대로 유지).
- `×`를 누르면 그 구간이 목록과 저장소에서 삭제된다. 활성 구간을 지우면
  반복도 같이 꺼진다.
- 지금 있는 별도의 🔁 토글 스위치는 제거한다.

### 6.2 파일을 열 때

`handleFile()`에서 `loadRegionsForFile(file.name)`으로 그 파일의 구간
목록을 불러와서 `regions`에 채우고, `activeRegionId`는 항상 `null`로
시작한다(새로 파일을 열 때마다 반복이 자동으로 켜져있지 않게).

## 7. 테스트

- `lastTickOffsetQL`을 이용한 "경계를 넘는 순간" 판정은 `app.js`의
  DOM 오케스트레이션 코드 안에 있어서, 지금 프로젝트 관례상(다른
  DOM 종속 로직들처럼) 별도 유닛테스트 대상은 아니다. 다만 이 판정에
  쓰이는 순수한 수치 비교 규칙 자체(`prev < end && current >= end`)는
  단순해서, 원한다면 `scheduler.js`에 작은 순수 헬퍼 함수로 뽑아 테스트를
  붙일 수도 있다 — 구현 단계에서 이 판단을 내린다.
- `file-memory.js`의 `saveRegionsForFile`/`loadRegionsForFile`은 지금 있는
  다른 IndexedDB 함수들과 마찬가지로 브라우저 API 직접 래퍼라 유닛테스트
  대상이 아니다(기존 관례와 동일).
- 실제 반복 동작(탐색 후 재진입, 구간 끝 미리듣기 등)은 이 프로젝트가
  계속 해온 대로 사용자의 실제 청취/조작으로 확인한다.

## 8. 전역 제약

- `scheduler.js`(`TempoClock`, `computeMeasureStarts`, `snapLoopStart`,
  `snapLoopEnd`, `effectiveDurationQL`)는 수정하지 않는다 — `snapLoopStart`/
  `snapLoopEnd`는 새 구간을 만들 때 그대로 재사용한다.
- `synth.js`/`metronome.js`는 이 기능과 무관하므로 수정하지 않는다.
- 기존 `scoreData` 계약(반환 필드)은 바뀌지 않는다 — 이번 라운드는 재생
  엔진의 반복 상태와 그 저장 방식만 다룬다.
