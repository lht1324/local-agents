import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { checkBillingGate } from "../../../lib/billing";
import { getDb } from "../../../lib/neon/client";
import { commands, devices, sessionsMeta } from "../../../lib/neon/schema";
import type { AppEnv } from "../../../lib/env";
import type { AuthVariables } from "../../middleware/auth";
import { notifyInBackground } from "../../notify";
import { getBaseResponse } from "../../utils/getBaseResponse";

const EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_MS = 120_000;

interface CommandBody {
    deviceId?: unknown;
    type?: unknown;
    payload?: unknown;
}

// 웹 입력 → 명령 outbox. 대상 기기는 내 것이고 지금 활성이어야 한다.
const commandsRoute = new Hono<{ Bindings: AppEnv; Variables: AuthVariables }>();

commandsRoute.post("/", async (c) => {
    const userId = c.get("userId");
    const gate = await checkBillingGate(userId);
    if (!gate.allowed) {
        return getBaseResponse({ success: false, status: 403, error: "trial_ended" });
    }

    let body: CommandBody;
    try {
        body = (await c.req.json()) as CommandBody;
    } catch {
        return getBaseResponse({ success: false, status: 400, error: "invalid JSON body" });
    }
    if (typeof body.deviceId !== "string" || body.deviceId.length === 0) {
        return getBaseResponse({ success: false, status: 400, error: "deviceId is required" });
    }
    if (typeof body.type !== "string" || body.type.length === 0) {
        return getBaseResponse({ success: false, status: 400, error: "type is required" });
    }

    const db = getDb();
    const target = await db
        .select({ lastSeenAt: devices.lastSeenAt })
        .from(devices)
        .where(and(eq(devices.id, body.deviceId), eq(devices.userId, userId), isNull(devices.unlinkedAt)))
        .limit(1);
    if (target.length === 0) {
        return getBaseResponse({ success: false, status: 404, error: "device not found" });
    }
    const lastSeen = target[0].lastSeenAt;
    if (!lastSeen || Date.now() - lastSeen.getTime() > ACTIVE_MS) {
        return getBaseResponse({ success: false, status: 409, error: "device is not active" });
    }

    const payloadText = typeof body.payload === "string" ? body.payload : "{}";
    let tabId: string | null = null;
    try {
        const parsed = JSON.parse(payloadText) as { sessionID?: unknown };
        tabId = typeof parsed.sessionID === "string" && parsed.sessionID.length > 0 ? parsed.sessionID : null;
    } catch {
        tabId = null;
    }
    if (tabId) {
        const owned = await db
            .select({ id: sessionsMeta.id })
            .from(sessionsMeta)
            .where(and(eq(sessionsMeta.id, tabId), eq(sessionsMeta.userId, userId)))
            .limit(1);
        if (owned.length === 0) {
            return getBaseResponse({ success: false, status: 404, error: "session not found" });
        }
    }

    const id = randomUUID();
    await db.insert(commands).values({
        id,
        userId,
        deviceId: body.deviceId,
        tabId,
        type: body.type,
        payload: payloadText,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + EXPIRES_IN_MS),
    });
    // 대상 기기가 붙어 있으면 즉시 받는다. 없으면 다음 폴링이 가져간다.
    notifyInBackground(c.executionCtx, userId, { kind: "command", tabId: tabId ?? undefined, id });
    return getBaseResponse({ success: true, status: 201, data: { id, status: "pending" } });
});

export default commandsRoute;
