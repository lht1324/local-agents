import { execFile } from "node:child_process";
import { platform } from "node:os";

// 새 메시지가 로컬에 적용됐을 때 띄우는 시스템 알림.
// 이벤트마다 띄우면 도배되므로 5초 모았다가 1회, 같은 알림은 교체한다.

const REPLACE_ID = "4242";
const DEBOUNCE_MS = 5_000;
// macOS는 표준 알림을 교체할 수 없어 같은 알림을 2분에 한 번만 띄운다.
const MAC_COOLDOWN_MS = 120_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pendingSessions = new Set<string>();
let pendingMessages = 0;
let lastShownAt = 0;

export function queueNotice(sessionId: string, messages: number): void {
    if (messages <= 0) {
        return;
    }
    pendingSessions.add(sessionId);
    pendingMessages += messages;
    if (timer) {
        clearTimeout(timer);
    }
    timer = setTimeout(flushNotice, DEBOUNCE_MS);
}

function flushNotice(): void {
    const messages = pendingMessages;
    if (messages === 0) {
        return;
    }
    const sessions = pendingSessions.size;
    pendingSessions = new Set();
    pendingMessages = 0;

    const now = Date.now();
    if (platform() === "darwin" && now - lastShownAt < MAC_COOLDOWN_MS) {
        return;
    }
    lastShownAt = now;
    show("새 메시지 도착", `${sessions}개 세션 · ${messages}개 메시지 — 세션을 다시 열어 주세요`);
}

function show(title: string, body: string): void {
    try {
        if (platform() === "darwin") {
            execFile("osascript", ["-e", `display notification ${appleString(body)} with title ${appleString(title)}`]);
            return;
        }
        if (platform() === "linux") {
            // -r: 같은 id의 알림을 교체한다 (쌓이지 않음).
            execFile("notify-send", ["-r", REPLACE_ID, title, body]);
        }
    } catch {
        // 알림 실패는 동기화에 영향을 주지 않는다.
    }
}

function appleString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
