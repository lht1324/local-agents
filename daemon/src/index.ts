#!/usr/bin/env node
import { apiGet, apiPost, discoverServer, type DiscoveredServer } from "./server";
import { cloudGet } from "./cloud";
import { hostInfo, readState, writeState, baseUrl, clearState } from "./device";
import { installPlugin, installService, stopService, uninstallService } from "./service";
import { forkAndRegister } from "./fork";
import { ensureServer, killOwned, type ManagedServer } from "./serve";
import { syncSessions } from "./sessions";
import { setSessionAgent, setSessionModel, syncCatalog, type ModelRef } from "./catalog";
import { backfillMissing, syncCurrentSessions, syncMessages } from "./messages";
import { checkboxPick, dumpTab, listVersions, pickNumbers, pullVersion, pushTabs, syncOneTab, type HandoffVersion } from "./handoff";
import { countAll, countNewer, epochOf, findLocalDirByRemote, localRoleCounts, repoForDirectory, sessionExists, setTabDirectory } from "./localdb";
import { askTyped, isDir, pickDirectory } from "./sysdialog";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readPushMark } from "./pushstate";
import { listPending, reply, pushPending, type ReplyDecision } from "./permissions";
import { pollCommands } from "./commands";

interface SessionRow {
    id: string;
    title?: string;
    outcome?: string;
    time?: { updated?: number };
}

async function requireServer(): Promise<DiscoveredServer> {
    const server = await discoverServer();
    if (!server) {
        throw new Error("no running opencode server found. start `opencode serve` or open the desktop app first");
    }
    return server;
}

function ago(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) {
        return `${s}s ago`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return `${m}m ago`;
    }
    const h = Math.floor(m / 60);
    if (h < 24) {
        return `${h}h ago`;
    }
    return `${Math.floor(h / 24)}d ago`;
}

