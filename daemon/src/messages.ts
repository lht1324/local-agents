import { apiGet, type DiscoveredServer } from "./server";
import { formatToolExit } from "./tools";
import { cloudGet, cloudPost } from "./cloud";
import { isNewer, type Watermark } from "./watermark";
import { childSessionIds, readEpochRows, sessionParentId } from "./localdb";
import type { PlainRow, ServerMessage } from "./types";

// 서버에 저장된 마지막 행. 기준점은 이것 하나뿐이다
// (재설치·DB 초기화·다른 환경(dev/prod) 공존을 모두 견딘다).
async function readServerWatermark(sessionID: string): Promise<Watermark | null> {
    try {
        const body = (await cloudGet(
            `/api/daemon/messages/watermark?sessionID=${encodeURIComponent(sessionID)}`,
        )) as { data?: { createdAt?: unknown; messageId?: unknown } | null };
        const data = body.data;
        if (!data || typeof data.createdAt !== "number" || typeof data.messageId !== "string") {
            return null;
        }
        return { createdAt: data.createdAt, messageId: data.messageId };
    } catch {
        return null;
    }
}

function cap(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

function at(m: ServerMessage): number | null {
    return typeof m.time?.created === "number" ? m.time.created : null;
}

// 텍스트 항상, tool은 메타만, payload·첨부 제외.
export function flatten(messages: ServerMessage[]): PlainRow[] {
    const rows: PlainRow[] = [];
    messages.forEach((m, seq) => {
        if (typeof m.id !== "string" || m.id.length === 0) {
            return;
        }
        const createdAt = at(m);
        let part = 0;
        const key = () => (part === 0 ? m.id : `${m.id}#${part}`);
        if (m.type === "user") {
            const text = m.text ?? m.payload?.text ?? "";
            if (text.length > 0) {
                rows.push({ id: key(), seq, role: "user", kind: "text", body: cap(text, 8000), createdAt });
                part++;
            }
            const files = (m as { files?: { name?: string; mime?: string; data?: string }[] }).files ?? [];
            for (const f of files) {
                const kb = f.data ? Math.round(f.data.length / 1024) : 0;
                rows.push({ id: key(), seq, role: "user", kind: "file", body: `${f.name ?? "file"} (${f.mime ?? "?"}, ${kb}KB, on-demand)`, createdAt });
                part++;
            }
            return;
        }
        if (m.type === "assistant") {
            for (const block of m.content ?? []) {
                if (block.type === "text" && block.text && block.text.length > 0) {
                    rows.push({ id: key(), seq, role: "assistant", kind: "text", body: cap(block.text, 8000), createdAt });
                    part++;
                } else if (block.type === "tool") {
                    const toolName = block.name ?? "tool";
                    const outputs = block.state?.content ?? [];
                    const texts = outputs.filter((o) => o.type === "text").map((o) => o.text ?? "");
                    const exit = formatToolExit(toolName, texts.join("\n"));
                    const hasImage = outputs.some((o) => o.type === "file");
                    const raw = ((block.state?.input ?? {}) as Record<string, unknown>);
                    const kept: Record<string, unknown> = {};
                    const stripped: string[] = [];
                    for (const [ik, value] of Object.entries(raw)) {
                        if ((ik === "content" || ik === "data") && typeof value === "string" && value.length > 500) {
                            stripped.push(`${ik}:${Math.round(value.length / 1024)}KB`);
                            continue;
                        }
                        kept[ik] = value;
                    }
                    const envelope: Record<string, unknown> = { tool: toolName, input: kept };
                    if (stripped.length > 0) {
                        envelope.stripped = stripped;
                    }
                    if (exit) {
                        envelope.exit = exit;
                    }
                    if (hasImage) {
                        envelope.hasImage = true;
                    }
                    if (toolName === "question" && texts.length > 0) {
                        envelope.answer = cap(
                            texts.join(" ").replace(/^User has answered your questions:\s*/, ""),
                            500,
                        );
                    }
                    // edit 전문이 너무 길면 diff 생략. JSON 모양 유지 + 줄 수만 저장.
                    // 기준: old+new 합 16K 초과. 펼침 없음, 경로만 보인다.
                    if (toolName === "edit") {
                        const oldText = typeof kept.oldString === "string" ? kept.oldString : "";
                        const newText = typeof kept.newString === "string" ? kept.newString : "";
                        if (oldText.length + newText.length > 16384) {
                            envelope.truncated = true;
                            envelope.addedLines = newText.split("\n").length;
                            envelope.removedLines = oldText.split("\n").length;
                            delete (envelope.input as Record<string, unknown>).oldString;
                            delete (envelope.input as Record<string, unknown>).newString;
                        }
                    }
                    // 필드 단위로 자른다. 직렬화 뒤 자르면 JSON이 깨져 파싱 실패 → 날것 표시가 된다.
                    for (const [k, v] of Object.entries(envelope.input as Record<string, unknown>)) {
                        if (typeof v === "string" && v.length > 8000) {
                            (envelope.input as Record<string, unknown>)[k] = cap(v, 8000);
                        }
                    }
                    rows.push({ id: key(), seq, role: "assistant", kind: "tool", body: JSON.stringify(envelope), createdAt });
                    part++;
                }
            }
            return;
        }
        if (m.type === "compaction") {
            const summary = (m as { summary?: string }).summary ?? "";
            if (summary.length > 0) {
                rows.push({ id: key(), seq, role: "system", kind: "compaction", body: cap(summary, 8000), createdAt });
                part++;
            }
        }
    });
    return rows;
}

async function fetchMessages(server: DiscoveredServer, sessionID: string): Promise<ServerMessage[]> {
    const body = (await apiGet(server, `/session/${sessionID}/message?limit=200`)) as
        | { data?: ServerMessage[] }
        | ServerMessage[];
    const list = Array.isArray(body) ? body : (body.data ?? []);
    return [...list].reverse();
}

export async function syncMessages(server: DiscoveredServer, sessionID: string): Promise<{ rows: number }> {
    const messages = await fetchMessages(server, sessionID);
    const rows = flatten(messages);
    // 차집합: 기준점보다 새로운 행만 올린다. 기준점은 서버에 저장된 마지막 행 하나뿐이다.
    // 로컬 커서를 두지 않는 이유: 다른 환경(dev/prod)의 커서가 섞이면 기준점을 앞으로 당겨
    // 메시지를 조용히 누락시킨다. 재업로드는 onConflictDoNothing 이라 무해하므로
    // 기준점은 항상 서버 하나만 본다.
    const cursor = await readServerWatermark(sessionID);
    const fresh = rows.filter((r) => isNewer(r.createdAt, r.id, cursor));
    if (fresh.length === 0) {
        return { rows: 0 };
    }
    const result = (await cloudPost("/api/daemon/messages", {
        messages: fresh.map((r) => ({
            sessionID,
            messageId: r.id,
            seq: r.seq,
            role: r.role,
            kind: r.kind,
            body: r.body,
            createdAt: r.createdAt,
        })),
    })) as { data?: { rows?: number } };
    return { rows: result.data?.rows ?? fresh.length };
}

function bar(pct: number, width = 40): string {
    const filled = Math.round((pct / 100) * width);
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${pct}%`;
}

// 첫 로그인 backfill. 로컬 DB에서 현재 세션(epoch) 전부를 올린다. 제한 없음.
// compaction 경계까지 거슬러 올라간다. 200행씩 끊어 올리며 진행률 표시. 실패하면 호출 쪽이 API 창으로 폴백.
export async function backfillSession(
    server: DiscoveredServer,
    sessionID: string,
    label?: string,
    report?: (frac: number) => void,
    quiet?: boolean,
): Promise<{ rows: number }> {
    const messages = readEpochRows(sessionID);
    const rows = flatten(messages);
    const name = label ?? sessionID.slice(0, 12);
    if (rows.length === 0) {
        if (!quiet) {
            console.log(`  ${name} — nothing to sync.`);
        }
        return { rows: 0 };
    }
    if (!quiet) {
        process.stdout.write(`\r  ${name} ${bar(0)}`);
    }
    for (let i = 0; i < rows.length; i += 10) {
        const part = rows.slice(i, i + 10);
        await cloudPost("/api/daemon/messages", {
            messages: part.map((r, k) => ({
                sessionID,
                messageId: r.id,
                seq: i + k,
                role: r.role,
                kind: r.kind,
                body: r.body,
                createdAt: r.createdAt,
            })),
        });
        const done = Math.min(i + part.length, rows.length);
        if (report) {
            report(done / rows.length);
        } else if (!quiet) {
            process.stdout.write(`\r  ${name} ${bar(Math.floor((done / rows.length) * 100))}`);
        }
    }
    if (!quiet && !report) {
        process.stdout.write("\n");
    }
    return { rows: rows.length };
}

// 조건부 backfill. 클라우드에 없는 탭만 채운다. session_id 대조.
export async function backfillMissing(server: DiscoveredServer, only?: string[]): Promise<{ checked: number; filled: number; rows: number }> {
    const listed = (await cloudGet("/api/daemon/sync")) as { data?: { tabIds?: string[] } };
    const have = new Set(Array.isArray(listed.data?.tabIds) ? listed.data.tabIds : []);
    const body = (await apiGet(server, "/session")) as { data?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(body) ? body : (body.data ?? []);
    const wanted = only ? new Set(only) : null;
    let filled = 0;
    let rows = 0;
    const pending = list.filter((s) => typeof s.id === "string" && (wanted ? wanted.has(s.id) : !have.has(s.id)));
    if (pending.length > 0) {
        console.log("Please keep this window open until done.");
        console.log(`Syncing ${pending.length} session${pending.length === 1 ? "" : "s"}...`);
    }
    for (let i = 0; i < pending.length; i++) {
        const s = pending[i];
        let title: string | null = null;
        try {
            const detail = (await apiGet(server, `/session/${s.id}`)) as { data?: { title?: string } } | { title?: string };
            const row = (detail as { data?: { title?: string } }).data ?? detail;
            title = (row as { title?: string }).title ?? null;
        } catch {
            // 제목 없이 진행
        }
        console.log(`(${i + 1}/${pending.length}) ${title ?? s.id}`);
        try {
            const r = await backfillSession(server, s.id, title ?? undefined);
            filled++;
            rows += r.rows;
        } catch {
            console.log("  Something went wrong, skipped. It will retry later.");
        }
    }
    return { checked: list.length, filled, rows };
}

interface SessionListRow {
    id?: string;
    projectID?: string;
    time?: { updated?: number };
}

// 탭(project)별 현재 세션 하나씩만 본문 동기화한다.
// "세션 = 컨텍스트 사용량 구간"이므로, 지금 돌고 있는 대화만 미러링하면 충분하다.
// 지난 세션은 이미 올라간 행을 그대로 두고(freeze) 동기화만 멈춘다.
export async function syncCurrentSessions(server: DiscoveredServer): Promise<{ sessions: number; rows: number }> {
    const body = (await apiGet(server, "/session")) as { data?: SessionListRow[] } | SessionListRow[];
    const list = Array.isArray(body) ? body : (body.data ?? []);
    const latest = new Map<string, { id: string; updated: number }>();
    for (const s of list) {
        if (typeof s.id !== "string" || s.id.length === 0) {
            continue;
        }
        // 루트 세션만 "탭의 현재 세션" 후보. 자식은 부모를 통해 따라간다.
        if (sessionParentId(s.id) !== null) {
            continue;
        }
        const key = typeof s.projectID === "string" && s.projectID.length > 0 ? s.projectID : s.id;
        const updated = s.time?.updated ?? 0;
        const cur = latest.get(key);
        if (!cur || updated > cur.updated) {
            latest.set(key, { id: s.id, updated });
        }
    }
    // 루트 + 자식 서브트리 전체가 이번 주기의 동기화 대상이다.
    const targets: string[] = [];
    const seen = new Set<string>();
    const addSubtree = (id: string): void => {
        if (seen.has(id)) {
            return;
        }
        seen.add(id);
        targets.push(id);
        for (const child of childSessionIds(id)) {
            addSubtree(child);
        }
    };
    for (const item of latest.values()) {
        addSubtree(item.id);
    }

    let rows = 0;
    for (const id of targets) {
        try {
            rows += (await syncMessages(server, id)).rows;
        } catch {
            // 다음 주기가 잡는다
        }
    }
    // 웹의 live 표시용. 새 행이 없어도 "지금 미러링 중"임을 알린다.
    try {
        await cloudPost("/api/daemon/sessions/current", { sessionIds: targets });
    } catch {
        // 표시는 다음 주기에 다시 시도된다
    }
    return { sessions: targets.length, rows };
}
