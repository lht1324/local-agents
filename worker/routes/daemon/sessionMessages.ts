import { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { checkBillingGate } from "../../../lib/billing";
import { getDb } from "../../../lib/neon/client";
import { deviceCursors, sessionMessages, sessionParts, sessionState } from "../../../lib/neon/schema";
import type { AppEnv } from "../../../lib/env";
import type { DeviceVariables } from "../../middleware/device";
import { notifyInBackground } from "../../notify";
import { getBaseResponse } from "../../utils/getBaseResponse";

// raw 동기화 — 로컬 SQLite(session_message / part)를 그대로 올리고 내린다.
// 파일(R2)이 아니라 DB가 원본이므로, 데몬은 커서 이후 행만 주고받는다.

interface RawMessage {
    id?: unknown;
    type?: unknown;
    timeCreated?: unknown;
    timeUpdated?: unknown;
    data?: unknown;
}

interface RawPart {
    id?: unknown;
    messageId?: unknown;
    timeCreated?: unknown;
    timeUpdated?: unknown;
    data?: unknown;
}

interface RawState {
    title?: unknown;
    directory?: unknown;
    agent?: unknown;
    model?: unknown;
    revert?: unknown;
    parentId?: unknown;
    provider?: unknown;
    updatedAt?: unknown;
}

const daemonLog = new Hono<{ Bindings: AppEnv; Variables: DeviceVariables }>();

function str(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// onConflictDoUpdate의 set에서 "들어온 값"을 가리킨다.
function excluded(column: string) {
    return sql.raw(`excluded."${column}"`);
}

// 이 기기가 마지막으로 올린 위치. 첫 업로드면 null → 데몬이 전체를 보낸다.
daemonLog.get("/watermark", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
        return getBaseResponse({ success: false, status: 400, error: "sessionId is required" });
    }
    const rows = await getDb()
        .select({ timeCreated: sessionMessages.timeCreated, id: sessionMessages.id })
        .from(sessionMessages)
        .where(
            and(
                eq(sessionMessages.userId, userId),
                eq(sessionMessages.sessionId, sessionId),
                eq(sessionMessages.deviceId, deviceId),
            ),
        )
        .orderBy(desc(sessionMessages.timeCreated), desc(sessionMessages.id))
        .limit(1);
    const last = rows[0];
    return getBaseResponse({
        success: true,
        status: 200,
        data: last ? { timeCreated: last.timeCreated, id: last.id } : null,
    });
});

