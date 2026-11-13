# context.md - local-agents

2026-11-14 05:46

## 프로젝트
- 폴더: `local-agents` 하나만 남았다. 구 `cli-agents-dev` 폴더는 2026-11-04 삭제(.env.local의 `GITKRAKEN_PAT`만 `.env.legacy.local`로 백업)
- GitHub 저장소도 `lht1324/local-agents`로 이름 변경(히스토리·리다이렉트 유지). 두 로컬 저장소의 remote fetch/push 모두 새 주소
- 서비스명 `localagents`, 도메인 `localagents.link` (dev 터널 `dev.localagents.link`)
- 스택: **Vite 8 + React Router 8(library mode) + Hono on Cloudflare Workers**. TypeScript / Tailwind CSS 4
- 버전: 웹 `1.0.0` · 데몬 소스 `1.0.14` · npm 배포본 `1.0.6` (npm 일시 밴으로 배포 중단)
- **레포는 분리하지 않는다**(2026-10-30 결정). 한 레포 + `daemon/` 하위 publishable 패키지.
  - 분리 트리거: CLI 오픈소스 공개 / 릴리스 빈도 차이 / 웹 배포가 CLI 때문에 깨짐 / 외부 기여자 유입

## 사업 아이템
- **본체 = PC↔PC 세션 이어받기**. 웹 인박스는 보조(폰에서 보기·지시·승인).
- **현재 OpenCode만 지원**. 다른 에이전트 지원 전까지 사용자 노출 문구에 쓰지 않는다.
- 로컬 데몬 + 클라우드 제어서버(Workers + Neon) + 웹 UI. 데몬은 아웃바운드 폴링.
- Neon 역할 2개: 세션 거울 저장소 + 명령 outbox. PC↔PC 인계 파일은 **Cloudflare R2**(서명 URL 또는 워커 중계).

## 용어 (내부 표준)
- **session** = 하나의 대화(컨텍스트 사용량 구간). 사용자에게 보이는 단위.
- **tab** = OpenCode GUI의 최상위 작업 공간. 내부/DB(`cloud_messages.tab_id`)에만 남아 있고, 화면·법적 문서·랜딩 문구는 **session으로 통일**했다.
- OpenCode `/api/.../message`의 `tabId` 파라미터는 아직 옛 이름이다. ClientAPI 함수 안에서 session→tabId 변환만 한다.

## 개발 환경
- **단일 dev 서버 3004** (`npm run dev`). Vite가 워커까지 같은 포트에서 돌린다. API 컨테이너·게이트웨이는 없다.
- `strictPort: true` — 3004가 사용 중이면 다른 포트로 도망가지 않고 실패한다. 터널이 3004만 보므로 조용히 밀리면 웹훅이 유실된다.
- `allowedHosts: dev.localagents.link` — cloudflared 터널(dev.localagents.link → localhost:3004)로 들어오는 요청 허용.
- **dev/prod 구분은 실행 경로로 결정한다** (2026-11-14 변경). `daemon/src/device.ts:baseUrl()`
  - 저장소에서 직접 실행 (`node daemon/dist/index.js`) → `https://dev.localagents.link`
  - npm/npx 설치본 (`node_modules` 경로) → `https://localagents.link`
  - 서비스 설치본 (`~/.local/share/localagents/app`) → `https://localagents.link`
  - `LOCALAGENTS_BASE_URL` 로 덮어쓰기 가능 (자체 호스팅)
- **로그인 상태 파일은 환경별로 분리한다.** 한 파일을 쓰면 dev 로그인이 운영 로그인을 덮어쓴다.
  - 운영: `~/.config/localagents/device.json`
  - 개발: `~/.config/localagents/device.dev.localagents.link.json` (그 외 호스트는 호스트명이 붙는다)
  - 공유: `machine`(기기 지문) · `server.json`(OpenCode 서버 비번) · `spool/`(플러그인 이벤트 큐)
- **dev 워커 설정은 `wrangler.dev.jsonc`** (prod는 `wrangler.jsonc`). `remote: true` 라서 로컬 시뮬레이터가 아닌 실제 `local-agents-dev` 버킷에 붙는다. vite가 이 파일을 읽는다.
- 데몬 실행: shim `~/.local/bin/localagents` → `~/.local/share/localagents/app/dist/index.js` (서비스 설치본이 복사본을 갖는다).
- 데몬 SIGTERM이 즉시 종료되지 않는 문제가 있다. 재시작이 안 되면 `launchctl kickstart -k gui/$UID/link.localagents.daemon`.

