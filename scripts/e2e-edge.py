#!/usr/bin/env python3
"""
End-to-end test of the savings meter against a real Chromium engine.

There is no Chrome on this machine, so this drives Microsoft Edge, which runs
the same extension stack. It loads the unpacked extension, serves a local page
full of blockable resources, lets the extension actually block them, then reads
chrome.storage.local out of the live service worker over the DevTools protocol.

This is the only check that exercises DNR rules, content-script injection and
the counter together. scripts/test-savings.mjs covers the logic in isolation;
this covers "does it work in a browser".

    python3 scripts/e2e-edge.py [--keep]

Exits non-zero if the meter did not count what it should have.
"""

import base64
import hashlib
import http.server
import json
import os
import random
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --dir lets the run load a directory other than the working tree — in
# practice, an extracted release zip. The working tree and the zip are not the
# same thing: the zip is built from an explicit include list, so a file that
# exists on disk and is missing from that list passes every test here and then
# breaks for real users. Test what ships.
_dir = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--dir=")), None)
if _dir:
    # realpath, not abspath: Chrome derives an unpacked extension's id from the
    # resolved path, and on macOS /tmp is a symlink to /private/tmp. abspath
    # leaves the symlink in place, so the predicted id never matches and the
    # run fails looking for a service worker that is right there.
    ROOT = os.path.realpath(_dir)
EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
PORT_CDP = 9333
PORT_WEB = 8731

IMAGES = 20
SCRIPTS = 4
IFRAMES = 3


# ---------------------------------------------------------------------------
# Unpacked extension IDs are a hash of the absolute path, so we can predict the
# ID instead of scraping it out of the browser.
# ---------------------------------------------------------------------------
def unpacked_extension_id(path: str) -> str:
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


