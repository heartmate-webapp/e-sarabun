/**
 * Document Registry System - Cloudflare Worker API Gateway
 *
 * Connects:
 *   GitHub Pages (index.html, dashboard.html)
 *       -> Cloudflare Worker (/api)
 *       -> Google Apps Script Web App (/exec)
 *       -> Google Sheets / Google Drive
 *
 * Required Worker bindings / variables:
 *   GATEWAY_SHARED_SECRET  (Secret; same value as Apps Script Script Property)
 *   GAS_WEB_APP_URL        (Variable; full /exec URL)
 *   ALLOWED_ORIGINS        (Variable; comma-separated exact origins)
 *   NONCE_DB               (D1 database binding; name exactly NONCE_DB)
 *
 * Optional Worker variables:
 *   SESSION_COOKIE_NAME    (default: DRS_SESSION)
 *   COOKIE_SAMESITE        (default: None; use Lax for same-site custom domains)
 *   API_PATH               (default: /api)
 *
 * IMPORTANT:
 *   - Never put GATEWAY_SHARED_SECRET in GitHub Pages or frontend JavaScript.
 *   - The Worker stores the Apps Script session token in Secure HttpOnly cookie.
 *   - D1's PRIMARY KEY is used as a persistent atomic replay barrier for nonces.
 *   - This file is intended to be pasted into Cloudflare Workers > Edit code.
 */

const DEFAULT_API_PATH = "/api";
const DEFAULT_COOKIE_NAME = "DRS_SESSION";
const DEFAULT_COOKIE_MAX_AGE = 21600; // 6 hours; matches Code.gs SESSION_TTL_SECONDS.
const MAX_INCOMING_BODY_BYTES = 11_800_000; // Keep below Code.gs MAX_REQUEST_BYTES.
const NONCE_RETENTION_SECONDS = 86_400; // Keep replay records for 24 hours.
const RANDOM_HEX_BYTES = 256; // 512 hexadecimal characters, as required by Code.gs.

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      // Do not log request bodies, passwords, session tokens, or secrets.
      console.error("Gateway internal error:", error && error.message ? error.message : "unknown");
      const origin = request.headers.get("Origin");
      return jsonResponse(
        { ok: false, code: "GATEWAY_INTERNAL_ERROR", message: "Gateway ไม่สามารถประมวลผลคำขอได้" },
        500,
        buildCorsHeaders(origin, env)
      );
    }
  }
};

