# context.md - local-agents

2026-11-07 00:40

## 프로젝트
- 폴더: `local-agents` 하나만 남았다. 구 `cli-agents-dev` 폴더는 2026-11-04 삭제(.env.local의 `GITKRAKEN_PAT`만 `.env.legacy.local`로 백업)
- GitHub 저장소도 `lht1324/local-agents`로 이름 변경(히스토리·리다이렉트 유지). 두 로컬 저장소의 remote fetch/push 모두 새 주소
- 서비스명 `localagents`, 도메인 `localagents.link` (dev 터널 `dev.localagents.link`)
- 스택: **Vite 8 + React Router 8(library mode) + Hono on Cloudflare Workers**. TypeScript / Tailwind CSS 4
- 버전: 웹·데몬 모두 `1.0.0`
- **레포는 분리하지 않는다**(2026-10-30 결정). 한 레포 + `daemon/` 하위 publishable 패키지.
  - 분리 트리거: CLI 오픈소스 공개 / 릴리스 빈도 차이 / 웹 배포가 CLI 때문에 깨짐 / 외부 기여자 유입

## 사업 아이템
- **본체 = PC↔PC 세션 이어받기**. 웹 인박스는 보조(폰에서 보기·지시·승인).
- **현재 OpenCode만 지원**. 다른 에이전트 지원 전까지 사용자 노출 문구에 쓰지 않는다.
- 로컬 데몬 + 클라우드 제어서버(Workers + Neon) + 웹 UI. 데몬은 아웃바운드 폴링.
- Neon 역할 2개: 세션 거울 저장소 + 명령 outbox. PC↔PC 인계는 Neon Storage(서명 URL).

## 용어 (내부 표준)
- **session** = 하나의 대화(컨텍스트 사용량 구간). 사용자에게 보이는 단위.
- **tab** = OpenCode GUI의 최상위 작업 공간. 내부/DB(`cloud_messages.tab_id`)에만 남아 있고, 화면·법적 문서·랜딩 문구는 **session으로 통일**했다.
- OpenCode `/api/.../message`의 `tabId` 파라미터는 아직 옛 이름이다. ClientAPI 함수 안에서 session→tabId 변환만 한다.

## 개발 환경
- **단일 dev 서버 3004** (`npm run dev`). Vite가 워커까지 같은 포트에서 돌린다. API 컨테이너·게이트웨이는 없다.
- `strictPort: true` — 3004가 사용 중이면 다른 포트로 도망가지 않고 실패한다. 터널이 3004만 보므로 조용히 밀리면 웹훅이 유실된다.
- `allowedHosts: dev.localagents.link` — cloudflared 터널(dev.localagents.link → localhost:3004)로 들어오는 요청 허용.
- 데몬 baseUrl 기본값은 **`https://localagents.link`** (설치 직후 설정 없이 동작). 개발은 `LOCALAGENTS_BASE_URL`로 덮어쓴다.
  - 사장님 PC: 셸 `export LOCALAGENTS_BASE_URL=http://localhost:3004` + `~/.config/localagents/env`(서비스용).
- 데몬 실행: systemd user `localagents.service` → shim `~/.local/bin/localagents` → **`local-agents/daemon/dist/index.js`** (2026-11-03 교체 완료).
- 데몬 SIGTERM이 즉시 종료되지 않는 문제가 있다. 재시작이 안 되면 `systemctl --user kill -s KILL`.

## 라우팅·인증 구조
```
worker/index.ts
  ├ bindEnv + bodyLimit(2MB)          모든 요청
  ├ /api/auth, /api/pairing, /api/webhook/dodo, /api/health, sitemap·robots   공개
  ├ / (pageGuard)                     로그인 필요한 페이지만 (run_worker_first)
  ├ /api/web/*   → requireSession     세션 쿠키
  └ /api/daemon/* → requireDevice     기기 토큰
```
- `wrangler.jsonc`의 `run_worker_first`에 보호 경로를 등록해야 워커가 먼저 받는다.
- OAuth 콜백은 `/api/auth/callback` 고정. `localagents_connect` 쿠키가 있으면 기기 연결 화면으로 복귀.
- 로그인 뒤 화면은 워커가 응답 직전에 `noindex`를 삽입한다 (프리렌더로 만들면 인증 없는 HTML이 정적 노출될 수 있음).