async function onLogout(): Promise<void> {
    const { readState, clearState, baseUrl } = await import("./device.js");
    const state = readState();
    if (!state?.token) {
        throw new Error("not logged in. nothing to do");
    }
    // revoke 먼저. 실패하면 상태 유지 (살아있는 토큰 고아 방지).
    // 단 401은 서버에 세션이 없다는 뜻이라 로컬만 비운다.
    const res = await fetch(`${baseUrl()}/api/daemon/device/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) {
        clearState();
        console.log("already logged out.");
        return;
    }
    if (!res.ok) {
        throw new Error(`revoke rejected: ${res.status}. state kept, try again online`);
    }
    clearState();
    console.log("logged out.");
    // 토큰이 없는 데몬이 계속 돌면 401만 반복한다. 유닛은 남기고 프로세스만 멈춘다.
    const stopped = stopService();
    if (stopped.ok) {
        console.log("background service stopped. run `localagents login` to start it again.");
    }
}

// 프로그램 제거. 서비스·복사본·상태를 모두 지운다 (logout과 다르다).
async function onUninstall(): Promise<void> {
    const state = readState();
    if (state?.token) {
        try {
            await fetch(`${baseUrl()}/api/daemon/device/revoke`, {
                method: "POST",
                headers: { Authorization: `Bearer ${state.token}` },
                signal: AbortSignal.timeout(10000),
            });
        } catch {
            // 오프라인이어도 제거는 진행한다.
        }
    }
    const service = uninstallService();
    clearState();
    console.log(service.message);
    console.log("localagents is no longer running on this machine.");
}

async function onServiceInstall(): Promise<void> {
    const res = installService();
    console.log(res.message);
    if (!res.ok) {
        process.exitCode = 1;
    }
}

// 토큰 사전 검증. 죽은 토큰이면 작업 전에 로그인 메시지로 끝낸다.
async function ensureAuth(): Promise<{ deviceId: string; userId: string; token: string }> {
    const { readState, baseUrl } = await import("./device.js");
    const state = readState();
    if (!state?.token) {
        throw new Error("not logged in. run `localagents login` first");
    }
    let res: Response;
    try {
        res = await fetch(`${baseUrl()}/api/daemon/whoami`, {
            headers: { Authorization: `Bearer ${state.token}` },
            signal: AbortSignal.timeout(10000),
        });
    } catch {
        throw new Error("cloud unreachable. check your connection");
    }
    if (res.status === 401) {
        throw new Error("not logged in. run `localagents login` first");
    }
    if (!res.ok) {
        throw new Error(`cloud rejected auth check: ${res.status}`);
    }
    return { deviceId: state.deviceId, userId: state.userId, token: state.token };
}

async function onPush(ids: string[]): Promise<void> {
    await ensureAuth();
    const server = await ensureServer();
    const clean = ids.filter((a) => a !== "--all" && a !== "--jaeholee");
    const all = ids.includes("--all");
    let targets = clean;
    if (targets.length === 0 && !all) {
        const body = (await apiGet(server, "/session")) as
            | { data?: { id: string; time?: { updated?: number } }[] }
            | { id: string; time?: { updated?: number } }[];
        const list = (Array.isArray(body) ? body : (body.data ?? [])).filter((s) => typeof s.id === "string");
        const sorted = [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
        if (sorted.length === 0) {
            console.log("no tabs.");
            return;
        }
        const titles: string[] = [];
        const dirties: number[] = [];
        for (const s of sorted) {
            let title: string | null = null;
            try {
                const detail = (await apiGet(server, `/session/${s.id}`)) as { data?: { title?: string } } | { title?: string };
                const row = (detail as { data?: { title?: string } }).data ?? detail;
                title = (row as { title?: string }).title ?? null;
            } catch {
                // id로 표시
            }
            titles.push(title ?? s.id);
            let dirty = 0;
            try {
                const mark = readPushMark(s.id);
                dirty = mark ? countNewer(s.id, mark.at, mark.id) : countAll(s.id);
            } catch {
                // 0으로 표시
            }
            dirties.push(dirty);
        }
        console.log("Pick tabs to push (space: toggle, a: all, n: none, Esc: cancel, Enter: confirm):");
        const picked = await checkboxPick(
            [...titles.map((t, i) => `${t} (${dirties[i]} new)`), "Not now"],
            titles.map(() => false),
        );
        targets = picked.filter((i) => i < sorted.length).map((i) => sorted[i].id);
        if (picked.includes(titles.length) || targets.length === 0) {
            console.log("Nothing picked.");
            return;
        }
    } else if (all) {
        const body = (await apiGet(server, "/session")) as { data?: { id: string }[] } | { id: string }[];
        const list = Array.isArray(body) ? body : (body.data ?? []);
        targets = list.map((s) => s.id).filter((id) => typeof id === "string");
    }
    const result = await pushTabs(server, targets);
    // 같은 동작 1회에 거울 DB도 채운다. 자동과 겹치지만 단일 상태가 우선.
    await backfillMissing(server, targets);
    console.log(`Done: ${result.pushed} tabs pushed and synced.`);
}

async function onPull(): Promise<void> {
    await ensureAuth();
    const versions = await listVersions();
    // 탭별 최신 1건으로 묶어 수정일 내림차순. 받은 건(내 기기) 숨김.
    const state = readState();
    const mine = state?.deviceId ?? "";
    const latest = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
        // 받은 건 숨김. 단 로컬에 탭이 없으면(지웠으면) 다시 보여준다.
        if (v.receivedBy === mine && sessionExists(v.tabId)) {
            continue;
        }
        const cur = latest.get(v.tabId);
        if (!cur || (v.createdAt ?? "") > (cur.createdAt ?? "")) {
            latest.set(v.tabId, v);
        }
    }
    const tabs = [...latest.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    if (tabs.length === 0) {
        console.log("Nothing to pull.");
        return;
    }
    console.log("Pick tabs to pull (space: toggle, a: all, n: none, Esc: cancel, Enter: confirm):");
    const labels = tabs.map((v) => {
        const name = v.title ?? v.tabId.slice(0, 12);
        if (v.userMsgs == null && v.aiMsgs == null) {
            return `${name} (${v.rowCount} rows)`;
        }
        const local = sessionExists(v.tabId) ? localRoleCounts(v.tabId) : null;
        const du = Math.max(0, (v.userMsgs ?? 0) - (local?.user ?? 0));
        const da = Math.max(0, (v.aiMsgs ?? 0) - (local?.ai ?? 0));
        return `${name} (AI +${da} · User +${du})`;
    });
    const picked = await checkboxPick(
        labels,
        tabs.map((_, i) => i === 0),
    );
    if (picked.length === 0) {
        console.log("Nothing picked.");
        return;
    }
    for (const n of picked) {
        const version = tabs[n] ?? tabs[0];
        // diff 모델: epoch 가드 대신 충돌 판정. 새 메시지만 적용된다.
        const dir = await resolveTabDir(version.remote ?? null, version.title ?? version.tabId);
        if (!dir) {
            console.log(`Skipped ${version.title ?? version.tabId}: no folder.`);
            continue;
        }
        const applied = await pullVersion(version);
        if (applied.conflict) {
            console.log(`Conflict on ${version.title ?? version.tabId}: ${applied.conflictMessage}`);
            console.log("Resolve manually before pulling again.");
            continue;
        }
        try {
            setTabDirectory(version.tabId, dir);
        } catch {
            // 폴더 지정 실패해도 내용은 들어감
        }
        console.log(applied.created ? `Created new tab ${applied.title} in ${dir}.` : `Updated local tab ${applied.title} (${dir}).`);
        console.log(`Done: ${applied.messages} messages, ${applied.parts} parts applied.`);
    }
}

// 작업폴더 확정. 자동 매칭 → 새로/기존 → 선택기/clone/검증.
async function resolveTabDir(remote: string | null, label: string): Promise<string | null> {
    if (remote) {
        const match = findLocalDirByRemote(remote);
        if (match) {
            console.log(`Matched folder: ${match}`);
            return match;
        }
    }
    console.log(`No local folder for ${label}${remote ? ` (${remote})` : ""}.`);
    const choice = (await askTyped("New clone or existing folder? [new/existing]: ")).toLowerCase();
    if (choice.startsWith("e")) {
        const dir = await pickDirectory();
        if (!dir || !isDir(dir)) {
            return null;
        }
        if (remote) {
            const got = repoForDirectory(dir).remote;
            if (got !== remote) {
                console.log(`Stopped: folder remote is ${got ?? "none"}, expected ${remote}.`);
                return null;
            }
        }
        return dir;
    }
    if (!remote) {
        return null;
    }
    const parent = await pickDirectory();
    if (!parent || !isDir(parent)) {
        return null;
    }
    const name = remote.split("/").pop()?.replace(/\.git$/, "") ?? "repo";
    const target = join(parent, name);
    console.log(`Cloning into ${target}...`);
    try {
        execSync(`git clone "${remote}" "${target}"`, { timeout: 300000, stdio: "inherit" });
    } catch {
        console.log("Clone failed.");
        return null;
    }
    return target;
}

async function onDump(sessionID: string | undefined): Promise<void> {
    if (!sessionID) {
        throw new Error("usage: localagents dump <session-id>");
    }
    const state = readState();
    if (!state) {
        throw new Error("not logged in. run `localagents login` first");
    }
    const server = await ensureServer();
    const result = await dumpTab(server, state.userId, sessionID);
    console.log(`dumped: ${result.key} (${result.bytes} bytes)`);
}

async function onWhoami(): Promise<void> {
    const state = readState();
    if (!state?.token) {
        throw new Error("not logged in. run `localagents login` first");
    }
    const res = await fetch(`${baseUrl()}/api/daemon/whoami`, {
        headers: { Authorization: `Bearer ${state.token}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`whoami rejected: ${res.status}`);
    }
    const body = (await res.json()) as { data?: { email?: string | null; planId?: string } };
    console.log(`email: ${body.data?.email ?? "?"}`);
    console.log(`plan: ${body.data?.planId ?? "?"}`);
}