/* ========================================================================== */
/* 01. REQUEST ROUTER                                                         */
/* ========================================================================== */

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const apiPath = env.API_PATH || DEFAULT_API_PATH;
  const origin = request.headers.get("Origin");
  const corsHeaders = buildCorsHeaders(origin, env);

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse(
      { ok: true, service: "document-registry-api", status: "running", timestamp: new Date().toISOString() },
      200,
      corsHeaders
    );
  }

  if (url.pathname !== apiPath) {
    return jsonResponse(
      { ok: false, code: "NOT_FOUND", message: "ไม่พบ API Endpoint นี้" },
      404,
      corsHeaders
    );
  }

  if (origin && !isAllowedOrigin(origin, env)) {
    return jsonResponse(
      { ok: false, code: "ORIGIN_NOT_ALLOWED", message: "เว็บไซต์ต้นทางไม่ได้รับอนุญาต" },
      403,
      new Headers({ "Cache-Control": "no-store", "Vary": "Origin" })
    );
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, code: "METHOD_NOT_ALLOWED", message: "API นี้รองรับเฉพาะ POST" },
      405,
      corsHeaders
    );
  }

  validateEnvironment(env);

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(
      { ok: false, code: "CONTENT_TYPE_REQUIRED", message: "กรุณาส่งข้อมูลแบบ application/json" },
      415,
      corsHeaders
    );
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength && declaredLength > MAX_INCOMING_BODY_BYTES) {
    return jsonResponse(
      { ok: false, code: "REQUEST_TOO_LARGE", message: "ข้อมูลคำขอมีขนาดใหญ่เกินกำหนด" },
      413,
      corsHeaders
    );
  }

  const rawBody = await request.text();
  const actualBytes = new TextEncoder().encode(rawBody).byteLength;
  if (!rawBody || actualBytes > MAX_INCOMING_BODY_BYTES) {
    return jsonResponse(
      { ok: false, code: "REQUEST_TOO_LARGE", message: "ข้อมูลคำขอว่างหรือมีขนาดใหญ่เกินกำหนด" },
      413,
      corsHeaders
    );
  }

  let browserRequest;
  try {
    browserRequest = JSON.parse(rawBody);
  } catch (error) {
    return jsonResponse(
      { ok: false, code: "INVALID_JSON", message: "รูปแบบ JSON ไม่ถูกต้อง" },
      400,
      corsHeaders
    );
  }

  const action = String(browserRequest.action || "").trim();
  const data = browserRequest.data && typeof browserRequest.data === "object" && !Array.isArray(browserRequest.data)
    ? browserRequest.data
    : {};
  const userAgent = String(browserRequest.userAgent || request.headers.get("User-Agent") || "").slice(0, 180);

  if (!action || action.length > 100) {
    return jsonResponse(
      { ok: false, code: "ACTION_REQUIRED", message: "ไม่พบชื่อคำสั่ง API" },
      400,
      corsHeaders
    );
  }

  const cookieName = env.SESSION_COOKIE_NAME || DEFAULT_COOKIE_NAME;
  const cookieToken = readCookie(request.headers.get("Cookie") || "", cookieName);
  const token = action === "auth.login" ? "" : cookieToken;

  // A replay record must be committed before the request reaches Apps Script.
  // If D1 is unavailable, fail closed: do not bypass the replay check.
  const nonce = createHexNonce(24);
  const timestamp = Math.floor(Date.now() / 1000);
  const secureRandomHex = createSecureRandomHex(RANDOM_HEX_BYTES);

  try {
    await registerNonceOrThrow(env.NONCE_DB, nonce, timestamp);
    ctx.waitUntil(cleanOldNonces(env.NONCE_DB, timestamp - NONCE_RETENTION_SECONDS));
  } catch (error) {
    console.error("Nonce database unavailable or nonce rejected:", error && error.message ? error.message : "unknown");
    return jsonResponse(
      { ok: false, code: "REPLAY_PROTECTION_UNAVAILABLE", message: "ระบบตรวจสอบความปลอดภัยไม่พร้อมใช้งาน กรุณาลองใหม่" },
      503,
      corsHeaders
    );
  }

  // Property order is deliberate. Apps Script signs/verifies JSON.stringify(payload).
  const payload = {
    action: action,
    data: data,
    token: token,
    userAgent: userAgent,
    ipHint: String(request.headers.get("CF-Connecting-IP") || "").slice(0, 80)
  };

  const canonicalText =
    String(timestamp) + "\n" +
    nonce + "\n" +
    secureRandomHex.toLowerCase() + "\n" +
    JSON.stringify(payload);

  const signature = await signHmacSha256Base64Url(env.GATEWAY_SHARED_SECRET, canonicalText);
  const envelope = {
    timestamp: timestamp,
    nonce: nonce,
    secureRandomHex: secureRandomHex,
    payload: payload,
    signature: signature
  };

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(env.GAS_WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
      redirect: "follow",
      cache: "no-store"
    });
  } catch (error) {
    console.error("Apps Script connection error:", error && error.message ? error.message : "unknown");
    return jsonResponse(
      { ok: false, code: "UPSTREAM_UNAVAILABLE", message: "ไม่สามารถเชื่อมต่อ Google Apps Script ได้" },
      502,
      corsHeaders
    );
  }

  let upstreamText;
  try {
    upstreamText = await upstreamResponse.text();
  } catch (error) {
    return jsonResponse(
      { ok: false, code: "UPSTREAM_READ_FAILED", message: "ไม่สามารถอ่านผลตอบกลับจากระบบฐานข้อมูลได้" },
      502,
      corsHeaders
    );
  }

  let upstreamResult;
  try {
    upstreamResult = JSON.parse(upstreamText);
  } catch (error) {
    console.error("Apps Script returned non-JSON response. HTTP:", upstreamResponse.status);
    return jsonResponse(
      { ok: false, code: "UPSTREAM_INVALID_RESPONSE", message: "Google Apps Script ส่งผลลัพธ์ที่ไม่ใช่ JSON กรุณาตรวจสอบการ Deploy และ URL /exec" },
      502,
      corsHeaders
    );
  }

  const responseHeaders = new Headers(corsHeaders);
  responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
  responseHeaders.set("Pragma", "no-cache");
  responseHeaders.set("X-Content-Type-Options", "nosniff");

  // On successful login, move the token into a Secure HttpOnly cookie and
  // remove it from the JSON response before the browser receives the result.
  if (action === "auth.login" && upstreamResult && upstreamResult.ok === true && upstreamResult.data) {
    const loginData = upstreamResult.data;
    const sessionToken = String(loginData.token || "");
    if (sessionToken) {
      const maxAge = Math.max(60, Math.min(Number(loginData.expiresIn) || DEFAULT_COOKIE_MAX_AGE, DEFAULT_COOKIE_MAX_AGE));
      responseHeaders.append("Set-Cookie", buildSessionCookie(cookieName, sessionToken, maxAge, env));
      const safeData = { ...loginData };
      delete safeData.token;
      upstreamResult.data = safeData;
    }
  }

  if (action === "auth.logout" && upstreamResult && upstreamResult.ok === true) {
    responseHeaders.append("Set-Cookie", clearSessionCookie(cookieName, env));
  }

  if (upstreamResult && upstreamResult.ok === false) {
    const errorCode = String(upstreamResult.code || "");
    if (["AUTH_REQUIRED", "SESSION_EXPIRED", "SESSION_INVALID", "ACCOUNT_DISABLED"].includes(errorCode)) {
      responseHeaders.append("Set-Cookie", clearSessionCookie(cookieName, env));
    }
  }

  return new Response(JSON.stringify(upstreamResult), {
    status: 200,
    headers: responseHeaders
  });
}

