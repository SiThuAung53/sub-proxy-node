# Subscription Proxy (Node.js)

High-concurrency subscription relay/converter for V2Ray/Hiddify-compatible clients.

## One-Command Install (Ubuntu)

You can install in two ways:

```bash
sudo bash install.sh YOUR_DOMAIN YOUR_EMAIL /opt/sub-proxy
```

Example:

```bash
sudo bash install.sh nextv2.cc admin@nextv2.cc /opt/sub-proxy
```

If you want HTTP only (no certbot), skip email:

```bash
sudo bash install.sh nextv2.cc - /opt/sub-proxy
```

Install directly from GitHub (no manual upload):

```bash
sudo bash install.sh nextv2.cc - /opt/sub-proxy https://github.com/USER/REPO.git main
```

Or with environment variable:

```bash
export GITHUB_REPO=https://github.com/USER/REPO.git
sudo bash install.sh nextv2.cc - /opt/sub-proxy
```

No-email mode still enables HTTPS using certbot registration without email, enables auto-renew timer, and runs `certbot renew --dry-run`.

## Behavior
- Dynamic mode only: `url=` is required.
- Auto client rewrite when upstream contains `/auto/`:
- Singbox -> `/singbox/`
- Clash Meta -> `/clashmeta/`
- V2Ray -> `/sub/`
- Stateless — no caching, every request fetches fresh from upstream.
- Retry upstream fetch on failure.

## Manual Run
```bash
npm install
cp .env.example .env
npm start
```

## Production (PM2)
```bash
pm2 start server.js -i max --name sub-proxy
pm2 save
pm2 startup
```

## Use in client

Short URL (recommended):
```
https://YOUR_DOMAIN/https://k129.nextprivate.cc/cLefwonRiP/YOUR_UUID/auto/?asn=unknown#K129
```

Also works:
```
https://YOUR_DOMAIN/sub/https://k129.nextprivate.cc/cLefwonRiP/YOUR_UUID/auto/?asn=unknown#K129
https://YOUR_DOMAIN/sub?url=https%3A%2F%2Fk129.nextprivate.cc%2FcLefwonRiP%2FYOUR_UUID%2Fauto%2F%3Fasn%3Dunknown
```

Optional:
- Base64 output: add `?base64=1` (short) or `&base64=1` (query)
- Force client type: add `?client=singbox` or `&client=clashmeta` or `&client=v2ray`

## Endpoints
- `/health`
- `/metrics`
- `/<upstream_url>` — shortest format
- `/sub/<upstream_url>` — short format
- `/sub?url=<encoded_url>` — query format