// raw 행 업로드. 데몬이 2MB 이하로 나눠 보낸다 (Worker 본문 제한).
daemonLog.post("/", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const gate = await checkBillingGate(userId);
    if (!gate.allowed) {
        return getBaseResponse({ success: false, status: 403, error: "trial_ended" });
    }
    let body: { sessionId?: unknown; messages?: unknown; parts?: unknown; state?: unknown };
    try {
        body = (await c.req.json()) as typeof body;
    } catch {
        return getBaseResponse({ success: false, status: 400, error: "invalid JSON body" });
    }
    const sessionId = str(body.sessionId);
    if (!sessionId) {
        return getBaseResponse({ success: false, status: 400, error: "sessionId is required" });
    }
    const db = getDb();
    const messages = (Array.isArray(body.messages) ? body.messages : []) as RawMessage[];
    const parts = (Array.isArray(body.parts) ? body.parts : []) as RawPart[];
    let lastId: string | null = null;
    let lastAt = 0;

    if (messages.length > 0) {
        const rows = messages
            .map((m) => {
                const id = str(m.id);
                const type = str(m.type);
                const data = typeof m.data === "string" ? m.data : null;
                const timeCreated = num(m.timeCreated);
                if (!id || !type || data === null || timeCreated === null) {
                    return null;
                }
                return {
                    userId,
                    sessionId,
                    id,
                    type,
                    timeCreated,
                    timeUpdated: num(m.timeUpdated),
                    data,
                    deviceId,
                };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);
        if (rows.length > 0) {
            // 같은 메시지는 스트리밍 중 data가 커진다. 마지막 업로드가 이기도록 덮어쓴다.
            // (한 메시지를 쓰는 기기는 하나이고, 업로드는 시간 순서로 온다.)
            await db
                .insert(sessionMessages)
                .values(rows)
                .onConflictDoUpdate({
                    target: [sessionMessages.sessionId, sessionMessages.id],
                    set: {
                        type: excluded("type"),
                        timeCreated: excluded("time_created"),
                        timeUpdated: excluded("time_updated"),
                        data: excluded("data"),
                        deviceId: excluded("device_id"),
                    },
                });
            const newest = rows.reduce((acc, row) => (row.timeCreated >= acc.timeCreated ? row : acc), rows[0]);
            lastId = newest.id;
            lastAt = newest.timeCreated;
        }
    }

    if (parts.length > 0) {
        const rows = parts
            .map((p) => {
                const id = str(p.id);
                const messageId = str(p.messageId);
                const data = typeof p.data === "string" ? p.data : null;
                const timeCreated = num(p.timeCreated);
                if (!id || !messageId || data === null || timeCreated === null) {
                    return null;
                }
                return {
                    userId,
                    sessionId,
                    id,
                    messageId,
                    timeCreated,
                    timeUpdated: num(p.timeUpdated),
                    data,
                    deviceId,
                };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);
        if (rows.length > 0) {
            await db
                .insert(sessionParts)
                .values(rows)
                .onConflictDoUpdate({
                    target: [sessionParts.sessionId, sessionParts.id],
                    set: {
                        data: excluded("data"),
                        timeUpdated: excluded("time_updated"),
                    },
                });
        }
    }

    const state = body.state as RawState | undefined;
    if (state && typeof state === "object") {
        const updatedAt = num(state.updatedAt);
        await db
            .insert(sessionState)
            .values({
                sessionId,
                userId,
                title: str(state.title),
                directory: str(state.directory),
                agent: str(state.agent),
                model: str(state.model),
                revert: str(state.revert),
                parentId: str(state.parentId),
                provider: str(state.provider),
                updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
                deviceId,
            })
            .onConflictDoUpdate({
                target: sessionState.sessionId,
                set: {
                    title: excluded("title"),
                    directory: excluded("directory"),
                    agent: excluded("agent"),
                    model: excluded("model"),
                    revert: excluded("revert"),
                    parentId: excluded("parent_id"),
                    provider: excluded("provider"),
                    updatedAt: excluded("updated_at"),
                    deviceId: excluded("device_id"),
                },
            });
    }

    // 업로드 커서. 실패해도 다음에 watermark로 복구되므로 치명적이지 않다.
    if (lastId) {
        await db
            .insert(deviceCursors)
            .values({ userId, deviceId, sessionId, upTimeCreated: lastAt, upMessageId: lastId })
            .onConflictDoUpdate({
                target: [deviceCursors.userId, deviceCursors.deviceId, deviceCursors.sessionId],
                set: { upTimeCreated: lastAt, upMessageId: lastId, updatedAt: new Date() },
            });
        notifyInBackground(c.executionCtx, userId, { kind: "log", tabId: sessionId, id: lastId, from: deviceId });
    }
    return getBaseResponse({
        success: true,
        status: 200,
        data: { messages: messages.length, parts: parts.length },
    });
});

// 커서 이후 행 조회. 데몬이 받아서 로컬 SQLite에 적용한다.
daemonLog.get("/", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
        return getBaseResponse({ success: false, status: 400, error: "sessionId is required" });
    }
    const sinceTime = Number(c.req.query("sinceTime") ?? 0);
    const sinceId = c.req.query("sinceId") ?? "";
    const limitRaw = Number(c.req.query("limit") ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 200;
    const db = getDb();

    const after =
        sinceTime > 0 || sinceId.length > 0
            ? or(
                  gt(sessionMessages.timeCreated, sinceTime),
                  and(eq(sessionMessages.timeCreated, sinceTime), gt(sessionMessages.id, sinceId)),
              )
            : undefined;

    const messages = await db
        .select({
            id: sessionMessages.id,
            type: sessionMessages.type,
            timeCreated: sessionMessages.timeCreated,
            timeUpdated: sessionMessages.timeUpdated,
            data: sessionMessages.data,
            deviceId: sessionMessages.deviceId,
        })
        .from(sessionMessages)
        .where(and(eq(sessionMessages.userId, userId), eq(sessionMessages.sessionId, sessionId), after))
        .orderBy(asc(sessionMessages.timeCreated), asc(sessionMessages.id))
        .limit(limit);

    const ids = messages.map((m) => m.id);
    const parts =
        ids.length > 0
            ? await db
                  .select({
                      id: sessionParts.id,
                      messageId: sessionParts.messageId,
                      timeCreated: sessionParts.timeCreated,
                      timeUpdated: sessionParts.timeUpdated,
                      data: sessionParts.data,
                  })
                  .from(sessionParts)
                  .where(and(eq(sessionParts.userId, userId), inArray(sessionParts.messageId, ids)))
                  .orderBy(asc(sessionParts.timeCreated), asc(sessionParts.id))
            : [];

    const stateRows = await db
        .select()
        .from(sessionState)
        .where(and(eq(sessionState.userId, userId), eq(sessionState.sessionId, sessionId)))
        .limit(1);
    const state = stateRows[0]
        ? {
              title: stateRows[0].title,
              directory: stateRows[0].directory,
              agent: stateRows[0].agent,
              model: stateRows[0].model,
              revert: stateRows[0].revert,
              parentId: stateRows[0].parentId,
              provider: stateRows[0].provider,
              deletedAt: stateRows[0].deletedAt ? stateRows[0].deletedAt.getTime() : null,
              updatedAt: stateRows[0].updatedAt.getTime(),
          }
        : null;

    const last = messages[messages.length - 1];
    if (last) {
        await db
            .insert(deviceCursors)
            .values({
                userId,
                deviceId,
                sessionId,
                downTimeCreated: last.timeCreated,
                downMessageId: last.id,
            })
            .onConflictDoUpdate({
                target: [deviceCursors.userId, deviceCursors.deviceId, deviceCursors.sessionId],
                set: { downTimeCreated: last.timeCreated, downMessageId: last.id, updatedAt: new Date() },
            });
    }

    return getBaseResponse({
        success: true,
        status: 200,
        data: {
            messages,
            parts,
            state,
            hasMore: messages.length === limit,
            nextCursor: last ? { timeCreated: last.timeCreated, id: last.id } : null,
        },
    });
});

export default daemonLog;
