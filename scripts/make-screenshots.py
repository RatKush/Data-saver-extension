#!/usr/bin/env python3
"""
Generate Chrome Web Store listing screenshots (1280x800) from the real extension.

Nothing here is a mockup. It boots Microsoft Edge twice against a locally served
demo page — once with the extension loaded and once without — so the "blocking
on" and "blocking off" frames are genuinely produced by the shipping code. The
popup is rendered from the real popup.html with seeded stats. Compositing is
done in HTML and screenshotted again, which avoids an image-library dependency
(this project has none, and shouldn't grow one for a build script).

The demo page is a generic, invented publication. Using a real news site's
frames in store art would put someone else's masthead and copyrighted photos on
our listing.

    python3 scripts/make-screenshots.py

Writes to store-listing/screenshots/.
"""

import base64
import http.server
import json
import os
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "store-listing", "screenshots")
EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
PORT = 8742

BG = "#1e1e20"
SURFACE = "#29292c"
BORDER = "#3a3a3e"
TEXT = "#f2f2f3"
MUTED = "#9a9aa0"
ACCENT = "#9b3bff"


# ---------------------------------------------------------------------------
# Minimal PNG writer — enough for the demo page's photos.
# ---------------------------------------------------------------------------
def write_png(w, h, fn):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b = fn(x / w, y / h)
            raw += bytes((r & 255, g & 255, b & 255))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def photo(seed):
    """A soft abstract gradient that reads as a photograph at article size."""
    import math

    def fn(u, v):
        a = math.sin((u * 3.1 + seed) * 1.7) * math.cos((v * 2.3 + seed * 0.7) * 2.1)
        b = math.sin((u * 1.3 - v * 2.7 + seed) * 2.9)
        base = [(38, 70, 104), (104, 52, 38), (40, 92, 74), (86, 44, 96), (96, 82, 34)][seed % 5]
        return (
            int(max(0, min(255, base[0] + a * 58 + b * 26 + v * 40))),
            int(max(0, min(255, base[1] + a * 46 + b * 30 + v * 34))),
            int(max(0, min(255, base[2] + a * 62 + b * 22 + v * 28))),
        )

    return write_png(300, 170, fn)


ARTICLES = [
    ("Coastal towns rebuild after the long winter storms",
     "Four months of repairs have reshaped the harbour front, and residents say the quieter season has changed how the town works."),
    ("The slow return of the overnight train",
     "Sleeper routes written off a decade ago are filling again, driven by travellers who would rather arrive rested than early."),
    ("What a thousand rooftop sensors learned about heat",
     "A volunteer network mapped the city street by street, and found differences of nine degrees within a single postcode."),
    ("Small presses are outselling the imprints that dropped them",
     "Independent publishers describe a year of unexpected demand, and the logistics problems that came with it."),
    ("A quieter approach to the morning commute",
     "Transport planners are testing staggered timetables, with early results suggesting crowding falls faster than expected."),
    ("The harbour library that never closes",
     "Open shelving, no membership and a night desk staffed by volunteers — a decade on, the experiment has spread."),
]


def demo_page() -> bytes:
    cards = []
    for i, (title, dek) in enumerate(ARTICLES):
        cards.append(f"""
        <article>
          <img src="/photo{i}.png" width="300" height="170" alt="">
          <h2>{title}</h2>
          <p>{dek}</p>
        </article>""")
    return f"""<!doctype html>
<meta charset="utf-8">
<title>The Harbour Review</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:#fbfbfa; color:#15181a;
         font-family:Georgia,'Times New Roman',serif; }}
  header {{ border-bottom:2px solid #15181a; padding:20px 40px 14px;
            display:flex; align-items:baseline; justify-content:space-between; }}
  .logo {{ font-size:27px; font-weight:700; letter-spacing:-0.5px; }}
  nav {{ font-family:-apple-system,'Segoe UI',sans-serif; font-size:12.5px;
         color:#5d6a68; display:flex; gap:20px; }}
  main {{ padding:26px 40px 40px; display:grid;
          grid-template-columns:repeat(3,1fr); gap:28px 26px; }}
  article img {{ width:100%; height:170px; object-fit:cover; display:block;
                 border-radius:3px; background:#e8ebea; }}
  article h2 {{ font-size:19px; line-height:1.25; margin:11px 0 0; }}
  article p {{ font-size:13.5px; line-height:1.5; color:#4a5654; margin:7px 0 0; }}
</style>
<header>
  <span class="logo">The Harbour Review</span>
  <nav><span>World</span><span>Business</span><span>Culture</span><span>Climate</span><span>Opinion</span></nav>
</header>
<main>{''.join(cards)}</main>
""".encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/photo"):
            idx = int(self.path[6])
            body, ctype = photo(idx), "image/png"
        else:
            body, ctype = demo_page(), "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def shoot(url, out, w, h, with_extension, scale=2):
    profile = tempfile.mkdtemp(prefix="ds-shot-")
    args = [EDGE, f"--user-data-dir={profile}", "--headless=new", "--disable-gpu",
            "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
            f"--force-device-scale-factor={scale}", f"--window-size={w},{h}",
            f"--screenshot={out}"]
    if with_extension:
        args += [f"--load-extension={ROOT}", f"--disable-extensions-except={ROOT}"]
    subprocess.run(args + [url], capture_output=True, timeout=90)
    shutil.rmtree(profile, ignore_errors=True)
    if not os.path.exists(out):
        raise RuntimeError(f"Edge produced no screenshot for {url}")
    return out


def data_uri(path):
    return "data:image/png;base64," + base64.b64encode(open(path, "rb").read()).decode()


