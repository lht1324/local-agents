import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// SPA(React Router) + Worker(Hono API)를 한 포트에서 돌린다.
// dev에서 워커는 workerd로 실행되므로 프로덕션과 동작이 같다.
// dev용 워커 설정은 wrangler.dev.jsonc (prod 는 wrangler.jsonc).
export default defineConfig({
    // 기존 클라 dev 포트 유지 (데몬 baseUrl·문서와 맞춤)
    // dev.localagents.link는 cloudflared 터널로 들어오는 공개 주소다 (Dodo 웹훅 수신용).
    // strictPort: 3004가 사용 중이면 다른 포트로 도망가지 않고 즉시 실패한다.
    // 도망가면 터널(3004)이 죽은 포트를 가리켜 웹훅이 조용히 사라진다.
    server: { port: 3004, strictPort: true, allowedHosts: ["dev.localagents.link", ".localagents.link"] },
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    plugins: [react(), tailwindcss(), cloudflare({ configPath: "./wrangler.dev.jsonc", viteEnvironment: { name: "worker" } })],
    environments: {
        worker: { build: { sourcemap: true } },
    },
});