# ---------------------------------------------------------------------------
# Minimal WebSocket client — just enough for CDP. Avoids adding a dependency to
# a project that currently has none.
# ---------------------------------------------------------------------------
class WS:
    def __init__(self, url: str):
        _, rest = url.split("://", 1)
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=20)
        key = base64.b64encode(bytes(random.getrandbits(8) for _ in range(16))).decode()
        self.sock.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        if b"101" not in buf.split(b"\r\n")[0]:
            raise RuntimeError(f"WebSocket upgrade refused: {buf[:200]!r}")
        self.rest = buf.split(b"\r\n\r\n", 1)[1]
        self._id = 0

    def _recv(self, n):
        while len(self.rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("socket closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, obj):
        payload = json.dumps(obj).encode()
        header = bytes([0x81])
        mask = bytes(random.getrandbits(8) for _ in range(4))
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def recv(self):
        while True:
            b0, b1 = self._recv(2)
            opcode = b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._recv(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv(8))[0]
            data = self._recv(n)
            if opcode == 0x8:
                raise RuntimeError("websocket closed by peer")
            if opcode in (0x1, 0x2):
                return json.loads(data)

    def call(self, method, params=None, session=None):
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.send(msg)
        while True:
            r = self.recv()
            if r.get("id") == self._id:
                if "error" in r:
                    raise RuntimeError(f"{method}: {r['error']}")
                return r.get("result", {})


# ---------------------------------------------------------------------------
# A page with resources the extension should block.
# ---------------------------------------------------------------------------
def test_page() -> bytes:
    parts = ["<!doctype html><meta charset=utf-8><title>blocked-resource fixture</title><h1>fixture</h1>"]
    for i in range(IMAGES):
        parts.append(f'<img src="https://images.example-cdn.test/photo-{i}.jpg" alt="">')
    for i in range(SCRIPTS):
        parts.append(f'<script src="https://doubleclick.net/tag-{i}.js"></script>')
    for i in range(IFRAMES):
        parts.append(f'<iframe src="https://googlesyndication.com/frame-{i}.html"></iframe>')
    return "\n".join(parts).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = test_page()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def wait_for_cdp(timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json/version", timeout=2) as r:
                return json.load(r)
        except Exception:
            time.sleep(0.3)
    raise RuntimeError("Edge did not expose a DevTools endpoint in time")


def targets():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json/list", timeout=5) as r:
        return json.load(r)


def main():
    keep = "--keep" in sys.argv
    real_url = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--url=")), None)
    if not os.path.exists(EDGE):
        print(f"Microsoft Edge not found at {EDGE}", file=sys.stderr)
        return 2

    ext_id = unpacked_extension_id(ROOT)
    print(f"extension path : {ROOT}")
    print(f"predicted id   : {ext_id}")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT_WEB), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"fixture served : http://127.0.0.1:{PORT_WEB}/  "
          f"({IMAGES} images, {SCRIPTS} scripts, {IFRAMES} iframes)")

    profile = tempfile.mkdtemp(prefix="ds-e2e-")
    proc = subprocess.Popen(
        [
            EDGE,
            f"--user-data-dir={profile}",
            f"--remote-debugging-port={PORT_CDP}",
            f"--load-extension={ROOT}",
            f"--disable-extensions-except={ROOT}",
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        wait_for_cdp()
        print("edge           : up")

        # The service worker registers rulesets and content scripts on startup;
        # give it a moment before asking it to block anything.
        time.sleep(2.5)

        sw = None
        for _ in range(20):
            sw = next((t for t in targets()
                       if t.get("type") == "service_worker" and ext_id in t.get("url", "")), None)
            if sw:
                break
            time.sleep(0.5)
        if not sw:
            print("\nFAIL: extension service worker never appeared. Targets seen:", file=sys.stderr)
            for t in targets():
                print(f"  {t.get('type')}  {t.get('url','')[:90]}", file=sys.stderr)
            return 1
        print("service worker : running")

        ws = WS(sw["webSocketDebuggerUrl"])

        def sw_eval(expr):
            r = ws.call("Runtime.evaluate",
                        {"expression": expr, "awaitPromise": True, "returnByValue": True})
            return r.get("result", {}).get("value")

        # Start from a clean slate so the assertions below are about this run.
        sw_eval("chrome.storage.local.set({stats:{ads:0,images:0,media:0,bytes:0,since:null}}).then(()=>1)")

        # A fresh profile must come up with YouTube already unblocked, seeded by
        # onInstalled — this is the default that stops the extension looking
        # broken on the site people try first.
        seeded = sw_eval(
            "chrome.storage.sync.get({allowlist:[],seededDefaults:null})"
            ".then(r=>JSON.stringify(r))")
        seeded = json.loads(seeded) if seeded else {}
        seeded_list = seeded.get("allowlist") or []
        expected = json.loads(sw_eval("Promise.resolve(JSON.stringify(DEFAULT_ALLOWLIST))"))
        print(f"default allowlist: {len(seeded_list)} entries seeded "
              f"({', '.join(seeded_list[:4])}, …)")
        yt_ok = (sorted(seeded_list) == sorted(expected)
                 and sorted(seeded.get("seededDefaults") or []) == sorted(expected))

        yt_state = sw_eval(
            "chrome.storage.sync.get({allowlist:[]})"
            ".then(r=>['youtube.com','www.youtube.com','m.youtube.com','notyoutube.com']"
            ".map(h=>h+'='+isAllowlisted(h,r.allowlist)).join(' '))")
        print(f"youtube matching : {yt_state}")

        rulesets = sw_eval("chrome.declarativeNetRequest.getEnabledRulesets().then(r=>r.join(','))")
        print(f"rulesets on    : {rulesets}")

        scripts = sw_eval("chrome.scripting.getRegisteredContentScripts().then(s=>s.map(x=>x.id).join(','))")
        print(f"scripts        : {scripts}")

        # Drive a real page load through the browser. /json/new is PUT-only on
        # current Chromium, so go through the browser-level CDP endpoint instead.
        browser = WS(wait_for_cdp()["webSocketDebuggerUrl"])
        fixture = real_url or f"http://127.0.0.1:{PORT_WEB}/"
        browser.call("Target.createTarget", {"url": fixture})
        print(f"loaded fixture : {fixture}")

        # The counter batches for 3s; give it that plus load time.
        time.sleep(7)

        stats = sw_eval("chrome.storage.local.get({stats:null}).then(r=>JSON.stringify(r.stats))")
        stats = json.loads(stats) if stats else None
        print(f"\nstats          : {stats}")

        if not stats:
            print("\nFAIL: no stats recorded at all", file=sys.stderr)
            return 1

        total = stats["ads"] + stats["images"] + stats["media"]
        mb = stats["bytes"] / (1024 * 1024)
        print(f"counted        : {total} requests, ~{mb:.1f} MB estimated "
              f"(ads={stats['ads']}, images={stats['images']})")

        # ---- The popup and the dashboard, under real extension APIs. ----
        # Everything above exercises the service worker and the content
        # scripts. The popup is the surface users actually touch, and until
        # now it had only ever been rendered against hand-written stubs — a
        # stub that has drifted from the real API does not throw, it just
        # quietly renders an empty panel. So load both pages for real and
        # assert they populated: if popup.js threw at DOMContentLoaded these
        # nodes keep their placeholder text and nothing is wired up.
        def probe(page_name, expr):
            t = browser.call("Target.createTarget",
                             {"url": f"chrome-extension://{ext_id}/{page_name}"})
            sid = browser.call("Target.attachToTarget",
                               {"targetId": t["targetId"], "flatten": True})["sessionId"]
            time.sleep(2.5)
            r = browser.call("Runtime.evaluate",
                             {"expression": expr, "returnByValue": True,
                              "awaitPromise": True}, session=sid)
            browser.call("Target.closeTarget", {"targetId": t["targetId"]})
            return r.get("result", {}).get("value")

        print("\nloading the popup and dashboard for real …")

        popup = probe("popup.html", """(() => {
          const host = document.getElementById('siteHost');
          const amount = document.getElementById('savedAmount');
          const top = document.getElementById('savedTop');
          const ads = document.getElementById('adsToggle');
          const pills = document.querySelectorAll('.pill');
          return JSON.stringify({
            host: (host && host.textContent || '').trim(),
            shown: !!(top && !top.hidden),
            amount: (amount && amount.textContent || '').trim(),
            adsChecked: !!(ads && ads.checked),
            pills: pills.length,
            err: window.__err || null
          });
        })()""")
        print(f"popup          : {popup}")

        dash = probe("dashboard.html", """(() => {
          const t7 = document.getElementById('t7');
          const trend = document.getElementById('trend');
          const gb = document.getElementById('budgetGB');
          return JSON.stringify({
            totals: (t7 && t7.textContent || '').trim(),
            trendBars: trend ? trend.children.length : 0,
            budgetField: !!gb,
            topSites: !!document.getElementById('topSites').textContent.trim()
          });
        })()""")
        print(f"dashboard      : {dash}")

        import json as _json
        pu, da = _json.loads(popup or "{}"), _json.loads(dash or "{}")
        ui_ok = True
        # The toggle reflecting stored state proves popup.js ran to completion:
        # it is set from a storage callback near the end of initialisation.
        if not pu.get("adsChecked"):
            print("  ✗ popup: ads toggle never reflected stored settings"); ui_ok = False
        if pu.get("pills") != 3:
            print(f"  ✗ popup: expected 3 per-site pills, saw {pu.get('pills')}"); ui_ok = False
        if not pu.get("shown"):
            print("  ✗ popup: savings figure stayed hidden despite counted blocks"); ui_ok = False
        if da.get("trendBars") != 14:
            print(f"  ✗ dashboard: expected a 14-day trend, saw {da.get('trendBars')} bars"); ui_ok = False
        if not da.get("budgetField"):
            print("  ✗ dashboard: data budget controls missing"); ui_ok = False
        print("  both pages initialised correctly" if ui_ok else "  UI CHECK FAILED")

        if real_url:
            print("\n(--url run: reporting only, fixture assertions skipped)")
            return 0

        # ---- The escape hatch: pausing a site must actually stop blocking. ----
        # This is the control that matters most for retention, so it is proved
        # against a real browser rather than a stub. Reset the counters, pause
        # the fixture's host, reload, and assert nothing gets blocked.
        print("\npausing 127.0.0.1 and reloading …")
        sw_eval("chrome.storage.local.set({stats:{ads:0,images:0,media:0,bytes:0,since:null}}).then(()=>1)")
        sw_eval("toggleSite('127.0.0.1').then(p=>p)")
        time.sleep(2)

        allowlist = sw_eval("chrome.storage.sync.get({allowlist:[]})"
                            ".then(r=>r.allowlist.filter(d=>!DEFAULT_ALLOWLIST.includes(d)).join(','))")
        print(f"allowlist      : {allowlist!r}")

        browser.call("Target.createTarget", {"url": fixture})
        time.sleep(7)

        after = sw_eval("chrome.storage.local.get({stats:null}).then(r=>JSON.stringify(r.stats))")
        after = json.loads(after) if after else {"ads": 0, "images": 0, "media": 0}
        paused_total = after["ads"] + after["images"] + after["media"]
        print(f"blocked while paused: {paused_total} (expected 0)")

        # Frames: the fixture loads 3 googlesyndication iframes, which fire
        # 'load' rather than 'error' and so can only be counted via the
        # background blocklist lookup. Before that existed this was always 0.
        frames_counted = stats["ads"] >= 3

        ok = True
        if not frames_counted:
            print(f"FAIL: blocked iframes were not counted (ads={stats['ads']}, "
                  f"expected >=3 from the fixture's ad frames)", file=sys.stderr)
            ok = False
        if not yt_ok:
            print(f"FAIL: allowlist not seeded correctly on install -> {seeded_list}", file=sys.stderr)
            ok = False
        if yt_state != ("youtube.com=true www.youtube.com=true "
                        "m.youtube.com=true notyoutube.com=false"):
            print(f"FAIL: youtube subdomain matching wrong -> {yt_state}", file=sys.stderr)
            ok = False
        if allowlist != "127.0.0.1":
            print(f"FAIL: allowlist should contain the host, got {allowlist!r}", file=sys.stderr)
            ok = False
        if paused_total > 2:
            print(f"FAIL: paused site still blocked {paused_total} requests", file=sys.stderr)
            ok = False

        if stats["images"] < IMAGES * 0.8:
            print(f"FAIL: expected ~{IMAGES} images blocked, got {stats['images']}", file=sys.stderr)
            ok = False
        if stats["ads"] < 1:
            print(f"FAIL: expected ad scripts/iframes blocked, got {stats['ads']}", file=sys.stderr)
            ok = False
        if stats["bytes"] <= 0:
            print("FAIL: byte estimate did not accumulate", file=sys.stderr)
            ok = False
        if not stats.get("since"):
            print("FAIL: 'since' was never stamped", file=sys.stderr)
            ok = False

        ok = ok and ui_ok
        print("\nPASS — meter counts, pausing stops them, and both pages load" if ok else "\nFAILED")
        return 0 if ok else 1

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        server.shutdown()
        if keep:
            print(f"profile kept   : {profile}")
        else:
            shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
