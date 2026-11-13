import { Hono } from "hono";
import { bindEnv, type AppEnv } from "../lib/env";
import authRoutes from "./routes/auth";
import pageRoutes from "./pageGuard";
import webSessions from "./routes/web/sessions";
import webMessages from "./routes/web/messages";
import webCommands from "./routes/web/commands";
import webDevice from "./routes/web/device";
import webPairing from "./routes/web/pairing";
import webDodo from "./routes/web/dodo";
import webDeviceUnlink from "./routes/web/devices";
import webAccount from "./routes/web/account";
import webMe from "./routes/web/me";
import pairingRoutes from "./routes/pairing";
import webhookDodo from "./routes/webhook/dodo";
import seoRoutes from "./routes/seo";
import daemonBasic from "./routes/daemon/basic";
import daemonCommands from "./routes/daemon/commands";
import daemonHeartbeat from "./routes/daemon/heartbeat";
import daemonSync from "./routes/daemon/sync";
import daemonMessages from "./routes/daemon/messages";
import daemonHandoffs from "./routes/daemon/handoffs";
import daemonPresign from "./routes/daemon/presign";
import { requireDevice } from "./middleware/device";
import { requireSession, type AuthVariables } from "./middleware/auth";
import { bodyLimit } from "./middleware/bodyLimit";
import { getBaseResponse } from "./utils/getBaseResponse";

// 단일 워커: /api/* 는 여기서, 나머지는 자산(SPA)으로.
// 등록 순서가 곧 접근 제어다 — requireSession보다 뒤에 등록된 라우트만 인증 대상.
const app = new Hono<{ Bindings: AppEnv; Variables: AuthVariables }>();

app.use("*", async (c, next) => {
    bindEnv(c.env);
    await next();
});
// 본문 크기 상한. 동기화 행 배치가 커도 2MB면 충분하다.
// 인계 파일은 워커를 거치지 않는다 (presigned URL 로 데몬이 R2 에 직접 PUT/GET).
app.use("/api/*", bodyLimit());

// 인증 불필요
app.route("/api/auth", authRoutes);
app.route("/api/pairing", pairingRoutes);
// Dodo가 직접 부르는 공개 엔드포인트. 서명 검증이 곧 인증이다.
app.route("/api/webhook/dodo", webhookDodo);
app.route("/", seoRoutes);
app.get("/api/health", () => getBaseResponse({ success: true, status: 200 }));

// 페이지 가드 (run_worker_first에 등록된 경로만 도달)
app.route("/", pageRoutes);

// 여기서부터 세션 인증 (API)
app.use("/api/web/*", requireSession);

app.route("/api/web/sessions", webSessions);
app.route("/api/web/messages", webMessages);
app.route("/api/web/commands", webCommands);
app.route("/api/web/device", webDevice);
app.route("/api/web/pairing", webPairing);
app.route("/api/web/dodo", webDodo);
app.route("/api/web/account", webAccount);
app.route("/api/web/me", webMe);
app.route("/api/web/devices", webDeviceUnlink);

// 데몬 채널 (기기 토큰)
app.use("/api/daemon/*", requireDevice);
app.route("/api/daemon", daemonBasic);
app.route("/api/daemon/commands", daemonCommands);
app.route("/api/daemon/heartbeat", daemonHeartbeat);
app.route("/api/daemon/sync", daemonSync);
app.route("/api/daemon/messages", daemonMessages);
app.route("/api/daemon/handoffs/url", daemonPresign);
app.route("/api/daemon/handoffs", daemonHandoffs);

app.notFound((c) => getBaseResponse({ success: false, status: 404, error: `not found: ${c.req.method} ${c.req.path}` }));

app.onError((error, c) => {
    console.error(`[worker] ${c.req.method} ${c.req.path}:`, error);
    return getBaseResponse({ success: false, status: 500, error: "internal server error" });
});

export default app;