# ---------------------------------------------------------------------------
# Store frames
# ---------------------------------------------------------------------------
FRAME_CSS = f"""
  * {{ box-sizing:border-box; }}
  body {{ margin:0; width:1280px; height:800px; background:{BG}; color:{TEXT};
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
          overflow:hidden; }}
  .frame {{ width:1280px; height:800px; padding:54px 60px;
            display:flex; flex-direction:column; }}
  h1 {{ font-size:44px; line-height:1.1; letter-spacing:-1.1px; margin:0;
        font-weight:700; max-width:19ch; }}
  h1 em {{ font-style:normal; color:{ACCENT}; }}
  .sub {{ font-size:18px; color:{MUTED}; margin:14px 0 0; max-width:60ch;
          line-height:1.45; }}
  .stage {{ flex:1; margin-top:34px; position:relative; display:flex;
            gap:26px; align-items:flex-end; justify-content:center; }}
  .shot {{ border:1px solid {BORDER}; border-radius:12px; overflow:hidden;
           box-shadow:0 26px 60px rgba(0,0,0,.5); background:{SURFACE}; }}
  .shot img {{ display:block; }}
  .popup {{ border-radius:14px; overflow:hidden; border:1px solid {BORDER};
            box-shadow:0 30px 70px rgba(0,0,0,.62); }}
  .popup img {{ display:block; width:340px; }}
  .tag {{ position:absolute; font-size:13px; font-weight:600; letter-spacing:.06em;
          text-transform:uppercase; padding:7px 13px; border-radius:999px;
          background:{SURFACE}; border:1px solid {BORDER}; color:{MUTED}; }}
  .tag.on {{ background:rgba(155,59,255,.16); border-color:rgba(155,59,255,.4); color:{ACCENT}; }}
"""


def frame_html(body):
    return f"<!doctype html><meta charset=utf-8><style>{FRAME_CSS}</style>{body}"


def build(tmp):
    os.makedirs(OUT, exist_ok=True)
    url = f"http://127.0.0.1:{PORT}/"

    print("  capturing demo page without the extension …")
    normal = shoot(url, os.path.join(tmp, "normal.png"), 1000, 620, False)
    print("  capturing demo page with blocking on …")
    blocked = shoot(url, os.path.join(tmp, "blocked.png"), 1000, 620, True)

    print("  rendering popup with sample savings …")
    popup_src = open(os.path.join(ROOT, "popup.html")).read()
    stub = """<script>
    window.chrome={storage:{local:{get:(d,cb)=>cb({stats:{ads:4821,images:12043,media:311,
      bytes:4821*30*1024+12043*35*1024+311*300*1024,since:Date.now()-86400000*16}})},
    sync:{get:(d,cb)=>cb({ads:true,images:true,media:true,allowlist:[]}),set:(o,cb)=>cb&&cb()},
    onChanged:{addListener:()=>{}}},
    tabs:{query:(q,cb)=>cb([{id:1,url:'https://theharbourreview.example/world'}]),reload:()=>{}}};
    </script>"""
    shutil.copy(os.path.join(ROOT, "popup.js"), os.path.join(tmp, "popup.js"))
    os.makedirs(os.path.join(tmp, "icons"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "icons", "icon48.png"), os.path.join(tmp, "icons", "icon48.png"))
    open(os.path.join(tmp, "popup.html"), "w").write(
        popup_src.replace('<script src="popup.js"></script>', stub + '<script src="popup.js"></script>'))
    popup = shoot("file://" + os.path.join(tmp, "popup.html"),
                  os.path.join(tmp, "popup.png"), 300, 430, False)

    u_normal, u_blocked, u_popup = data_uri(normal), data_uri(blocked), data_uri(popup)

    frames = [
        ("01-savings.png", f"""
        <div class="frame">
          <h1>See exactly what you're <em>saving</em></h1>
          <p class="sub">Every ad, image and video blocked is counted, with a running estimate
          of the data it would have cost you.</p>
          <div class="stage">
            <div class="shot"><img src="{u_blocked}" width="820"></div>
            <div class="popup" style="margin-bottom:8px"><img src="{u_popup}"></div>
          </div>
        </div>"""),

        ("02-before-after.png", f"""
        <div class="frame">
          <h1>The same page, <em>without the weight</em></h1>
          <p class="sub">Images, ad networks and autoplay video stop at the network layer —
          before a single byte is downloaded.</p>
          <div class="stage" style="align-items:center">
            <div style="position:relative">
              <div class="shot"><img src="{u_normal}" width="540"></div>
              <span class="tag" style="top:-15px; left:14px">Blocking off</span>
            </div>
            <div style="position:relative">
              <div class="shot"><img src="{u_blocked}" width="540"></div>
              <span class="tag on" style="top:-15px; left:14px">Blocking on</span>
            </div>
          </div>
        </div>"""),

        ("03-controls.png", f"""
        <div class="frame">
          <h1>Three switches. <em>Your call.</em></h1>
          <p class="sub">Block all three for a text-only browser, or keep images and turn off
          just the ads. Pause any single site without touching your settings.</p>
          <div class="stage" style="align-items:center">
            <div class="popup"><img src="{u_popup}" style="width:400px"></div>
          </div>
        </div>"""),
    ]

    for name, body in frames:
        path = os.path.join(tmp, "frame.html")
        open(path, "w").write(frame_html(body))
        dest = os.path.join(OUT, name)
        shoot("file://" + path, dest, 1280, 800, False, scale=1)
        print(f"  wrote {os.path.relpath(dest, ROOT)}")


def main():
    if not os.path.exists(EDGE):
        print("Microsoft Edge not found"); return 2
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="ds-frames-")
    try:
        build(tmp)
        print(f"\nDone — {OUT}")
        print("Chrome Web Store accepts up to 5 screenshots at 1280x800.")
        return 0
    finally:
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
