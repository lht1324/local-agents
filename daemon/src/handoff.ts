import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { apiGet, type DiscoveredServer } from "./server";
import { cloudGet, cloudPost } from "./cloud";
import { baseUrl, readState } from "./device";
import { backfillSession } from "./messages";
import { applyTabPackageUpsert, dbPath, epochOf, latestOf, readTabPackage, sessionExists, type TabPackage } from "./localdb";
import { readPushMark, writePushMark } from "./pushstate";
import { getBytes, putBytes } from "./storage";

export interface HandoffVersion {
    tabId: string;
    title?: string | null;
    remote?: string | null;
    branch?: string | null;
    epoch: number;
    version: string;
    storageKey: string;
    baseHash: string;
    rowCount: number;
    pushMarkAt?: number | null;
    pushMarkId?: string | null;
    pushMarkSeq?: number | null;
    userMsgs?: number | null;
    aiMsgs?: number | null;
    sha256: string;
    receivedBy?: string | null;
    receivedAt?: string | null;
    createdAt?: string | null;
}

function sha256Hex(data: string): string {
    return createHash("sha256").update(data).digest("hex");
}

// 통째 스냅샷 포장. 불변 버전, 합치기 없음.
export function packTab(sessionID: string, since?: { at: number; id: string } | null): { bytes: Uint8Array; sha256: string; rowCount: number; baseHash: string; userMsgs: number; aiMsgs: number; remote: string | null; branch: string | null } | null {
    const pkg = readTabPackage(sessionID, since ?? null);
    if (!pkg) {
        return null;
    }
    const canonical = JSON.stringify(pkg);
    const baseHash = sha256Hex(
        JSON.stringify({ tabId: pkg.tabId, first: pkg.messages[0]?.id ?? null, count: pkg.messages.length }),
    );
    return {
        bytes: gzipSync(canonical),
        sha256: sha256Hex(canonical),
        rowCount: pkg.messages.length + pkg.parts.length,
        baseHash,
        userMsgs: pkg.messages.filter((m) => m.type === "user").length,
        aiMsgs: pkg.messages.filter((m) => m.type === "assistant").length,
        remote: pkg.repo?.remote ?? null,
        branch: pkg.repo?.branch ?? null,
    };
}

export function unpackTab(bytes: Uint8Array, sha256: string): TabPackage {
    const canonical = gunzipSync(bytes).toString("utf8");
    if (sha256Hex(canonical) !== sha256) {
        throw new Error("checksum mismatch. download again");
    }
    return JSON.parse(canonical) as TabPackage;
}

// push 본체. 함수라 자동화도 같은 걸 부른다.
export async function pushTabs(server: DiscoveredServer, sessionIDs: string[]): Promise<{ pushed: number; rows: number }> {
    const state = readState();
    if (!state) {
        throw new Error("not logged in. run `localagents login` first");
    }
    let pushed = 0;
    let rows = 0;
    for (let i = 0; i < sessionIDs.length; i++) {
        const sid = sessionIDs[i];
        let title: string | null = null;
        try {
            const detail = (await apiGet(server, `/session/${sid}`)) as { data?: { title?: string } } | { title?: string };
            const row = (detail as { data?: { title?: string } }).data ?? detail;
            title = (row as { title?: string }).title ?? null;
        } catch {
            // 제목 없이 진행
        }
        const name = title ?? sid.slice(0, 12);
        console.log(`Pushing (${i + 1}/${sessionIDs.length}) ${name}...`);
        const r = await pushOneTab(server, state.userId, sid, title, (frac) => putProgress(name, Math.round(frac * 100)));
        process.stdout.write("\n");
        if (r.skipped) {
            console.log(`  no new messages for ${name}.`);
            continue;
        }
        pushed++;
        rows += r.rows;
    }
    return { pushed, rows };
}

