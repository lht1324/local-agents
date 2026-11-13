import { Hono } from "hono";
import { checkBillingGate } from "../../../lib/billing";
import { requireEnv, type AppEnv } from "../../../lib/env";
import { presignGet, presignPut, type R2SigningConfig } from "../../../lib/r2sign";
import type { DeviceVariables } from "../../middleware/device";
import { getBaseResponse } from "../../utils/getBaseResponse";

const presign = new Hono<{ Bindings: AppEnv; Variables: DeviceVariables }>();

// 서명 URL 유효시간. 데몬이 파일을 바로 올리고/내리는 용도라 길 필요 없다.
const EXPIRES_SEC = 900;
// 인계 파일은 전부 gzip 압축본이다. Content-Type 을 서명해 데몬이 그대로 보내게 한다.
const CONTENT_TYPE = "application/gzip";

// 서명 자격증명. dev/prod 는 버킷 이름만 갈린다 (HANDOFFS_BUCKET_NAME).
//   R2_ACCESS_KEY_ID     = R2 API 토큰 id
//   R2_SECRET_ACCESS_KEY = 그 토큰 value 의 SHA-256 해시
function signingConfig(): R2SigningConfig {
    return {
        accountId: requireEnv("R2_ACCOUNT_ID"),
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
        bucket: requireEnv("HANDOFFS_BUCKET_NAME"),
    };
}

// 서명 URL 발급. 데몬은 이 URL 로 R2 에 직접 PUT/GET 한다.
// 워커는 서명만 하고 파일 본문은 절대 읽지 않는다 (파일은 워커를 거치지 않는다).
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
    // 키는 본인 userId/ 접두사여야 한다. 남의 파일을 못 건드린다.
    if (typeof body.key !== "string" || !body.key.startsWith(`${userId}/`)) {
        return getBaseResponse({ success: false, status: 403, error: "key must start with your user id" });
    }

    const cfg = signingConfig();
    const signed =
        body.operation === "upload"
            ? presignPut(cfg, body.key, EXPIRES_SEC, new Date(), CONTENT_TYPE)
            : presignGet(cfg, body.key, EXPIRES_SEC);

    return getBaseResponse({
        success: true,
        status: 200,
        data: {
            url: signed.url,
            method: signed.method,
            headers: signed.headers,
        },
    });
});

export default presign;