async function onStatus(): Promise<void> {
    const state = readState();
    if (!state) {
        throw new Error("not logged in. run `localagents login` first");
    }
    const host = hostInfo();
    console.log(`device: ${host.label}`);
    let server = "unreachable";
    try {
        const found = await discoverServer();
        if (found) {
            server = "ok";
        }
    } catch {
        // unreachable 유지
    }
    console.log(`server: ${server}`);
    console.log(`last sync: ${state.lastOkAt ? ago(Date.now() - state.lastOkAt) : "never"}`);
    if (!state.token) {
        console.log("pending: unknown (no token)");
        return;
    }
    // 401이면 로컬 상태에 죽은 토큰이 남아 있다는 뜻이다 (해제·회전). 안내를 위해 기억한다.
    let unauthorized = false;
    try {
        const res = await fetch(`${baseUrl()}/api/daemon/commands/pending`, {
            headers: { Authorization: `Bearer ${state.token}` },
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401) {
            unauthorized = true;
            console.log("pending: unknown (not logged in)");
        } else if (res.status === 403) {
            console.log("pending: unknown (subscription required)");
        } else if (!res.ok) {
            console.log(`pending: unknown (http ${res.status})`);
        } else {
            const body = (await res.json()) as { data?: { pending?: number } };
            console.log(`pending: ${body.data?.pending ?? "?"} commands`);
        }
    } catch {
        console.log("pending: unknown (cloud unreachable)");
    }
    // 과금 상태. 403이면 트라이얼 종료 — 구독 안내를 붙인다.
    try {
        const res = await fetch(`${baseUrl()}/api/daemon/billing/status`, {
            headers: { Authorization: `Bearer ${state.token}` },
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401) {
            unauthorized = true;
            console.log("billing: unknown (not logged in)");
        } else if (res.status === 403) {
            console.log("billing: Subscription ended. Subscribe at localagents.link");
        } else if (!res.ok) {
            console.log(`billing: unknown (http ${res.status})`);
        } else {
            const body = (await res.json()) as {
                data?: { active?: boolean; daysLeft?: number | null; cancelAtPeriodEnd?: boolean; currentPeriodEnd?: string | null };
            };
            if (body.data?.active) {
                if (body.data.cancelAtPeriodEnd && body.data.currentPeriodEnd) {
                    const end = new Date(body.data.currentPeriodEnd);
                    const date = Number.isNaN(end.getTime()) ? "period end" : end.toISOString().slice(0, 10);
                    console.log(`billing: Pro, cancels at ${date}`);
                } else {
                    console.log("billing: Pro");
                }
            } else if (body.data?.daysLeft === 0) {
                console.log("billing: Subscription ended. Subscribe at localagents.link");
            } else if (typeof body.data?.daysLeft === "number") {
                console.log(`billing: Trial, ${body.data.daysLeft} days left`);
            }
        }
    } catch {
        console.log("billing: unknown (cloud unreachable)");
    }
    if (unauthorized) {
        console.log("hint: this device is no longer signed in. run `localagents login` to reconnect.");
    }
}

async function onSessions(): Promise<void> {
    const server = await ensureServer();
    const body = (await apiGet(server, "/session")) as { data?: SessionRow[] } | SessionRow[];
    const sessions = Array.isArray(body) ? body : (body.data ?? []);
    for (const s of sessions) {
        console.log(`${s.id}\t${s.title ?? s.outcome ?? "(untitled)"}`);
    }
    console.log(`total: ${sessions.length}`);
}

async function onLogin(): Promise<void> {
    const { createServer } = await import("node:http");
    const { exec } = await import("node:child_process");
    const { platform } = await import("node:os");
    const { stableDeviceId, writeState, hostInfo, baseUrl, readState } = await import("./device.js");
    const existing = readState();
    if (existing?.token) {
        try {
            const check = await fetch(`${baseUrl()}/api/daemon/whoami`, {
                headers: { Authorization: `Bearer ${existing.token}` },
                signal: AbortSignal.timeout(10000),
            });
            if (check.ok) {
                let email: string | null = null;
                try {
                    const who = (await check.json()) as { data?: { email?: string | null } };
                    email = who.data?.email ?? null;
                } catch {
                    // id로 표시
                }
                console.log(`already logged in${email ? ` as ${email}` : ""}. run \`localagents logout\` first to switch.`);
                return;
            }
        } catch {
            // 죽은 토큰이면 재로그인 진행
        }
    }
    const deviceId = stableDeviceId();
    const host = hostInfo();
    const state = Math.random().toString(36).slice(2, 10);
    const received = await new Promise<{ token: string }>((resolve, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname !== "/callback") {
                res.writeHead(404);
                res.end();
                return;
            }
            const token = url.searchParams.get("token") ?? "";
            const returned = url.searchParams.get("state") ?? "";
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Connected. You can close this tab and return to the terminal.");
            server.close();
            if (returned !== state || token.length === 0) {
                reject(new Error("invalid callback. try again"));
                return;
            }
            resolve({ token });
        });
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            const base = baseUrl().replace(/\/$/, "");
            const params = new URLSearchParams({
                device: deviceId,
                port: String(port),
                state,
                label: host.label,
                platform: host.platform,
                hostname: host.hostname,
            });
            // 사전 포장. 브라우저 주소창에 평문이 일순도 안 뜨게 한다. 실패하면 평문 폴백.
            fetch(`${base}/api/pairing/pack`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    device: deviceId,
                    port: String(port),
                    state,
                    label: host.label,
                    platform: host.platform,
                    hostname: host.hostname,
                }),
                signal: AbortSignal.timeout(10000),
            })
                .then(async (res) => {
                    if (!res.ok) {
                        return null;
                    }
                    const packed = (await res.json()) as { data?: { data?: string } };
                    return packed.data?.data ?? null;
                })
                .catch(() => null)
                .then((data) => {
                    const target = data
                        ? `${base}/api/pairing/begin?data=${encodeURIComponent(data)}`
                        : `${base}/api/pairing/begin?${params.toString()}`;
                    const opener =
                        platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
                    exec(`${opener} "${target}"`);
                    console.log("opened browser. approve this device, then return here.");
                    console.log(`if the browser did not open, visit:\n${target}`);
                });
        });
        setTimeout(() => {
            server.close();
            reject(new Error("timed out waiting for browser. try again"));
        }, 5 * 60 * 1000).unref?.();
    }).catch((err: unknown) => {
        throw err;
    });
    const who = await fetch(`${baseUrl()}/api/daemon/whoami`, {
        headers: { Authorization: `Bearer ${received.token}` },
        signal: AbortSignal.timeout(10000),
    });
    if (!who.ok) {
        throw new Error(`whoami rejected: ${who.status}`);
    }
    const body = (await who.json()) as { data?: { userId?: string } };
    const userId = body.data?.userId;
    if (!userId) {
        throw new Error("whoami returned no user");
    }
    writeState({ deviceId, userId, token: received.token });
    console.log(`logged in: ${deviceId} (${host.label})`);
    // 첫 동기화. 웹에 세션이 바로 뜨게 한다. 실패해도 로그인은 유효, 수동 sync로 메움.
    try {
        await onHeartbeat();
        const syncedServer = await ensureServer();
        const sessions = await syncSessions(syncedServer, true);
        // 조건부 backfill. 전부 보여주고 없는 것만 기본 체크. DB 유무는 표시만.
        const listed = (await cloudGet("/api/daemon/sync")) as { data?: { tabIds?: string[] } };
        const have = new Set(Array.isArray(listed.data?.tabIds) ? listed.data.tabIds : []);
        const body = (await apiGet(syncedServer, "/session")) as { data?: { id: string }[] } | { id: string }[];
        const all = (Array.isArray(body) ? body : (body.data ?? [])).filter((s) => typeof s.id === "string");
        let picked: string[] | null = null;
        if (all.length > 0 && process.stdin.isTTY) {
            const titles: string[] = [];
            const flags: boolean[] = [];
            for (const s of all) {
                const synced = have.has(s.id);
                let title: string | null = null;
                try {
                    const detail = (await apiGet(syncedServer, `/session/${s.id}`)) as
                        | { data?: { title?: string } }
                        | { title?: string };
                    const row = (detail as { data?: { title?: string } }).data ?? detail;
                    title = (row as { title?: string }).title ?? null;
                } catch {
                    // id로 표시
                }
                titles.push(synced ? `${title ?? s.id} (synced)` : (title ?? s.id));
                flags.push(!synced);
            }
            console.log("Pick sessions to sync (space: toggle, a: all, n: none, Esc: cancel, Enter: confirm):");
            const nums = await checkboxPick([...titles, "Not now"], [...flags, false]);
            if (nums.includes(titles.length)) {
                console.log("Nothing picked.");
                picked = [];
            } else {
                picked = nums.filter((i) => i < all.length).map((i) => all[i].id);
                if (picked.length === 0) {
                    console.log("Nothing picked.");
                }
            }
        }
        if (picked === null || picked.length > 0) {
            const ids = picked ?? all.filter((s) => !have.has(s.id)).map((s) => s.id);
            const nameOf = new Map<string, string>();
            for (const sid of ids) {
                let title: string | null = null;
                try {
                    const detail = (await apiGet(syncedServer, `/session/${sid}`)) as
                        | { data?: { title?: string } }
                        | { title?: string };
                    const row = (detail as { data?: { title?: string } }).data ?? detail;
                    title = (row as { title?: string }).title ?? null;
                } catch {
                    // id로 표시
                }
                nameOf.set(sid, title ?? sid);
            }
            const items = ids.map((sid) => ({ sid, title: nameOf.get(sid) ?? sid }));
            console.log("Please keep this window open until done.");
            let done = 0;
            for (const item of items) {
                done++;
                console.log(`(${done}/${items.length}) ${item.title}`);
                const draw = (frac: number) => {
                    const pct = Math.floor(frac * 100);
                    const width = 40;
                    const filled = Math.round((pct / 100) * width);
                    process.stdout.write(`\r  ${item.title} [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${pct}%`);
                };
                await syncOneTab(syncedServer, userId, item.sid, item.title, item.title, draw);
            }
            console.log(`Done: ${items.length} sessions synced.`);
        } else {
            console.log(`Done: ${sessions.sessions} sessions found.`);
        }
    } catch (err) {
        console.error(`initial sync failed: ${err instanceof Error ? err.message : err}`);
    }
    // OpenCode 플러그인. 있으면 이벤트 기반 즉시 동기화가 동작한다.
    // 서비스를 건너뛰어도 플러그인은 설치한다 (터미널에서 run 하는 사용자도 혜택).
    const plugin = installPlugin();
    if (!plugin.ok) {
        console.log(`opencode plugin was not installed: ${plugin.message}`);
    }
    // 백그라운드 상주 등록. 실패해도 로그인은 유효하다 (초기 sync는 이미 끝났다).
    if (process.argv.includes("--no-service")) {
        console.log("background service skipped (--no-service).");
        return;
    }
    const service = installService();
    if (service.ok) {
        console.log(`${service.message}. keeps syncing after you close the terminal.`);
        console.log("to remove: localagents uninstall");
    } else {
        console.log(`background service was not installed: ${service.message}`);
        console.log("fix later with: localagents service install");
    }
}

