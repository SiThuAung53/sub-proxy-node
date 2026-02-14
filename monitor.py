#!/usr/bin/env python3
"""
Myanmar IP Health Checker + Telegram Bot
— auto-remove dead IPs from Cloudflare DNS
— notify via Telegram when IPs go down/up
— respond to /status command in Telegram

Run on a mini PC in Thailand (or anywhere with Telegram access).
Uses only Python stdlib (no pip install needed).

Usage:
  1. Copy monitor.example.json to monitor.json
  2. Fill in Cloudflare API token, zone ID, domain, IPs, Telegram bot token
  3. python monitor.py
"""

import http.client
import json
import os
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "monitor.json")

def load_config():
    if not os.path.exists(CONFIG_FILE):
        print(f"[ERROR] Config file not found: {CONFIG_FILE}")
        print(f"  Copy monitor.example.json to monitor.json and fill in your values.")
        sys.exit(1)
    with open(CONFIG_FILE, "r") as f:
        return json.load(f)

# ── Logging ─────────────────────────────────────────────────────

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")

# ── Shared state ────────────────────────────────────────────────

last_status = {
    "healthy": [],
    "dead": [],
    "dns_count": 0,
    "last_check": None,
    "removed": [],
    "added": [],
}

# ── Health check ────────────────────────────────────────────────

def check_ip(ip, domain, timeout=5):
    """Check if IP is reachable by hitting http://<IP>/health with Host header."""
    try:
        conn = http.client.HTTPConnection(ip, 80, timeout=timeout)
        conn.request("GET", "/health", headers={"Host": domain})
        resp = conn.getresponse()
        body = resp.read().decode("utf-8").strip()
        conn.close()
        return resp.status == 200 and body == "ok"
    except Exception:
        return False

# ── Cloudflare API ──────────────────────────────────────────────

CF_API = "api.cloudflare.com"

def cf_request(method, path, token, body=None):
    """Make a Cloudflare API request."""
    conn = http.client.HTTPSConnection(CF_API, timeout=10)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body) if body else None
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    result = json.loads(resp.read().decode("utf-8"))
    conn.close()
    return result

def get_dns_records(zone_id, domain, token):
    """Get all A records for domain."""
    path = f"/client/v4/zones/{zone_id}/dns_records?type=A&name={domain}&per_page=100"
    result = cf_request("GET", path, token)
    if not result.get("success"):
        log(f"[ERROR] Failed to list DNS records: {result.get('errors')}")
        return []
    return result.get("result", [])

def delete_dns_record(zone_id, record_id, token):
    """Delete a DNS A record."""
    path = f"/client/v4/zones/{zone_id}/dns_records/{record_id}"
    result = cf_request("DELETE", path, token)
    return result.get("success", False)

def create_dns_record(zone_id, domain, ip, token):
    """Create a DNS A record (DNS only, no proxy)."""
    path = f"/client/v4/zones/{zone_id}/dns_records"
    body = {
        "type": "A",
        "name": domain,
        "content": ip,
        "ttl": 60,
        "proxied": False,
    }
    result = cf_request("POST", path, token, body)
    return result.get("success", False)

# ── Telegram Bot ────────────────────────────────────────────────

TG_API = "https://api.telegram.org"

def tg_request(method, bot_token, params=None):
    """Make a Telegram Bot API request."""
    url = f"{TG_API}/bot{bot_token}/{method}"
    try:
        if params:
            data = json.dumps(params).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        else:
            req = urllib.request.Request(url)
        ctx = ssl.create_default_context()
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log(f"[TG ERROR] {e}")
        return None

def tg_send(bot_token, chat_id, text):
    """Send a message to Telegram chat."""
    if not bot_token or not chat_id:
        return
    tg_request("sendMessage", bot_token, {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
    })

def build_status_message(domain):
    """Build a status message from last check results."""
    s = last_status
    if not s["last_check"]:
        return "No health check has run yet."

    lines = [f"<b>{domain} Status</b>", f"Last check: {s['last_check']}", ""]

    if s["healthy"]:
        lines.append("<b>Healthy:</b>")
        for ip in s["healthy"]:
            lines.append(f"  {ip}")

    if s["dead"]:
        lines.append("<b>Dead:</b>")
        for ip in s["dead"]:
            lines.append(f"  {ip}")

    lines.append(f"\nDNS has {s['dns_count']} active IP(s)")

    if s["removed"]:
        lines.append(f"Removed: {', '.join(s['removed'])}")
    if s["added"]:
        lines.append(f"Added back: {', '.join(s['added'])}")

    return "\n".join(lines)

