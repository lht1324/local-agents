import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, release, userInfo } from "node:os";
import { join } from "node:path";

// 기기 지문. OS 기계 id + OS 유저명으로 결정적 생성. logout해도 바뀌지 않는다.
// 같은 PC·같은 유저는 항상 같은 기기 id. 서버는 upsert라 재로그인이 덮어쓴다.
export function stableDeviceId(): string {
    let machine = "";
    try {
        if (platform() === "linux" && existsSync("/etc/machine-id")) {
            machine = readFileSync("/etc/machine-id", "utf8").trim();
        }
    } catch {
        // fall through
    }
    let user = "";
    try {
        user = userInfo().username;
    } catch {
        // fall through
    }
    const seed = machine && user ? `localagents:${machine}:${user}` : "";
    if (!seed) {
        return fallbackDeviceId();
    }
    const hash = createHash("sha256").update(seed).digest();
    hash[6] = (hash[6] & 0x0f) | 0x40;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fallbackDeviceId(): string {
    const path = join(homedir(), ".config", "localagents", "machine");
    try {
        const saved = readFileSync(path, "utf8").trim();
        if (/^[0-9a-f-]{36}$/.test(saved)) {
            return saved;
        }
    } catch {
        // fall through
    }
    const id = newDeviceId();
    try {
        mkdirSync(join(homedir(), ".config", "localagents"), { recursive: true });
        writeFileSync(path, id, { mode: 0o600 });
    } catch {
        // 무시. 이번 실행만 유효.
    }
    return id;
}

// UUIDv7: 시간 48비트 + 랜덤 74비트. 정렬 유리, 충돌 무시 수준.
export function newDeviceId(): string {
    const now = Date.now();
    const rand = randomBytes(10);
    const bytes = Buffer.alloc(16);
    bytes.writeUIntBE(now, 0, 6);
    rand.copy(bytes, 6);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface DeviceState {
    deviceId: string;
    userId: string;
    token?: string;
    lastOkAt?: number;
}

export interface ServerState {
    password: string;
}

function stateDir(): string {
    return join(homedir(), ".config", "localagents");
}

function statePath(): string {
    return join(stateDir(), "device.json");
}

export function readState(): DeviceState | null {
    try {
        if (!existsSync(statePath())) {
            return null;
        }
        const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<DeviceState>;
        if (!raw.deviceId || !raw.userId) {
            return null;
        }
        return { deviceId: raw.deviceId, userId: raw.userId, token: raw.token, lastOkAt: raw.lastOkAt };
    } catch {
        return null;
    }
}

export function baseUrl(): string {
    // 환경변수로 명시적 지정 가능 (자체 호스팅 등)
    if (process.env.LOCALAGENTS_BASE_URL) {
        return process.env.LOCALAGENTS_BASE_URL;
    }
    // node_modules에 있으면 npm 설치 (prod), 아니면 dev
    const isInstalled = process.argv[1]?.includes("node_modules") ?? false;
    return isInstalled ? "https://localagents.link" : "https://dev.localagents.link";
}

export function writeState(state: DeviceState): void {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state, null, 4), { mode: 0o600 });
    chmodSync(statePath(), 0o600);
}

// logout용. 등록 상태만 지운다. env·서버 비번은 유지.
export function clearState(): void {
    try {
        unlinkSync(statePath());
    } catch {
        // 없어도 정상
    }
    try {
        unlinkSync(join(stateDir(), "cursors.json"));
    } catch {
        // 없어도 정상
    }
    try {
        for (const f of readdirSync(join(stateDir(), "spool"))) {
            if (f.endsWith(".json")) {
                try {
                    unlinkSync(join(stateDir(), "spool", f));
                } catch {
                    // 무시
                }
            }
        }
    } catch {
        // 없어도 정상
    }
}

function serverStatePath(): string {
    return join(stateDir(), "server.json");
}

export function readServerState(): ServerState | null {
    try {
        if (!existsSync(serverStatePath())) {
            return null;
        }
        return JSON.parse(readFileSync(serverStatePath(), "utf8")) as ServerState;
    } catch {
        return null;
    }
}

export function writeServerState(state: ServerState): void {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(serverStatePath(), JSON.stringify(state), { mode: 0o600 });
    chmodSync(serverStatePath(), 0o600);
}

export interface HostInfo {
    platform: string;
    release: string;
    hostname: string;
    label: string;
}

// os 모듈 동기 호출. 부팅 시점에 항상 값 있음.
export function hostInfo(): HostInfo {
    const p = platform();
    const h = hostname();
    return { platform: p, release: release(), hostname: h, label: `${h} · ${p}` };
}
