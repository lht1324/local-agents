import { Hono } from "hono";
import { verifyDeviceToken } from "../../../lib/auth/device";
import type { AppEnv } from "../../../lib/env";
import type { DeviceVariables } from "../../middleware/device";
import { getBaseResponse } from "../../utils/getBaseResponse";

const daemonWs = new Hono<{ Bindings: AppEnv; Variables: DeviceVariables }>();

// 데몬 구독 — 사용자 방에 WebSocket으로 붙는다.
// requireDevice보다 앞에 마운트되므로 여기서 직접 기기 토큰을 검증한다.
// Authorization 헤더를 우선 쓰고, 없으면 ?token= (WebSocket 핸드셰이크 제약)을 받는다.
daemonWs.get("/", async (c) => {
    if (c.req.header("upgrade") !== "websocket") {
        return getBaseResponse({ success: false, status: 426, error: "expected websocket upgrade" });
    }
    const raw = c.req.raw;
    const queryToken = c.req.query("token");
    const probe =
        raw.headers.get("authorization") || !queryToken
            ? raw
            : new Request(raw.url, { headers: { authorization: `Bearer ${queryToken}` } });
    const authed = await verifyDeviceToken(probe);
    if (!authed) {
        return getBaseResponse({ success: false, status: 401, error: "unauthorized" });
    }
    const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(authed.userId));
    const url = new URL(raw.url);
    url.pathname = "/ws";
    const headers = new Headers(raw.headers);
    headers.set("x-la-device-id", authed.deviceId);
    return stub.fetch(new Request(url.toString(), { method: "GET", headers }));
});

export default daemonWs;
