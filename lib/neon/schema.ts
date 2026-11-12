import { bigint, boolean, integer, pgTable, primaryKey, real, text, timestamp } from "drizzle-orm/pg-core";

// 상주 데몬 1대 = 1행. 페어링 코드로 웹 계정과 연결한다.
export const devices = pgTable("devices", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    platform: text("platform"),
    hostname: text("hostname"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // 연결 해제 시각. 행을 지우지 않는 이유: 7개 테이블이 devices.id를 참조하고,
    // 과거 세션의 출처("Arch에서 온 세션")와 명령 라우팅 정보를 보존해야 하기 때문.
    // 해제 = 토큰 revoke + 이 값 기록 + 목록에서 숨김. 다시 로그인하면 null로 되돌린다.
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
});

// 세션 메타만 저장한다. transcript 전문은 저장하지 않는다.
export const sessionsMeta = pgTable("sessions_meta", {
    id: text("id").primaryKey(),
    // 소유는 계정. 기기가 아니라 유저에 귀속된다 (공유 서비스의 전제).
    userId: text("user_id").notNull(),
    // 마지막으로 이 세션을 보고한 기기 = 현재 호스트. 명령 기본 대상·presence 판정에만 쓴다.
    deviceId: text("device_id")
        .notNull()
        .references(() => devices.id),
    provider: text("provider").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    agent: text("agent"),
    model: text("model"),
    cost: real("cost"),
    lastInput: integer("last_input"),
    lastOutput: integer("last_output"),
    lastReasoning: integer("last_reasoning"),
    lastCacheRead: integer("last_cache_read"),
    lastCacheWrite: integer("last_cache_write"),
    msgUser: integer("msg_user"),
    msgAssistant: integer("msg_assistant"),
    sessionCreatedAt: timestamp("session_created_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    // 본문(메시지)이 마지막으로 미러링된 시각. 헤더 sync와 구분해 "지금 돌고 있는 세션"을 판정한다.
    lastBodySyncAt: timestamp("last_body_sync_at", { withTimezone: true }),
    // 부모 세션. 값이 있으면 에이전트가 만든 자식(서브에이전트) 세션이다.
    parentId: text("parent_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 웹 → PC 명령 우체통. 데몬이 폴링해서 가져간다.
// status 흐름: pending → delivered → done, 기한 지나면 expired.
export const commands = pgTable("commands", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id")
        .notNull()
        .references(() => devices.id),
    // 대상 세션. payload JSON 안에 숨기지 않고 컬럼으로 둬서 "이 세션의 명령 이력" 조회가 가능하게 한다.
    tabId: text("tab_id"),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 탭 거울 헤더. UPDATE 전용. 로컬 탭 1개 = 1행.
export const cloudTabs = pgTable("cloud_tabs", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id")
        .notNull()
        .references(() => devices.id),
    provider: text("provider").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    epoch: integer("epoch").notNull().default(0),
    cost: real("cost").notNull().default(0),
    tokensInput: integer("tokens_input").notNull().default(0),
    tokensOutput: integer("tokens_output").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 대화 로그. INSERT-only. 텍스트 항상, tool은 메타만, 무거운 payload 제외.
export const cloudMessages = pgTable(
    "cloud_messages",
    {
        tabId: text("tab_id")
            .notNull()
            .references(() => cloudTabs.id, { onDelete: "cascade" }),
        messageId: text("message_id").notNull(),
        seq: integer("seq").notNull(),
        role: text("role").notNull(),
        kind: text("kind").notNull(),
        body: text("body").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.tabId, t.messageId] })],
);

// 세션이 지금 어느 기기에 있는지. push/pull로 같은 세션이 여러 PC에 존재할 수 있어 N:M이다.
// sync마다 그 기기가 가진 세션을 upsert하고, 며칠 지난 행은 정리한다.
// 상세 화면의 "명령 대상 선택"과 활성 판정에 쓴다.
export const sessionLocations = pgTable(
    "session_locations",
    {
        tabId: text("tab_id").notNull(),
        deviceId: text("device_id")
            .notNull()
            .references(() => devices.id),
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.tabId, t.deviceId] })],
);

// 대기 승인 거울. 로컬에만 있는 pending을 웹에 보여주기 위해 데몬이 올린다.
// status 흐름: open → resolved. 해결된 건 데몬이 표시한다.
export const pendingApprovals = pgTable("pending_approvals", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id")
        .notNull()
        .references(() => devices.id),
    sessionId: text("session_id").notNull(),
    action: text("action").notNull(),
    resources: text("resources").notNull(),
    message: text("message"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// 모델·에이전트 카탈로그 거울. 서버 조회 결과를 웹 드롭다운용으로 보관.
export const modelCatalog = pgTable("model_catalog", {
    deviceId: text("device_id")
        .primaryKey()
        .references(() => devices.id),
    payload: text("payload").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 구독(플랜 배정). plan_id가 진실, 해석된 값은 함께 저장한다.
// 과금 상태: status는 Dodo 웹훅이 갱신, trial_ends_at은 첫 API 활동 시 초기화 (30일 no-card 트라이얼).
export const subscriptions = pgTable("subscriptions", {
    userId: text("user_id").primaryKey(),
    planId: text("plan_id").notNull().default("plan-1"),
    syncIntervalSec: integer("sync_interval_sec").notNull().default(1800),
    // Dodo 웹훅이 채우는 필드. null = 아직 결제 이력 없음.
    dodoSubscriptionId: text("dodo_subscription_id"),
    status: text("status"), // active | canceled | expired
    interval: text("interval"), // monthly | annual
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    // 취소 예정 (기간 끝까지 유효). subscription.updated 웹훅이 cancel_at_next_billing_date를 거울로 기록.
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 디바이스 토큰. 데몬→클라우드 인증. 해시만 저장, revoke 가능.
export const deviceTokens = pgTable("device_tokens", {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
        .notNull()
        .references(() => devices.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 인계 포인터. Storage 버전 파일 1행 = 1버전. PC 2는 이 행만 보고 받는다.
export const handoffs = pgTable("handoffs", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id")
        .notNull()
        .references(() => devices.id),
    tabId: text("tab_id").notNull(),
    title: text("title"),
    remote: text("remote"),
    branch: text("branch"),
    epoch: integer("epoch").notNull().default(0),
    version: text("version").notNull(),
    storageKey: text("storage_key").notNull(),
    baseHash: text("base_hash").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    userMsgs: integer("user_msgs").notNull().default(0),
    aiMsgs: integer("ai_msgs").notNull().default(0),
    sha256: text("sha256").notNull(),
    pushMarkAt: bigint("push_mark_at", { mode: "number" }),
    pushMarkId: text("push_mark_id"),
    pushMarkSeq: integer("push_mark_seq"),
    receivedBy: text("received_by"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 이전 epoch 접기. 압축 발동 시 이전 구간 요약 1줄만 보관한다.
export const cloudFolds = pgTable(
    "cloud_folds",
    {
        tabId: text("tab_id")
            .notNull()
            .references(() => cloudTabs.id, { onDelete: "cascade" }),
        epoch: integer("epoch").notNull(),
        summary: text("summary").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.tabId, t.epoch] })],
);