// 탭 1개 push. report 0→1.
export async function pushOneTab(
    server: DiscoveredServer,
    userId: string,
    sid: string,
    title: string | null,
    report?: (frac: number) => void,
): Promise<{ rows: number; skipped?: boolean }> {
    const show = report ?? ((pct01: number) => putProgress(sid.slice(0, 12), Math.round(pct01 * 100)));
    // DB에서 push mark 읽기 (로컬 push.json 사용 안 함)
    let dbPushMark: { at: number; id: string; seq: number } | null = null;
    try {
        const versions = await listVersions();
        const v = versions.find((x) => x.tabId === sid);
        if (v?.pushMarkAt && v?.pushMarkId) {
            dbPushMark = { at: v.pushMarkAt, id: v.pushMarkId, seq: v.pushMarkSeq ?? 0 };
            console.log(`  push mark (DB): at=${dbPushMark.at} id=${dbPushMark.id} seq=${dbPushMark.seq}`);
        } else {
            console.log(`  push mark (DB): none (first push)`);
        }
    } catch {
        // DB 읽기 실패 시 로컬 캐시 사용
        const local = readPushMark(sid);
        if (local) {
            dbPushMark = { at: local.at, id: local.id, seq: local.seq ?? 0 };
            console.log(`  push mark (local): at=${dbPushMark.at} id=${dbPushMark.id}`);
        } else {
            console.log(`  push mark: none (first push)`);
        }
    }
    const since = dbPushMark ? { at: dbPushMark.at, id: dbPushMark.id, seq: dbPushMark.seq } : null;
    const packed = packTab(sid, since);
    if (!packed) {
        console.log(`  no new messages.`);
        return { rows: 0, skipped: true } as { rows: number; skipped: boolean };
    }
    console.log(`  uploading ${packed.rowCount} messages`);
    const epoch = epochOf(sid);
    const { userMsgs, aiMsgs } = packed;
    const version = `${Date.now()}`;
    const key = `${userId}/${sid}/${epoch}/${version}.bin.gz`;
    show(0.3);
    await putBytes(key, packed.bytes);
    show(0.7);
    const latestMark = latestOf(sid);
    await cloudPost("/api/daemon/handoffs", {
        tabId: sid,
        title,
        userMsgs,
        aiMsgs,
        remote: packed.remote,
        branch: packed.branch,
        epoch,
        version,
        storageKey: key,
        baseHash: packed.baseHash,
        rowCount: packed.rowCount,
        sha256: packed.sha256,
        pushMarkAt: latestMark?.at ?? null,
        pushMarkId: latestMark?.id ?? null,
        pushMarkSeq: latestMark?.seq ?? null,
    });
    show(1);
    if (latestMark) {
        writePushMark(sid, latestMark.at, latestMark.id, latestMark.seq);
    }
    return { rows: packed.rowCount };
}

function putProgress(name: string, pct: number): void {
    const width = 40;
    const filled = Math.round((pct / 100) * width);
    process.stdout.write(`\r  ${name} [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${pct}%`);
}

// 탭 1개 통합 동기화. 바 1개: 거울 0→50, Storage 50→100. 채널 구분 노출 없음.
export async function syncOneTab(
    server: DiscoveredServer,
    userId: string,
    sid: string,
    label: string,
    title: string | null,
    draw: (frac: number) => void,
): Promise<void> {
    draw(0);
    await backfillSession(server, sid, label, (f) => draw(f * 0.5), true);
    await pushOneTab(server, userId, sid, title, (f) => draw(0.5 + f * 0.5));
    draw(1);
    process.stdout.write("\n");
    const newMark = latestOf(sid);
    if (newMark) {
        writePushMark(sid, newMark.at, newMark.id);
    }
}