async function onFork(sessionID: string | undefined): Promise<void> {
    if (!sessionID) {
        throw new Error("usage: localagents fork <session-id>");
    }
    const server = await ensureServer();
    const id = await forkAndRegister(server, sessionID);
    console.log(`forked: ${id}`);
}

async function onSyncMessages(sessionID: string | undefined): Promise<void> {
    if (!sessionID) {
        throw new Error("usage: localagents sync-messages <session-id>");
    }
    const server = await ensureServer();
    const result = await syncMessages(server, sessionID);
    console.log(`synced: ${result.rows} rows`);
}

async function onSync(): Promise<void> {
    const server = await ensureServer();
    const result = await pushPending(server);
    console.log(`pushed: ${result.open} open`);
}

async function onSyncModels(): Promise<void> {
    const server = await ensureServer();
    const result = await syncCatalog(server);
    console.log(`catalog: ${result.models} models, ${result.agents} agents`);
}

async function onSyncSessions(): Promise<void> {
    const server = await ensureServer();
    const result = await syncSessions(server);
    console.log(`sessions: ${result.sessions}`);
}

async function onDoctor(): Promise<void> {
    const lines: string[] = [];
    try {
        const server = await requireServer();
        lines.push(`server: ok (${server.url}${server.version ? ` v${server.version}` : ""})`);
        try {
            const sessions = (await apiGet(server, "/session")) as { data?: unknown[] } | unknown[];
            const count = Array.isArray(sessions) ? sessions.length : (sessions.data?.length ?? 0);
            lines.push(`sessions: ok (${count})`);
        } catch (err) {
            lines.push(`sessions: FAIL (${err instanceof Error ? err.message : err})`);
        }
    } catch (err) {
        lines.push(`server: FAIL (${err instanceof Error ? err.message : err})`);
    }
    try {
        const state = readState();
        lines.push(state ? `state: ok (${state.deviceId})` : "state: FAIL (not registered)");
    } catch (err) {
        lines.push(`state: FAIL (${err instanceof Error ? err.message : err})`);
    }
    try {
        const state = readState();
        if (!state?.token) {
            lines.push("cloud: FAIL (no device token)");
        } else {
            const res = await fetch(`${baseUrl()}/api/daemon/heartbeat`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
                body: JSON.stringify({}),
                signal: AbortSignal.timeout(10000),
            });
            lines.push(res.ok ? "cloud: ok (api)" : `cloud: FAIL (${res.status})`);
        }
    } catch (err) {
        lines.push(`cloud: FAIL (${err instanceof Error ? err.message : err})`);
    }
    for (const line of lines) {
        console.log(line);
    }
}
let updateWarned = false;

