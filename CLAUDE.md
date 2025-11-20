# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**Network JSON Saver** - Chrome DevTools의 Network 탭에서 Fetch/XHR JSON 응답을 자동으로 수집하고 저장하는 Chrome Extension (Manifest V3)

### 핵심 기능
- Chrome Debugger API를 사용한 네트워크 요청 캡처
- Whitelist/Blacklist 기반 필터링
- 자동 저장 모드 (Auto) / 수동 검토 모드 (Manual)
- Smart Filter로 노이즈 제거 (notification, log, menu 등)
- 설정 Import/Export (JSON)

## 아키텍처

### 주요 컴포넌트

1. **background.js** (Service Worker)
   - Chrome Debugger API 제어 (`chrome.debugger.attach/detach`)
   - 네트워크 이벤트 모니터링 (`Network.responseReceived`, `Network.loadingFinished`)
   - 필터링 로직 (Whitelist/Blacklist/Smart Filter)
   - 자동 다운로드 처리 (`chrome.downloads.download`)
   - Storage 관리 (`chrome.storage.local`)

2. **popup.html/popup.js/popup.css** (UI)
   - 3-Tab 인터페이스: 메인(Main), 목록(List), 설정(Settings)
   - 녹화 토글 및 상태 표시
   - 캡처된 요청 목록 (실시간 업데이트)
   - Whitelist/Blacklist 태그 관리
   - 설정 Import/Export UI

3. **manifest.json**
   - 권한: `debugger`, `storage`, `downloads`, `<all_urls>`
   - Manifest Version 3 (Service Worker 기반)

## 데이터 흐름

```
Tab Navigation
  ↓
[Debugger Attach] (background.js:160)
  ↓
Network.responseReceived → Filtering → Queue (background.js:193-234)
  ↓
Network.loadingFinished → Get Response Body (background.js:236-263)
  ↓
processCapturedData (background.js:269)
  ├─ Auto Mode → downloadFile() (Blacklist는 이미 필터링됨)
  └─ Manual Mode
       ├─ Whitelisted → downloadFile()
       └─ New item → Add to capturedRequests[]
            ↓
       chrome.runtime.sendMessage('updateList') → popup.js
            ↓
       renderCapturedList() (popup.js:219)
```

## 필터링 로직 (background.js:270-314)

**중요: Race Condition 해결 (v1.1)**

이전 버전에서는 `Network.responseReceived` 이벤트 처리 중 비동기 필터 체크(`await chrome.storage.local.get()`)로 인해 `Network.loadingFinished` 이벤트가 먼저 도착하는 Race Condition이 발생했습니다.

**해결 방법:**
```javascript
// 1. Queue에 즉시 추가 (동기)
pendingRequests.set(requestId, { url, timestamp });

// 2. 비동기 필터 체크
const settings = await chrome.storage.local.get(...);

// 3. 필터에 걸리면 Queue에서 제거
if (filtered) {
  pendingRequests.delete(requestId);
}
```

**실행 순서:**
1. MIME Type 체크 (`response.mimeType.includes('json')`)
2. HTTP Status 체크 (3xx 리다이렉트, 204/205 제외)
3. **Queue에 즉시 추가** (Race Condition 방지)
4. Smart Filter (선택적, 기본값: true) - 노이즈 제거
5. Blacklist 체크 (차단 패턴) - 통과 못하면 Queue에서 제거

**다운로드 시점 로직 (background.js:350-434):**
- **Auto 모드**: Blacklist 아닌 모든 것 즉시 다운로드
- **Manual 모드**:
  - Whitelist 매칭 → 즉시 다운로드
  - 새로운 항목 → 목록에 추가하여 사용자 선택 대기

## 주요 설정 (chrome.storage.local)

```javascript
{
  isRecording: false,        // 녹화 활성화 여부
  mode: 'auto',              // 'auto' | 'manual'
  smartFilter: true,         // 노이즈 필터 활성화
  whitelist: [],             // [{ keyword: string, memo: string }]
  blacklist: [],             // [string]
  filenamePrefix: '',        // 파일명 접두사
  capturedRequests: []       // 캡처된 요청 목록 (최대 20개)
}
```

## 파일명 생성 규칙 (background.js:343-373)

형식: `[prefix_]YYYYMMDD_HHMMSS_mmm_[urlSlug].json`

- `urlSlug`: URL pathname의 처음 10자 (슬래시 제거, 밑줄로 변환)
- 예: `login_test_20231119_153045_123_api_user_l.json`

## Chrome Extension 개발 가이드

### 로컬 테스트 방법
1. Chrome에서 `chrome://extensions/` 열기
2. "개발자 모드" 활성화
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. `extension/` 폴더 선택