## API 응답 규칙
- 모든 응답은 `{ success, status, message?, error?, data? }` (`lib/types/api/BaseResponse.ts`).
- 라우트는 **`getBaseResponse()`**(`worker/utils/getBaseResponse.ts`)만 쓴다. 상태 코드를 본문과 인자에 중복 지정하지 않는다.
- `notFound`·`onError`도 같은 봉투.

## 클라이언트 구조 (서버 상태를 화면이 모르게)
```
화면 → [~]ClientAPI (판정) → baseFetch (전송) → Hono 라우트
```
- `src/lib/api/client/baseFetch.ts`: `getFetch/postFetch/deleteFetch`. 전송만, 상태 판정 없음.
- `readBaseResponse`: 봉투 해석. **401 → /auth/sign-in**, **403 trial_ended → /billing/locked**. 실패 시 `null`.
- 도메인 파일: `sessionsClientAPI`(getSessions, getSessionById), `messagesClientAPI`(getMessagesBySessionId), `devicesClientAPI`, `accountClientAPI`, `dodoClientAPI`, `commandsClientAPI`, `pairingClientAPI`.
- 함수명 규칙: **경로 기준**(`getX`, `getXById`). 의미형은 집계·RPC만(`authorizeDevice`, `createCheckout`).
- 화면에 `fetch` 직접 호출 금지. 응답 타입은 ClientAPI에서 import.

## 동기화
- **빠른 층(10초)**: heartbeat + spool 소비 + 명령 폴링.
- OpenCode 플러그인(`~/.config/opencode/plugins/localagents-sync.js`)이 이벤트를 `~/.config/localagents/spool/*.json`에 적재 → 데몬이 그 세션만 증분 동기화.
- **느린 층(플랜 주기: Pro 10분)**: 세션 헤더 전체, 모델 카탈로그, 안전망(`syncCurrentSessions`).
- **본문 동기화 대상 = 각 탭의 최신 루트 세션 + 그 자식 세션 전체(재귀)**. 지난 루트 세션은 헤더만 유지(frozen).
- 증분 기준점은 **서버 워터마크**(`/api/daemon/messages/watermark`) 우선, 로컬 커서 보조.
- 하위 에이전트 세션: `sessions_meta.parent_id`로 판별. 목록에서는 숨기고 부모 상세의 **Subagents** 목록으로 드릴다운. 자식 화면은 읽기 전용(입력·승인 차단).
- `seq`는 최근 200개 창의 인덱스라 재사용된다. 정렬은 `createdAt` 우선이므로 화면은 정상.

## DB (Neon)
- production `br-red-morning-azc2kkl8` / development `br-solitary-tree-azkgbwbu`, 프로젝트 `patient-water-01729139`.
- **양쪽 모두 마이그레이션 20개 적용 완료** (2026-11-04). prod는 0016~0019가 없었고 이번에 적용.
- dev는 0018·0019를 SQL로 직접 적용했던 탓에 drizzle 기록이 2개 모자랐다. 기록을 채워 `db:migrate`가 정상 통과한다.
- dev 구독 데이터는 2026-11-04 초기화(trial 30일로 재시작).
- `NEON_API_KEY`가 org 스코프다. 프로젝트 스코프 교체 권장.

## 과금
- **Pro $9/월 · $90/연**(2개월 할인). 30일 no-card 트라이얼, 종료 시 hard cutoff. 데이터 보존·재구독 복원.
- Dodo(MoR). 모드 판정은 `DODO_PAYMENTS_ENVIRONMENT`만(`test_mode`/`live_mode`). 상품은 `products.list()` + metadata `{plan: pro, interval}` 매핑(1시간 캐시).
- 웹훅 `POST /api/webhook/dodo`: Standard Webhooks HMAC-SHA256(Web Crypto), 5분 리플레이 창. `subscription.*` upsert.
- **구독 활성화 시 `trial_ends_at`을 소진**한다. NULL은 "트라이얼 미시작"이라 30일이 다시 부여되므로 금지.
- 게이트 `lib/billing.ts`: `active` 통과 / 트라이얼 남음 통과 / 그 외 403 `trial_ended`.
- **취소 의미**: 예약 취소는 `active` + `cancel_at_period_end`로 기간 끝까지 유지. 대시보드 **즉시 취소**는 `canceled`가 되어 즉시 차단. 둘 다 정상 동작.
- **이미 구독 중이면 체크아웃 409** → 클라이언트가 `/profile`로 이동(중복 결제 방지).
- ⚠️ 과거 버그(수정됨): 웹훅이 `planId:"pro"`(없는 id)를 저장하고 기존 행 갱신 시 플랜을 안 써서, Pro 결제해도 Starter(30분)로 동기화됐다. `plan-2`/600초로 수정.
- Google OAuth 브랜딩: 커스텀 client는 정상이었고, **Google Cloud의 앱 브랜딩 인증·게시** 후 `LocalAgents`로 표시됐다.
- 테스트 모드 전 경로 실증 완료(2026-11-04). **live 실결제 1건 미실시.**