## 라우팅·인증 구조
```
worker/index.ts
  ├ bindEnv + bodyLimit(2MB)          모든 요청 (중계 업로드 PUT은 예외)
  ├ /api/auth, /api/pairing, /api/webhook/dodo, /api/health, sitemap·robots   공개
  ├ / (pageGuard)                     로그인 필요한 페이지만 (run_worker_first)
  ├ /api/web/*   → requireSession     세션 쿠키
  └ /api/daemon/* → requireDevice     기기 토큰
```
- `wrangler.jsonc`의 `run_worker_first`에 보호 경로를 등록해야 워커가 먼저 받는다.
- OAuth 콜백은 `/api/auth/callback` 고정. `localagents_connect` 쿠키가 있으면 기기 연결 화면으로 복귀.
- 로그인 뒤 화면은 워커가 응답 직전에 `noindex`를 삽입한다 (프리렌더로 만들면 인증 없는 HTML이 정적 노출될 수 있음).
- 인계 파일 경로는 **`/api/daemon/handoffs` 하나로 묶여 있다**: `POST /url`(URL 발급) · `PUT /upload`(중계) · `GET /download`(중계). 마운트와 발급 URL이 어긋나 404가 났던 이력이 있으니 경로를 바꿀 때 두 곳을 함께 본다.

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
- 도메인 파일: `sessionsClientAPI`, `messagesClientAPI`, `devicesClientAPI`, `accountClientAPI`, `dodoClientAPI`, `commandsClientAPI`, `pairingClientAPI`.
- 함수명 규칙: **경로 기준**(`getX`, `getXById`). 의미형은 집계·RPC만(`authorizeDevice`, `createCheckout`).
- 화면에 `fetch` 직접 호출 금지. 응답 타입은 ClientAPI에서 import.

## 동기화
- **빠른 층(10초)**: heartbeat + spool 소비 + 명령 폴링.
- OpenCode 플러그인(`~/.config/opencode/plugins/localagents-sync.js`)이 이벤트를 `~/.config/localagents/spool/*.json`에 적재 → 데몬이 그 세션만 증분 동기화.
- **느린 층(플랜 주기: Pro 10분)**: 세션 헤더 전체, 모델 카탈로그, 안전망(`syncCurrentSessions`).
- **증분 기준점은 서버 워터마크 하나뿐이다** (2026-11-14 변경). 로컬 `cursors.json`은 제거했다.
  - 이유: 환경이 섞이면 로컬 커서가 기준점을 앞으로 당겨 **메시지가 조용히 누락**된다.
  - 업로드는 `onConflictDoNothing`(INSERT-only)이라 재업로드가 무해하다. 안전한 쪽(재업로드)으로 실패하게 둔다.
  - push 기준점도 서버 `handoffs.push_mark_*` 만 본다. 로컬 `push.json`은 제거했다.
- 워터마크 정렬은 `createdAt DESC, messageId DESC`. **`seq`는 쓰지 않는다** — 최근 200개 창의 배열 인덱스라 요청마다 달라진다. 화면 정렬도 `createdAt` 우선이므로 영향 없다.
- **본문 동기화 대상 = 각 탭의 최신 루트 세션 + 그 자식 세션 전체(재귀)**. 지난 루트 세션은 헤더만 유지(frozen).
- 하위 에이전트 세션: `sessions_meta.parent_id`로 판별. 목록에서는 숨기고 부모 상세의 **Subagents** 목록으로 드릴다운. 자식 화면은 읽기 전용(입력·승인 차단).

## DB (Neon)
- production `br-red-morning-azc2kkl8` / development `br-solitary-tree-azkgbwbu`, 프로젝트 `patient-water-01729139`.
- 마이그레이션 파일 23개 (`0000`~`0022`).
  - **dev: 23/23 적용** (0022 = `cloud_messages` 인덱스 포함)
  - **prod: 20/23** — 0020·0021은 SQL로 먼저 적용됐는데 drizzle 기록이 없다. 0022도 아직 없다.
