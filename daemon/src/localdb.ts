import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSqlite, type SqliteDatabase } from "./sqlite";
import type { ServerMessage } from "./types";
import { pkgFlavor, toV1, toV2, v1MessageProblems, v1PartProblems } from "./convert";

export function dbPath(): string | null {
    // 설치 방식마다 다르다. 둘 다 찔러본다 (이 Mac은 XDG 쪽에 있음).
    const candidates = [
        join(homedir(), ".local", "share", "opencode", "opencode.db"),
        join(homedir(), "Library", "Application Support", "opencode", "opencode.db"),
    ];
    for (const path of candidates) {
        if (existsSync(path)) {
            return path;
        }
    }
    return null;
}

function toMessage(row: { id: string; type: string; createdAt: number | null; data: string }): ServerMessage | null {
    let d: Record<string, unknown>;
    try {
        d = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
        return null;
    }
    const time = typeof row.createdAt === "number" ? { created: row.createdAt } : undefined;
    if (row.type === "user") {
        const meta = (d.metadata ?? {}) as Record<string, unknown>;
        return {
            id: row.id,
            type: "user",
            time,
            text: typeof meta.displayText === "string" ? meta.displayText : "",
            files: Array.isArray(meta.attachments) ? (meta.attachments as { name?: string; mime?: string }[]) : [],
        } as ServerMessage;
    }
    if (row.type === "assistant") {
        return {
            id: row.id,
            type: "assistant",
            time,
            content: Array.isArray(d.content) ? (d.content as ServerMessage["content"]) : [],
        };
    }
    if (row.type === "compaction") {
        return { id: row.id, type: "compaction", time, summary: typeof d.summary === "string" ? d.summary : "" };
    }
    return null;
}

// 로컬 탭 역할별 누적 합계. 목록 새개수 표시용. v1은 data JSON role을 센다.
export function localRoleCounts(sessionID: string): { user: number; ai: number } {
    const path = dbPath();
    if (!path) {
        return { user: 0, ai: 0 };
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const probe = db.prepare("SELECT COUNT(*) AS n FROM session_message").get() as { n: number };
        if (probe.n > 0) {
            const rows = db
                .prepare("SELECT type, COUNT(*) AS n FROM session_message WHERE session_id = ? GROUP BY type")
                .all(sessionID) as { type: string; n: number }[];
            let user = 0;
            let ai = 0;
            for (const r of rows) {
                if (r.type === "user") {
                    user = r.n;
                } else if (r.type === "assistant") {
                    ai = r.n;
                }
            }
            return { user, ai };
        }
        const rows = db.prepare("SELECT data FROM message WHERE session_id = ?").all(sessionID) as { data: string }[];
        let user = 0;
        let ai = 0;
        for (const r of rows) {
            try {
                const d = JSON.parse(r.data) as { role?: unknown };
                if (d.role === "user") {
                    user++;
                } else if (d.role === "assistant") {
                    ai++;
                }
            } catch {
                // 스킵
            }
        }
        return { user, ai };
    } catch {
        return { user: 0, ai: 0 };
    } finally {
        db.close();
    }
}

