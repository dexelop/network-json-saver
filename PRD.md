# Network JSON Saver - PRD (Product Requirements Document)

## 프로젝트 목표

웹 페이지에서 개발자 도구의 Network 탭에 Fetch/XHR로 받은 JSON 데이터를 수동으로 저장하는 번거로움을 해결하는 Chrome Extension 개발

## 핵심 요구사항

### 1. 자동 네트워크 캡처
- Chrome Debugger API를 사용한 실시간 네트워크 모니터링
- Fetch/XHR 요청의 JSON 응답 자동 감지
- 백그라운드에서 비침투적으로 작동

### 2. 저장 모드

#### Auto 모드
- Blacklist를 제외한 모든 JSON 응답을 즉시 자동 다운로드
- 대량의 API 응답을 빠르게 수집할 때 유용

#### Manual 모드
- Whitelist 항목: 즉시 자동 다운로드
- 새로운 항목 (Whitelist도 Blacklist도 아닌 것): 목록에 추가하여 사용자가 수동 선택
- 필요한 데이터만 선택적으로 저장할 때 유용

### 3. 필터링 시스템

#### Whitelist
- 특정 키워드가 포함된 URL만 캡처
- 메모 기능 제공 (각 키워드에 대한 설명 추가 가능)
- 예: 'wehago', 'api/user' 등

#### Blacklist
- 특정 키워드가 포함된 URL 차단
- 예: 'google', 'analytics', 'tracking' 등

#### Smart Filter
- 노이즈 자동 제거
- 기본 차단 키워드: 'notification', 'notice', 'log', 'menu', 'alarm', 'event', 'track', 'analytics'
- 선택적으로 활성화/비활성화 가능

### 4. 설정 관리
- Whitelist/Blacklist 태그 기반 관리
- 설정 JSON 파일로 Import/Export
- 파일명 접두사 설정 기능
- 설정 변경 시 즉시 적용

### 5. 파일명 규칙
- 형식: `[prefix_]YYYYMMDD_HHMMSS_mmm_[urlSlug].json`
- urlSlug: URL pathname의 처음 10자 (슬래시 제거, 밑줄로 변환)
- 예: `login_test_20251120_153045_123_api_user_l.json`

## 기술적 요구사항

### 안정성

#### Auto Re-attach (v1.1)
- **Debugger Detach 자동 복구**: 페이지 새로고침/리디렉션 시 자동 재연결
- **Service Worker 재시작 대응**: Chrome 재시작/Extension 재로드 시 녹화 상태 자동 복원
- **Tab 활성화 시 상태 확인**: Tab 전환 시 attach 상태 확인 및 재연결
- DevTools 충돌 방지: 사용자가 DevTools를 열 때는 재연결하지 않음

#### Race Condition 해결 (v1.1)
- **문제**: `Network.responseReceived` 이벤트 처리 중 비동기 필터 체크로 인해 `Network.loadingFinished`가 먼저 도착하는 경우 발생
- **해결**: Queue 추가를 동기적으로 먼저 실행하고, 필터 체크는 나중에 비동기로 처리
- **효과**: Whitelist 항목을 여러 번 조회할 때 안정적으로 다운로드

### Storage 관리
- `chrome.storage.local` 사용 (~10MB 제한)
- 캡처된 요청 목록: 최대 20개 제한
- Quota 초과 시 자동 트리밍 (5개로 축소)

### 권한
- `debugger`: 네트워크 모니터링
- `storage`: 설정 및 캡처 목록 저장
- `downloads`: JSON 파일 다운로드
- `<all_urls>`: 모든 사이트에서 작동

## UI/UX 요구사항

### 3-Tab 인터페이스

#### 메인 탭
- 녹화 ON/OFF 토글
- 저장 모드 선택 (Auto/Manual)
- Smart Filter 활성화 체크박스
- 파일명 접두사 입력

#### 목록 탭
- 캡처된 요청 목록 (최신 순)
- 각 항목별 저장/허용/차단 버튼
- 전체 저장 / 목록 비우기 버튼

#### 설정 탭
- Whitelist/Blacklist 태그 관리
- 설정 Import/Export 버튼

## 사용 시나리오

### 시나리오 1: 대량 API 수집
1. Auto 모드 선택
2. Blacklist에 불필요한 도메인 추가 ('google', 'facebook' 등)
3. 녹화 ON
4. 여러 탭을 열면서 작업
5. 자동으로 모든 JSON 다운로드

### 시나리오 2: 선택적 수집
1. Manual 모드 선택
2. Whitelist에 필요한 키워드 추가 ('wehago', 'api/data' 등)
3. 녹화 ON
4. Whitelist 항목은 자동 다운로드, 나머지는 목록에서 선택

## 개발 히스토리

### v1.0 (Initial Release)
- 기본 기능 구현 (녹화, 필터링, 저장)
- Whitelist/Blacklist 시스템
- 설정 Import/Export

### v1.1 (Stability Improvements)
- **Auto/Manual 모드 로직 수정**
  - Auto 모드: Blacklist 제외 모든 것 다운로드
  - Manual 모드: Whitelist 자동 다운로드, 새로운 항목 목록 추가

- **Auto Re-attach 구현**
  - Debugger detach 자동 복구
  - Service Worker 재시작 대응
  - Tab 활성화 시 상태 확인

- **Race Condition 해결**
  - Queue 추가를 동기적으로 먼저 실행
  - 필터 체크는 비동기로 나중에 처리
  - Whitelist 항목 안정적으로 다운로드

- **디버깅 로그 추가**
  - 상세한 로그로 문제 추적 가능
  - 각 단계별 로그 출력

## 알려진 제약사항

1. **Debugger API 제약**
   - Chrome DevTools와 동시 사용 불가 (한 번에 하나의 클라이언트만 attach 가능)
   - 사용자가 DevTools를 열면 Extension의 Debugger가 자동 detach됨

2. **Storage Quota**
   - `chrome.storage.local` 약 10MB 제한
   - 큰 JSON 응답이 많으면 제한 초과 가능

3. **Service Worker Lifecycle**
   - Chrome은 Service Worker를 5분 후 자동 sleep
   - Auto Re-attach 로직으로 대응

## 향후 개선 방향

1. **아이콘 추가**: `icons/` 폴더에 Extension 아이콘 추가
2. **필터 패턴 개선**: 정규표현식 지원
3. **다운로드 폴더 지정**: 사용자가 다운로드 폴더 지정 가능
4. **통계 기능**: 캡처된 요청 수, 총 다운로드 용량 등 표시
5. **Export 형식 다양화**: JSON 외에 CSV 등 지원