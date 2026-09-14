import json, os, shutil, subprocess, sys, tempfile, threading, time, http.server, urllib.request
src = open("/Users/ratneshkushwaha/Downloads/data saver extension/scripts/e2e-edge.py").read().split("if __name__ ==")[0]
ns = {"__file__": "/Users/ratneshkushwaha/Downloads/data saver extension/scripts/e2e-edge.py"}
exec(compile(src, "e2e", "exec"), ns)
WS = ns["WS"]
ROOT = "/Users/ratneshkushwaha/Downloads/data saver extension"
EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
PORT, WEB = 9455, 8755

PAGE = b"""<!doctype html><meta charset=utf-8><title>iframe probe</title>
<script>
window.__ev = [];
function note(tag, type, el) {
  window.__ev.push({tag: tag, type: type, src: (el && el.src || '').slice(0, 48)});
}
</script>
<iframe id="a" src="https://googlesyndication.com/frame-a.html"></iframe>
<iframe id="b" src="https://doubleclick.net/frame-b.html"></iframe>
<embed id="c" src="https://doubleclick.net/thing.swf" type="application/x-shockwave-flash">
<object id="d" data="https://googlesyndication.com/obj.png"></object>
<img id="e" src="https://example-cdn.test/x.png">
<script>
for (const id of ['a','b','c','d','e']) {
  const el = document.getElementById(id);
  el.addEventListener('load',  () => note(el.tagName, 'load', el));
  el.addEventListener('error', () => note(el.tagName, 'error', el));
}
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName) note(e.target.tagName, 'capture-error', e.target);
}, true);
</script>
"""

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE))); self.end_headers(); self.wfile.write(PAGE)
    def log_message(self,*a): pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", WEB), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

profile = tempfile.mkdtemp(prefix="ds-probe-")
p = subprocess.Popen([EDGE, f"--user-data-dir={profile}", f"--remote-debugging-port={PORT}",
    f"--load-extension={ROOT}", f"--disable-extensions-except={ROOT}", "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try:
            v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2)); break
        except Exception: time.sleep(0.4)
    time.sleep(3)
    b = WS(v["webSocketDebuggerUrl"])
    t = b.call("Target.createTarget", {"url": f"http://127.0.0.1:{WEB}/"})["targetId"]
    time.sleep(6)
    sess = b.call("Target.attachToTarget", {"targetId": t, "flatten": True})["sessionId"]
    r = b.call("Runtime.evaluate", {"expression": "JSON.stringify(window.__ev)", "returnByValue": True}, session=sess)
    events = json.loads(r["result"]["value"])
    print("events observed on blocked elements:\n")
    for e in events:
        print(f"  {e['tag']:8} {e['type']:16} {e['src']}")
    print("\nby tag:")
    seen = {}
    for e in events: seen.setdefault(e["tag"], set()).add(e["type"])
    for tag in ["IFRAME","EMBED","OBJECT","IMG"]:
        print(f"  {tag:8} -> {sorted(seen.get(tag, [])) or 'NOTHING FIRED'}")
finally:
    p.terminate()
    try: p.wait(timeout=8)
    except Exception: p.kill()
    srv.shutdown(); shutil.rmtree(profile, ignore_errors=True)