// 탭의 현재 epoch 번호. compaction 횟수 = 지금 세대.
export function epochOf(sessionID: string): number {
    const path = dbPath();
    if (!path) {
        return 0;
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const row = db
            .prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'compaction'")
            .get(sessionID) as { n: number };
        return row.n;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}
// 메시지+파트 합산. 파트는 새 메시지에 딸린 것만 셈한다.
export function countNewer(sessionID: string, createdAt: number | null, messageId: string | null): number {
    const path = dbPath();
    if (!path) {
        return 0;
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const at = createdAt ?? 0;
        const mid = messageId ?? "";
        const msgs = db
            .prepare(
                "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND (time_created > ? OR (time_created = ? AND id > ?))",
            )
            .get(sessionID, at, at, mid) as { n: number };
        const parts = db
            .prepare(
                "SELECT COUNT(*) AS n FROM part p INNER JOIN session_message m ON m.id = p.message_id WHERE m.session_id = ? AND (m.time_created > ? OR (m.time_created = ? AND m.id > ?))",
            )
            .get(sessionID, at, at, mid) as { n: number };
        return msgs.n + parts.n;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

// 탭 최신점. push 워터마크 기록용.
export function latestOf(sessionID: string): { at: number; id: string } | null {
    const path = dbPath();
    if (!path) {
        return null;
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const row = db
            .prepare("SELECT time_created AS at, id FROM session_message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1")
            .get(sessionID) as { at: number | null; id: string } | undefined;
        if (!row) {
            return null;
        }
        return { at: row.at ?? 0, id: row.id };
    } catch {
        return null;
    } finally {
        db.close();
    }
}

// 워터마크 없으면 탭 전체 행 수 (메시지+파트). 첫 push 표시용.
export function countAll(sessionID: string): number {
    const path = dbPath();
    if (!path) {
        return 0;
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const msgs = db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?").get(sessionID) as {
            n: number;
        };
        const parts = db
            .prepare("SELECT COUNT(*) AS n FROM part p INNER JOIN session_message m ON m.id = p.message_id WHERE m.session_id = ?")
            .get(sessionID) as { n: number };
        return msgs.n + parts.n;
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

export interface SessionUsage {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    msgUser: number;
    msgAssistant: number;
}

export interface TabMessage {
    id: string;
    type: string;
    seq: number;
    createdAt: number | null;
    updatedAt: number | null;
    data: string;
}

export interface TabPart {
    id: string;
    messageId: string;
    createdAt: number | null;
    updatedAt: number | null;
    data: string;
}

export interface TabPackage {
    tabId: string;
    exportedAt: number;
    flavor?: "v1" | "v2" | null;
    title?: string | null;
    directory?: string | null;
    repo?: TabRepo | null;
    version?: string | null;
    agent?: string | null;
    modelJson?: string | null;
    messages: TabMessage[];
    parts: TabPart[];
}

// 로컬 DB 맛보기. session_message에 행이 있으면 v2, 없으면 v1 (message+part).
function dbFlavor(): "v1" | "v2" {
    const path = dbPath();
    if (!path) {
        return "v1";
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const row = db.prepare("SELECT COUNT(*) AS n FROM session_message").get() as { n: number };
        return row.n > 0 ? "v2" : "v1";
    } catch {
        return "v1";
    } finally {
        db.close();
    }
}

// 부모 세션 id. 없으면 null (루트). v2 우선, v1 폴백.
export function sessionParentId(sessionID: string): string | null {
    const path = dbPath();
    if (!path) {
        return null;
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const v2 = db.prepare("SELECT parent_id FROM session_v2 WHERE id = ?").get(sessionID) as
            | { parent_id: string | null }
            | undefined;
        if (v2) {
            return v2.parent_id ?? null;
        }
        const v1 = db.prepare("SELECT parent_id FROM session WHERE id = ?").get(sessionID) as
            | { parent_id: string | null }
            | undefined;
        return v1?.parent_id ?? null;
    } catch {
        return null;
    } finally {
        db.close();
    }
}

// 직계 자식 세션 id 목록.
export function childSessionIds(parentID: string): string[] {
    const path = dbPath();
    if (!path) {
        return [];
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const v2 = db.prepare("SELECT id FROM session_v2 WHERE parent_id = ?").all(parentID) as { id: string }[];
        if (v2.length > 0) {
            return v2.map((r) => r.id);
        }
        const v1 = db.prepare("SELECT id FROM session WHERE parent_id = ?").all(parentID) as { id: string }[];
        return v1.map((r) => r.id);
    } catch {
        return [];
    } finally {
        db.close();
    }
}

export function sessionExists(sessionID: string): boolean {
    const path = dbPath();
    if (!path) {
        return false;
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const row = db.prepare("SELECT id FROM session WHERE id = ?").get(sessionID) as { id: string } | undefined;
        return !!row;
    } catch {
        return false;
    } finally {
        db.close();
    }
}

// v1 읽기. message 테이블 role을 type으로, 순서를 seq로 쓴다. compaction 절단 없음.
function readTabPackageV1(db: SqliteDatabase, sessionID: string): { messages: TabMessage[]; parts: TabPart[] } {
    const msgs = db
        .prepare("SELECT id, time_created AS createdAt, time_updated AS updatedAt, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(sessionID) as { id: string; createdAt: number | null; updatedAt: number | null; data: string }[];
    const messages: TabMessage[] = msgs.map((m, i) => {
        let role = "assistant";
        try {
            const d = JSON.parse(m.data) as { role?: unknown };
            if (typeof d.role === "string" && d.role.length > 0) {
                role = d.role;
            }
        } catch {
            // 원문 유지
        }
        return { id: m.id, type: role, seq: i, createdAt: m.createdAt, updatedAt: m.updatedAt, data: m.data };
    });
    const parts = db
        .prepare("SELECT id, message_id AS messageId, time_created AS createdAt, time_updated AS updatedAt, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(sessionID) as unknown as TabPart[];
    return { messages, parts };
}

export interface TabRepo {
    directory: string | null;
    remote: string | null;
    branch: string | null;
}

// 탭 작업폴더 + git 정체. 폴더 지정·매칭용. 전부 best-effort.
export function tabRepoInfo(sessionID: string): TabRepo {
    const path = dbPath();
    if (!path) {
        return { directory: null, remote: null, branch: null };
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const row = db.prepare("SELECT directory FROM session_v2 WHERE id = ?").get(sessionID) as
            | { directory: string | null }
            | undefined;
        return repoForDirectory(row?.directory ?? null);
    } catch {
        return { directory: null, remote: null, branch: null };
    } finally {
        db.close();
    }
}

export function repoForDirectory(directory: string | null): TabRepo {
    if (!directory) {
        return { directory: null, remote: null, branch: null };
    }
    return { directory, remote: gitRemote(directory), branch: gitBranch(directory) };
}

// remote 같은 로컬 폴더 찾기. 없으면 null.
export function findLocalDirByRemote(remote: string): string | null {
    if (!remote) {
        return null;
    }
    for (const dir of localProjectDirs()) {
        try {
            if (gitRemote(dir) === remote) {
                return dir;
            }
        } catch {
            // 다음 후보
        }
    }
    return null;
}

// 탭 작업폴더 재지정. 단일 컬럼이라 안전.
export function setTabDirectory(tabId: string, directory: string): void {
    const path = dbPath();
    if (!path) {
        throw new Error("opencode db not found");
    }
    const db = openSqlite(path);
    try {
        const cols = db.prepare("SELECT name FROM pragma_table_info('session_v2')").all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        if (names.has("directory")) {
            db.prepare("UPDATE session_v2 SET directory = ? WHERE id = ?").run(directory, tabId);
        }
        const cols1 = db.prepare("SELECT name FROM pragma_table_info('session')").all() as { name: string }[];
        if (new Set(cols1.map((c) => c.name)).has("directory")) {
            try {
                db.prepare("UPDATE session SET directory = ? WHERE id = ?").run(directory, tabId);
            } catch {
                // v1에 해당 행 없으면 무시
            }
        }
    } finally {
        db.close();
    }
}

function gitRemote(dir: string): string | null {
    try {
        const out = execSync("git remote get-url origin", { cwd: dir, timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const remote = out.trim();
        return remote.length > 0 ? remote : null;
    } catch {
        return null;
    }
}

function gitBranch(dir: string): string | null {
    try {
        const out = execSync("git branch --show-current", { cwd: dir, timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const branch = out.trim();
        return branch.length > 0 ? branch : null;
    } catch {
        return null;
    }
}

// 로컬 후보 폴더 목록. OpenCode가 아는 폴더만. 전수 탐색 없음.
export function localProjectDirs(): string[] {
    const path = dbPath();
    if (!path) {
        return [];
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const rows = db.prepare("SELECT worktree FROM project WHERE worktree IS NOT NULL AND worktree != ''").all() as {
            worktree: string;
        }[];
        return [...new Set(rows.map((r) => r.worktree))];
    } catch {
        return [];
    } finally {
        db.close();
    }
}
// v2는 session_message, v1은 message+part에서 읽는다.
export function readTabPackage(sessionID: string, since?: { at: number; id: string } | null): TabPackage {
    const path = dbPath();
    if (!path) {
        throw new Error("opencode db not found");
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const meta = (db.prepare("SELECT title, directory, version, agent, model FROM session WHERE id = ?").get(sessionID) ??
            db.prepare("SELECT title, directory, version, agent, model FROM session_v2 WHERE id = ?").get(sessionID)) as
            | { title: string; directory: string; version: string; agent: string | null; model: string | null }
            | undefined;
        if (dbFlavor() === "v1") {
            const v1 = readTabPackageV1(db, sessionID);
            // v1은 증분 필터를 적용하지 않는다 (전체).
            return {
                tabId: sessionID,
                exportedAt: Date.now(),
                flavor: "v1" as const,
                title: meta?.title ?? null,
                directory: meta?.directory ?? null,
                repo: repoForDirectory(meta?.directory ?? null),
                version: meta?.version ?? null,
                agent: meta?.agent ?? null,
                modelJson: meta?.model ?? null,
                messages: v1.messages,
                parts: v1.parts,
            };
        }
        let cut = -1;
        const bounds = db
            .prepare("SELECT seq FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 1")
            .all(sessionID) as { seq: number }[];
        if (bounds.length > 0) {
            cut = bounds[0].seq;
        }
        // compaction 이후에 push mark가 가리키는 메시지가 없으면 (새 epoch) push mark를 버린다.
        let effectiveSince = since ?? null;
        if (effectiveSince) {
            const found = db
                .prepare("SELECT id FROM session_message WHERE session_id = ? AND id = ? AND seq > ?")
                .get(sessionID, effectiveSince.id, cut) as { id: string } | undefined;
            if (!found) {
                effectiveSince = null;
            }
        }
        let msgQuery =
            "SELECT id, type, seq, time_created AS createdAt, time_updated AS updatedAt, data FROM session_message WHERE session_id = ? AND seq > ?";
        const msgParams: unknown[] = [sessionID, cut];
        if (effectiveSince) {
            msgQuery += " AND (time_created > ? OR (time_created = ? AND id > ?))";
            msgParams.push(effectiveSince.at, effectiveSince.at, effectiveSince.id);
        }
        msgQuery += " ORDER BY id ASC";
        const messages = db.prepare(msgQuery).all(...msgParams) as unknown as (TabMessage & { type: string })[];
        if (messages.length === 0) {
            db.close();
            return null as unknown as TabPackage;
        }
        const v2dir = (() => {
            try {
                const r = db.prepare("SELECT directory FROM session_v2 WHERE id = ?").get(sessionID) as
                    | { directory: string | null }
                    | undefined;
                return r?.directory ?? null;
            } catch {
                return null;
            }
        })();
        const msgIds = messages.map((m) => m.id);
        const parts =
            msgIds.length === 0
                ? []
                : (db
                      .prepare(
                          `SELECT p.id, p.message_id AS messageId, p.time_created AS createdAt, p.time_updated AS updatedAt, p.data FROM part p WHERE p.message_id IN (${msgIds.map(() => "?").join(",")})`,
                      )
                      .all(...msgIds) as unknown as TabPart[]);
        return {
            tabId: sessionID,
            exportedAt: Date.now(),
            flavor: "v2" as const,
            title: meta?.title ?? null,
            directory: meta?.directory ?? null,
            repo: repoForDirectory(v2dir ?? meta?.directory ?? null),
            version: meta?.version ?? null,
            agent: meta?.agent ?? null,
            modelJson: meta?.model ?? null,
            messages: messages.map((m) => ({ id: m.id, type: m.type, seq: m.seq, createdAt: m.createdAt, updatedAt: m.updatedAt, data: m.data })),
            parts,
        };
    } finally {
        db.close();
    }
}

function ensureSessionV2Parent(
    db: SqliteDatabase,
    pkg: TabPackage,
    dir: string,
    now: number,
    fallbackTitle?: string | null,
): boolean {
    let columns: Set<string>;
    try {
        const rows = db.prepare("SELECT name FROM pragma_table_info('session_v2')").all() as { name: string }[];
        if (rows.length === 0) {
            return false;
        }
        columns = new Set(rows.map((row) => row.name));
    } catch {
        return false;
    }

    const existing = db.prepare("SELECT project_id FROM session_v2 WHERE id = ?").get(pkg.tabId) as
        | { project_id: string | null }
        | undefined;
    if (existing) {
        return false;
    }

    const v1 = db.prepare("SELECT project_id FROM session WHERE id = ?").get(pkg.tabId) as
        | { project_id: string | null }
        | undefined;
    let projectId = v1?.project_id ?? null;
    if (!projectId) {
        projectId =
            (db.prepare("SELECT id FROM project WHERE worktree = ?").get(dir) as { id: string } | undefined)?.id ??
            (db.prepare("SELECT id FROM project LIMIT 1").get() as { id: string } | undefined)?.id ??
            null;
    }
    if (!projectId) {
        throw new Error("no project row to attach the tab to");
    }

    let sibling1: { version?: string; agent?: string | null; model?: string | null } | undefined;
    let sibling2: { version?: string; agent?: string | null; model?: string | null } | undefined;
    try {
        sibling1 = db.prepare("SELECT version, agent, model FROM session LIMIT 1").get() as typeof sibling1;
    } catch {
        sibling1 = undefined;
    }
    try {
        sibling2 = db.prepare("SELECT version, agent, model FROM session_v2 LIMIT 1").get() as typeof sibling2;
    } catch {
        sibling2 = undefined;
    }

    const values: Record<string, string | number | null> = {
        id: pkg.tabId,
        project_id: projectId,
        slug: pkg.tabId,
        directory: dir,
        version: pkg.version ?? sibling1?.version ?? sibling2?.version ?? "unknown",
        time_created: now,
        time_updated: now,
    };
    if (columns.has("title")) values.title = pkg.title ?? fallbackTitle ?? pkg.tabId;
    if (columns.has("agent")) values.agent = pkg.agent ?? sibling1?.agent ?? sibling2?.agent ?? null;
    if (columns.has("model")) values.model = pkg.modelJson ?? sibling1?.model ?? sibling2?.model ?? null;

    const keys = Object.keys(values);
    db.prepare(`INSERT INTO session_v2 (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
        ...keys.map((key) => values[key]),
    );
    return true;
}

// 인계 적용 upsert. 탭 없으면 생성, 있으면 병합. id는 유지, 그릇은 로컬 맛보기.
// v1(message+part) ⇄ v2(session_message) 교차는 메시지+파트 행 단위 변환이다.
export function applyTabPackageUpsert(pkg: TabPackage, fallbackTitle?: string | null): { created: boolean; messages: number; parts: number } {
    const path = dbPath();
    if (!path) {
        throw new Error("opencode db not found");
    }
    const db = openSqlite(path);
    try {
        const exists = db.prepare("SELECT id FROM session WHERE id = ?").get(pkg.tabId) as { id: string } | undefined;
        let created = false;
        const now = Date.now();
        const dir = pkg.directory ?? process.cwd();
        if (!exists) {
            const proj =
                (db.prepare("SELECT id FROM project WHERE worktree = ?").get(dir) as { id: string } | undefined) ??
                (db.prepare("SELECT id FROM project LIMIT 1").get() as { id: string } | undefined);
            if (!proj) {
                throw new Error("no project row to attach the tab to");
            }
            const sibling = db.prepare("SELECT version, agent, model FROM session LIMIT 1").get() as
                | { version: string; agent: string | null; model: string | null }
                | undefined;
            db.prepare(
                "INSERT INTO session (id, project_id, slug, directory, title, version, agent, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
                pkg.tabId,
                proj.id,
                pkg.tabId,
                dir,
                pkg.title ?? fallbackTitle ?? pkg.tabId,
                pkg.version ?? sibling?.version ?? "unknown",
                pkg.agent ?? sibling?.agent ?? null,
                pkg.modelJson ?? sibling?.model ?? null,
                now,
                now,
            );
            created = true;
        } else {
            db.prepare("UPDATE session SET title = ?, time_updated = ? WHERE id = ?").run(
                pkg.title ?? fallbackTitle ?? pkg.tabId,
                now,
                pkg.tabId,
            );
        }
        // v2 부모가 없으면 이후 session_message 삽입이 FK 위반한다.
        // v1만 존재하고 v2가 누락된 채 pull된 실패 케이스도 이 보완으로 해소된다.
        const v2Created = ensureSessionV2Parent(db, pkg, dir, now, fallbackTitle);
        created = created || v2Created;
        const flavor: "v1" | "v2" = (() => {
            try {
                const r = db.prepare("SELECT COUNT(*) AS n FROM session_message").get() as { n: number };
                return r.n > 0 ? "v2" : "v1";
            } catch {
                return "v1";
            }
        })();
        let messages = 0;
        let parts = 0;
        // 그릇이 다르면 통째로 번역한다. id는 유지.
        let writeMessages = pkg.messages;
        let writeParts = pkg.parts;
        const srcFlavor = pkgFlavor(pkg);
        if (srcFlavor !== flavor) {
            const dirRow = db.prepare("SELECT directory FROM session WHERE id = ?").get(pkg.tabId) as
                | { directory: string }
                | undefined;
            const sib = db.prepare("SELECT agent, model FROM session LIMIT 1").get() as
                | { agent: string | null; model: string | null }
                | undefined;
            const modelObj = parseModel(pkg.modelJson ?? sib?.model ?? null);
            const cctx = {
                directory: pkg.directory ?? dirRow?.directory ?? dir,
                agent: pkg.agent ?? sib?.agent ?? "build",
                modelID: modelObj.id ?? "unknown",
                providerID: modelObj.providerID ?? "opencode",
                now,
            };
            const converted = srcFlavor === "v2" ? toV1(pkg, cctx) : toV2(pkg, cctx);
            writeMessages = converted.messages;
            writeParts = converted.parts;
            if (converted.skipped > 0) {
                console.log(`  skipped ${converted.skipped} rows (unknown shape)`);
            }
            if (flavor === "v1") {
                // 쓰기 전 게이트. 빠진 키가 있으면 기록하고 중단한다.
                let prevOk = false;
                for (const m of writeMessages) {
                    const problems = v1MessageProblems(m.data, prevOk);
                    if (problems.length > 0) {
                        throw new Error(`v1 gate: message ${m.id} missing ${problems.join(", ")}`);
                    }
                    prevOk = true;
                }
                for (const p of writeParts) {
                    const problems = v1PartProblems(p.data);
                    if (problems.length > 0) {
                        throw new Error(`v1 gate: part ${p.id} missing ${problems.join(", ")}`);
                    }
                }
            }
        }
        db.exec("BEGIN");
        try {
            if (flavor === "v2") {
                const maxRow = db.prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM session_message WHERE session_id = ?").get(pkg.tabId) as {
                    maxSeq: number;
                };
                let seq = maxRow.maxSeq;
                const putMsg = db.prepare(
                    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, data = excluded.data, time_updated = excluded.time_updated",
                );
                for (const m of writeMessages) {
                    seq += 1;
                    putMsg.run(m.id, pkg.tabId, m.type, seq, m.createdAt ?? now, m.updatedAt ?? now, m.data);
                    messages++;
                }
            } else {
                const putMsg = db.prepare(
                    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated",
                );
                let prevId: string | null = null;
                for (const m of writeMessages) {
                    const data = chainParent(m, prevId);
                    prevId = m.id;
                    if (!data) {
                        continue;
                    }
                    putMsg.run(m.id, pkg.tabId, m.createdAt ?? now, m.updatedAt ?? now, data);
                    messages++;
                }
            }
            const putPart = db.prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
            );
            for (const p of writeParts) {
                putPart.run(p.id, p.messageId, pkg.tabId, p.createdAt ?? now, p.updatedAt ?? now, p.data);
                parts++;
            }
            db.exec("COMMIT");
        } catch (err) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // 무시
            }
            throw err;
        }
        return { created, messages, parts };
    } finally {
        db.close();
    }
}

// v1 체인 규칙: assistant 행에 직전 id를 parentID로. user는 무부모.
function chainParent(m: TabMessage, prevId: string | null): string | null {
    let d: Record<string, unknown>;
    try {
        d = JSON.parse(m.data) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (d["role"] !== "assistant") {
        return m.data;
    }
    if (!prevId) {
        return m.data;
    }
    d["parentID"] = prevId;
    return JSON.stringify(d);
}

// pkg.modelJson 파싱. v2 객체 {id, providerID} 또는 v1 문자열.
function parseModel(modelJson?: string | null): { id: string | null; providerID: string | null } {
    if (!modelJson) {
        return { id: null, providerID: null };
    }
    try {
        const d = JSON.parse(modelJson) as { id?: unknown; providerID?: unknown };
        return {
            id: typeof d.id === "string" ? d.id : modelJson,
            providerID: typeof d.providerID === "string" ? d.providerID : null,
        };
    } catch {
        return { id: modelJson, providerID: null };
    }
}

// 마지막 assistant 호출 토큰 + 누적 메시지 횟수. 없으면 null/0.
export function sessionUsage(sessionID: string): SessionUsage {
    const empty: SessionUsage = {
        input: null,
        output: null,
        reasoning: null,
        cacheRead: null,
        cacheWrite: null,
        msgUser: 0,
        msgAssistant: 0,
    };
    const path = dbPath();
    if (!path) {
        return empty;
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const counts = db
            .prepare("SELECT type, COUNT(*) AS n FROM session_message WHERE session_id = ? GROUP BY type")
            .all(sessionID) as { type: string; n: number }[];
        for (const c of counts) {
            if (c.type === "user") {
                empty.msgUser = c.n;
            } else if (c.type === "assistant") {
                empty.msgAssistant = c.n;
            }
        }
        const last = db
            .prepare(
                "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' AND json_extract(data, '$.tokens') IS NOT NULL ORDER BY seq DESC LIMIT 1",
            )
            .all(sessionID) as { data: string }[];
        if (last.length > 0) {
            try {
                const t = (JSON.parse(last[0].data) as { tokens?: Record<string, unknown> }).tokens ?? {};
                const cache = (t.cache ?? {}) as Record<string, unknown>;
                const num = (v: unknown) => (typeof v === "number" ? v : null);
                empty.input = num(t.input);
                empty.output = num(t.output);
                empty.reasoning = num(t.reasoning);
                empty.cacheRead = num(cache.read);
                empty.cacheWrite = num(cache.write);
            } catch {
                // 부분 실패 무시
            }
        }
        return empty;
    } finally {
        db.close();
    }
}
export function readEpochRows(sessionID: string): ServerMessage[] {
    const path = dbPath();
    if (!path) {
        throw new Error("opencode db not found");
    }
    const db = openSqlite(path, { readOnly: true });
    try {
        const rows = db
            .prepare("SELECT id, type, time_created AS createdAt, data FROM session_message WHERE session_id = ? ORDER BY seq ASC")
            .all(sessionID) as { id: string; type: string; createdAt: number | null; data: string }[];
        let cut = 0;
        rows.forEach((r, i) => {
            if (r.type === "compaction") {
                cut = i;
            }
        });
        const out: ServerMessage[] = [];
        for (const r of rows.slice(cut)) {
            const m = toMessage(r);
            if (m) {
                out.push(m);
            }
        }
        return out;
    } finally {
        db.close();
    }
}
