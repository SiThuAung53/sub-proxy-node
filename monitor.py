#!/usr/bin/env python3
"""
Myanmar IP Health Checker — auto-remove dead IPs from Cloudflare DNS.

Run on a PC inside Myanmar to detect blocked IPs.
Uses only Python stdlib (no pip install needed).

Usage:
  1. Copy monitor.example.json to monitor.json
  2. Fill in your Cloudflare API token, zone ID, domain, and IPs
  3. python monitor.py
"""

import http.client
import json
import os
import sys
import time
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

# ── Main loop ───────────────────────────────────────────────────

def run_check(config):
    token = config["cloudflare_api_token"]
    zone_id = config["zone_id"]
    domain = config["domain"]
    all_ips = config["ips"]
    timeout = config.get("timeout", 5)
    min_healthy = config.get("min_healthy_ips", 1)

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
    removed = 0
    for ip in dead:
        if ip in dns_ips:
            if active_count - removed <= min_healthy:
                log(f"  SKIP removing {ip} — would leave less than {min_healthy} IP(s) in DNS")
                continue
            ok = delete_dns_record(zone_id, dns_ips[ip], token)
            if ok:
                removed += 1
                log(f"  REMOVED {ip} from DNS")
            else:
                log(f"  [ERROR] Failed to remove {ip}")

    # 4. Re-add healthy IPs that are missing from DNS
    added = 0
    for ip in healthy:
        if ip not in dns_ips:
            ok = create_dns_record(zone_id, domain, ip, token)
            if ok:
                added += 1
                log(f"  ADDED {ip} back to DNS")
            else:
                log(f"  [ERROR] Failed to add {ip}")

    log(f"  Summary: {len(healthy)}/{len(all_ips)} healthy | removed={removed} added={added} | DNS has {active_count - removed + added} IPs")
    print()

def main():
    config = load_config()
    interval = config.get("check_interval", 60)

    log(f"Monitor started — domain={config['domain']} ips={len(config['ips'])} interval={interval}s")
    log(f"Checking from this network. Press Ctrl+C to stop.\n")

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