### 디버깅
- **Background Script**: `chrome://extensions/` → "Service Worker" 클릭
- **Popup**: Popup 창에서 우클릭 → "검사"
- **Storage 확인**: DevTools → Application → Storage → Local Storage

### 주의사항
- Debugger API는 **한 번에 하나의 클라이언트**만 attach 가능 (DevTools와 충돌 가능)
- Service Worker는 비활성 시 자동 종료됨 (State 유지는 chrome.storage 사용)
- `chrome.storage.local` Quota: ~10MB (초과 시 자동 트리밍 로직 있음, background.js:324-335)

## 파일 구조

```
extension/
├── manifest.json          # Extension 메타데이터 및 권한
├── background.js          # Service Worker (네트워크 캡처 로직)
├── popup.html             # UI 구조
├── popup.js               # UI 로직 및 이벤트 핸들러
├── popup.css              # 스타일
└── icons/                 # (비어있음, 아이콘 추가 필요)
```

## 알려진 제약사항

1. **Storage Quota 초과 가능**
   - `capturedRequests`가 큰 JSON을 저장할 때 10MB 초과 가능
   - 현재: 최대 20개 항목으로 제한 (background.js:313)
   - 초과 시 5개로 긴급 트리밍 (background.js:327)

2. **Whitelist/Blacklist 동작**
   - **Auto 모드**: Blacklist 제외 모든 것 자동 다운로드
   - **Manual 모드**: Whitelist → 자동 다운로드, 새로운 항목 → 목록 추가
   - Blacklist: 캡처 자체를 차단 (onDebuggerEvent에서 필터링)
   - 목록(List) 탭의 "허용"/"차단" 버튼은 URL pathname 기준으로 작동

3. **Tab 관리 및 자동 재연결 (Auto Re-attach)**
   - Recording ON 시 모든 탭에 Debugger attach 시도
   - **Debugger Detach 자동 복구** (background.js:209-245)
     - 페이지 새로고침/리디렉션 시 자동 재연결
     - DevTools를 열 때는 충돌 방지를 위해 재연결 안 함
   - **Service Worker 재시작 대응** (background.js:32-49)
     - Chrome 재시작/Extension 재로드 시 녹화 상태 복원
     - Service Worker sleep 후 깨어날 때도 자동 복원
   - **Tab 활성화 시 상태 확인** (background.js:150-171)
     - Tab 전환 시 attach 상태 확인 및 재연결
   - `attachedTabs` Set으로 중복 attach 방지

## 개발 시 주의사항

- **Race Condition (Network Events)**:
  - **문제**: `Network.responseReceived`와 `Network.loadingFinished` 이벤트 간 타이밍 이슈
  - **해결**: Queue 추가를 동기적으로 먼저 실행 (background.js:282-288)
  - **효과**: Whitelist 항목 안정적으로 다운로드

- **Race Condition (Storage)**:
  - popup.js와 background.js가 동시에 storage를 수정하면 데이터 손실 가능
  - 가능한 한 background.js에서 storage 업데이트 처리

- **Error Handling**:
  - `chrome.debugger.sendCommand()` 실패 시 "No resource with given identifier found" 에러는 정상 (리다이렉트/캐시된 응답)
  - background.js:338-339에서 처리

- **Popup 상태 동기화**:
  - popup.js는 `loadSettings()`로 초기화하고, background.js의 `updateList` 메시지로 실시간 업데이트

- **Auto Re-attach 로직**:
  - `onDebuggerDetach`에서 500ms 딜레이 후 재연결 시도 (안정성)
  - DevTools 충돌 방지를 위해 `canceled_by_user` reason은 재연결 안 함
  - Service Worker가 깨어날 때 `attachedTabs.size === 0` 체크로 중복 초기화 방지

- **디버깅 로그**:
  - 각 단계별 상세 로그 출력 (v1.1에서 추가)
  - Service Worker 콘솔에서 확인 가능
  - 프로덕션 배포 시 로그 제거 고려

## 기능 확장 시 참고

- **새로운 필터 추가**: background.js의 `onDebuggerEvent` 함수 수정 (line 247)
- **파일명 형식 변경**: `downloadFile` 함수 수정 (line 390)
- **UI 탭 추가**: popup.html에 tab-btn 추가 + popup.js의 tab 이벤트 리스너 자동 처리됨
- **Storage 스키마 변경**: background.js:7-30의 `onInstalled` 리스너에서 기본값 업데이트 필수
- **Auto Re-attach 로직 수정**: background.js:209-245의 `onDebuggerDetach` 함수 참고