def tg_poll_loop(config):
    """Poll Telegram for /status commands."""
    bot_token = config.get("telegram_bot_token", "")
    chat_id = config.get("telegram_chat_id", "")
    domain = config["domain"]

    if not bot_token:
        return

    log("[TG] Bot polling started. Send /status to get IP health report.")
    offset = 0

    while True:
        try:
            result = tg_request("getUpdates", bot_token, {
                "offset": offset,
                "timeout": 30,
            })
            if not result or not result.get("ok"):
                time.sleep(5)
                continue

            for update in result.get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message", {})
                text = msg.get("text", "").strip()
                from_chat = msg.get("chat", {}).get("id")

                if not from_chat:
                    continue

                # Only respond if chat_id is set and matches, or chat_id is empty (respond to anyone)
                if chat_id and str(from_chat) != str(chat_id):
                    continue

                if text == "/status":
                    reply = build_status_message(domain)
                    tg_send(bot_token, from_chat, reply)
                elif text == "/start":
                    tg_send(bot_token, from_chat,
                        f"IP Health Monitor for <b>{domain}</b>\n\n"
                        f"Commands:\n"
                        f"/status — Show current IP health\n\n"
                        f"You will also receive alerts when IPs go down or come back up.\n\n"
                        f"Your chat ID: <code>{from_chat}</code>")
                elif text == "/id":
                    tg_send(bot_token, from_chat, f"Your chat ID: <code>{from_chat}</code>")

        except Exception as e:
            log(f"[TG ERROR] {e}")
            time.sleep(5)

# ── Main check loop ─────────────────────────────────────────────

def run_check(config):
    token = config["cloudflare_api_token"]
    zone_id = config["zone_id"]
    domain = config["domain"]
    all_ips = config["ips"]
    timeout = config.get("timeout", 5)
    min_healthy = config.get("min_healthy_ips", 1)
    bot_token = config.get("telegram_bot_token", "")
    chat_id = config.get("telegram_chat_id", "")

    # 1. Health check all IPs
    healthy = []
    dead = []
    for ip in all_ips:
        ok = check_ip(ip, domain, timeout)
        if ok:
            healthy.append(ip)
            log(f"  {ip} — OK")
        else:
            dead.append(ip)
            log(f"  {ip} — DEAD")

    # 2. Get current DNS records
    records = get_dns_records(zone_id, domain, token)
    dns_ips = {r["content"]: r["id"] for r in records}

    # 3. Remove dead IPs from DNS
    active_count = len(dns_ips)
    removed = []
    for ip in dead:
        if ip in dns_ips:
            if active_count - len(removed) <= min_healthy:
                log(f"  SKIP removing {ip} — would leave less than {min_healthy} IP(s) in DNS")
                continue
            ok = delete_dns_record(zone_id, dns_ips[ip], token)
            if ok:
                removed.append(ip)
                log(f"  REMOVED {ip} from DNS")
            else:
                log(f"  [ERROR] Failed to remove {ip}")

    # 4. Re-add healthy IPs that are missing from DNS
    added = []
    for ip in healthy:
        if ip not in dns_ips:
            ok = create_dns_record(zone_id, domain, ip, token)
            if ok:
                added.append(ip)
                log(f"  ADDED {ip} back to DNS")
            else:
                log(f"  [ERROR] Failed to add {ip}")

    final_dns = active_count - len(removed) + len(added)
    log(f"  Summary: {len(healthy)}/{len(all_ips)} healthy | removed={len(removed)} added={len(added)} | DNS has {final_dns} IPs")
    print()

    # 5. Update shared state
    last_status["healthy"] = healthy
    last_status["dead"] = dead
    last_status["dns_count"] = final_dns
    last_status["last_check"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    last_status["removed"] = removed
    last_status["added"] = added

    # 6. Send Telegram alerts
    alerts = []
    for ip in removed:
        alerts.append(f"REMOVED {ip} from DNS")
    for ip in added:
        alerts.append(f"ADDED {ip} back to DNS")

    if alerts and bot_token and chat_id:
        msg = f"<b>{domain} Alert</b>\n\n" + "\n".join(alerts)
        msg += f"\n\nHealthy: {len(healthy)}/{len(all_ips)} | DNS: {final_dns} IPs"
        tg_send(bot_token, chat_id, msg)

def main():
    config = load_config()
    interval = config.get("check_interval", 60)
    bot_token = config.get("telegram_bot_token", "")

    log(f"Monitor started — domain={config['domain']} ips={len(config['ips'])} interval={interval}s")
    if bot_token:
        log(f"Telegram bot enabled. Send /start to your bot to get started.")
    log(f"Checking from this network. Press Ctrl+C to stop.\n")

    # Start Telegram polling in background thread
    if bot_token:
        t = threading.Thread(target=tg_poll_loop, args=(config,), daemon=True)
        t.start()

    while True:
        try:
            log("Health check starting...")
            run_check(config)
        except KeyboardInterrupt:
            log("Stopped by user.")
            break
        except Exception as e:
            log(f"[ERROR] {e}")
            print()

        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            log("Stopped by user.")
            break

if __name__ == "__main__":
    main()
