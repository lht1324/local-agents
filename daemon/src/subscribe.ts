import { baseUrl, readState } from "./device";

// 알림 버스 이벤트. 내용이 아니라 포인터만 온다.
export interface BusEvent {
    kind: string;
    tabId?: string;
    id?: string;
    from?: string;
}

// 사용자 방에 붙어 신호를 받는다. 실패하면 조용히 재연결한다.
// 이 구독은 즉시성만 담당한다. 정합성은 폴링과 커서가 보장하므로 예외를 던지지 않는다.
export function startSubscription(onEvent: (event: BusEvent) => void): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const schedule = (): void => {
        if (stopped) {
            return;
        }
        attempt += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        timer = setTimeout(connect, delay);
    };

    function connect(): void {
        const state = readState();
        if (stopped || !state?.token) {
            return;
        }
        const url = `${baseUrl().replace(/^http/, "ws")}/api/daemon/ws?token=${encodeURIComponent(state.token)}`;
        const ws = new WebSocket(url);
        socket = ws;
        ws.onopen = () => {
            attempt = 0;
            console.log("ws: connected");
        };
        ws.onmessage = (event) => {
            let data: (BusEvent & { type?: string }) | null = null;
            try {
                data = JSON.parse(String(event.data)) as BusEvent & { type?: string };
            } catch {
                return;
            }
            if (!data || data.type === "hello") {
                return;
            }
            try {
                onEvent(data);
            } catch {
                // 다음 폴링이 잡는다.
            }
        };
        ws.onclose = () => {
            if (socket === ws) {
                socket = null;
            }
            schedule();
        };
        ws.onerror = () => {
            // onclose가 뒤따른다.
        };
    }

    connect();

    return () => {
        stopped = true;
        if (timer) {
            clearTimeout(timer);
        }
        socket?.close();
    };
}
