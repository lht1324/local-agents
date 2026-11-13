import { existsSync, readFileSync } from "node:fs";
import type { Config } from "drizzle-kit";

// drizzle-kit은 Node CLI로 돈다(워커 밖). 시크릿은 .dev.vars 한 곳에서만 읽는다.
// 런타임(worker)은 c.env 바인딩을 쓰므로 process.env를 전혀 사용하지 않는다.
function readDevVars(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(".dev.vars")) {
        return out;
    }
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) {
            continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq < 0) {
            continue;
        }
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed
            .slice(eq + 1)
            .trim()
            .replace(/^"(.*)"$/, "$1");
        out[key] = value;
    }
    return out;
}

export default {
    schema: "./lib/neon/schema.ts",
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        // 기본은 개발 브랜치(.dev.vars). 운영 브랜치에 적용할 때만 DATABASE_URL 로 덮어쓴다.
        // (워커 런타임이 아니라 drizzle-kit CLI 에서만 읽는 값이다)
        url: process.env.DATABASE_URL ?? readDevVars().DATABASE_URL ?? "",
    },
} satisfies Config;
