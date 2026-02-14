const http = require("http");
const { Agent, fetch } = require("undici");

/* ── .env loader ─────────────────────────────────────────────── */
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

/* ── Config ──────────────────────────────────────────────────── */
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 10) * 1000;
const RETRIES = Number(process.env.UPSTREAM_RETRIES || 1);
const LOG_UPSTREAM = ["1", "true", "yes"].includes(
  (process.env.LOG_UPSTREAM || "0").toLowerCase()
);
const MAX_CONNECTIONS = Number(process.env.HTTP_MAX_CONNECTIONS || 256);
const MAX_KEEPALIVE = Number(process.env.HTTP_MAX_KEEPALIVE_CONNECTIONS || 64);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_REQUESTS || 50);
const MAX_QUEUE = Number(process.env.MAX_QUEUE_SIZE || 100);

/* ── Regex & client detection tokens ─────────────────────────── */
const PROTOCOL_RE =
  /^(?:#.*\n)?\s*((?:vless|vmess|trojan|ss|ssr|tuic|hysteria2?):\/\/[^\s]+)/gim;
const SINGBOX_UA = ["sing-box", "singbox", "sfa", "sfm"];
const CLASHMETA_UA = ["clash-verge", "clash meta", "clash-meta", "mihomo", "clash"];
const V2RAY_UA = ["v2ray", "v2rayng", "v2rayn"];

/* ── Undici agent — controlled concurrency ────────────────────── */
const agent = new Agent({
  connections: MAX_CONNECTIONS,
  keepAliveMaxTimeout: 20_000,
  keepAliveTimeout: 10_000,
  pipelining: 1,
});

/* ── Metrics counters ────────────────────────────────────────── */
let totalRequests = 0;
let activeRequests = 0;
let peakActive = 0;
let totalErrors = 0;
let totalDropped = 0;
let totalQueued = 0;

/* ── Concurrency limiter with queue ──────────────────────────── */
const queue = [];

function tryDrain() {
  while (queue.length > 0 && activeRequests < MAX_CONCURRENT) {
    const next = queue.shift();
    if (!next.res.destroyed) {
      processRequest(next.url, next.base64Mode, next.rewrittenUrl, next.res);
    } else {
      activeRequests--; // was counted when queued
    }
  }
}

function processRequest(url, base64Mode, rewrittenUrl, res) {
  buildSubscription(rewrittenUrl, base64Mode)
    .then((body) => {
      if (res.destroyed) return;
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
    })
    .catch((e) => {
      totalErrors++;
      if (res.destroyed) return;
      const msg = e.message || String(e);
      console.log(`[sub-proxy] error url=${rewrittenUrl}: ${msg}`);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream error: ${msg}\n`);
    })
    .finally(() => {
      activeRequests--;
      tryDrain();
    });
}

/* ── Helpers ─────────────────────────────────────────────────── */
function looksLikeBase64(s) {
  const str = String(s || "").trim();
  if (!str || str.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(str);
}

function maybeDecodeBase64(text) {
  if (!looksLikeBase64(text)) return text;
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    return decoded.includes("://") ? decoded : text;
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
  return matches.length > 0 ? `${matches.join("\n")}\n` : text;
}

function detectClient(ua = "", hint = "") {
  const h = String(hint || "").trim().toLowerCase();
  if (h === "singbox" || h === "sing-box") return "singbox";
  if (["clashmeta", "clash", "meta", "clash-meta", "mihomo"].includes(h)) return "clashmeta";
  if (["v2ray", "v2rayng", "v2rayn"].includes(h)) return "v2ray";

  const u = String(ua || "").toLowerCase();
  if (SINGBOX_UA.some((t) => u.includes(t))) return "singbox";
  if (CLASHMETA_UA.some((t) => u.includes(t))) return "clashmeta";
  if (V2RAY_UA.some((t) => u.includes(t))) return "v2ray";
  return "default";
}

function rewriteForClient(upstream, client) {
  let parsed;
  try {
    parsed = new URL(upstream);
  } catch {
    return upstream;
  }
  if (!parsed.pathname.includes("/auto/")) return upstream;
  const map = { singbox: "/singbox/", clashmeta: "/clashmeta/", v2ray: "/sub/" };
  const target = map[client];
  if (!target) return upstream;
  parsed.pathname = parsed.pathname.replace("/auto/", target);
  return parsed.toString();
}

/* ── Upstream fetch with retry ───────────────────────────────── */
async function fetchUpstream(url) {
  let lastErr;
  for (let i = 0; i <= Math.max(0, RETRIES); i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: { "user-agent": "sub-proxy-node/1.0", accept: "text/plain,text/html,*/*" },
        signal: ac.signal,
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
      clearTimeout(timer);
      lastErr = e;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr || new Error("upstream request failed");
}

/* ── Build subscription (fetch → decode → extract → encode) ── */
async function buildSubscription(url, base64Mode) {
  const raw = await fetchUpstream(url);
  const decoded = maybeDecodeBase64(raw);
  const links = extractLinks(decoded);
  if (!base64Mode) return links;
  return Buffer.from(links, "utf8").toString("base64") + "\n";
}

/* ── Raw HTTP request handler (no Express overhead) ──────────── */
function handleRequest(req, res) {
  // Health check — fast path
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }

  // Metrics
  if (req.url === "/metrics") {
    const mem = process.memoryUsage();
    const body = JSON.stringify({
      total_requests: totalRequests,
      active_requests: activeRequests,
      queued_requests: queue.length,
      peak_active: peakActive,
      total_errors: totalErrors,
      total_dropped: totalDropped,
      total_queued: totalQueued,
      max_concurrent: MAX_CONCURRENT,
      max_queue: MAX_QUEUE,
      memory_rss_mb: Math.round(mem.rss / 1048576),
      memory_heap_used_mb: Math.round(mem.heapUsed / 1048576),
      memory_heap_total_mb: Math.round(mem.heapTotal / 1048576),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed\n");
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;

  // Extract upstream URL from either:
  //   Short: /sub/https://upstream.com/path?x=1#frag
  //   Query: /sub?url=https://upstream.com/path
  let url = "";
  const shortMatch = req.url.match(/^\/sub\/(https?:\/\/.+)/);
  if (shortMatch) {
    url = shortMatch[1];
  } else if (pathname === "/" || pathname === "/sub") {
    url = parsed.searchParams.get("url") || "";
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }

  if (!url) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("missing upstream URL.\nuse: /sub/https://upstream.com/path\n or: /sub?url=<encoded_url>\n");
    return;
  }

  const base64Mode = ["1", "true", "yes"].includes(
    (parsed.searchParams.get("base64") || "0").toLowerCase()
  );
  const clientName = detectClient(
    req.headers["user-agent"] || "",
    parsed.searchParams.get("client") || ""
  );
  const rewrittenUrl = rewriteForClient(url, clientName);

  totalRequests++;
  activeRequests++;
  if (activeRequests > peakActive) peakActive = activeRequests;

  if (LOG_UPSTREAM && rewrittenUrl !== url) {
    console.log(`[sub-proxy] rewrite client=${clientName} ${url} -> ${rewrittenUrl}`);
  }

  // Concurrency control: process now, queue, or drop
  if (activeRequests <= MAX_CONCURRENT) {
    processRequest(url, base64Mode, rewrittenUrl, res);
  } else if (queue.length < MAX_QUEUE) {
    totalQueued++;
    queue.push({ url, base64Mode, rewrittenUrl, res });
  } else {
    // Server overloaded — drop request
    totalDropped++;
    activeRequests--;
    res.writeHead(503, {
      "content-type": "text/plain",
      "retry-after": "5",
    });
    res.end("server busy, try again later\n");
  }
}

/* ── Server ──────────────────────────────────────────────────── */
const server = http.createServer(handleRequest);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 60_000;
server.maxConnections = 0; // unlimited — let OS handle it

server.listen(PORT, HOST, () => {
  console.log(
    `sub-proxy node startup host=${HOST} port=${PORT} timeout=${TIMEOUT / 1000}s ` +
      `retries=${RETRIES} max_conn=${MAX_CONNECTIONS} max_concurrent=${MAX_CONCURRENT}`
  );
});
