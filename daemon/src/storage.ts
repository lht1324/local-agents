import { cloudPost } from "./cloud";
import { baseUrl, readState } from "./device";

interface PresignResult {
    url: string;
    method: string;
    headers: Record<string, string>;
}

// 서명 URL 요청. 서버는 서명만 한다. 파일은 데몬이 R2에 직접 PUT/GET 한다.
async function presign(operation: "upload" | "download", key: string): Promise<PresignResult> {
    const body = (await cloudPost("/api/daemon/handoffs/url", { operation, key })) as {
        data?: PresignResult;
    };
    if (!body.data?.url) {
        throw new Error("presign returned no url");
    }
    return body.data;
}

// 요청 헤더.
//   같은 출처  → 우리 API 라우트. 기기 토큰이 필요하다.
//   다른 출처  → R2 presigned URL. 서명이 권한을 증명하므로 토큰을 보내면 안 된다.
//                 (S3 는 인증 방식을 2개 같이 쓰면 "Only one auth mechanism allowed" 로 거절한다)
// 서버를 배포하기 전에 데몬부터 올려야 끊김이 없는 이유다.
function requestHeaders(url: string, extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    try {
        if (new URL(url).origin === new URL(baseUrl()).origin) {
            const token = readState()?.token;
            if (token) {
                headers["Authorization"] = `Bearer ${token}`;
            }
        }
    } catch {
        // URL을 못 읽으면 토큰 없이 간다
    }
    return headers;
}

export async function putBytes(key: string, data: Uint8Array): Promise<void> {
    const p = await presign("upload", key);
    const res = await fetch(p.url, {
        method: p.method,
        headers: requestHeaders(p.url, p.headers),
        body: Buffer.from(data),
        signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
        throw new Error(`upload failed: ${res.status}`);
    }
}

export async function getBytes(key: string): Promise<Uint8Array> {
    const p = await presign("download", key);
    const res = await fetch(p.url, {
        method: p.method,
        headers: requestHeaders(p.url, p.headers),
        signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
        throw new Error(`download failed: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
}