// dump 진단. 정준 패키지를 Storage user_id/dump에 올리고 키만 뱉는다. 포인터 없음.
export async function dumpTab(server: DiscoveredServer, userId: string, sid: string): Promise<{ key: string; bytes: number }> {
    const packed = packTab(sid);
    if (!packed) {
        throw new Error("nothing to dump");
    }
    const key = `${userId}/dump/${sid}-${Date.now()}.bin.gz`;
    const res = await fetch(`${baseUrl()}/api/daemon/handoffs/url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${readState()?.token ?? ""}` },
        body: JSON.stringify({ operation: "upload", key }),
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
        throw new Error(`url rejected: ${res.status}`);
    }
    const body = (await res.json()) as { data?: { url?: string; method?: string; headers?: Record<string, string> } };
    const url = body.data?.url;
    if (!url) {
        throw new Error("presign returned no url");
    }
    const put = await fetch(url, {
        method: body.data?.method ?? "PUT",
        headers: { "Content-Type": "application/gzip", ...(body.data?.headers ?? {}) },
        body: Buffer.from(packed.bytes),
        signal: AbortSignal.timeout(120000),
    });
    if (!put.ok) {
        throw new Error(`upload rejected: ${put.status}`);
    }
    return { key, bytes: packed.bytes.length };
}
// pull 본체. 버전 고르기 → 받기 → upsert(없으면 생성) → 검증. 함수라 자동화도 같은 걸 부른다.
export async function pullVersion(version: HandoffVersion): Promise<{ created: boolean; messages: number; parts: number; title: string; conflict?: boolean; conflictMessage?: string }> {
    const name = version.title ?? version.tabId;
    putProgress(name, 10);
    const raw = await getBytes(version.storageKey);
    putProgress(name, 50);
    const pkg = unpackTab(raw, version.sha256);
    putProgress(name, 80);

    // 충돌 감지: 로컬에 이미 있는 메시지인데 내용이 다르면 덮어쓰지 않는다.
    // 메시지는 append-only이므로, 같은 ID = 같은 메시지여야 한다.
    if (sessionExists(version.tabId)) {
        const dbPath = (await import("./localdb.js")).dbPath();
        if (dbPath) {
            const { openSqlite } = await import("./sqlite.js");
            const db = openSqlite(dbPath, { readOnly: true });
            try {
                const localRows = db
                    .prepare("SELECT id, data FROM session_message WHERE session_id = ?")
                    .all(version.tabId) as { id: string; data: string }[];
                const localMap = new Map(localRows.map((r) => [r.id, r.data]));
                for (const m of pkg.messages) {
                    const local = localMap.get(m.id);
                    if (local && local !== m.data) {
                        putProgress(name, 100);
                        process.stdout.write("\n");
                        return {
                            created: false,
                            messages: 0,
                            parts: 0,
                            title: pkg.title ?? version.title ?? version.tabId,
                            conflict: true,
                            conflictMessage: `message ${m.id} differs between this PC and the remote version`,
                        };
                    }
                }
            } finally {
                db.close();
            }
        }
    }

    const applied = applyTabPackageUpsert(pkg, version.title);

    // DB에서 push mark 읽어서 로컬 push mark 설정
    if (version.pushMarkAt && version.pushMarkId) {
        writePushMark(version.tabId, version.pushMarkAt, version.pushMarkId, version.pushMarkSeq ?? 0);
    }


    await cloudPost("/api/daemon/handoffs", { receivedVersion: version.version });
    putProgress(name, 100);
    process.stdout.write("\n");
    return { ...applied, title: pkg.title ?? version.title ?? version.tabId, conflict: false };
}

export async function listVersions(): Promise<HandoffVersion[]> {
    const body = (await cloudGet("/api/daemon/handoffs")) as { data?: { versions?: HandoffVersion[] } };
    return body.data?.versions ?? [];
}

function ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// TTY 체크박스. 방향키 이동, 스페이스 토글, 엔터 확정, a 전체. 의존성 없음.
export async function checkboxPick(labels: string[], initial: boolean[]): Promise<number[]> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return initial.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    }
    const checked = [...initial];
    let cursor = Math.max(0, initial.findIndex((v) => v));
    const render = () => {
        let out = "";
        labels.forEach((label, i) => {
            out += `${i === cursor ? ">" : " "} [${checked[i] ? "x" : " "}] ${label}\n`;
        });
        return out;
    };
    process.stdout.write(render());
    const lines = labels.length;
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const cleanup = () => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
        };
        const redraw = () => {
            process.stdout.write(`\x1B[${lines}A\x1B[J${render()}`);
        };
        const onData = (key: Buffer) => {
            const s = key.toString();
            if (s === "\u0003") {
                cleanup();
                resolve([]);
            } else if (s === "\r" || s === "\n") {
                cleanup();
                resolve(checked.map((v, i) => (v ? i : -1)).filter((i) => i >= 0));
            } else if (s === " ") {
                checked[cursor] = !checked[cursor];
                redraw();
            } else if (s.toLowerCase() === "a") {
                const all = !checked.every((v) => v);
                for (let i = 0; i < checked.length; i++) {
                    checked[i] = all;
                }
                redraw();
            } else if (s.toLowerCase() === "n") {
                for (let i = 0; i < checked.length; i++) {
                    checked[i] = false;
                }
                redraw();
            } else if (s === "\u001b") {
                // Esc 단독. 방향키는 뒤에 바이트가 따라온다.
                setTimeout(() => {
                    cleanup();
                    resolve([]);
                }, 60);
            } else if (s === "\u001b[A") {
                cursor = (cursor - 1 + labels.length) % labels.length;
                redraw();
            } else if (s === "\u001b[B") {
                cursor = (cursor + 1) % labels.length;
                redraw();
            }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
}

// TTY 선택. 없으면(파이프·플래그) 묻지 않는다.
export async function pickNumbers(count: number, what: string): Promise<number[]> {
    if (!process.stdin.isTTY) {
        return [];
    }
    const answer = await ask(`Pick ${what} (e.g. 1 3, a = all, Enter = 1): `);
    if (answer.toLowerCase() === "a" || answer.toLowerCase() === "all") {
        return Array.from({ length: count }, (_, i) => i);
    }
    if (answer === "") {
        return [0];
    }
    return answer
        .split(/[\s,]+/)
        .map((n) => parseInt(n, 10) - 1)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < count);
}
