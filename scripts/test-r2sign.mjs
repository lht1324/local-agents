// SigV4 구현 검증 스크립트.
//
// 레퍼런스: AWS CLI (`aws s3 presign`)가 만든 URL과 우리 구현의 출력을 나란히 비교한다.
// 서명값이 바이트 단위로 같으면 canonical request·쿼리 인코딩·서명키 파생이 모두 맞다는 뜻.
//
// 사용법:
//   node scripts/test-r2sign.mjs
//
// AWS CLI docker 컨테이너가 필요하면 아래의 REF_URL 을 직접 붙여넣어도 된다.

import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";

const ACCOUNT_ID = "9ab5fff4a2988fde61db5d5705759000";
const BUCKET = "local-agents-dev";
const KEY = "someuser/ses_abc123/0/1700000000000.bin.gz";
const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "secretkeyexample";
const EXPIRES = 900;

// ---------- 우리 구현 (lib/r2sign.ts 를 그대로 옮긴 것) ----------
const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const REGION = "auto";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function awsUriEncode(value) {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}
function sha256Hex(data) {
    return createHash("sha256").update(data, "utf8").digest("hex");
}
function hmac(key, data) {
    return createHmac("sha256", key).update(data, "utf8").digest();
}
function encodeKeyPath(key) {
    return key.split("/").map(awsUriEncode).join("/");
}
function amzDate(date) {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { amz: iso, stamp: iso.slice(0, 8) };
}
function signingKey(secret, stamp) {
    const kDate = hmac(`AWS4${secret}`, stamp);
    const kRegion = hmac(kDate, REGION);
    const kService = hmac(kRegion, SERVICE);
    return hmac(kService, "aws4_request");
}
function signRequest({ method, baseUrl, query, expiresSec, accessKeyId, secretAccessKey, canonicalUri, signedHeaders, date }) {
    const { amz, stamp } = amzDate(date);
    const host = new URL(baseUrl).host;
    const params = new URLSearchParams(query);
    params.set("X-Amz-Algorithm", ALGORITHM);
    params.set("X-Amz-Credential", `${accessKeyId}/${stamp}/${REGION}/${SERVICE}/aws4_request`);
    params.set("X-Amz-Date", amz);
    params.set("X-Amz-Expires", String(expiresSec));
    params.set("X-Amz-SignedHeaders", Object.keys(signedHeaders).sort().join(";"));
    const sorted = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonicalQuery = sorted.map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join("&");
    const canonicalHeaders = Object.keys(signedHeaders)
        .sort()
        .map((k) => `${k}:${signedHeaders[k].trim()}\n`)
        .join("");
    const signedHeaderList = Object.keys(signedHeaders).sort().join(";");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaderList, UNSIGNED_PAYLOAD].join("\n");
    const scope = `${stamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amz, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = hmac(signingKey(secretAccessKey, stamp), stringToSign).toString("hex");
    const url = `${baseUrl}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return { canonicalRequest, stringToSign, signature, url };
}
function presign(method, cfg, key, expiresSec, date = new Date(), contentType = null) {
    const encodedKey = encodeKeyPath(key);
    const origin = cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`;
    const baseUrl = `${origin}/${cfg.bucket}/${encodedKey}`;
    const canonicalUri = `/${cfg.bucket}/${encodedKey}`;
    const signedHeaders = { host: new URL(baseUrl).host };
    if (contentType) {
        signedHeaders["content-type"] = contentType;
    }
    return signRequest({
        method,
        baseUrl,
        query: {},
        expiresSec,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        canonicalUri,
        signedHeaders,
        date,
    });
}

// ---------- 레퍼런스 URL 얻기 ----------
// 레퍼런스는 boto3(botocore) 가 만든다. AWS CLI 의 `s3 presign` 는 GET 전용이라 PUT 을 못 만든다.
// 컨테이너를 띄우는 이유: 로컬에 boto3 를 깔지 않고도 공식 구현으로 대조하기 위해서다.
const REF_PY = `
import sys, boto3
from botocore.config import Config
method, key, expires = sys.argv[1], sys.argv[2], int(sys.argv[3])
content_type = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
s3 = boto3.client(
    "s3",
    endpoint_url="https://9ab5fff4a2988fde61db5d5705759000.r2.cloudflarestorage.com",
    region_name="auto",
    aws_access_key_id="AKIDEXAMPLE",
    aws_secret_access_key="secretkeyexample",
    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
)
op = {"PUT": "put_object", "GET": "get_object"}[method]
params = {"Bucket": "local-agents-dev", "Key": key}
if content_type:
    params["ContentType"] = content_type
print(s3.generate_presigned_url(op, Params=params, ExpiresIn=expires))
`;

function refPresign(method, contentType) {
    const out = execFileSync(
        "docker",
        [
            "run", "--rm",
            "-e", "REF=" + REF_PY,
            "r2sign-ref:latest",
            "sh", "-c",
            `printf '%s' "$REF" > /work/ref.py && python3 /work/ref.py ${method} ${KEY} ${EXPIRES} ${contentType ?? ""}`,
        ],
        { encoding: "utf8" },
    );
    return out.trim();
}

// ---------- 비교 ----------
const cfg = {
    accountId: ACCOUNT_ID,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    bucket: BUCKET,
};

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) {
        failures++;
    }
}

function compare(method, contentType) {
    const label = contentType ? `${method} (content-type 서명)` : method;
    console.log(`\n=== ${label} ===`);
    const refUrl = refPresign(method, contentType);
    const refParams = new URL(refUrl).searchParams;
    const refDate = refParams.get("X-Amz-Date");
    const refSig = refParams.get("X-Amz-Signature");

    const date = new Date(
        `${refDate.slice(0, 4)}-${refDate.slice(4, 6)}-${refDate.slice(6, 8)}T${refDate.slice(9, 11)}:${refDate.slice(11, 13)}:${refDate.slice(13, 15)}Z`,
    );
    const mine = presign(method, cfg, KEY, EXPIRES, date, contentType);

    check("서명값 일치", mine.signature === refSig, `ref=${refSig.slice(0, 16)}… mine=${mine.signature.slice(0, 16)}…`);
    check("전체 URL 일치", mine.url === refUrl);
    if (mine.url !== refUrl) {
        console.log("    ref :", refUrl);
        console.log("    mine:", mine.url);
    }
}

compare("PUT", undefined);
compare("GET", undefined);
compare("PUT", "application/gzip");

// ---------- canonical request 구조 검증 ----------
// AWS CLI(botocore) 의 --debug 출력이 남긴 형식과 우리 구현이 만든 문자열을 줄 단위로 대조한다.
//   GET
//   /local-agents-dev/someuser/ses_abc123/0/1700000000000.bin.gz
//   X-Amz-Algorithm=...&X-Amz-Credential=...&...
//   host:9ab5fff4a2988fde61db5d5705759000.r2.cloudflarestorage.com
//   (빈 줄)
//   host
//   UNSIGNED-PAYLOAD
console.log("\n=== canonical request 구조 ===");
{
    const date = new Date("2026-11-13T19:13:07Z");
    const { canonicalRequest } = presign("GET", cfg, KEY, EXPIRES, date);
    const lines = canonicalRequest.split("\n");
    const expectedShape = [
        "GET",
        `/${BUCKET}/${KEY}`,
        null, // 쿼리 문자열
        `host:${ACCOUNT_ID}.r2.cloudflarestorage.com`,
        "",
        "host",
        "UNSIGNED-PAYLOAD",
    ];
    let ok = lines.length === expectedShape.length;
    for (let i = 0; i < expectedShape.length && ok; i++) {
        if (expectedShape[i] === null) {
            ok = lines[i].startsWith("X-Amz-Algorithm=AWS4-HMAC-SHA256&");
        } else {
            ok = lines[i] === expectedShape[i];
        }
        if (!ok) {
            console.log(`    줄 ${i + 1} 불일치: 기대="${expectedShape[i]}" 실제="${lines[i]}"`);
        }
    }
    check("canonical request 형식", ok);
}

console.log(failures === 0 ? "\n전부 통과 ✅" : `\n실패 ${failures}건 ❌`);
process.exit(failures === 0 ? 0 : 1);
