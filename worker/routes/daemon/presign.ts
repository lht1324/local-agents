import { Hono } from "hono";
import { checkBillingGate } from "../../../lib/billing";
import { type AppEnv } from "../../../lib/env";
import type { DeviceVariables } from "../../middleware/device";
import { getBaseResponse } from "../../utils/getBaseResponse";

const presign = new Hono<{ Bindings: AppEnv; Variables: DeviceVariables }>();

// R2 binding을 사용한 업로드/다운로드 URL 발급.
// presigned URL 대신 Worker가 직접 R2에 접근.
presign.post("/", async (c) => {
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
    if (typeof body.key !== "string" || !body.key.startsWith(`${userId}/`)) {
        return getBaseResponse({ success: false, status: 403, error: "key must start with your user id" });
    }

    const bucket = c.env.HANDOFFS_BUCKET;
    if (!bucket) {
        return getBaseResponse({ success: false, status: 500, error: "R2 bucket not configured" });
    }

    // R2 presigned URL 생성 (S3 호환)
    // R2는 S3 호환 API를 제공하므로, Worker에서 직접 URL을 생성할 수 없음.
    // 대신 Worker가 직접 업로드/다운로드를 처리.
    if (body.operation === "upload") {
        // 업로드: Worker가 직접 R2에 쓰기
        // 데몬이 Worker에 파일을 POST하면 Worker가 R2에 저장
        return getBaseResponse({
            success: true,
            status: 200,
            data: {
                url: `${new URL(c.req.url).origin}/api/daemon/handoffs/upload?key=${encodeURIComponent(body.key)}`,
                method: "PUT",
                headers: {},
            },
        });
    } else {
        // 다운로드: Worker가 R2에서 읽어서 반환
        return getBaseResponse({
            success: true,
            status: 200,
            data: {
                url: `${new URL(c.req.url).origin}/api/daemon/handoffs/download?key=${encodeURIComponent(body.key)}`,
                method: "GET",
                headers: {},
            },
        });
    }
});

// 업로드 엔드포인트: 데몬이 파일을 PUT하면 Worker가 R2에 저장
presign.put("/upload", async (c) => {
    const userId = c.get("userId");
    const key = c.req.query("key");
    if (typeof key !== "string" || !key.startsWith(`${userId}/`)) {
        return getBaseResponse({ success: false, status: 403, error: "key must start with your user id" });
    }
    const bucket = c.env.HANDOFFS_BUCKET;
    if (!bucket) {
        return getBaseResponse({ success: false, status: 500, error: "R2 bucket not configured" });
    }
    const body = await c.req.arrayBuffer();
    await bucket.put(key, body, { httpMetadata: { contentType: "application/gzip" } });
    return getBaseResponse({ success: true, status: 200, data: { key } });
});

// 다운로드 엔드포인트: Worker가 R2에서 읽어서 반환
presign.get("/download", async (c) => {
    const userId = c.get("userId");
    const key = c.req.query("key");
    if (typeof key !== "string" || !key.startsWith(`${userId}/`)) {
        return getBaseResponse({ success: false, status: 403, error: "key must start with your user id" });
    }
    const bucket = c.env.HANDOFFS_BUCKET;
    if (!bucket) {
        return getBaseResponse({ success: false, status: 500, error: "R2 bucket not configured" });
    }
    const obj = await bucket.get(key);
    if (!obj) {
        return getBaseResponse({ success: false, status: 404, error: "not found" });
    }
    return new Response(obj.body, {
        headers: { "Content-Type": "application/gzip" },
    });
});

export default presign;