## 화면
- `/` 랜딩: 히어로(터미널 데모)·기능 2단·사용법 3단계·요금제·CTA·푸터. 문구는 session 기준.
- `/legal/terms`·`/legal/privacy`·`/legal/refunds`: 본문 그대로, 목차·앵커.
- `/sessions`: 카드형 목록, `live/frozen`, `synced N min ago`, 다른 PC 핸드오프 배너. 빈 상태는 npx/npm 온보딩.
- 세션 상세: 대화 + 도구 접이식 카드 + compaction + 승인 + 통계(컨텍스트 %·진행 바) + Agent/Model/Variant 선택 + Subagents + Move to another PC.
- `/devices`: 접속 상태 표시, Unlink 확인 모달.
- `/profile`: 계정 카드, 구독 카드(해지/재개), 가입일.
- `/billing/locked`: 체험 종료 안내 + 월/연 구독.
- `/auth/sign-in`: 소셜 로그인 카드.
- SEO: `scripts/prerender.mjs`가 랜딩·법적 3종만 정적 HTML 생성(제목·설명·canonical·robots). sitemap·robots는 워커 라우트.

## 데몬 배포·자동 실행
- `login` 성공 직후 백그라운드 서비스 자동 등록(linux systemd / darwin LaunchAgent).
- `logout`: 토큰 revoke + 서비스 중지. `uninstall`: 유닛·복사본·상태·PATH 블록 제거.
- **macOS LaunchAgent 검증 완료** (2026-11-07): npx 설치 → launchd 등록·실행, status/heartbeat 정상. Windows는 v1 미지원.
- Node 하한 22.13.0(`node:sqlite`). 그 미만은 안내 후 종료.
- **npm 게시 완료**: `localagents@1.0.0` (2026-11-07). registry `latest` 확인.
  - npm 계정 2FA가 꼬여 있다: 보안 키는 등록됐지만 "2FA 미활성" 배너가 뜨고 publish가 403으로 거부된다.
  - 우회: **Bypass 2FA Granular 토큰**으로 publish. 토큰은 사용 직후 폐기.
  - 2027-01부터 bypass 토큰의 직접 publish가 제거되고 staged publish + 2FA 승인으로 바뀐다. 그 전에 npm 2FA를 정상화해야 한다.

## 배포·브랜치 (2026-11-04)
- `feat/vite-hono` → `develop` fast-forward → `master`에 `--no-ff` 릴리즈 머지 완료. 현재 체크아웃 `develop`.
- **prod 배포 완료**: Workers `localagents` (Version `d4044203`). 구 Next 앱(10-26 배포본)을 대체했다.
- prod 확인: `/`·`/legal/*` 200, `/sessions` 302 → 로그인, `/api/health` 200, 웹훅 401, Google 로그인 init이 prod Auth(`ep-late-night`)로 연결.
- 배포 중 수정: 법적 페이지가 `/legal/terms` → `/legal/terms/`로 307 되던 문제. 프리렌더 산출물을 디렉터리 인덱스에서 **파일명(`legal/terms.html`)** 방식으로 바꿔 해결.
- prod DB에는 아직 세션 0건. 데몬이 dev(`localhost:3004`)를 보고 있어서 정상.

## 다음 할 일

### 출시 전 필수
- [ ] **live $9 실결제 1건** → DB `status=active`·`dodo_subscription_id` 확인 → 환불
- [ ] prod 로그인 상태에서 `/`·`/sessions`·`/profile` 렌더 확인 (배포 직후 1회)
- [ ] prod Dodo 웹훅 URL 확인 (`https://localagents.link/api/webhook/dodo`)
- [ ] Dodo 브랜드에 법률 3 URL 등록, `support@` 수신 확인
- [ ] **npm publish** (`daemon/`) → 클린 환경에서 `npx localagents@latest login`
- [ ] macOS LaunchAgent 1회 검증
- [x] `develop`·`master` 머지 및 prod 배포 (2026-11-04)

