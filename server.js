const http = require("http");
const express = require("express");
const { Agent, fetch } = require("undici");

function loadDotEnv(path = ".env") {
  const fs = require("fs");
  if (!fs.existsSync(path)) return;
  const content = fs.readFileSync(path, "utf8");
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 15) * 1000;
const RETRIES = Number(process.env.UPSTREAM_RETRIES || 1);
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 60);
const CACHE_STALE_TTL = Number(process.env.CACHE_STALE_TTL_SECONDS || 240);
const SWR_ENABLED = ["1", "true", "yes"].includes((process.env.CACHE_STALE_WHILE_REVALIDATE || "1").toLowerCase());
const LOG_UPSTREAM = ["1", "true", "yes"].includes((process.env.LOG_UPSTREAM || "0").toLowerCase());
const MAX_CONNECTIONS = Number(process.env.HTTP_MAX_CONNECTIONS || 2000);
const MAX_KEEPALIVE = Number(process.env.HTTP_MAX_KEEPALIVE_CONNECTIONS || 400);

const PROTOCOL_RE = /^(?:#.*\n)?\s*((?:vless|vmess|trojan|ss|ssr|tuic|hysteria2?):\/\/[^\s]+)/gim;
const SINGBOX_UA_TOKENS = ["sing-box", "singbox", "sfa", "sfm"];
const CLASHMETA_UA_TOKENS = ["clash-verge", "clash meta", "clash-meta", "mihomo", "clash"];
const V2RAY_UA_TOKENS = ["v2ray", "v2rayng", "v2rayn"];

const app = express();
app.set("x-powered-by", false);

const agent = new Agent({
  connections: MAX_CONNECTIONS,
  keepAliveMaxTimeout: 20000,
  keepAliveTimeout: 20000,
  pipelining: 1,
});

const cache = new Map();
const inFlight = new Map();
const refreshing = new Set();
let cacheHits = 0;
let cacheMisses = 0;

function looksLikeBase64(s) {
  const str = String(s || "").trim();
  if (!str || str.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(str);
}

function maybeDecodeBase64(text) {
  if (!looksLikeBase64(text)) return text;
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    if (decoded.includes("://")) return decoded;
    return text;
  } catch {
    return text;
  }
}

function extractLinks(text) {
  const matches = [];
  PROTOCOL_RE.lastIndex = 0;
  let m;
  while ((m = PROTOCOL_RE.exec(text)) !== null) {
    if (m[1]) matches.push(m[1].trim());
  }
  if (matches.length > 0) return `${matches.join("\n")}\n`;
  return text;
}

function detectClient(userAgent = "", clientHint = "") {
  const hint = String(clientHint || "").trim().toLowerCase();
  if (["singbox", "clashmeta", "v2ray"].includes(hint)) return hint;
  if (["clash", "meta", "clash-meta", "mihomo"].includes(hint)) return "clashmeta";
  if (["v2rayng", "v2rayn"].includes(hint)) return "v2ray";
  if (hint === "sing-box") return "singbox";

  const ua = String(userAgent || "").toLowerCase();
  if (SINGBOX_UA_TOKENS.some((t) => ua.includes(t))) return "singbox";
  if (CLASHMETA_UA_TOKENS.some((t) => ua.includes(t))) return "clashmeta";
  if (V2RAY_UA_TOKENS.some((t) => ua.includes(t))) return "v2ray";
  return "default";
}

function rewriteUpstreamForClient(upstream, clientName) {
  let parsed;
  try {
    parsed = new URL(upstream);
  } catch {
    return upstream;
  }

  if (!parsed.pathname.includes("/auto/")) return upstream;
  let targetPath = null;
  if (clientName === "singbox") targetPath = "/singbox/";
  else if (clientName === "clashmeta") targetPath = "/clashmeta/";
  else if (clientName === "v2ray") targetPath = "/sub/";
  else return upstream;

  parsed.pathname = parsed.pathname.replace("/auto/", targetPath);
  return parsed.toString();
}

function buildCacheKey(url, base64Mode) {
  return `${url}|b64=${base64Mode ? 1 : 0}`;
}

async function fetchUpstreamText(url) {
  let lastErr;
  for (let i = 0; i <= Math.max(0, RETRIES); i += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": "sub-proxy-node/1.0",
          accept: "text/plain,text/html,*/*",
        },
        signal: controller.signal,
        dispatcher: agent,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const err = new Error(`upstream http error: ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      return await resp.text();
    } catch (e) {
      lastErr = e;
      if (i < RETRIES) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  throw lastErr || new Error("upstream request failed");
}

async function buildSubscription(url, base64Mode) {
  const text = await fetchUpstreamText(url);
  const decoded = maybeDecodeBase64(text);
  const links = extractLinks(decoded);
  if (!base64Mode) return links;
  return `${Buffer.from(links, "utf8").toString("base64")}\n`;
}

function writeCache(key, body) {
  const now = Date.now();
  cache.set(key, {
    body,
    createdAt: now,
    expiresAt: now + CACHE_TTL * 1000,
    staleUntil: now + (CACHE_TTL + CACHE_STALE_TTL) * 1000,
  });
}

async function refreshInBackground(key, url, base64Mode) {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  try {
    const body = await buildSubscription(url, base64Mode);
    writeCache(key, body);
    if (LOG_UPSTREAM) console.log(`[sub-proxy] background refresh success key=${key.slice(0, 120)}`);
  } catch (e) {
    console.log(`[sub-proxy] background refresh failed: ${e.message || e}`);
  } finally {
    refreshing.delete(key);
  }
}

async function getOrBuildSubscription(url, base64Mode) {
  const key = buildCacheKey(url, base64Mode);
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    cacheHits += 1;
    return cached.body;
  }

  if (cached && cached.staleUntil > now && SWR_ENABLED) {
    cacheHits += 1;
    refreshInBackground(key, url, base64Mode).catch(() => {});
    return cached.body;
  }

  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    cacheMisses += 1;
    const body = await buildSubscription(url, base64Mode);
    writeCache(key, body);
    return body;
  })();

  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok\n");
});

app.get("/metrics", (_req, res) => {
  const total = cacheHits + cacheMisses;
  const ratio = total === 0 ? 0 : Number((cacheHits / total).toFixed(4));
  res.json({
    cache_size: cache.size,
    inflight_keys: inFlight.size,
    cache_hits: cacheHits,
    cache_misses: cacheMisses,
    cache_hit_ratio: ratio,
  });
});

app.get(["/", "/sub"], async (req, res) => {
  const url = String(req.query.url || "");
  if (!url) {
    res.status(400).type("text/plain").send("missing upstream URL. use /sub?url=<encoded_url>\n");
    return;
  }

  const base64Mode = ["1", "true", "yes"].includes(String(req.query.base64 || "0").toLowerCase());
  const clientName = detectClient(req.headers["user-agent"] || "", String(req.query.client || ""));
  const rewrittenUrl = rewriteUpstreamForClient(url, clientName);

  try {
    if (LOG_UPSTREAM && rewrittenUrl !== url) {
      console.log(`[sub-proxy] rewrite client=${clientName} from=${url} to=${rewrittenUrl}`);
    }
    const body = await getOrBuildSubscription(rewrittenUrl, base64Mode);
    res.setHeader("Cache-Control", "no-store");
    res.type("text/plain").send(body);
  } catch (e) {
    const status = Number(e && e.status) || 502;
    if (status >= 400 && status < 600 && e.message && e.message.startsWith("upstream http error")) {
      console.log(`[sub-proxy] ${e.message} for url=${rewrittenUrl}`);
      res.status(502).type("text/plain").send(`${e.message}\n`);
      return;
    }
    console.log(`[sub-proxy] upstream/internal error for url=${rewrittenUrl}: ${e.message || e}`);
    res.status(502).type("text/plain").send(`upstream error: ${e.message || e}\n`);
  }
});

const server = http.createServer(app);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
server.maxConnections = MAX_CONNECTIONS + MAX_KEEPALIVE;

server.listen(PORT, HOST, () => {
  console.log(
    `sub-proxy node startup host=${HOST} port=${PORT} timeout=${TIMEOUT / 1000}s retries=${RETRIES} cache_ttl=${CACHE_TTL}s stale_ttl=${CACHE_STALE_TTL}s max_conn=${MAX_CONNECTIONS}`
  );
});

