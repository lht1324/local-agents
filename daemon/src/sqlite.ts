// node:sqlite는 Node 22.13.0부터 플래그 없이 동작한다.
// 그보다 낮은 Node에서는 정적 import 단계에서 "Cannot find module 'node:sqlite'"로 죽어
// 원인을 알 수 없으므로, 필요한 시점에 불러오고 실패하면 명시적으로 안내한다.

export interface SqliteStatement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): void;
    close(): void;
}

type DatabaseCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

let ctor: DatabaseCtor | null = null;

// Node 26에서는 DatabaseSync가 Database의 deprecated alias다. 둘 다 받아둔다.
function loadCtor(): DatabaseCtor {
    if (ctor) {
        return ctor;
    }
    try {
        const mod = require("node:sqlite") as { DatabaseSync?: DatabaseCtor; Database?: DatabaseCtor };
        ctor = mod.DatabaseSync ?? mod.Database ?? null;
    } catch {
        ctor = null;
    }
    if (!ctor) {
        throw new Error(
            `localagents requires Node 22.13 or newer (found ${process.version}).\n` +
                "Node 20 and older are end-of-life. Install Node 22 LTS or newer: https://nodejs.org",
        );
    }
    return ctor;
}

export function openSqlite(path: string, options?: { readOnly?: boolean }): SqliteDatabase {
    const Ctor = loadCtor();
    // 두 번째 인자에 undefined를 명시하면 ERR_INVALID_ARG_TYPE이 난다. 있을 때만 넘긴다.
    const db = options ? new Ctor(path, options) : new Ctor(path);
    try {
        // OpenCode 앱·상주 서비스와 같은 DB를 쓴다. 쓰기 경합 시 최대 60초 기다린다.
        db.exec("PRAGMA busy_timeout = 60000");
    } catch {
        // 프래그마가 실패해도 연결은 유지한다.
    }
    return db;
}
