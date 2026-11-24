import { Hono } from "hono";
import { and, asc, count, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { checkBillingGate } from "../../../lib/billing";
import { getDb } from "../../../lib/neon/client";
import { deviceCursors, sessionLinks, sessionMessages, sessionParts, sessionShares, sessionState } from "../../../lib/neon/schema";
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

    // 전체 다운로드(커서 없음)일 때만 총 개수를 함께 준다. 진행률 표시에 쓴다.
    const isFull = !(sinceTime > 0 || sinceId.length > 0);
    const totalRows = isFull
        ? await db
              .select({ n: count() })
              .from(sessionMessages)
              .where(and(eq(sessionMessages.userId, userId), eq(sessionMessages.sessionId, sessionId)))
        : [];
    const total = isFull ? Number(totalRows[0]?.n ?? 0) : null;

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
            total,
            nextCursor: last ? { timeCreated: last.timeCreated, id: last.id } : null,
        },
    });
});

// 공유 세션 등록. 만든 기기는 자동으로 연동된다.
daemonLog.post("/share", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    let body: { sessionId?: unknown };
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
    await db
        .insert(sessionShares)
        .values({ sessionId, userId })
        .onConflictDoUpdate({ target: sessionShares.sessionId, set: { userId } });
    await db
        .insert(sessionLinks)
        .values({ userId, sessionId, deviceId })
        .onConflictDoUpdate({
            target: [sessionLinks.userId, sessionLinks.sessionId, sessionLinks.deviceId],
            set: { linkedAt: new Date() },
        });
    return getBaseResponse({ success: true, status: 200, data: { sessionId, shared: true } });
});

// 공유 해제. 연동도 함께 지운다 (자동 동기화 중지).
daemonLog.delete("/share", async (c) => {
    const userId = c.get("userId");
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
        return getBaseResponse({ success: false, status: 400, error: "sessionId is required" });
    }
    const db = getDb();
    await db.delete(sessionLinks).where(and(eq(sessionLinks.userId, userId), eq(sessionLinks.sessionId, sessionId)));
    await db.delete(sessionShares).where(and(eq(sessionShares.userId, userId), eq(sessionShares.sessionId, sessionId)));
    return getBaseResponse({ success: true, status: 200, data: { sessionId, shared: false } });
});

// 이 기기를 공유 세션에 연동. 공유되지 않은 세션은 거부한다.
daemonLog.post("/link", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    let body: { sessionId?: unknown };
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
    const shared = await db
        .select({ sessionId: sessionShares.sessionId })
        .from(sessionShares)
        .where(and(eq(sessionShares.userId, userId), eq(sessionShares.sessionId, sessionId)))
        .limit(1);
    if (shared.length === 0) {
        return getBaseResponse({ success: false, status: 404, error: "session is not shared" });
    }
    await db
        .insert(sessionLinks)
        .values({ userId, sessionId, deviceId })
        .onConflictDoUpdate({
            target: [sessionLinks.userId, sessionLinks.sessionId, sessionLinks.deviceId],
            set: { linkedAt: new Date() },
        });
    return getBaseResponse({ success: true, status: 200, data: { sessionId, linked: true } });
});

daemonLog.delete("/link", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
        return getBaseResponse({ success: false, status: 400, error: "sessionId is required" });
    }
    await getDb()
        .delete(sessionLinks)
        .where(
            and(
                eq(sessionLinks.userId, userId),
                eq(sessionLinks.deviceId, deviceId),
                eq(sessionLinks.sessionId, sessionId),
            ),
        );
    return getBaseResponse({ success: true, status: 200, data: { sessionId, linked: false } });
});

// 이 사용자의 모든 공유 세션. link 선택기가 쓴다 (아직 연동하지 않은 기기도 보여야 한다).
daemonLog.get("/shares", async (c) => {
    const userId = c.get("userId");
    const rows = await getDb()
        .select({
            sessionId: sessionShares.sessionId,
            sharedAt: sessionShares.createdAt,
            title: sessionState.title,
            directory: sessionState.directory,
            updatedAt: sessionState.updatedAt,
            deletedAt: sessionState.deletedAt,
        })
        .from(sessionShares)
        .leftJoin(sessionState, eq(sessionState.sessionId, sessionShares.sessionId))
        .where(eq(sessionShares.userId, userId));
    return getBaseResponse({
        success: true,
        status: 200,
        data: {
            sessions: rows.map((r) => ({
                sessionId: r.sessionId,
                title: r.title,
                directory: r.directory,
                sharedAt: r.sharedAt.toISOString(),
                updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
                deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
            })),
        },
    });
});

// 이 기기에 연동된 공유 세션 목록 + 다운로드 커서. 데몬이 동기화 대상으로 쓴다.
daemonLog.get("/shared", async (c) => {
    const userId = c.get("userId");
    const deviceId = c.get("deviceId");
    const db = getDb();
    const rows = await db
        .select({
            sessionId: sessionLinks.sessionId,
            linkedAt: sessionLinks.linkedAt,
            title: sessionState.title,
            directory: sessionState.directory,
            parentId: sessionState.parentId,
            updatedAt: sessionState.updatedAt,
            deletedAt: sessionState.deletedAt,
            downTimeCreated: deviceCursors.downTimeCreated,
            downMessageId: deviceCursors.downMessageId,
            upTimeCreated: deviceCursors.upTimeCreated,
        })
        .from(sessionLinks)
        .innerJoin(
            sessionShares,
            and(eq(sessionShares.userId, userId), eq(sessionShares.sessionId, sessionLinks.sessionId)),
        )
        .leftJoin(sessionState, eq(sessionState.sessionId, sessionLinks.sessionId))
        .leftJoin(
            deviceCursors,
            and(
                eq(deviceCursors.userId, userId),
                eq(deviceCursors.deviceId, deviceId),
                eq(deviceCursors.sessionId, sessionLinks.sessionId),
            ),
        )
        .where(and(eq(sessionLinks.userId, userId), eq(sessionLinks.deviceId, deviceId)));
    return getBaseResponse({
        success: true,
        status: 200,
        data: {
            sessions: rows.map((r) => ({
                sessionId: r.sessionId,
                title: r.title,
                directory: r.directory,
                parentId: r.parentId,
                linkedAt: r.linkedAt.toISOString(),
                updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
                deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
                downCursor:
                    r.downTimeCreated && r.downMessageId
                        ? { timeCreated: r.downTimeCreated, id: r.downMessageId }
                        : null,
                upCursor:
                    r.upTimeCreated
                        ? { timeCreated: r.upTimeCreated }
                        : null,
            })),
        },
    });
});

export default daemonLog;
