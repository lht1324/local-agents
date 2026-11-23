import { cloudGet, cloudPost } from "./cloud";
import {
    applySessionState,
    applyTabPackageUpsert,
    readRawMessages,
    readRawParts,
    readSessionState,
    type TabPackage,
} from "./localdb";

// 클라우드(session_message)와 로컬 SQLite 사이의 원본 행 동기화.
// 공유(share)된 세션 중 이 기기에 연동(link)된 것만 다룬다.

export interface SharedSession {
    sessionId: string;
    title: string | null;
    directory: string | null;
    parentId: string | null;
    linkedAt: string;
    updatedAt: string | null;
    deletedAt: string | null;
    downCursor: { timeCreated: number; id: string } | null;
    upCursor: { timeCreated: number } | null;
}

interface RawRow {
    id: string;
    type: string;
    timeCreated: number;
    timeUpdated: number | null;
    data: string;
    deviceId?: string;
}

interface RawPart {
    id: string;
    messageId: string;
    timeCreated: number;
    timeUpdated: number | null;
    data: string;
}

// 한 요청이 Worker 본문 제한(2MB)을 넘지 않도록 나눈다.
// JSON으로 감싸면 따옴표/개행이 이스케이프되어 커진다. 2MB 한도에 여유를 둔다.
const CHUNK_BYTES = 600_000;

export async function listShared(): Promise<SharedSession[]> {
    const body = (await cloudGet("/api/daemon/session-messages/shared")) as { data?: { sessions?: SharedSession[] } };
    return body.data?.sessions ?? [];
}

export interface ShareInfo {
    sessionId: string;
    title: string | null;
    directory: string | null;
    sharedAt: string;
    updatedAt: string | null;
}

// 사용자의 모든 공유 세션. link 선택기는 이 목록을 써야 한다 (연동 전 기기도 보여야 함).
export async function listShares(): Promise<ShareInfo[]> {
    const body = (await cloudGet("/api/daemon/session-messages/shares")) as { data?: { sessions?: ShareInfo[] } };
    return body.data?.sessions ?? [];
}

export async function shareSession(sessionId: string): Promise<void> {
    await cloudPost("/api/daemon/session-messages/share", { sessionId });
}

export async function linkSession(sessionId: string): Promise<void> {
    await cloudPost("/api/daemon/session-messages/link", { sessionId });
}

async function uploadWatermark(sessionId: string): Promise<{ timeCreated: number; id: string } | null> {
    const body = (await cloudGet(
        `/api/daemon/session-messages/watermark?sessionId=${encodeURIComponent(sessionId)}`,
    )) as { data?: { timeCreated: number; id: string } | null };
    return body.data ?? null;
}

// 로컬 행을 클라우드로 올린다. full=true면 처음부터 전부.
export async function uploadSession(sessionId: string, full = false): Promise<number> {
    const watermark = full ? null : await uploadWatermark(sessionId);
    const rows = readRawMessages(sessionId, watermark);
    const state = readSessionState(sessionId);
    if (rows.length === 0 && !state) {
        return 0;
    }
    let sent = 0;
    let batch: RawRow[] = [];
    let bytes = 0;

    const flush = async (): Promise<void> => {
        if (batch.length === 0) {
            return;
        }
        const ids = batch.map((row) => row.id);
        const parts = readRawParts(sessionId, ids);
        await cloudPost("/api/daemon/session-messages", {
            sessionId,
            messages: batch,
            parts,
            state: state
                ? {
                      title: state.title,
                      directory: state.directory,
                      agent: state.agent,
                      model: state.model,
                      revert: state.revert,
                      parentId: state.parentId,
                      updatedAt: state.updatedAt,
                  }
                : null,
        });
        sent += batch.length;
        batch = [];
        bytes = 0;
    };

    for (const row of rows) {
        const size = JSON.stringify(row.data).length + 256;
        if (bytes + size > CHUNK_BYTES && batch.length > 0) {
            await flush();
        }
        batch.push({
            id: row.id,
            type: row.type,
            timeCreated: row.createdAt,
            timeUpdated: row.updatedAt,
            data: row.data,
        });
        bytes += size;
    }
    await flush();
    return sent;
}