// "1.2.3" 형태 비교. 형식이 다르면 false(경고하지 않음).
function isOlder(current: string, minimum: string): boolean {
    const a = current.split(".").map((n) => Number(n));
    const b = minimum.split(".").map((n) => Number(n));
    if (a.some((n) => Number.isNaN(n)) || b.some((n) => Number.isNaN(n))) {
        return false;
    }
    for (let i = 0; i < 3; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) {
            return x < y;
        }
    }
    return false;
}

async function onHeartbeat(quiet = false): Promise<number> {
    const state = readState();
    if (!state) {
        throw new Error("not registered. run `localagents login` first");
    }
    if (!state.token) {
        throw new Error("no device token. run `localagents login` again");
    }
    const host = hostInfo();
    const res = await fetch(`${baseUrl()}/api/daemon/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ platform: host.platform, hostname: host.hostname, label: host.label }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`heartbeat rejected: ${res.status}`);
    }
    const body = (await res.json()) as { data?: { intervalSec?: number; minVersion?: string } };
    const intervalSec = body.data?.intervalSec;
    const minVersion = body.data?.minVersion;
    if (minVersion && isOlder(VERSION, minVersion) && !updateWarned) {
        updateWarned = true;
        console.log(
            `update required: ${VERSION} is older than ${minVersion}. run: npx localagents@latest login`,
        );
    }
    if (!quiet) {
        console.log(`heartbeat: ${state.deviceId} (${host.label}) via api`);
    }
    return typeof intervalSec === "number" && intervalSec > 0 ? intervalSec : 1800;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 상주 루프. heartbeat·sync·poll을 주기마다 순서대로. 1개 실패해도 계속.
async function autoPull(server: DiscoveredServer): Promise<void> {
    const versions = await listVersions();
    const state = readState();
    const mine = state?.deviceId ?? "";
    const latest = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
        if (v.receivedBy === mine && sessionExists(v.tabId)) {
            continue;
        }
        const cur = latest.get(v.tabId);
        if (!cur || (v.createdAt ?? "") > (cur.createdAt ?? "")) {
            latest.set(v.tabId, v);
        }
    }
    for (const v of latest.values()) {
        if (!sessionExists(v.tabId)) {
            continue; // 새 탭은 수동 pull (폴더 결정 필요)
        }
        try {
            const applied = await pullVersion(v);
            if (applied.conflict) {
                console.log(`auto-pull conflict on ${v.title ?? v.tabId}: ${applied.conflictMessage}`);
            } else if (applied.messages > 0) {
                console.log(`auto-pull: ${applied.title} +${applied.messages} messages`);
            }
        } catch (err) {
            // 조용히 실패 (다음 주기에 재시도)
        }
    }
}

async function onRun(): Promise<void> {
    let stopping = false;
    const stop = () => {
        stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // 미로그인 대기. crash-loop 대신 login을 기다린다.
    let state = readState();
    while (!stopping && (!state || !state.token)) {
        console.log("run: waiting for `localagents login`...");
        const deadline = Date.now() + 30000;
        while (!stopping && Date.now() < deadline) {
            await sleep(Math.min(1000, deadline - Date.now()));
        }
        state = readState();
    }
    if (stopping || !state?.token) {
        return;
    }
    console.log(`run: device=${state.deviceId}`);
    let intervalSec = 1800;
    let lastSlow = 0;
    // 구독 게이트에 막힌 상태. 403이 반복되면 안내를 한 번만 하고 폴링 간격을 늘린다.
    let blocked = false;
    let blockedNotice = false;
    const isBlocked = (err: unknown): boolean => /\b403\b/.test(err instanceof Error ? err.message : String(err));
    const noteBlocked = (): void => {
        blocked = true;
        if (!blockedNotice) {
            blockedNotice = true;
            console.log("subscription ended. syncing paused. subscribe at localagents.link");
        }
    };
    let owned: ManagedServer | null = null;
    try {
        owned = await ensureServer();
        if (owned.child) {
            console.log(`run: spawned server at ${owned.url}`);
        }
    } catch (err) {
        console.error(`server ensure failed: ${err instanceof Error ? err.message : err}`);
    }
    while (!stopping) {
        const now = Date.now();
        // 느린 층: 플랜 주기. heartbeat·거울·카탈로그·안전망. 무겁다.
        if (now - lastSlow >= intervalSec * 1000) {
            lastSlow = now;
            try {
                intervalSec = await onHeartbeat();
            } catch (err) {
                console.error(`heartbeat failed: ${err instanceof Error ? err.message : err}`);
            }
            try {
                const server = await ensureServer();
                await pushPending(server);
                await syncSessions(server);
                await syncCatalog(server);
                const current = await syncCurrentSessions(server);
                blocked = false;
                blockedNotice = false;
                if (current.sessions > 0) {
                    console.log(`current-sessions: ${current.sessions} sessions, ${current.rows} rows`);
                }
                // auto-pull: 로컬에 이미 있는 탭에 대해 충돌 없는 새 메시지만 자동 적용.
                try {
                    await autoPull(server);
                } catch (err) {
                    if (isBlocked(err)) {
                        noteBlocked();
                    } else {
                        console.error(`auto-pull failed: ${err instanceof Error ? err.message : err}`);
                    }
                }
            } catch (err) {
                if (isBlocked(err)) {
                    noteBlocked();
                } else {
                    console.error(`sync failed: ${err instanceof Error ? err.message : err}`);
                }
            }
            console.log(`run: slow done, next in ${intervalSec}s`);
        }
        // 빠른 층: 10초. 하트비트·스풀 비우기 + 명령 가져오기. presence는 플랜 주기와 분리한다.
        // (동기화 30분마다만 뛰면 2분 기준 온라인 표시가 항상 꺼진다.)
        try {
            intervalSec = await onHeartbeat(true);
        } catch (err) {
            console.error(`heartbeat failed: ${err instanceof Error ? err.message : err}`);
        }
        try {
            await pollCommands();
        } catch (err) {
            if (isBlocked(err)) {
                noteBlocked();
            } else {
                console.error(`poll failed: ${err instanceof Error ? err.message : err}`);
            }
        }
        // 막힌 상태에서는 요청을 줄인다 (하트비트는 유지해 온라인 표시는 계속).
        const deadline = Date.now() + (blocked ? 60000 : 10000);
        while (!stopping && Date.now() < deadline) {
            await sleep(Math.min(1000, deadline - Date.now()));
        }
    }
    try {
        await onHeartbeat();
    } catch {
        // best-effort flush only
    }
    // 항시 서버는 죽이지 않는다. 다음 run이 이어쓴다.
    console.log("run: stopped");
}

// Node 22.13 미만은 node:sqlite를 쓸 수 없다. 명령을 실행하기 전에 한 번에 알려준다
// (명령마다 다른 에러로 죽는 것보다 낫다).
function checkNodeVersion(): boolean {
    const [major, minor] = process.versions.node.split(".").map((n) => Number(n));
    if (major > 22 || (major === 22 && minor >= 13)) {
        return true;
    }
    console.error(
        `localagents requires Node 22.13 or newer (found ${process.version}).\n` +
            "Node 20 and older are end-of-life. Install Node 22 LTS or newer: https://nodejs.org",
    );
    return false;
}

const VERSION: string = (() => {
    try {
        const raw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
        const parsed = JSON.parse(raw) as { version?: unknown };
        return typeof parsed.version === "string" ? parsed.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
})();

function printUsage(): void {
    console.log(`localagents ${VERSION}

Sync OpenCode sessions across your computers.

Usage:
  localagents <command>

Commands:
  login       Connect this PC (opens the browser, installs background sync)
  logout      Revoke this device and stop background sync
  status      Show device, OpenCode server, last sync, pending commands, plan
  whoami      Show the signed-in account
  push        Upload selected sessions to the cloud
  pull        Download sessions from another PC
  uninstall   Remove the background service, files and saved state

Options:
  -h, --help      Show this help
  -v, --version   Show the version

Environment:
  LOCALAGENTS_BASE_URL   Server to connect to (default: https://localagents.link)
  OPENCODE_SERVER_URL    Attach to a specific OpenCode server instead of auto-discovering

Docs: https://localagents.link
`);
}

async function main(): Promise<void> {
    if (!checkNodeVersion()) {
        process.exitCode = 1;
        return;
    }
    const args = process.argv.slice(2).filter((a) => a !== "--jaeholee");
    const cmd = args[0];
    if (cmd === "-h" || cmd === "--help" || cmd === "help") {
        printUsage();
        return;
    }
    if (cmd === "-v" || cmd === "--version" || cmd === "version") {
        console.log(VERSION);
        return;
    }
    const advanced = new Set([
        "sessions",
        "heartbeat",
        "sync",
        "fork",
        "sync-messages",
        "sync-models",
        "sync-sessions",
        "poll",
        "dump",
    ]);
    // 숨김 진단 명령. 플래그 없이 치면 없는 명령으로 보인다. run은 unit이 쓰니 예외.
    if (cmd && advanced.has(cmd) && !process.argv.includes("--jaeholee")) {
        console.log(`unknown command: ${cmd}`);
        console.log("run `localagents --help` for usage.");
        process.exitCode = 1;
        return;
    }
    if (cmd === "status") {
        await onStatus();
    } else if (cmd === "logout") {
        await onLogout();
    } else if (cmd === "uninstall") {
        await onUninstall();
    } else if (cmd === "service") {
        const sub = args[1];
        if (sub === "install") {
            await onServiceInstall();
        } else {
            console.log("usage: localagents service install");
            process.exitCode = 1;
        }
    } else if (cmd === "whoami") {
        await onWhoami();
    } else if (cmd === "sessions") {
        await onSessions();
    } else if (cmd === "login") {
        await onLogin();
    } else if (cmd === "heartbeat") {
        await onHeartbeat();
    } else if (cmd === "sync") {
        await onSync();
    } else if (cmd === "fork") {
        await onFork(args[1]);
    } else if (cmd === "sync-messages") {
        await onSyncMessages(args[1]);
    } else if (cmd === "sync-models") {
        await onSyncModels();
    } else if (cmd === "sync-sessions") {
        await onSyncSessions();
    } else if (cmd === "push") {
        await onPush(args.slice(1));
    } else if (cmd === "pull") {
        await onPull();
    } else if (cmd === "run") {
        await onRun();
    } else if (cmd === "poll") {
        await pollCommands();
    } else if (cmd === "dump") {
        await onDump(args[1]);
    } else {
        if (cmd) {
            console.log(`unknown command: ${cmd}`);
        }
        console.log("run `localagents --help` for usage.");
        process.exitCode = 1;
    }
    // 1회성 명령이 띄운 서버는 함께 내린다. run은 스스로 관리한다.
    if (cmd !== "run") {
        killOwned();
    }
}

main().catch((err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
});
