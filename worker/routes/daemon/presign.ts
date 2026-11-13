import { Hono } from "hono";
import { checkBillingGate } from "../../../lib/billing";
import { optionalEnv, requireEnv, type AppEnv } from "../../../lib/env";
import { presignGet, presignPut, type R2SigningConfig } from "../../../lib/r2sign";
import type { DeviceVariables } from "../../middleware/device";
import { getBaseResponse } from "../../utils/getBaseResponse";

const presign = new Hono<{ Bindings: AppEnv; Variables: DeviceVariables }>();

// 서명 URL 유효시간. 데몬이 파일을 바로 올리고/내리는 용도라 길 필요 없다.
const EXPIRES_SEC = 900;
// 인계 파일은 전부 gzip 압축본이다. Content-Type 을 서명해 데몬이 그대로 보내게 한다.
const CONTENT_TYPE = "application/gzip";
// 중계 경로 업로드 상한. 실제 세션 스냅샷은 최대 수십 MB 이다.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// 서명 자격증명. 있으면 presigned URL(=파일이 워커를 안 지남), 없으면 중계.
//   R2_ACCESS_KEY_ID     = R2 API 토큰 id
//   R2_SECRET_ACCESS_KEY = 그 토큰 value 의 SHA-256 해시
function signingConfig(): R2SigningConfig | null {
    const accountId = optionalEnv("R2_ACCOUNT_ID");
    const accessKeyId = optionalEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = optionalEnv("R2_SECRET_ACCESS_KEY");
    if (!accountId || !accessKeyId || !secretAccessKey) {
        return null;
    }
    return {
        accountId,
        accessKeyId,
        secretAccessKey,
        bucket: requireEnv("HANDOFFS_BUCKET_NAME"),
    };
}

// URL 발급. 데몬은 이 URL로 직접 PUT/GET 한다.
//   서명 가능 → R2 presigned URL (파일이 워커를 거치지 않는다)
//   서명 불가 → 워커 중계 URL (자격증명 미설정 interim 경로)
// 마운트는 "/api/daemon/handoffs" 이다. 경로: /url (발급) · /upload · /download
presign.post("/url", async (c) => {
    const userId = c.get("userId");
    const gate = await checkBillingGate(userId);
    if (!gate.allowed) {
        return getBaseResponse({ success: false, status: 403, error: "trial_ended" });
    }

    let body: { operation?: unknown; key?: unknown };
    try {
        body = (await c.req.json()) as { operation?: unknown; key?: unknown };
    } catch {
        return getBaseResponse({ success: false, status: 400, error: "invalid JSON body" });
    }
    if (body.operation !== "upload" && body.operation !== "download") {
        return getBaseResponse({ success: false, status: 400, error: "operation must be upload or download" });
    }
    // 키는 본인 userId/ 접두사여야 한다. 남의 파일을 못 건드린다.
    if (typeof body.key !== "string" || !body.key.startsWith(`${userId}/`)) {
        return getBaseResponse({ success: false, status: 403, error: "key must start with your user id" });
    }

    const cfg = signingConfig();
    if (cfg) {
        const signed =
            body.operation === "upload"
                ? presignPut(cfg, body.key, EXPIRES_SEC, new Date(), CONTENT_TYPE)
                : presignGet(cfg, body.key, EXPIRES_SEC);
        return getBaseResponse({
            success: true,
            status: 200,
            data: { url: signed.url, method: signed.method, headers: signed.headers },
        });
    }

    // 서명 자격증명이 없을 때. 워커가 R2 를 직접 다룬다.
    const origin = new URL(c.req.url).origin;
    const url =
        body.operation === "upload"
            ? `${origin}/api/daemon/handoffs/upload?key=${encodeURIComponent(body.key)}`
            : `${origin}/api/daemon/handoffs/download?key=${encodeURIComponent(body.key)}`;
    return getBaseResponse({
        success: true,
        status: 200,
        data: { url, method: body.operation === "upload" ? "PUT" : "GET", headers: {} },
    });
});

// 중계 업로드. 데몬이 워커에 PUT 하면 워커가 R2 에 넣는다.
// 본문은 스트림으로 넘긴다 (통째로 메모리에 올리지 않는다).
presign.put("/upload", async (c) => {
    const userId = c.get("userId");
    const key = c.req.query("key");
    if (typeof key !== "string" || !key.startsWith(`${userId}/`)) {
        return getBaseResponse({ success: false, status: 403, error: "key must start with your user id" });
    }
    const declared = c.req.header("content-length");
    if (declared && Number(declared) > MAX_UPLOAD_BYTES) {
        return getBaseResponse({ success: false, status: 413, error: "payload too large" });
    }
    const body = c.req.raw.body;
    if (!body) {
        return getBaseResponse({ success: false, status: 400, error: "empty body" });
    }
    await c.env.HANDOFFS_BUCKET.put(key, body, { httpMetadata: { contentType: CONTENT_TYPE } });
    return getBaseResponse({ success: true, status: 200, data: { key } });
});

// 중계 다운로드. 워커가 R2 에서 읽어 그대로 내보낸다.
presign.get("/download", async (c) => {
    const userId = c.get("userId");
    const key = c.req.query("key");
    if (typeof key !== "string" || !key.startsWith(`${userId}/`)) {
        return getBaseResponse({ success: false, status: 403, error: "key must start with your user id" });
    }
    const obj = await c.env.HANDOFFS_BUCKET.get(key);
    if (!obj) {
        return getBaseResponse({ success: false, status: 404, error: "not found" });
    }
    return new Response(obj.body, { headers: { "Content-Type": CONTENT_TYPE } });
});

export default presign;
