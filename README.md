# 📦 Network JSON Saver

Chrome에서 웹 개발할 때 개발자 도구(F12)의 Network 탭에서 JSON 응답을 일일이 저장하는 번거로움을 해결하는 Chrome Extension입니다.

## 🎯 핵심 기능

### 1. 자동 네트워크 캡처
- Chrome Debugger API를 사용해 모든 Fetch/XHR 요청의 JSON 응답을 자동 감지
- 백그라운드에서 실시간으로 네트워크 트래픽 모니터링

### 2. 스마트 필터링
- **Whitelist**: 원하는 키워드(예: 'wehago', 'api')가 포함된 URL만 캡처
- **Blacklist**: 특정 키워드(예: 'google', 'analytics')가 포함된 URL은 차단
- **Smart Filter**: 로그/알림/메뉴 같은 노이즈 자동 제거

### 3. 2가지 저장 모드
- **Auto Mode**: Blacklist를 제외한 모든 JSON을 즉시 자동 다운로드
- **Manual Mode**:
  - Whitelist 항목 → 자동 다운로드
  - 새로운 항목 (Whitelist도 Blacklist도 아닌 것) → 목록에 추가하여 수동 선택

### 4. 설정 관리
- Whitelist/Blacklist 태그 관리 (메모 추가 가능)
- 설정 JSON 파일로 Import/Export
- 파일명 접두사 설정 (예: `login_test_`)

---

## 📂 프로젝트 구조

```
network-json-saver/
├── extension/
│   ├── manifest.json      # Extension 메타데이터 (권한, 이름 등)
│   ├── background.js      # Service Worker (핵심 로직)
│   ├── popup.html         # UI 구조 (3개 탭: 메인/목록/설정)
│   ├── popup.js           # UI 로직 및 이벤트 처리
│   └── popup.css          # 스타일
├── CLAUDE.md              # 개발 가이드 (아키텍처, 데이터 흐름 설명)
├── PRD.md                 # 프로젝트 요구사항 문서
├── README.md              # 프로젝트 개요 (본 문서)
└── .gitignore
```

---

## 🔧 핵심 동작 흐름

```
1️⃣ 사용자가 녹화 버튼 ON
    ↓
2️⃣ background.js가 모든 탭에 Chrome Debugger attach
    ↓
3️⃣ Network 이벤트 모니터링 시작
    ├─ Network.responseReceived (응답 헤더 수신)
    │   ├─ MIME Type이 'json'인지 확인
    │   ├─ Smart Filter로 노이즈 제거
    │   ├─ Blacklist 체크 → 차단
    │   └─ 통과하면 Queue에 추가
    └─ Network.loadingFinished (응답 본문 완료)
        ├─ getResponseBody로 JSON 데이터 가져오기
        └─ processCapturedData() 실행
            ├─ Auto Mode → 즉시 다운로드 (Blacklist는 이미 제외됨)
            └─ Manual Mode
                ├─ Whitelisted → 즉시 다운로드
                └─ 새로운 항목 → capturedRequests 목록에 추가
                                  ↓
                           popup.js의 '목록' 탭에 실시간 업데이트
```

---

## 🛠️ 주요 기술 스택

- **Manifest V3** (Service Worker 기반)
- **Chrome Debugger API** (`chrome.debugger`)
- **Chrome Storage API** (`chrome.storage.local`)
- **Chrome Downloads API** (`chrome.downloads`)

---

## 📌 주요 파일 설명

### 1. background.js (extension/background.js:1-406)
네트워크 캡처 핵심 로직, 필터링, 다운로드, Storage 관리

**주요 함수:**
- `onDebuggerEvent()`: 네트워크 이벤트 처리 (line 196)
- `processCapturedData()`: 필터링 후 저장 여부 결정 (line 269)
- `downloadFile()`: JSON 파일 다운로드 (line 346)

### 2. popup.js (extension/popup.js:1-441)
3개 탭(메인/목록/설정) UI 관리, 사용자 입력 → Storage 저장, background.js와 메시지 통신

### 3. popup.html (extension/popup.html:1-93)
녹화 토글, 모드 선택, 필터 설정 UI, 캡처된 요청 목록 표시, Whitelist/Blacklist 태그 관리

---

## 🚀 로컬 테스트 방법

1. Chrome에서 `chrome://extensions/` 열기
2. "개발자 모드" 활성화
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. `extension/` 폴더 선택

### 디버깅
- **Background Script**: `chrome://extensions/` → "Service Worker" 클릭
- **Popup**: Popup 창에서 우클릭 → "검사"
- **Storage 확인**: DevTools → Application → Storage → Local Storage

---

## ⚠️ 알아두면 좋은 점

### 1. Storage Quota 제한
- `chrome.storage.local`은 약 10MB까지만 저장 가능
- 목록은 최대 20개로 제한 (background.js:316)
- 초과 시 자동으로 5개로 긴급 트리밍 (background.js:330)

### 2. Debugger API 제약
- 한 번에 하나의 클라이언트만 attach 가능
- 개발자 도구(F12)를 열면 Extension과 충돌 가능

### 3. 파일명 규칙
형식: `[prefix_]YYYYMMDD_HHMMSS_mmm_[urlSlug].json`

예시: `login_test_20231119_153045_123_api_user_l.json`

---

## 🔄 안정성 개선 (Auto Re-attach)

Extension은 다음 상황에서 자동으로 재연결을 시도합니다:

### 1. Debugger Detach 자동 복구
- 페이지 새로고침/리디렉션 시 Debugger가 detach되면 자동 재연결
- DevTools를 열 때는 충돌 방지를 위해 재연결하지 않음

### 2. Service Worker 재시작 대응
- Chrome 재시작 또는 Extension 재로드 시
- 녹화 상태였으면 자동으로 녹화 재개
- Service Worker가 sleep 후 깨어날 때도 상태 복원

### 3. Tab 활성화 시 상태 확인
- Tab 전환 시 attach 상태 확인
- 연결이 끊긴 경우 자동 재연결 시도

**권장 사용법:** 녹화를 켠 후 여러 탭을 생성하여 사용하면, 각 탭이 자동으로 모니터링됩니다.

---

## 📝 버전 히스토리

### v1.1 (2025-01-20) - Stability Improvements
- ✅ **Auto/Manual 모드 로직 수정**
  - Auto 모드: Blacklist 제외 모든 것 다운로드
  - Manual 모드: Whitelist 자동 다운로드, 새로운 항목 목록 추가

- ✅ **Auto Re-attach 구현**
  - Debugger detach 자동 복구 (페이지 새로고침/리디렉션 대응)
  - Service Worker 재시작 시 녹화 상태 자동 복원
  - Tab 활성화 시 attach 상태 확인 및 재연결

- ✅ **Race Condition 해결**
  - Queue 추가를 동기적으로 먼저 실행
  - Whitelist 항목을 여러 번 조회해도 안정적으로 다운로드

- ✅ **디버깅 로그 추가**
  - 각 단계별 상세 로그 출력
  - Service Worker 콘솔에서 문제 추적 가능

### v1.0 (2025-01-19) - Initial Release
- ✅ 기본 기능 완성 (녹화, 필터링, 저장)
- ✅ Whitelist/Blacklist 시스템
- ✅ 설정 Import/Export 기능

### 알려진 이슈
- ⚠️ 아이콘(icons/) 폴더는 비어있음

---

## 📖 더 자세한 정보

개발자를 위한 상세한 아키텍처 및 데이터 흐름 정보는 [CLAUDE.md](./CLAUDE.md)를 참조하세요.