- 2026-11-14에 dev의 기록 누락 2건(0020·0021)을 채워 `db:migrate`를 정상화했다. prod도 같은 드리프트라 배포 때 같은 절차가 필요하다.
- `drizzle.config.ts`는 `DATABASE_URL` 환경변수로 덮어쓸 수 있다 (운영 브랜치 마이그레이션용).
- 인덱스 `cloud_messages_tab_created_idx (tab_id, created_at, message_id)`
  - 워터마크 조회가 `Seq Scan + Sort`(0.31ms)에서 `Index Only Scan Backward`(0.06ms)로 바뀌었다. 데이터가 늘어도 비용이 고정된다.
- dev 구독 데이터는 2026-11-04 초기화(trial 30일로 재시작).
- `NEON_API_KEY`가 org 스코프다. 프로젝트 스코프 교체 권장.

## 인계 (push / pull)
- 파일 저장소는 **Cloudflare R2**. 버킷은 dev `local-agents-dev` / prod `local-agents`.
- 두 경로를 자동 선택한다 (데몬 코드는 동일).
  - `R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY` 있음 → **presigned URL**(데몬이 R2로 직행, 워커는 서명만)
  - 없음 → **워커 중계**(`HANDOFFS_BUCKET` 바인딩). 스트리밍이라 본문을 메모리에 올리지 않는다.
- 서명은 의존성 없이 직접 구현했다(`lib/r2sign.ts`, SigV4). boto3와 서명·URL이 바이트 단위로 일치하는 것까지 검증(`npm run test:r2sign`).
- **R2 API 토큰은 아직 없다.** wrangler OAuth는 R2 객체를 다룰 수 있지만 S3 자격증명(id + SHA-256 secret)이 없다. 발급은 대시보드에서 해야 한다(API로 만들면 `9109 Unauthorized`).
- 검증된 것: dev 경로로 202KB 왕복, PUT/GET 모두 바이트 일치. 현재는 중계 경로로 동작한다.
- 데몬은 발급 URL이 같은 출처일 때만 `Authorization`을 붙인다 (S3는 인증 방식이 두 개면 거부).

## 과금
- **Pro $9/월 · $90/연**(2개월 할인). 30일 no-card 트라이얼, 종료 시 hard cutoff. 데이터 보존·재구독 복원.
- Dodo(MoR). 모드 판정은 `DODO_PAYMENTS_ENVIRONMENT`만(`test_mode`/`live_mode`). 상품은 `products.list()` + metadata `{plan: pro, interval}` 매핑(1시간 캐시).
- 웹훅 `POST /api/webhook/dodo`: Standard Webhooks HMAC-SHA256(Web Crypto), 5분 리플레이 창. `subscription.*` upsert.
- **구독 활성화 시 `trial_ends_at`을 소진**한다. NULL은 "트라이얼 미시작"이라 30일이 다시 부여되므로 금지.
- 게이트 `lib/billing.ts`: `active` 통과 / 트라이얼 남음 통과 / 그 외 403 `trial_ended`.
- **취소 의미**: 예약 취소는 `active` + `cancel_at_period_end`로 기간 끝까지 유지. 대시보드 **즉시 취소**는 `canceled`가 되어 즉시 차단. 둘 다 정상 동작.
- **이미 구독 중이면 체크아웃 409** → 클라이언트가 `/profile`로 이동(중복 결제 방지).
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
- ⚠️ **알려진 버그**: 프리렌더가 `<head>` 메타만 바꾸고 body는 빈 `<div id="root">`를 복사한다. prod는 `/`·`/legal/*`를 `index, follow`로 표시하면서 본문이 비어 있다(h1 0개). 스모크 29개 중 5개가 이 때문에 실패한다.

## 데몬 배포·자동 실행
- `login` 성공 직후 백그라운드 서비스 자동 등록(linux systemd / darwin LaunchAgent). `login --no-service`로 건너뛸 수 있다.
- `logout`: 토큰 revoke + 서비스 중지. `uninstall`: 유닛·복사본·상태·PATH 블록·플러그인 제거.
- **macOS LaunchAgent 검증 완료** (2026-11-07). Windows는 v1 미지원.
- Node 하한 22.13.0(`node:sqlite`). 그 미만은 안내 후 종료.
- **npm 게시**: `1.0.0`(2026-11-07)부터 `1.0.6`까지 올라가 있다. 현재는 **일시 밴** 상태다.
  - 원인: 2FA가 꼬여 복구 코드를 사용했고, 그러면 자동으로 며칠간 publish가 막힌다.
  - 그래서 개발은 저장소 `node dist`, 실사용은 `localagents`(서비스 설치본)로 나눠 쓴다. 이 둘은 경로로 환경이 갈리므로 정확히 맞물린다.
  - 밴이 풀리면 `daemon`에서 `1.0.14`를 publish해야 한다.

