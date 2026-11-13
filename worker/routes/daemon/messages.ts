import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { checkBillingGate } from "../../../lib/billing";
import { getDb } from "../../../lib/neon/client";
import { cloudMessages, cloudTabs, sessionLocations, sessionsMeta } from "../../../lib/neon/schema";
import type { AppEnv } from "../../../lib/env";
import type { DeviceVariables } from "../../middleware/device";
import { getBaseResponse } from "../../utils/getBaseResponse";

interface MessageRow {
    sessionID?: unknown;
    messageId?: unknown;
    id?: unknown;
    seq?: unknown;
    role?: unknown;
    kind?: unknown;
    body?: unknown;
    createdAt?: unknown;
}

const daemonMessages = new Hono<{ Bindings: AppEnv; Variables: DeviceVariables }>();

// 증분 동기화 기준점. 서버에 저장된 마지막 행을 돌려준다.
// 데몬은 로컬에 기준점을 저장하지 않고 매번 이 값만 본다.
// 정렬은 데몬의 비교 규칙과 같아야 한다: createdAt 오름차순, 같으면 messageId 사전순.
// seq 는 데몬이 "몇 번째로 가져왔나"를 담은 배열 인덱스라 요청마다 달라진다. 정렬에 쓰면 안 된다.
daemonMessages.get("/watermark", async (c) => {
    const userId = c.get("userId");
    const sessionID = c.req.query("sessionID");
    if (!sessionID) {
        return getBaseResponse({ success: false, status: 400, error: "sessionID is required" });
    }
    const rows = await getDb()
        .select({
            messageId: cloudMessages.messageId,
            createdAt: cloudMessages.createdAt,
        })
        .from(cloudMessages)
        .innerJoin(cloudTabs, eq(cloudMessages.tabId, cloudTabs.id))
        .where(and(eq(cloudMessages.tabId, sessionID), eq(cloudTabs.userId, userId)))
        .orderBy(desc(cloudMessages.createdAt), desc(cloudMessages.messageId))
        .limit(1);
    const row = rows[0];
    return getBaseResponse({
        success: true,
        status: 200,
        data: row ? { messageId: row.messageId, createdAt: row.createdAt.getTime() } : null,
    });
});

// 데몬 대화 행 수신. INSERT-only. 탭 거울 행 없으면 함께 만든다.
daemonMessages.post("/", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const gate = await checkBillingGate(userId);
    if (!gate.allowed) {
        return getBaseResponse({ success: false, status: 403, error: "trial_ended" });
    }
    let body: { messages?: unknown };
    try {
        body = (await c.req.json()) as { messages?: unknown };
    } catch {
        return getBaseResponse({ success: false, status: 400, error: "invalid JSON body" });
    }
    const rows = Array.isArray(body.messages) ? (body.messages as MessageRow[]) : [];
    const db = getDb();
    const tabs = new Set<string>();
    let inserted = 0;

    for (const m of rows) {
        const messageId =
            typeof m.messageId === "string" && m.messageId.length > 0
                ? m.messageId
                : typeof m.id === "string" && m.id.length > 0
                  ? m.id
                  : null;
        if (typeof m.sessionID !== "string" || typeof m.seq !== "number" || !messageId) {
            continue;
        }
        if (!tabs.has(m.sessionID)) {
            tabs.add(m.sessionID);
            await db
                .insert(cloudTabs)
                .values({
                    id: m.sessionID,
                    userId,
                    deviceId,
                    provider: "opencode",
                    title: m.sessionID,
                    status: "active",
                })
                .onConflictDoNothing();
            await db
                .update(sessionsMeta)
                .set({ lastSyncAt: new Date(), lastBodySyncAt: new Date() })
                .where(eq(sessionsMeta.id, m.sessionID));
            await db
                .insert(sessionLocations)
                .values({ tabId: m.sessionID, deviceId, lastSeenAt: new Date() })
                .onConflictDoUpdate({
                    target: [sessionLocations.tabId, sessionLocations.deviceId],
                    set: { lastSeenAt: new Date() },
                });
        }
        const createdAt =
            typeof m.createdAt === "number"
                ? new Date(m.createdAt)
                : typeof m.createdAt === "string"
                  ? new Date(m.createdAt)
                  : null;
        await db
            .insert(cloudMessages)
            .values({
                tabId: m.sessionID,
                messageId,
                seq: m.seq,
                role: typeof m.role === "string" ? m.role : "?",
                kind: typeof m.kind === "string" ? m.kind : "text",
                body: typeof m.body === "string" ? m.body : "",
                ...(createdAt && !isNaN(createdAt.getTime()) ? { createdAt } : {}),
            })
            .onConflictDoNothing();
        inserted++;
    }
    return getBaseResponse({ success: true, status: 200, data: { rows: inserted } });
});

export default daemonMessages;