### 다음 릴리스 계획
- **1.0.4 (플러그인·안정성)**
  - [ ] `daemon/plugin/`을 npm 패키지에 포함 (`files`)
  - [ ] `login`/`service install` 시 `~/.config/opencode/plugins/`에 플러그인 복사 (없으면 생성, OpenCode 미설치면 건너뜀)
  - [ ] `uninstall` 시 우리 플러그인만 제거
  - [ ] 403 `trial_ended` 수신 시 1회 안내 + 폴링 백오프 (현재 10초마다 로그)
  - [ ] heartbeat 응답에 `minVersion` → 구버전 경고
- **1.1.0 (keepID 기준 접기)**
  - 전제: OpenCode compaction은 `summary` + `metadata.keepID`를 남긴다. 다음 요청 컨텍스트 = 요약 + keepID 이후 메시지.
  - [ ] `sessions_meta`에 `keep_message_id`, `keep_at` 추가
  - [ ] 데몬이 compaction 시 keepID 전송, 느린 동기화에서 최신 compaction 재확인(멱등)
  - [ ] 메시지 수신 시 경계 이전 행 거부 (재업로드 방지)
  - [ ] 조회는 경계 이후만 (화면 즉시 정확, 삭제는 지연)
  - [ ] 웹에서 경계 이전은 "압축됨 — 요약 보기" 블록
  - [ ] Cloudflare Cron Trigger로 경계 이전 행 배치 삭제
  - [ ] 기존 업로드분 처리 정책 결정 (그대로 둘지, 1회 정리할지)
  - 주의: 현재 `readEpochRows`는 compaction 메시지 위치에서 자르지만 실제 경계는 keepID(더 앞)이다.

### 출시 후
- [ ] Workers Builds 자동 배포 (master=production / develop=preview)
- [ ] `NEON_API_KEY` 프로젝트 스코프 교체
- [ ] API 파라미터 `tabId` → `sessionId` 개명 (DB 컬럼 `tab_id` 포함 여부 결정)
- [ ] 명령 브로드캐스트 v2 (세션 타겟 + 선착순 클레임)
- [ ] heartbeat에 OpenCode 실행 여부
- [ ] Windows 서비스 등록(작업 스케줄러)
- [ ] `cloud_tabs.title`이 세션 ID로 저장되는 문제
- [ ] 상세 응답의 모델 카탈로그 280KB 축소, 스레드 전체 재조회(500행) 완화
- [ ] 랜딩 실물 스크린샷·모바일 정합
- [ ] MoR: Fungies KYC 대기

## 커밋 이력 (최근)
- `27692d4` [Fix] [낡은 shim을 교체하지 않아 localagents 명령이 깨지던 문제]
- `32cb358` [Fix] [npx로 실행할 때 자기 파일을 찾지 못해 서비스를 설치하지 못하던 문제]
- `ff0784f` [Docs] [npm 배포용 README·메타데이터 정리와 --help/--version 추가]
- `1831fad` [Fix] [법적 페이지가 후행 슬래시로 리다이렉트되던 문제]
- `9c3609d` [Fix] [유료 구독 시 플랜이 Pro로 올라가지 않던 문제]
- `0a4a755` [Docs] [context.md를 새 스택 기준으로 갱신]
- `228a49a` [Refactor] [클라이언트 API 계층 도입과 화면의 직접 fetch 제거]
- `559344e` [Refactor] [API 응답 봉투를 공용 헬퍼로 통일]
- `3dc558d` [Merge] [프리렌더 리다이렉트 수정 배포 반영] (master)
- `c4acccf` [Merge] [Vite + React Router + Hono 스택 이전을 master에 릴리즈 병합]

## 아키텍처 요약
- 로컬 데몬(CLI) + 클라우드 제어서버(Workers + Neon) + 웹 인박스. 데몬은 아웃바운드 폴링.
- CLI 표면: `login`·`logout`·`status`·`whoami`·`push`·`pull`·`uninstall` (+ `service install`, 숨김 진단 다수)
- 인계: 웹↔클라이언트 = Neon DB(거울+outbox), 클라이언트↔클라이언트 = Neon Storage(push마다 버전 1개 + DB 포인터)
- 토큰: `device_tokens`(해시·revoke·만료)
- OpenCode v1/v2 양방향 변환기 `daemon/src/convert.ts`