## 배포·브랜치 (2026-11-14)
- `develop` = `origin/develop` = `3d1a0a7`, `master` = `origin/master` = `4683172`.
- `feature/r2-presigned-handoff`는 develop과 같은 커밋이 되어 삭제했다(로컬·원격).
- **prod 워커는 `b8d7676`** (2026-11-14 02:33 KST 배포). presign·중계 라우트가 아직 없다.
- prod 상태: `/api/health` 200. 단 `/`·`/legal/*`는 위 프리렌더 버그로 빈 본문.
- prod DB에도 데이터가 있다(2026-11-14 기준 `cloud_messages` 1,442행). 개발 브랜치와 별개.

## 다음 할 일

### 지금 막힌 곳 (순서대로)
- [ ] **dev에서 push/pull 테스트**
  - `node daemon/dist/index.js login --no-service` → `push` → `pull`
  - **`--no-service` 필수**: 없으면 새 빌드가 서비스로 복사되며 prod로 전환되고, `device.json`의 dev 토큰이 401이 된다
  - dev 테스트는 dev DB·`local-agents-dev` 버킷만 쓴다
- [ ] prod 워커 배포 (`npm run deploy`) — dev 테스트 통과 후
- [ ] prod DB 마이그레이션 — 0020·0021 기록 채우고 0022 적용
- [ ] 새 dist를 서비스로 설치(`node daemon/dist/index.js service install`) → `localagents login`
- [ ] R2 API 토큰 발급 → presign 활성 (없어도 중계로 동작)
- [ ] npm 밴 해제 후 `localagents@1.0.14` publish

### 출시 전 필수
- [ ] **live $9 실결제 1건** → DB `status=active`·`dodo_subscription_id` 확인 → 환불
- [ ] prod 로그인 상태에서 `/`·`/sessions`·`/profile` 렌더 확인 (배포 직후 1회)
- [ ] prod Dodo 웹훅 URL 확인 (`https://localagents.link/api/webhook/dodo`)
- [ ] Dodo 브랜드에 법률 3 URL 등록, `support@` 수신 확인
- [ ] 프리렌더가 body까지 생성하도록 수정 (SEO)
- [x] macOS LaunchAgent 검증 (2026-11-07)
- [x] `develop`·`master` 머지 및 prod 배포 (2026-11-04)

### 다음 릴리스 계획
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
- `3d1a0a7` [Refactor] [동기화 기준점을 서버 단일 진실로 통일]
- `57a065f` [Fix] [데몬 동기화 정합성과 안전성 수정]
- `95f578d` [Fix] [인계 파일 경로 404 해결 + 중계 경로 복구 + dev/prod R2 분리]
- `44bed89` [Feature] [인계 파일을 R2 presigned URL 로 직접 이동 — 워커는 서명만 한다]
- `b8d7676` [Fix] [업로드 엔드포인트 bodyLimit을 50MB로 상향]
- `d17b654` [Update] [R2 버킷 이름을 local-agents / local-agents-dev로 변경]
- `d26584e` [Fix] [R2 binding 타입 추가 및 requireEnv 미사용 제거]
- `e676320` [Feature] [Neon Storage에서 Cloudflare R2로 전환]
- `53c7edc` [Feature] [baseUrl 자동 구분: node_modules 있으면 prod, 없으면 dev]
- `9295706` [Fix] [push_mark_at 컬럼을 bigint로 변경 (타임스탬프 오버플로우)]

## 아키텍처 요약
- 로컬 데몬(CLI) + 클라우드 제어서버(Workers + Neon) + 웹 인박스. 데몬은 아웃바운드 폴링.
- CLI 표면: `login`·`logout`·`status`·`whoami`·`push`·`pull`·`uninstall` (+ `service install`, 숨김 진단 다수)
- 인계: 웹↔클라이언트 = Neon DB(거울+outbox), 클라이언트↔클라이언트 = R2(push마다 버전 1개 + DB 포인터)
- 토큰: `device_tokens`(해시·revoke·만료)
- OpenCode v1/v2 양방향 변환기 `daemon/src/convert.ts`
