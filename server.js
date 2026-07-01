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
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 15) * 1000;
const RETRIES = Number(process.env.UPSTREAM_RETRIES || 2);
const LOG_UPSTREAM = ["1", "true", "yes"].includes(
  (process.env.LOG_UPSTREAM || "0").toLowerCase()
);
const MAX_CONNECTIONS = Number(process.env.HTTP_MAX_CONNECTIONS || 256);
const MAX_KEEPALIVE = Number(process.env.HTTP_MAX_KEEPALIVE_CONNECTIONS || 64);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_REQUESTS || 200);
const MAX_QUEUE = Number(process.env.MAX_QUEUE_SIZE || 300);
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 1048576); // POST body cap (1 MB)

/* ── Regex & client detection tokens ─────────────────────────── */
const PROTOCOL_RE =
  /^(?:#.*\n)?\s*((?:vless|vmess|trojan|ss|ssr|tuic|hysteria2?):\/\/[^\s]+)/gim;
const SINGBOX_UA = ["sing-box", "singbox", "sfa", "sfm"];
const CLASHMETA_UA = ["clash-verge", "clash meta", "clash-meta", "mihomo", "clash"];
const V2RAY_UA = ["v2ray", "v2rayng", "v2rayn"];
const OUTLINE_UA = ["outline"];
const BROWSER_UA = ["mozilla", "chrome", "safari", "firefox", "edge", "opera"];
// Hosts whose absolute links are left direct (not routed through the proxy).
const REWRITE_SKIP_HOSTS = ["t.me", "telegram.org", "telegram.me", "w3.org"];

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
    const ctx = queue.shift();
    if (!ctx.res.destroyed) {
      processRequest(ctx);
    } else {
      activeRequests--; // was counted when queued
    }
  }
}