interface LogResponse {
    messages: RawRow[];
    parts: RawPart[];
    state: {
        title: string | null;
        directory: string | null;
        agent: string | null;
        model: string | null;
        revert: string | null;
        parentId: string | null;
        deletedAt: number | null;
        updatedAt: number;
    } | null;
    hasMore: boolean;
    nextCursor: { timeCreated: number; id: string } | null;
}

// 커서 이후 행을 받아 로컬 SQLite에 적용한다. 여러 페이지를 끝까지 받는다.
export async function downloadSession(
    sessionId: string,
    cursor: { timeCreated: number; id: string } | null,
    maxPages = 20,
): Promise<{ applied: number; title: string | null }> {
    let current = cursor;
    let applied = 0;
    let title: string | null = null;

    for (let page = 0; page < maxPages; page += 1) {
        const qs = new URLSearchParams({ sessionId, limit: "200" });
        if (current) {
            qs.set("sinceTime", String(current.timeCreated));
            qs.set("sinceId", current.id);
        }
        const body = (await cloudGet(`/api/daemon/session-messages?${qs.toString()}`)) as { data?: LogResponse };
        const data = body.data;
        if (!data) {
            break;
        }
        if (data.state?.title) {
            title = data.state.title;
        }
        if (data.state?.deletedAt) {
            // 원격에서 삭제된 세션은 로컬 데이터를 건드리지 않는다 (복구 여지를 남긴다).
            break;
        }
        if (data.messages.length > 0) {
            const local = readSessionState(sessionId);
            const directory = local?.directory ?? data.state?.directory ?? null;
            const pkg: TabPackage = {
                tabId: sessionId,
                exportedAt: Date.now(),
                flavor: "v2",
                title: data.state?.title ?? null,
                directory,
                repo: null,
                version: null,
                agent: data.state?.agent ?? null,
                modelJson: data.state?.model ?? null,
                messages: data.messages.map((m) => ({
                    id: m.id,
                    type: m.type,
                    seq: 0,
                    createdAt: m.timeCreated,
                    updatedAt: m.timeUpdated,
                    data: m.data,
                })),
                parts: data.parts.map((p) => ({
                    id: p.id,
                    messageId: p.messageId,
                    createdAt: p.timeCreated,
                    updatedAt: p.timeUpdated,
                    data: p.data,
                })),
            };
            applyTabPackageUpsert(pkg, data.state?.title ?? null);
            if (data.state) {
                applySessionState(sessionId, {
                    title: data.state.title,
                    agent: data.state.agent,
                    model: data.state.model,
                    revert: data.state.revert,
                });
            }
            applied += data.messages.length;
        } else if (data.state) {
            applySessionState(sessionId, {
                title: data.state.title,
                agent: data.state.agent,
                model: data.state.model,
                revert: data.state.revert,
            });
        }
        current = data.nextCursor ?? current;
        if (!data.hasMore) {
            break;
        }
    }
    return { applied, title };
}

export interface SyncResult {
    uploaded: number;
    applied: Array<{ sessionId: string; title: string | null; messages: number }>;
}

// 연동된 공유 세션 전체를 한 번 동기화한다. (올린 뒤 받는다)
export async function syncShared(): Promise<SyncResult> {
    const shared = await listShared();
    let uploaded = 0;
    const applied: SyncResult["applied"] = [];
    for (const session of shared) {
        try {
            uploaded += await uploadSession(session.sessionId);
        } catch {
            // 다음 주기가 잡는다
        }
        try {
            const result = await downloadSession(session.sessionId, session.downCursor);
            if (result.applied > 0) {
                applied.push({ sessionId: session.sessionId, title: result.title, messages: result.applied });
            }
        } catch {
            // 다음 주기가 잡는다
        }
    }
    return { uploaded, applied };
}
