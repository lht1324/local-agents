import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface PushMark {
    at: number;
    id: string;
    seq: number;
}

function pushFile(): string {
    return join(homedir(), ".config", "localagents", "push.json");
}

function loadAll(): Record<string, PushMark> {
    try {
        if (!existsSync(pushFile())) {
            return {};
        }
        return JSON.parse(readFileSync(pushFile(), "utf8")) as Record<string, PushMark>;
    } catch {
        return {};
    }
}

// push 워터마크. mirror 커서와 별개. 성공한 push마다 전진.
export function readPushMark(sessionID: string): PushMark | null {
    return loadAll()[sessionID] ?? null;
}

export function writePushMark(sessionID: string, at: number, id: string, seq?: number): void {
    const all = loadAll();
    all[sessionID] = { at, id, seq: seq ?? 0 };
    try {
        mkdirSync(join(homedir(), ".config", "localagents"), { recursive: true });
        writeFileSync(pushFile(), JSON.stringify(all));
    } catch {
        // 실패 무시. 다음 push가 전체로 잡는다.
    }
}
