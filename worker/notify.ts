import { getServerEnv } from "../lib/env";
import type { NotifyEvent } from "./do/room";

// 알림 중계. 실패해도 쓰기 요청은 성공해야 하므로 예외를 삼킨다.
// (알림은 즉시성만 담당한다. 정합성은 데몬이 커서로 따라잡는다.)
export async function notifyUser(userId: string, event: NotifyEvent): Promise<void> {
    try {
        const env = getServerEnv();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(userId));
        await stub.fetch("https://room/notify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(event),
        });
    } catch (error) {
        console.warn(`notify failed (${event.kind}):`, error);
    }
}

// Hono의 executionCtx와 Workers의 ExecutionContext는 타입이 달라서
// 필요한 메서드만 구조적으로 받는다.
interface BackgroundCtx {
    waitUntil(promise: Promise<unknown>): void;
}

// 응답을 기다리지 않고 백그라운드로 보낸다. waitUntil이 없으면 그냥 삼킨다.
export function notifyInBackground(executionCtx: BackgroundCtx | undefined, userId: string, event: NotifyEvent): void {
    const task = notifyUser(userId, event);
    if (executionCtx) {
        executionCtx.waitUntil(task);
    }
}
