// R2 presigned URL 발급 (AWS Signature Version 4).
//
// 왜 직접 서명하는가: Workers의 R2 바인딩은 presigned URL을 만들어 주지 않는다.
// 공식 문서도 "R2 Workers API binding cannot generate presigned URLs,
// so you must sign them with an S3 client" 라고 명시한다.
// 그래서 S3 클라이언트를 넣지 않고 SigV4만 직접 구현한다 (의존성 0).
//
// 흐름이 바뀐다:
//   예전) 데몬 → Worker → R2        (파일이 워커를 지나고, 워커 메모리를 먹음)
//   지금) 데몬 → R2                 (워커는 서명만 하고 페이로드는 안 본다)
//
// 자격증명:
//   Access Key ID     = R2 API 토큰의 id
//   Secret Access Key = 그 토큰 value의 SHA-256 해시
//   (Cloudflare 문서 "Get S3 API credentials from an API token" 참고)
// R2 리전은 항상 "auto"다.

import { createHash, createHmac } from "node:crypto";

export interface R2SigningConfig {
    /** Cloudflare 계정 ID. R2 엔드포인트 호스트를 만드는 데 쓴다. */
    accountId: string;
    /** R2 API 토큰 id (= Access Key ID) */
    accessKeyId: string;
    /** R2 API 토큰 value의 SHA-256 해시 (= Secret Access Key) */
    secretAccessKey: string;
    /** 대상 버킷. dev/prod를 갈라 여기서만 이름을 바꾼다. */
    bucket: string;
    /** 기본값 https://{accountId}.r2.cloudflarestorage.com */
    endpoint?: string;
    /** 기본값 "auto" (R2 규칙). 관할권별 버킷이 아니면 바꿀 일이 없다. */
    region?: string;
}

