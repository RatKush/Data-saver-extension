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
import importlib.util
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

# Kept in step with popup.html's dark tokens. These are the frame the popup is
# composited onto, so if they drift from the popup's own palette the store art
# shows a teal panel floating on the colours of a design that no longer exists.
BG = "#1B1C1E"
SURFACE = "#232629"
BORDER = "#34383D"
TEXT = "#F1F3F4"
MUTED = "#98A0A6"
ACCENT = "#35C2AC"
ACCENT_SOFT = "rgba(53, 194, 172, .15)"
ACCENT_LINE = "rgba(53, 194, 172, .40)"


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


# Edge's one-shot `--headless --screenshot=URL` hangs indefinitely on any
# http:// URL on this machine, though it is fine with file://. The fixture has
# to be served over http — declarativeNetRequest rules and <all_urls> content
# scripts do not apply to file:// — so screenshots are taken the way
# scripts/e2e-edge.py already drives the browser successfully: launch Edge with
# a debugging port and capture through CDP. That client is imported rather than
# copied so there is one WebSocket implementation to maintain.
PORT_CDP = 9344

def _load_cdp():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e-edge.py")
    spec = importlib.util.spec_from_file_location("ds_e2e_edge", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.WS


WS = _load_cdp()


def _wait_for_cdp(timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json/version", timeout=2):
                return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("Edge never opened its debugging port")


def shoot(url, out, w, h, with_extension, scale=2, dark=False):
    profile = tempfile.mkdtemp(prefix="ds-shot-")
    args = [EDGE, f"--user-data-dir={profile}", f"--remote-debugging-port={PORT_CDP}",
            "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--hide-scrollbars"]
    if with_extension:
        args += [f"--load-extension={ROOT}", f"--disable-extensions-except={ROOT}"]
    proc = subprocess.Popen(args + ["about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        _wait_for_cdp()
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json/list", timeout=5) as r:
            targets = json.load(r)
        page = next(t for t in targets if t.get("type") == "page")
        ws = WS(page["webSocketDebuggerUrl"])

        # Set the viewport through CDP rather than --window-size: headless
        # rounds the window down by the OS chrome otherwise, and the composited
        # frames need exact pixel dimensions.
        ws.call("Emulation.setDeviceMetricsOverride",
                {"width": w, "height": h, "deviceScaleFactor": scale, "mobile": False})
        if dark:
            # popup.html follows prefers-color-scheme, and a light panel on a
            # dark store frame reads as a screenshot of something else.
            ws.call("Emulation.setEmulatedMedia",
                    {"features": [{"name": "prefers-color-scheme", "value": "dark"}]})
        ws.call("Page.enable")
        ws.call("Page.navigate", {"url": url})
        # A page whose resources are being blocked may never reach a quiet
        # network state, so settle on a fixed pause rather than an event.
        time.sleep(3.5)

        shot = ws.call("Page.captureScreenshot", {"format": "png"})
        with open(out, "wb") as fh:
            fh.write(base64.b64decode(shot["data"]))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
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
  .shot {{ flex:none; border:1px solid {BORDER}; border-radius:12px; overflow:hidden;
           box-shadow:0 26px 60px rgba(0,0,0,.5); background:{SURFACE}; }}
  .shot img {{ display:block; }}
  .popup {{ flex:none; border-radius:14px; overflow:hidden; border:1px solid {BORDER};
            box-shadow:0 30px 70px rgba(0,0,0,.62); }}
  .popup img {{ display:block; width:342px; }}
  .popup.crop {{ height:470px; }}
  .frame.split {{ flex-direction:row; align-items:center; gap:54px; }}
  .frame.split .copy {{ flex:1; }}
  .tag {{ position:absolute; font-size:13px; font-weight:600; letter-spacing:.06em;
          text-transform:uppercase; padding:7px 13px; border-radius:999px;
          background:{SURFACE}; border:1px solid {BORDER}; color:{MUTED}; }}
  .tag.on {{ background:{ACCENT_SOFT}; border-color:{ACCENT_LINE}; color:{ACCENT}; }}

  /* argument frames — no UI, just the case for the product */
  .bar {{ display:flex; width:100%; height:210px; border-radius:16px; overflow:hidden;
          gap:3px; margin-top:8px; }}
  .bar div {{ display:flex; flex-direction:column; justify-content:flex-end;
              padding:14px 16px; }}
  .bar b {{ font-size:34px; font-weight:700; letter-spacing:-.8px; line-height:1; }}
  .bar span {{ font-size:15px; opacity:.75; margin-top:7px; }}
  .cap {{ font-size:15px; color:{MUTED}; margin-top:18px; }}
  .pts {{ display:flex; flex-direction:column; gap:34px; margin-top:6px; }}
  .pt {{ display:flex; gap:22px; align-items:flex-start; }}
  .pt .k {{ width:52px; height:52px; border-radius:15px; flex:none; display:grid;
            place-items:center; background:{ACCENT_SOFT}; color:{ACCENT};
            font-size:26px; font-weight:700; }}
  .pt h3 {{ margin:0; font-size:30px; font-weight:700; letter-spacing:-.6px; }}
  .pt p {{ margin:8px 0 0; font-size:19px; color:{MUTED}; line-height:1.5; max-width:62ch; }}
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
    # Stub the APIs popup.js actually uses today. This has to be kept in step
    # with the popup: an out-of-date stub does not error, it just renders an
    # empty panel into the store art.
    stub = """<script>
    const M={savingsRequests:'requests blocked',savingsBytes:'\\u2248 $1 saved',
      savingsEstimatedSince:'Estimated, since $1',savingsAds:'ads',savingsImages:'images',
      savingsVideos:'videos',savingsReset:'Reset',blockAds:'Block Ads',
      blockAdsSub:'Ad networks & trackers',blockImages:'Block Images',
      blockImagesSub:'Loads pages as text-only',blockVideos:'Block Videos',
      blockVideosSub:'Stops autoplay & streaming',popupTitle:'Data Saver',
      popupTagline:'Blocking ads, images & autoplay video',
      siteDontBlock:"Don't block on this site",siteBlocking:'Blocking active',
      shortcutHint:'or press',dashOpen:'Per-site rules & history',saved:'Saved',
      pillBlocking:'Blocking here',pillAllowing:'Allowed here','@@bidi_dir':'ltr'};
    window.chrome={
      i18n:{getMessage:(k,s)=>{let m=M[k]; if(!m) return '';
        if(s)(Array.isArray(s)?s:[s]).forEach((v,i)=>{m=m.split('$'+(i+1)).join(v);}); return m;}},
      storage:{
        local:{get:(d,cb)=>cb({stats:{ads:4821,images:12043,media:311,
          bytes:4821*30*1024+12043*35*1024+311*300*1024,since:Date.now()-86400000*16}}),
          set:(o,cb)=>cb&&cb()},
        sync:{get:(d,cb)=>cb({ads:true,images:true,media:true,allowlist:[],siteProfiles:{}}),
          set:(o,cb)=>cb&&cb()},
        onChanged:{addListener:()=>{}}},
      tabs:{query:(q,cb)=>cb([{id:1,url:'https://theharbourreview.example/world'}]),
        reload:()=>{},create:()=>{}},
      runtime:{id:'shot',lastError:undefined,openOptionsPage:()=>{},
        sendMessage:(m,cb)=>{
          // Review prompt and data budget are OFF by default, so the store art
          // shows what a new user actually gets rather than an unusual state.
          if(m.type==='ds-site-state') cb({paused:false});
          else if(m.type==='ds-review-state') cb({show:false});
          else if(m.type==='ds-budget-state') cb({enabled:false});
          else cb&&cb({ok:true});}}};
    </script>"""
    shutil.copy(os.path.join(ROOT, "popup.js"), os.path.join(tmp, "popup.js"))
    os.makedirs(os.path.join(tmp, "icons"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "icons", "icon48.png"), os.path.join(tmp, "icons", "icon48.png"))
    open(os.path.join(tmp, "popup.html"), "w").write(
        popup_src.replace('<script src="popup.js"></script>', stub + '<script src="popup.js"></script>'))
    # 360 wide because the panel was widened from 300. 650 tall is the panel's
    # own content height — taller leaves an empty strip below the last row in
    # the composited frame, which reads as a rendering fault.
    popup = shoot("file://" + os.path.join(tmp, "popup.html"),
                  os.path.join(tmp, "popup.png"), 360, 650, False, dark=True)

    u_normal, u_blocked, u_popup = data_uri(normal), data_uri(blocked), data_uri(popup)

    frames = [
        ("01-savings.png", f"""
        <div class="frame">
          <h1>See exactly what you're <em>saving</em></h1>
          <p class="sub">Every ad, image and video blocked is counted, with a running estimate
          of the data it would have cost you.</p>
          <div class="stage">
            <div class="shot"><img src="{u_blocked}" style="width:748px"></div>
            <div class="popup crop" style="margin-bottom:8px"><img src="{u_popup}"></div>
          </div>
        </div>"""),

        ("02-before-after.png", f"""
        <div class="frame">
          <h1>The same page, <em>without the weight</em></h1>
          <p class="sub">Images, ad networks and autoplay video stop at the network layer —
          before a single byte is downloaded.</p>
          <div class="stage" style="align-items:center">
            <div style="position:relative">
              <div class="shot"><img src="{u_normal}" style="width:540px"></div>
              <span class="tag" style="top:-15px; left:14px">Blocking off</span>
            </div>
            <div style="position:relative">
              <div class="shot"><img src="{u_blocked}" style="width:540px"></div>
              <span class="tag on" style="top:-15px; left:14px">Blocking on</span>
            </div>
          </div>
        </div>"""),

        ("03-weight.png", f"""
        <div class="frame">
          <h1 style="max-width:30ch">Most of a page <em>isn't the page</em></h1>
          <p class="sub">Images, video and advertising are the bulk of what you download.
          Data Saver stops them at the network layer, so you never pay for the bytes.</p>
          <div class="stage" style="align-items:center">
            <div style="width:100%">
              <div class="bar">
                <div style="flex:45;background:#1F6F62;color:#EAFBF7">
                  <b>30&ndash;60%</b><span>Images</span></div>
                <div style="flex:22;background:#2E9C89;color:#06231E">
                  <b>10&ndash;35%</b><span>Video &amp; audio</span></div>
                <div style="flex:20;background:#5FD0BC;color:#06231E">
                  <b>10&ndash;30%</b><span>Ads &amp; trackers</span></div>
                <div style="flex:13;background:#2A2F31;color:#C7D0D0">
                  <b>The rest</b><span>The words you came for</span></div>
              </div>
              <p class="cap">Typical page weight. The exact split varies by site &mdash; the
              extension shows you your own real figures rather than these.</p>
            </div>
          </div>
        </div>"""),

        ("04-controls.png", f"""
        <div class="frame split">
          <div class="copy">
            <h1>Three switches. <em>Your call.</em></h1>
            <p class="sub">Block all three for a text-only browser, or keep images and turn
            off just the ads. Set a rule for one site, or stop blocking there entirely —
            without touching anything else.</p>
          </div>
          <div class="popup"><img src="{u_popup}"></div>
        </div>"""),

        ("05-trust.png", f"""
        <div class="frame">
          <h1 style="max-width:30ch">Saves data. <em>Doesn't take any.</em></h1>
          <p class="sub">The three things people ask before installing a blocker.</p>
          <div class="stage" style="align-items:center; justify-content:flex-start">
            <div class="pts">
              <div class="pt">
                <div class="k">&#10003;</div>
                <div><h3>Streaming still works</h3>
                <p>Video platforms ship unblocked &mdash; you already know those use data, and
                blocking them just breaks them. Any site is one tap either way.</p></div>
              </div>
              <div class="pt">
                <div class="k">&#10003;</div>
                <div><h3>Nothing is collected</h3>
                <p>No account, no analytics, no server of its own. Every rule ships inside the
                extension and runs in your browser. The source is public.</p></div>
              </div>
              <div class="pt">
                <div class="k">&#10003;</div>
                <div><h3>Free, and in 25 languages</h3>
                <p>No trial, no paid tier, no upsell &mdash; including Hindi, Bengali, Tamil,
                Telugu, Marathi, Arabic, Indonesian, Swahili and Filipino.</p></div>
              </div>
            </div>
          </div>
        </div>"""),
    ]

    # --- small promo tile -------------------------------------------------
    # 440x280 is tiny: the wordmark, one line, and nothing else survives at
    # that size. Captured at scale 1 because the store requires those exact
    # pixel dimensions — a 2x render is rejected as the wrong size.
    tile = f"""<!doctype html><meta charset=utf-8><style>
      * {{ box-sizing:border-box; }}
      body {{ margin:0; width:440px; height:280px; background:{BG}; color:{TEXT};
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
              overflow:hidden; }}
      .t {{ width:440px; height:280px; padding:34px 36px; display:flex;
            flex-direction:column; justify-content:center; gap:14px; }}
      .row {{ display:flex; align-items:center; gap:11px; }}
      .row img {{ width:34px; height:34px; border-radius:9px; }}
      .name {{ font-size:23px; font-weight:700; letter-spacing:-.4px; }}
      h2 {{ margin:0; font-size:27px; line-height:1.18; font-weight:700; letter-spacing:-.7px; }}
      h2 em {{ font-style:normal; color:{ACCENT}; }}
      p {{ margin:0; font-size:14px; color:{MUTED}; line-height:1.4; }}
    </style>
    <div class="t">
      <div class="row"><img src="{data_uri(os.path.join(ROOT, 'icons', 'icon128.png'))}" alt=""><span class="name">Data Saver</span></div>
      <h2>Block ads, images<br>and video. <em>Use less data.</em></h2>
      <p>Built for slow, capped or metered connections.</p>
    </div>"""
    # --- marquee promo tile -----------------------------------------------
    # 1400x560, used in featured placements. Wide enough to carry the product
    # alongside the line, unlike the 440 tile.
    marquee = f"""<!doctype html><meta charset=utf-8><style>
      * {{ box-sizing:border-box; }}
      body {{ margin:0; width:1400px; height:560px; background:{BG}; color:{TEXT};
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
              overflow:hidden; }}
      .m {{ width:1400px; height:560px; padding:56px 68px; display:flex;
            align-items:center; gap:70px; }}
      .copy {{ flex:1; }}
      .row {{ display:flex; align-items:center; gap:14px; margin-bottom:22px; }}
      .row img {{ width:44px; height:44px; border-radius:12px; }}
      .name {{ font-size:27px; font-weight:700; letter-spacing:-.5px; }}
      h2 {{ margin:0; font-size:54px; line-height:1.1; font-weight:700; letter-spacing:-1.4px;
            max-width:16ch; }}
      h2 em {{ font-style:normal; color:{ACCENT}; }}
      p {{ margin:20px 0 0; font-size:20px; color:{MUTED}; line-height:1.45; max-width:44ch; }}
      .shotwrap {{ flex:none; width:300px; height:448px; border-radius:18px;
                   overflow:hidden; border:1px solid {BORDER};
                   box-shadow:0 30px 70px rgba(0,0,0,.6); }}
      .shotwrap img {{ display:block; width:300px; }}
    </style>
    <div class="m">
      <div class="copy">
        <div class="row"><img src="{data_uri(os.path.join(ROOT, 'icons', 'icon128.png'))}" alt="">
          <span class="name">Data Saver</span></div>
        <h2>Block ads, images and video. <em>Use less data.</em></h2>
        <p>Stops them before they download, not after. Built for slow, capped
        or metered connections &mdash; and it collects nothing.</p>
      </div>
      <div class="shotwrap"><img src="{u_popup}" alt=""></div>
    </div>"""
    marquee_path = os.path.join(tmp, "marquee.html")
    open(marquee_path, "w").write(marquee)
    shoot("file://" + marquee_path,
          os.path.join(OUT, "promo-1400x560.png"), 1400, 560, False, scale=1)
    print("  wrote store-listing/screenshots/promo-1400x560.png")

    tile_path = os.path.join(tmp, "tile.html")
    open(tile_path, "w").write(tile)
    shoot("file://" + tile_path, os.path.join(OUT, "promo-440x280.png"), 440, 280, False, scale=1)
    print("  wrote store-listing/screenshots/promo-440x280.png")

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