function processRequest(ctx) {
  buildSubscription(ctx)
    .then(({ body, contentType }) => {
      if (ctx.res.destroyed) return;
      ctx.res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      ctx.res.end(body);
    })
    .catch((e) => {
      totalErrors++;
      if (ctx.res.destroyed) return;
      const msg = e.message || String(e);
      console.log(`[sub-proxy] error url=${ctx.rewrittenUrl}: ${msg}`);
      ctx.res.writeHead(502, { "content-type": "text/plain" });
      ctx.res.end(`upstream error: ${msg}\n`);
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
  if (h === "outline") return "outline";
  if (h === "browser") return "browser";

  const u = String(ua || "").toLowerCase();
  if (OUTLINE_UA.some((t) => u.includes(t))) return "outline";
  if (SINGBOX_UA.some((t) => u.includes(t))) return "singbox";
  if (CLASHMETA_UA.some((t) => u.includes(t))) return "clashmeta";
  if (V2RAY_UA.some((t) => u.includes(t))) return "v2ray";
  if (BROWSER_UA.some((t) => u.includes(t))) return "browser";
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

/* ── Proxy self-URL (for rewriting browser pages) ────────────── */
function proxyBaseFrom(req) {
  const proto =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.encrypted ? "https" : "http");
  const host = req.headers.host || "localhost";
  return `${proto}://${host}`;
}

/* ── Rewrite a browser page so its "change server" flow routes ──
   through this proxy. Absolute app links (buttons, back links) are
   prefixed with the proxy; a small injected shim rewrites the page's
   own same-origin API calls (/servers, /pin) at runtime, while
   cross-origin probes / speed-tests are left direct so they still
   measure the client's own reachability. ─────────────────────── */
function proxifyBrowserHtml(html, proxyBase, upstreamOrigin) {
  const out = html.replace(/\bhttps?:\/\/[^\s"'<>()]+/gi, (m) => {
    let host;
    try {
      host = new URL(m).host.toLowerCase();
    } catch {
      return m;
    }
    if (REWRITE_SKIP_HOSTS.some((h) => host === h || host.endsWith("." + h))) return m;
    if (m.startsWith(proxyBase + "/")) return m; // already proxied
    return `${proxyBase}/${m}`;
  });

  const shim =
    "<script>(function(){" +
    "var BASE=" + JSON.stringify(proxyBase) + ",ORIGIN=" + JSON.stringify(upstreamOrigin) + ";" +
    "function P(u){try{var a=new URL(u,location.href);" +
    "if(a.origin===location.origin){" +
    "if(/^\\/https?:\\/\\//i.test(a.pathname))return u;" + // already a proxied path
    "return BASE+\"/\"+ORIGIN+a.pathname+a.search+a.hash;" + // same-origin API -> proxy+upstream
    "}return u;}catch(e){return u;}}" + // cross-origin (probe/speed-test) -> direct
    "var F=window.fetch;window.fetch=function(i,o){try{" +
    "if(typeof i===\"string\")i=P(i);else if(i&&i.url)i=new Request(P(i.url),i);" +
    "}catch(e){}return F.call(this,i,o);};" +
    "var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){" +
    "try{arguments[1]=P(u);}catch(e){}return O.apply(this,arguments);};" +
    "})();</script>";

  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (m) => m + shim);
  return shim + out;
}

/* ── Upstream fetch with retry ───────────────────────────────── */
async function fetchUpstream(ctx) {
  const ua = ctx.userAgent || "sub-proxy-node/1.0";
  const accept = ctx.clientName === "browser"
    ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    : "*/*";
  const isPost = ctx.method === "POST";
  const headers = { "user-agent": ua, accept };
  if (isPost && ctx.reqContentType) headers["content-type"] = ctx.reqContentType;
  // POST is not safe to replay — don't retry it.
  const retries = isPost ? 0 : Math.max(0, RETRIES);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const resp = await fetch(ctx.rewrittenUrl, {
        method: ctx.method || "GET",
        headers,
        body: isPost ? (ctx.body || "") : undefined,
        signal: ac.signal,
        dispatcher: agent,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const err = new Error(`upstream http error: ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      const contentType = resp.headers.get("content-type") || "text/plain";
      const body = await resp.text();
      return { body, contentType };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr || new Error("upstream request failed");
}

/* ── Build subscription (fetch → decode → extract → encode) ── */
async function buildSubscription(ctx) {
  const { clientName, base64Mode, rewrittenUrl, proxyBase, method } = ctx;
  const { body: raw, contentType } = await fetchUpstream(ctx);

  // Non-GET (change-server /pin POST etc.): pass upstream response through as-is.
  if (method && method !== "GET") {
    return { body: raw, contentType };
  }

  // Browser: pass the page through, but rewrite HTML so the change-server
  // buttons and the page's own API calls route back through this proxy.
  if (clientName === "browser") {
    if (/text\/html/i.test(contentType)) {
      const upstreamOrigin = new URL(rewrittenUrl).origin;
      return { body: proxifyBrowserHtml(raw, proxyBase, upstreamOrigin), contentType };
    }
    return { body: raw, contentType };
  }

  // Outline: pass through raw response (ss:// key)
  if (clientName === "outline") {
    return { body: raw, contentType: "text/plain; charset=utf-8" };
  }

  // Clash/Singbox: pass through YAML/JSON config from upstream
  if (clientName === "clashmeta" || clientName === "singbox") {
    return { body: raw, contentType };
  }

  // V2Ray/default: decode and extract protocol links
  const decoded = maybeDecodeBase64(raw);
  const links = extractLinks(decoded);
  const result = base64Mode
    ? Buffer.from(links, "utf8").toString("base64") + "\n"
    : links;
  return { body: result, contentType: "text/plain; charset=utf-8" };
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

  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed\n");
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;

  // Extract upstream URL from:
  //   Shortest: /https://upstream.com/path?x=1#frag
  //   Short:    /sub/https://upstream.com/path?x=1#frag
  //   Query:    /sub?url=https://upstream.com/path
  let url = "";
  const directMatch = req.url.match(/^\/(https?:\/\/.+)/);
  const subMatch = req.url.match(/^\/sub\/(https?:\/\/.+)/);
  if (subMatch) {
    url = subMatch[1];
  } else if (directMatch) {
    url = directMatch[1];
  } else if (pathname === "/" || pathname === "/sub") {
    url = parsed.searchParams.get("url") || "";
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }

  if (!url) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("missing upstream URL.\nuse: /https://upstream.com/path\n or: /sub?url=<encoded_url>\n");
    return;
  }

  const base64Mode = ["1", "true", "yes"].includes(
    (parsed.searchParams.get("base64") || "0").toLowerCase()
  );
  const userAgent = req.headers["user-agent"] || "";
  const clientName = detectClient(
    userAgent,
    parsed.searchParams.get("client") || ""
  );
  const rewrittenUrl = rewriteForClient(url, clientName);

  const ctx = {
    url,
    base64Mode,
    rewrittenUrl,
    res,
    clientName,
    userAgent,
    method: req.method,
    body: "",
    reqContentType: req.headers["content-type"] || "",
    proxyBase: proxyBaseFrom(req),
  };

  if (req.method === "POST") {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("payload too large\n");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted || res.destroyed) return;
      ctx.body = Buffer.concat(chunks).toString("utf8");
      dispatch(ctx);
    });
    req.on("error", () => {
      if (!res.destroyed) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad request\n");
      }
    });
    return;
  }

  dispatch(ctx);
}

/* ── Concurrency control: process now, queue, or drop ────────── */
function dispatch(ctx) {
  totalRequests++;
  activeRequests++;
  if (activeRequests > peakActive) peakActive = activeRequests;

  if (LOG_UPSTREAM) {
    console.log(`[sub-proxy] client=${ctx.clientName} ${ctx.method} url=${ctx.rewrittenUrl}`);
  }

  if (activeRequests <= MAX_CONCURRENT) {
    processRequest(ctx);
  } else if (queue.length < MAX_QUEUE) {
    totalQueued++;
    queue.push(ctx);
  } else {
    // Server overloaded — drop request
    totalDropped++;
    activeRequests--;
    ctx.res.writeHead(503, {
      "content-type": "text/plain",
      "retry-after": "5",
    });
    ctx.res.end("server busy, try again later\n");
  }
}

/* ── Server ──────────────────────────────────────────────────── */
const server = http.createServer(handleRequest);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 60_000;
// Leave server.maxConnections at its default (unlimited). Setting it to 0
// makes Node reject every connection.

server.listen(PORT, HOST, () => {
  console.log(
    `sub-proxy node startup host=${HOST} port=${PORT} timeout=${TIMEOUT / 1000}s ` +
      `retries=${RETRIES} max_conn=${MAX_CONNECTIONS} max_concurrent=${MAX_CONCURRENT}`
  );
});
