import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Cursor {
    createdAt: number;
    messageId: string;
}

function cursorFile(): string {
    return join(homedir(), ".config", "localagents", "cursors.json");
}

function loadAll(): Record<string, Cursor> {
    try {
        if (!existsSync(cursorFile())) {
            return {};
        }
        return JSON.parse(readFileSync(cursorFile(), "utf8")) as Record<string, Cursor>;
    } catch {
        return {};
    }
}

// (createdAt, messageId) 쌍 비교. 시간이 같으면 id 순.
export function isNewer(createdAt: number | null, messageId: string, cursor: Cursor | null): boolean {
    if (!cursor) {
        return true;
    }
    const at = createdAt ?? 0;
    if (at !== cursor.createdAt) {
        return at > cursor.createdAt;
    }
    return messageId > cursor.messageId;
}

export function readCursor(sessionID: string): Cursor | null {
    return loadAll()[sessionID] ?? null;
}

export function writeCursor(sessionID: string, createdAt: number | null, messageId: string): void {
    const all = loadAll();
    all[sessionID] = { createdAt: createdAt ?? 0, messageId };
    try {
        mkdirSync(join(homedir(), ".config", "localagents"), { recursive: true });
        writeFileSync(cursorFile(), JSON.stringify(all));
    } catch {
        // 커서 실패는 무시. 다음 주기가 다시 올린다.
    }
}
