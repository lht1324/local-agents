// 워커 바인딩(Secret/Var)을 한 곳에서 읽는다.
// Workers에서는 process.env가 채워지지 않으므로 요청마다 c.env를 bindEnv로 넘긴다.
// 라이브러리(lib/*)는 process.env를 직접 읽지 않고 requireEnv를 쓴다.

export interface AppEnv {
    DATABASE_URL: string;
    NEON_AUTH_BASE_URL: string;
    NEON_AUTH_COOKIE_SECRET: string;
    DEVICE_PACKET_KEY?: string;
    DODO_PAYMENTS_API_KEY?: string;
    DODO_PAYMENTS_ENVIRONMENT?: string;
    DODO_PAYMENTS_WEBHOOK_KEY?: string;
    NEON_API_KEY?: string;
    NEON_PROJECT_ID?: string;
    NEON_BRANCH_ID?: string;
    INTERNAL_FIRE_AND_FORGET_API_SECRET?: string;
    ASSETS: Fetcher;
    HANDOFFS_BUCKET: R2Bucket;
}

let bound: AppEnv | null = null;

export function bindEnv(env: AppEnv): void {
    bound = env;
}

export function getServerEnv(): AppEnv {
    if (!bound) {
        throw new Error("env is not bound (bindEnv must run in a middleware first)");
    }
    return bound;
}

export function requireEnv<K extends keyof AppEnv>(key: K): string {
    const value = getServerEnv()[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${String(key)} is not set`);
    }
    return value;
}

export function optionalEnv<K extends keyof AppEnv>(key: K): string {
    const value = getServerEnv()[key];
    return typeof value === "string" ? value : "";
}
