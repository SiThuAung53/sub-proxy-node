#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash install.sh ..."
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: bash install.sh <domain> [email|-] [app_dir] [github_repo] [branch]"
  echo "Example with email: bash install.sh nextv2.cc admin@nextv2.cc /opt/sub-proxy"
  echo "Example without email: bash install.sh nextv2.cc - /opt/sub-proxy"
  echo "Example with GitHub: bash install.sh nextv2.cc - /opt/sub-proxy https://github.com/USER/REPO.git main"
  exit 1
fi

DOMAIN="$1"
EMAIL="${2:-}"
APP_DIR="${3:-/opt/sub-proxy}"
GITHUB_REPO="${4:-${GITHUB_REPO:-}}"
GIT_BRANCH="${5:-main}"
APP_NAME="sub-proxy"
APP_PORT="8080"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl ca-certificates gnupg nginx git ufw

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm install -g pm2

mkdir -p "$APP_DIR"

if [[ -n "$GITHUB_REPO" ]]; then
  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" fetch --all --prune
    git -C "$APP_DIR" checkout "$GIT_BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$GIT_BRANCH"
  else
    rm -rf "$APP_DIR"
    git clone --depth 1 --branch "$GIT_BRANCH" "$GITHUB_REPO" "$APP_DIR"
  fi
fi

cd "$APP_DIR"

if [[ ! -f package.json || ! -f server.js ]]; then
  echo "Missing package.json/server.js in $APP_DIR"
  echo "Upload files there OR provide github_repo argument / GITHUB_REPO env."
  exit 1
fi

npm install --omit=dev

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

sed -i 's/^HOST=.*/HOST=127.0.0.1/' .env || true
sed -i 's/^PORT=.*/PORT=8080/' .env || true

grep -q '^HOST=' .env || echo 'HOST=127.0.0.1' >> .env
grep -q '^PORT=' .env || echo 'PORT=8080' >> .env

# Detect available RAM and set limits
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
NUM_CORES=$(nproc)

# Use 2 workers (enough for proxy workload, saves CPU)
# Only use more on large servers (8+ cores, 4GB+ RAM)
WORKERS=2
if [ "$NUM_CORES" -ge 8 ] && [ "$TOTAL_RAM_MB" -ge 4096 ]; then
  WORKERS=4
fi

# Reserve 300MB for OS+nginx, split rest among workers
AVAILABLE_MB=$((TOTAL_RAM_MB - 300))
PER_WORKER_MB=$((AVAILABLE_MB / WORKERS))
# Clamp between 128MB–400MB per worker
if [ "$PER_WORKER_MB" -lt 128 ]; then PER_WORKER_MB=128; fi
if [ "$PER_WORKER_MB" -gt 400 ]; then PER_WORKER_MB=400; fi
# Node heap = 80% of per-worker limit
NODE_HEAP_MB=$((PER_WORKER_MB * 80 / 100))

echo "RAM=${TOTAL_RAM_MB}MB cores=${NUM_CORES} workers=${WORKERS} per_worker=${PER_WORKER_MB}MB node_heap=${NODE_HEAP_MB}MB"

pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start "$APP_DIR/server.js" \
  -i "$WORKERS" \
  --name "$APP_NAME" \
  --update-env \
  --max-memory-restart "${PER_WORKER_MB}M" \
  --node-args="--max-old-space-size=${NODE_HEAP_MB}"
pm2 save

PM2_STARTUP_CMD="$(pm2 startup systemd -u root --hp /root | tail -n 1)"
bash -lc "$PM2_STARTUP_CMD" || true

cat >/etc/nginx/sites-available/${APP_NAME} <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location ~ /\\. {
        deny all;
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/${APP_NAME}
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw allow OpenSSH >/dev/null 2>&1 || true

apt-get install -y certbot python3-certbot-nginx
if [[ -n "$EMAIL" && "$EMAIL" != "-" ]]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || true
else
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || true
fi

systemctl enable certbot.timer >/dev/null 2>&1 || true
systemctl start certbot.timer >/dev/null 2>&1 || true
certbot renew --dry-run || true

echo
echo "Install complete"
echo "Health URL: http://${DOMAIN}/health"
echo "Health URL: https://${DOMAIN}/health"
echo "Renewal timer: systemctl status certbot.timer"
echo "Dry-run check: certbot renew --dry-run"
echo "PM2 status: pm2 status"
