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