export interface PresignedUrl {
    url: string;
    method: "PUT" | "GET";
    headers: Record<string, string>;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const REGION = "auto";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

// RFC 3986 unreserved = A-Z a-z 0-9 - _ . ~
// encodeURIComponent는 ! ' ( ) * 를 남겨두므로 AWS 규칙과 다르다. 직접 만든다.
function awsUriEncode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function sha256Hex(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
    return createHmac("sha256", key).update(data, "utf8").digest();
}

/** 키의 경로 구간만 인코딩한다. '/' 구분자는 보존해야 실제 오브젝트 키가 유지된다. */
function encodeKeyPath(key: string): string {
    return key.split("/").map(awsUriEncode).join("/");
}

function amzDate(date: Date): { amz: string; stamp: string } {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { amz: iso, stamp: iso.slice(0, 8) };
}

function signingKey(secret: string, stamp: string, region: string = REGION): Buffer {
    const kDate = hmac(`AWS4${secret}`, stamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, SERVICE);
    return hmac(kService, "aws4_request");
}

/** 테스트 전용. AWS SigV4 검증 벡터 대조에 쓴다. */
export function deriveSigningKey(
    secret: string,
    stamp: string,
    region: string = REGION,
    service: string = SERVICE,
): Buffer {
    const kDate = hmac(`AWS4${secret}`, stamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, "aws4_request");
}

interface SignInput {
    method: "PUT" | "GET";
    /** 호스트 포함 전체 URL (쿼리 없는 상태) */
    baseUrl: string;
    /** 서명할 쿼리 파라미터. 값은 원본(인코딩 전) */
    query: Record<string, string>;
    expiresSec: number;
    accessKeyId: string;
    secretAccessKey: string;
    /** canonical URI. path-style이므로 "/{bucket}/{key}" */
    canonicalUri: string;
    /** 서명할 헤더 목록 (소문자 이름). R2 presign은 host 만 쓴다. */
    signedHeaders: Record<string, string>;
    /** 기본값 "auto" (R2 규칙) */
    region?: string;
    date: Date;
}

export interface SignOutput {
    canonicalRequest: string;
    stringToSign: string;
    signature: string;
    /** 서명 후 쿼리까지 붙인 최종 URL */
    url: string;
}

/** SigV4 서명 본체. presignPut/presignGet 과 테스트 벡터가 함께 쓴다. */
export function signRequest(input: SignInput): SignOutput {
    const region = input.region ?? REGION;
    const { amz, stamp } = amzDate(input.date);
    const urlHost = new URL(input.baseUrl).host;
    // 서명한 host 와 실제 URL 의 host 가 다르면 R2 가 서명을 거부한다. 조기 실패시킨다.
    if (input.signedHeaders.host !== undefined && input.signedHeaders.host !== urlHost) {
        throw new Error(`signed host mismatch: ${input.signedHeaders.host} != ${urlHost}`);
    }

    // 쿼리는 키 이름순으로 정렬하고 값은 인코딩한다. 서명 파라미터는 제외.
    const params = new URLSearchParams(input.query);
    params.set("X-Amz-Algorithm", ALGORITHM);
    params.set("X-Amz-Credential", `${input.accessKeyId}/${stamp}/${region}/${SERVICE}/aws4_request`);
    params.set("X-Amz-Date", amz);
    params.set("X-Amz-Expires", String(input.expiresSec));
    params.set("X-Amz-SignedHeaders", Object.keys(input.signedHeaders).sort().join(";"));

    const sorted = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonicalQuery = sorted
        .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
        .join("&");

    const canonicalHeaders = Object.keys(input.signedHeaders)
        .sort()
        .map((k) => `${k}:${input.signedHeaders[k].trim()}\n`)
        .join("");
    const signedHeaderList = Object.keys(input.signedHeaders).sort().join(";");

    const canonicalRequest = [
        input.method,
        input.canonicalUri,
        canonicalQuery,
        canonicalHeaders,
        signedHeaderList,
        UNSIGNED_PAYLOAD,
    ].join("\n");

    const scope = `${stamp}/${region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amz, scope, sha256Hex(canonicalRequest)].join("\n");

    const signature = hmac(signingKey(input.secretAccessKey, stamp, region), stringToSign).toString("hex");

    const url = `${input.baseUrl}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return { canonicalRequest, stringToSign, signature, url };
}

function buildUrl(cfg: R2SigningConfig, key: string): { baseUrl: string; canonicalUri: string } {
    const encodedKey = encodeKeyPath(key);
    // path-style: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
    // 버킷명에 점이 있으면 가상호스트 방식의 TLS 인증서 문제가 생기므로 path-style을 쓴다.
    const origin = cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`;
    const baseUrl = `${origin}/${cfg.bucket}/${encodedKey}`;
    return { baseUrl, canonicalUri: `/${cfg.bucket}/${encodedKey}` };
}

/** 업로드용 presigned URL. 데몬이 이 URL로 R2에 직접 PUT한다. */
export function presignPut(
    cfg: R2SigningConfig,
    key: string,
    expiresSec: number,
    date: Date = new Date(),
    contentType?: string,
): PresignedUrl {
    const { baseUrl, canonicalUri } = buildUrl(cfg, key);
    const signedHeaders: Record<string, string> = { host: new URL(baseUrl).host };
    if (contentType) {
        signedHeaders["content-type"] = contentType;
    }
    const { url } = signRequest({
        method: "PUT",
        baseUrl,
        query: {},
        expiresSec,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        canonicalUri,
        signedHeaders,
        region: cfg.region,
        date,
    });
    return { url, method: "PUT", headers: contentType ? { "content-type": contentType } : {} };
}

/** 다운로드용 presigned URL. 데몬이 이 URL로 R2에서 직접 GET한다. */
export function presignGet(
    cfg: R2SigningConfig,
    key: string,
    expiresSec: number,
    date: Date = new Date(),
): PresignedUrl {
    const { baseUrl, canonicalUri } = buildUrl(cfg, key);
    const { url } = signRequest({
        method: "GET",
        baseUrl,
        query: {},
        expiresSec,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        canonicalUri,
        signedHeaders: { host: new URL(baseUrl).host },
        region: cfg.region,
        date,
    });
    return { url, method: "GET", headers: {} };
}
