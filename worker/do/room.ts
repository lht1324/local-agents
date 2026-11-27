// 알림 버스 — 사용자당 방 하나.
//
// 이 객체는 데이터를 저장하지 않는다. 데몬이 붙어 있는 연결만 들고 있다가
// Worker가 알려준 신호를 연결된 기기에 그대로 중계한다. 실제 데이터는 Neon에 있다.
//
// 반드시 ctx.acceptWebSocket()을 써야 한다. server.accept()를 쓰면 소켓이 붙어 있는
// 동안 객체가 메모리에 상주해 유휴에도 duration 과금이 발생한다.
// hibernation이 걸리면 소켓은 플랫폼이 보관하고, 메시지가 올 때만 객체가 깨어난다.

export interface NotifyEvent {
    kind: "message" | "meta" | "revert" | "handoff" | "command" | "deleted" | "log";
    tabId?: string;
    /** 메시지/기준점 id. 내용이 아니라 포인터만 보낸다. */
    id?: string;
    /** 신호를 만든 기기. 같은 기기에는 되돌려 보내지 않는다. */
    from?: string;
    at?: number;
}

interface Attachment {
    deviceId: string;
}

export class NotificationRoom implements DurableObject {
    private readonly ctx: DurableObjectState;

    constructor(ctx: DurableObjectState) {
        this.ctx = ctx;
        // 핑/퐁은 플랫폼이 응답한다. 연결 유지 때문에 객체가 깨어나지 않는다.
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/version") {
            return this.version(url.searchParams.get("sessionId") ?? "");
        }
        if (url.pathname === "/notify") {
            return this.notify(request);
        }
        const upgrade = request.headers.get("Upgrade");
        if (upgrade !== "websocket") {
            return new Response("expected websocket upgrade", { status: 426 });
        }
        const deviceId = request.headers.get("x-la-device-id") ?? "";
        const pair = new WebSocketPair();
        // hibernation 등록. 이후 이벤트는 webSocket* 핸들러로 들어온다.
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ deviceId } satisfies Attachment);
        pair[1].send(
            JSON.stringify({
                type: "hello",
                deviceId,
                peers: Math.max(0, this.ctx.getWebSockets().length - 1),
            }),
        );
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Worker가 호출하는 중계 지점. 신호를 연결된 모든 소켓에 그대로 보낸다.
    private async notify(request: Request): Promise<Response> {
        const raw = await request.text();
        let event: NotifyEvent | null = null;
        try {
            event = JSON.parse(raw) as NotifyEvent;
        } catch {
            return new Response(JSON.stringify({ error: "invalid json" }), {
                status: 400,
                headers: { "content-type": "application/json" },
            });
        }
        // 탭별 마지막 쓰기 버전을 남긴다. 데몬은 Neon 대신 이 값을 보고 조회를 건너뛴다.
        if (event.tabId && event.id) {
            try {
                this.ensureSchema();
                this.ctx.storage.sql.exec(
                    "INSERT INTO versions (session_id, msg_id, at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET msg_id = excluded.msg_id, at = excluded.at WHERE excluded.at >= versions.at",
                    event.tabId,
                    event.id,
                    event.at ?? Date.now(),
                );
            } catch {
                // 버전 저장 실패가 알림을 막지 않는다.
            }
        }
        let delivered = 0;
        for (const ws of this.ctx.getWebSockets()) {
            // 신호를 만든 기기에는 돌려보내지 않는다 (자기 쓰기를 다시 받을 이유가 없다).
            if (event.from) {
                const attached = ws.deserializeAttachment() as Attachment | null;
                if (attached?.deviceId === event.from) {
                    continue;
                }
            }
            try {
                ws.send(raw);
                delivered += 1;
            } catch {
                // 끊긴 소켓은 close 이벤트가 정리한다.
            }
        }
        return new Response(JSON.stringify({ delivered }), {
            headers: { "content-type": "application/json" },
        });
    }

    private ensureSchema(): void {
        this.ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS versions (session_id TEXT PRIMARY KEY, msg_id TEXT, at INTEGER)",
        );
    }

    // 탭의 마지막 쓰기 버전. 기록이 없으면 null (데몬은 안전하게 조회한다).
    private version(sessionId: string): Response {
        if (!sessionId) {
            return new Response(JSON.stringify({ error: "sessionId required" }), { status: 400 });
        }
        try {
            this.ensureSchema();
            const rows = this.ctx.storage.sql
                .exec("SELECT msg_id, at FROM versions WHERE session_id = ?", sessionId)
                .toArray() as { msg_id: string; at: number }[];
            const row = rows[0];
            return new Response(JSON.stringify(row ? { id: row.msg_id, at: row.at } : null), {
                headers: { "content-type": "application/json" },
            });
        } catch {
            return new Response("null", { headers: { "content-type": "application/json" } });
        }
    }

    webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
        // 데몬 → 방향 메시지는 아직 쓰지 않는다. 핑은 auto-response가 처리한다.
    }

    webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
        // hibernation 저장소에서 자동으로 빠진다. 별도 정리 없음.
    }

    webSocketError(_ws: WebSocket, _error: unknown): void {
        // 다음 재연결이 따라잡는다.
    }
}
