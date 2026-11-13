import { cloudPost } from "./cloud";
import { readState } from "./device";

interface PresignResult {
    url: string;
    method: string;
    headers: Record<string, string>;
}

// 서명 URL 발급. S3 키는 서버만 들고, 데몬은 URL로 직행한다.
async function presign(operation: "upload" | "download", key: string): Promise<PresignResult> {
    const body = (await cloudPost("/api/daemon/handoffs/url", { operation, key })) as { data?: PresignResult };
    if (!body.data?.url) {
        throw new Error("presign returned no url");
    }
    return body.data;
}

export async function putBytes(key: string, data: Uint8Array): Promise<void> {
    const p = await presign("upload", key);
    const token = readState()?.token;
    const headers: Record<string, string> = { ...p.headers };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(p.url, {
        method: p.method,
        headers,
        body: Buffer.from(data),
        signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
        throw new Error(`upload failed: ${res.status}`);
    }
}

export async function getBytes(key: string): Promise<Uint8Array> {
    const p = await presign("download", key);
    const token = readState()?.token;
    const headers: Record<string, string> = { ...p.headers };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(p.url, {
        method: p.method,
        headers,
        signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
        throw new Error(`download failed: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
}