/* ========================================================================== */
/* 02. ENVIRONMENT VALIDATION                                                 */
/* ========================================================================== */

function validateEnvironment(env) {
  if (!env.GATEWAY_SHARED_SECRET || String(env.GATEWAY_SHARED_SECRET).length < 32) {
    throw new Error("Missing or weak GATEWAY_SHARED_SECRET secret");
  }
  if (!env.GAS_WEB_APP_URL || !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(env.GAS_WEB_APP_URL)) {
    throw new Error("GAS_WEB_APP_URL must be the deployed https://script.google.com/macros/s/.../exec URL");
  }
  if (!env.NONCE_DB) {
    throw new Error("Missing D1 binding NONCE_DB");
  }
  if (!env.ALLOWED_ORIGINS || !String(env.ALLOWED_ORIGINS).trim()) {
    throw new Error("Missing ALLOWED_ORIGINS Worker variable");
  }
}

/* ========================================================================== */
/* 03. CORS                                                                   */
/* ========================================================================== */

function parseAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  if (!origin) return true; // Non-browser health checks; signed API is still required.
  return parseAllowedOrigins(env).includes(origin.replace(/\/$/, ""));
}

function buildCorsHeaders(origin, env) {
  const headers = new Headers();
  headers.set("Vary", "Origin");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  if (origin && env && isAllowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

/* ========================================================================== */
/* 04. D1 NONCE REPLAY PROTECTION                                             */
/* ========================================================================== */

async function registerNonceOrThrow(database, nonce, timestamp) {
  if (!database) throw new Error("D1 database binding is not available");
  const result = await database
    .prepare("INSERT OR IGNORE INTO used_nonces (nonce, created_at) VALUES (?1, ?2)")
    .bind(nonce, timestamp)
    .run();

  const changes = Number(result && result.meta && result.meta.changes || 0);
  if (changes !== 1) throw new Error("Nonce already exists");
}

async function cleanOldNonces(database, cutoffTimestamp) {
  try {
    await database
      .prepare("DELETE FROM used_nonces WHERE created_at < ?1")
      .bind(cutoffTimestamp)
      .run();
  } catch (error) {
    // Cleanup failure must not expose data or bypass nonce checks.
    console.warn("Old nonce cleanup failed");
  }
}

/* ========================================================================== */
/* 05. SIGNING AND CRYPTOGRAPHIC RANDOMNESS                                   */
/* ========================================================================== */

async function signHmacSha256Base64Url(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToBase64Url(new Uint8Array(signatureBuffer));
}

function createSecureRandomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function createHexNonce(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function bytesToHex(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    output += bytes[index].toString(16).padStart(2, "0");
  }
  return output;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/* ========================================================================== */
/* 06. SESSION COOKIE                                                         */
/* ========================================================================== */

function getCookieSameSite(env) {
  const value = String(env.COOKIE_SAMESITE || "None").trim();
  return ["None", "Lax", "Strict"].includes(value) ? value : "None";
}

function buildSessionCookie(name, token, maxAge, env) {
  return [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    `SameSite=${getCookieSameSite(env)}`,
    `Max-Age=${maxAge}`
  ].join("; ");
}

function clearSessionCookie(name, env) {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    `SameSite=${getCookieSameSite(env)}`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");
}

function readCookie(cookieHeader, cookieName) {
  const parts = String(cookieHeader || "").split(";");
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }
  return "";
}

/* ========================================================================== */
/* 07. JSON RESPONSE                                                          */
/* ========================================================================== */

function jsonResponse(body, status, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}
