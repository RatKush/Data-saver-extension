#!/usr/bin/env python3
"""
Render the Chrome Web Store promo video (1920x1080, 30 fps, ~40 s, no audio).

Like make-screenshots.py, nothing on screen is a mockup of the product. Stage
one drives the real extension in headless Edge against the same invented demo
publication: the page with blocking off and on, a real hover that brings up
"Load image", a real click that loads that one picture, and the real popup
rendered active and paused. Stage two lays those captures out on a timeline in
an HTML page with captions and a cursor, steps it frame by frame through CDP,
and hands the frames to ffmpeg. Stepping a clock rather than screen-recording
keeps every run frame-exact.

Captions only, no voice: the store plays the video muted, and on-screen text
can be translated later without re-recording anything.

    python3 scripts/make-video.py            full render
    python3 scripts/make-video.py --stills   capture stage + a few sample frames only

Writes store-listing/video/data-saver-promo.mp4 (and poster.jpg).
"""

import base64
import importlib.util
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "store-listing", "video")
PORT_CDP = 9347   # clear of e2e-edge (9333) and make-screenshots (9344)
FPS = 30
W, H = 1920, 1080


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


shots = _load("ds_make_screenshots", "make-screenshots.py")
WS, EDGE, PORT_WEB = shots.WS, shots.EDGE, shots.PORT


# ---------------------------------------------------------------------------
# A headless Edge session that can be poked, not just photographed.
# ---------------------------------------------------------------------------
class Session:
    def __init__(self, extension=False):
        self.profile = tempfile.mkdtemp(prefix="ds-video-")
        args = [EDGE, f"--user-data-dir={self.profile}", f"--remote-debugging-port={PORT_CDP}",
                "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--hide-scrollbars"]
        if extension:
            args += [f"--load-extension={ROOT}", f"--disable-extensions-except={ROOT}"]
        self.proc = subprocess.Popen(args + ["about:blank"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 25
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT_CDP}/json/list", timeout=2) as r:
                    targets = json.load(r)
                page = next(t for t in targets if t.get("type") == "page")
                break
            except Exception:
                if time.time() > deadline:
                    self.close()
                    raise RuntimeError("Edge never opened its debugging port")
                time.sleep(0.25)
        self.ws = WS(page["webSocketDebuggerUrl"])
        self.ws.call("Page.enable")

    def viewport(self, w, h, scale=1, dark=False):
        self.ws.call("Emulation.setDeviceMetricsOverride",
                     {"width": w, "height": h, "deviceScaleFactor": scale, "mobile": False})
        if dark:
            self.ws.call("Emulation.setEmulatedMedia",
                         {"features": [{"name": "prefers-color-scheme", "value": "dark"}]})

    def goto(self, url, settle=3.0):
        self.ws.call("Page.navigate", {"url": url})
        time.sleep(settle)

    def eval(self, expr, wait=False):
        r = self.ws.call("Runtime.evaluate",
                         {"expression": expr, "returnByValue": True, "awaitPromise": wait})
        if "exceptionDetails" in r:
            raise RuntimeError(f"page error: {r['exceptionDetails']}")
        return r.get("result", {}).get("value")

    def rect(self, selector):
        return self.eval(f"""(() => {{ const r = document.querySelector({json.dumps(selector)})
            .getBoundingClientRect(); return {{x: r.left, y: r.top, w: r.width, h: r.height}}; }})()""")

    def mouse(self, kind, x, y):
        params = {"type": kind, "x": x, "y": y, "pointerType": "mouse"}
        if kind in ("mousePressed", "mouseReleased"):
            params.update(button="left", clickCount=1)
        self.ws.call("Input.dispatchMouseEvent", params)

    def shot(self, path, fmt="png", quality=None):
        params = {"format": fmt}
        if quality:
            params["quality"] = quality
        data = self.ws.call("Page.captureScreenshot", params)["data"]
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(data))
        return path

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


# ---------------------------------------------------------------------------
# Stage one: capture the real product
# ---------------------------------------------------------------------------
PAGE_W, PAGE_H = 1200, 700      # the demo page's viewport, in CSS px
TARGET = "article:nth-of-type(2) img"   # top-middle photo: the one we load


def capture(tmp):
    url = f"http://127.0.0.1:{PORT_WEB}/"
    data = {}

    print("  page with blocking off …")
    s = Session(extension=False)
    try:
        s.viewport(PAGE_W, PAGE_H, 2)
        s.goto(url, 2.5)
        s.shot(os.path.join(tmp, "normal.png"))
    finally:
        s.close()

    print("  page with blocking on, then hover and load one image …")
    s = Session(extension=True)
    try:
        time.sleep(2.5)   # let the first reconcile register rules and scripts
        # Installing opens the welcome tab in front of ours, and a background
        # tab gets no animation frames — which is what the placeholders and
        # the Load image button are drawn on.
        s.ws.call("Page.bringToFront")
        s.viewport(PAGE_W, PAGE_H, 2)
        s.goto(url, 4.0)
        blanked = s.eval("[...document.images].filter((i) => i.naturalWidth <= 1).length")
        if not blanked:
            raise RuntimeError("no image was blocked — is the extension loading?")
        s.shot(os.path.join(tmp, "blocked.png"))

        img = s.rect(TARGET)
        data["img"] = img
        cx, cy = img["x"] + img["w"] / 2, img["y"] + img["h"] / 2
        for f in (0.2, 0.6, 1.0):   # a few moves, so pointermove fires like a real hand
            s.mouse("mouseMoved", cx - 120 * (1 - f), cy + 60 * (1 - f))
            time.sleep(0.15)
        time.sleep(0.6)
        btn = s.rect("data-saver-load")
        if not btn["w"]:
            raise RuntimeError("the Load image button never appeared on hover")
        data["btn"] = btn
        s.shot(os.path.join(tmp, "hover.png"))

        bx, by = btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2
        s.mouse("mouseMoved", bx, by)
        time.sleep(0.2)
        s.mouse("mousePressed", bx, by)
        s.mouse("mouseReleased", bx, by)
        time.sleep(2.0)
        loaded = s.eval(f"document.querySelector({json.dumps(TARGET)}).naturalWidth")
        if not loaded or loaded <= 1:
            raise RuntimeError("pressing Load image did not load the picture")
        s.mouse("mouseMoved", 5, PAGE_H - 5)   # park the pointer off the photos
        time.sleep(0.5)
        s.shot(os.path.join(tmp, "loaded.png"))
    finally:
        s.close()

    print("  popup, active and paused …")
    shutil.copy(os.path.join(ROOT, "popup.js"), os.path.join(tmp, "popup.js"))
    os.makedirs(os.path.join(tmp, "icons"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "icons", "icon48.png"), os.path.join(tmp, "icons", "icon48.png"))
    src = open(os.path.join(ROOT, "popup.html"), encoding="utf-8").read()
    for name, paused in (("popup", False), ("popup-paused", True)):
        page = os.path.join(tmp, f"{name}.html")
        open(page, "w", encoding="utf-8").write(src.replace(
            '<script src="popup.js"></script>',
            shots.popup_stub(paused) + '<script src="popup.js"></script>'))
        s = Session(extension=False)
        try:
            s.viewport(360, 650, 2, dark=True)
            s.goto("file://" + page, 1.5)
            if not paused:
                data["siteBtn"] = s.rect("#siteToggleBtn")
            # The panel is shorter than the 650 px it is laid out in; crop to
            # the content so no empty strip hangs below it.
            bottom = s.eval("Math.ceil(Math.max(...[...document.body.querySelectorAll('*')]"
                            ".map((e) => e.getBoundingClientRect().bottom)))")
            s.viewport(360, min(650, bottom + 12), 2, dark=True)
            time.sleep(0.3)
            s.shot(os.path.join(tmp, f"{name}.png"))
        finally:
            s.close()

    return data


# ---------------------------------------------------------------------------
# Stage two: the timeline
# ---------------------------------------------------------------------------
# Layout, in composite px.
CW = 1240                        # page width on screen
K = CW / PAGE_W                  # capture px -> composite px
CH = round(PAGE_H * K)
TH = 50                          # browser toolbar
BX, BY = (W - CW) // 2, 212
POP_W = 380
PK = POP_W / 360
ICON_X, ICON_Y = BX + CW - 44, BY + TH // 2          # extension icon centre
POP_X, POP_Y = ICON_X + 26 - POP_W, BY + TH + 6
ZOOM = 1.9
END = 40.0

# Brand tokens, from the store art.
BG, SURFACE, BORDER, TEXT, MUTED, ACCENT = (shots.BG, shots.SURFACE, shots.BORDER,
                                           shots.TEXT, shots.MUTED, shots.ACCENT)


def plan(data):
    """Cursor keyframes and clicks, worked out from where things really were."""
    img, btn, site = data["img"], data["btn"], data["siteBtn"]
    ox, oy = (img["x"] + img["w"] / 2) * K, (img["y"] + img["h"] / 2) * K  # zoom origin

    def page_pt(x, y, z=1.0):
        qx, qy = x * K, y * K
        return BX + ox + (qx - ox) * z, BY + TH + oy + (qy - oy) * z

    icon = (ICON_X + 4, ICON_Y + 6)
    img_c = page_pt(img["x"] + img["w"] / 2, img["y"] + img["h"] / 2, ZOOM)
    btn_c = page_pt(btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2, ZOOM)
    site_c = (POP_X + (site["x"] + site["w"] / 2) * PK, POP_Y + (site["y"] + site["h"] / 2) * PK)

    # (time, x, y, opacity)
    track = [
        (11.6, BX + 760, BY + 420, 0), (11.9, BX + 760, BY + 420, 1),
        (12.6, *icon, 1), (13.2, *icon, 1), (13.5, *icon, 0),

        (19.5, img_c[0] + 260, img_c[1] + 210, 0), (19.8, img_c[0] + 260, img_c[1] + 210, 1),
        (20.8, img_c[0] + 30, img_c[1] + 20, 1),
        (21.9, *btn_c, 1), (22.9, *btn_c, 1),
        (23.7, img_c[0] + 300, img_c[1] + 240, 1), (24.2, img_c[0] + 300, img_c[1] + 240, 0),

        (25.3, BX + 700, BY + 470, 0), (25.6, BX + 700, BY + 470, 1),
        (26.3, *icon, 1), (26.6, *icon, 1),
        (27.6, *site_c, 1), (28.4, *site_c, 1),
        (29.2, site_c[0] - 60, site_c[1] + 120, 1), (29.6, site_c[0] - 60, site_c[1] + 120, 0),
    ]
    clicks = [(12.75, *icon), (22.3, *btn_c), (26.45, *icon), (27.9, *site_c)]
    return {"track": track, "clicks": clicks, "origin": [ox, oy]}


def timeline_html(caps, data):
    uri = shots.data_uri
    icon48 = uri(os.path.join(ROOT, "icons", "icon48.png"))
    icon128 = uri(os.path.join(ROOT, "icons", "icon128.png"))
    cfg = plan(data)
    cfg.update(ZOOM=ZOOM, END=END)

    html = r"""<!doctype html><meta charset="utf-8"><style>
* { box-sizing: border-box; }
body { margin:0; width:__W__px; height:__H__px; overflow:hidden; background:__BG__; color:__TEXT__;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
.abs { position:absolute; }
.cap { position:absolute; left:0; right:0; top:46px; text-align:center; opacity:0; }
.cap h1 { margin:0; font-size:56px; line-height:1.12; font-weight:700; letter-spacing:-1.4px; }
.cap h1 em { font-style:normal; color:__ACCENT__; }
.cap p { margin:16px 0 0; font-size:25px; color:__MUTED__; }
.hero { top:390px; }
.hero h1 { font-size:76px; letter-spacing:-2px; }
.hero p { font-size:30px; margin-top:22px; }
#browser { left:__BX__px; top:__BY__px; width:__CW__px; height:calc(__CH__px + __TH__px); border-radius:14px;
           overflow:hidden; border:1px solid __BORDER__; background:__SURFACE__; opacity:0;
           box-shadow:0 40px 90px rgba(0,0,0,.55); }
.bar { height:__TH__px; display:flex; align-items:center; gap:14px; padding:0 16px; background:#2A2E32; }
.dots { display:flex; gap:8px; } .dots i { width:12px; height:12px; border-radius:50%; background:#4A4F55; display:block; }
.url { flex:1; height:32px; border-radius:16px; background:#1E2124; color:#B8C0C6; font-size:15px;
       display:flex; align-items:center; padding:0 16px; }
.ext { position:relative; width:30px; height:30px; display:grid; place-items:center; border-radius:8px; }
.ext img { width:22px; height:22px; }
.badge { position:absolute; right:-9px; bottom:-5px; font-size:10px; font-weight:800; letter-spacing:.02em;
         padding:2px 4px; border-radius:4px; background:#C4453C; color:#fff; opacity:0; }
#view { position:relative; width:__CW__px; height:__CH__px; overflow:hidden; background:#fbfbfa; }
#zoom { position:absolute; inset:0; }
#zoom img { position:absolute; left:0; top:0; width:__CW__px; height:__CH__px; }
#edge { position:absolute; top:0; bottom:0; width:4px; margin-left:-2px; background:__ACCENT__;
        box-shadow:0 0 24px __ACCENT__; opacity:0; }
.tag { position:absolute; left:18px; bottom:18px; font-size:15px; font-weight:700; letter-spacing:.06em;
       text-transform:uppercase; padding:8px 14px; border-radius:999px; opacity:0;
       background:rgba(27,28,30,.86); border:1px solid __BORDER__; color:#D5DBDF; }
.tag.on { background:rgba(15,48,43,.92); border-color:rgba(53,194,172,.6); color:__ACCENT__; }
.pop { left:__POPX__px; top:__POPY__px; width:__POPW__px; border-radius:14px; overflow:hidden;
       border:1px solid __BORDER__; box-shadow:0 30px 80px rgba(0,0,0,.65); opacity:0; }
.pop img { display:block; width:__POPW__px; }
#cursor { left:0; top:0; width:34px; height:34px; opacity:0; z-index:20; }
.ring { position:absolute; width:56px; height:56px; margin:-28px 0 0 -28px; border-radius:50%;
        border:3px solid __ACCENT__; opacity:0; z-index:19; }
#trust { left:0; right:0; top:330px; display:flex; flex-direction:column; align-items:center; gap:34px; }
.row { display:flex; align-items:center; gap:22px; width:760px; opacity:0; }
.row .k { width:58px; height:58px; border-radius:16px; flex:none; display:grid; place-items:center;
          background:rgba(53,194,172,.15); color:__ACCENT__; font-size:30px; font-weight:800; }
.row b { font-size:36px; letter-spacing:-.6px; }
#endcard { left:0; right:0; top:250px; display:flex; flex-direction:column; align-items:center; opacity:0; }
#endcard img { width:150px; height:150px; border-radius:34px; box-shadow:0 30px 70px rgba(0,0,0,.5); }
#endcard .name { font-size:68px; font-weight:800; letter-spacing:-1.8px; margin-top:34px; }
#endcard .line { font-size:34px; margin-top:12px; color:__TEXT__; }
#endcard .line em { font-style:normal; color:__ACCENT__; }
#endcard .store { margin-top:40px; font-size:24px; color:__MUTED__; padding:14px 26px; border-radius:999px;
                  border:1px solid __BORDER__; background:__SURFACE__; }
</style>

<div class="cap hero" id="c1"><h1>Every page you open <em>costs data.</em></h1>
  <p>Most of it isn't the words you came for.</p></div>
<div class="cap" id="c2"><h1>Ads, images and autoplay video are <em>the heavy part.</em></h1></div>
<div class="cap" id="c3"><h1>Data Saver stops them <em>before they download.</em></h1>
  <p>Not hidden after loading. Never fetched at all.</p></div>
<div class="cap" id="c4"><h1>Three switches, and <em>a count of everything blocked.</em></h1>
  <p>The data figure is an estimate, worked out on your device.</p></div>
<div class="cap" id="c5"><h1>Need one picture? <em>Load just that one.</em></h1>
  <p>Hover a blocked image and press Load image.</p></div>
<div class="cap" id="c6"><h1>Or let a whole site load normally, <em>in one tap.</em></h1>
  <p>Shortcut: Alt + Shift + D. The icon shows OFF on that site.</p></div>
<div class="cap" id="c7"><h1>Saves data. <em>Doesn't take any.</em></h1></div>

<div class="abs" id="browser">
  <div class="bar"><div class="dots"><i></i><i></i><i></i></div>
    <div class="url">theharbourreview.example/world</div>
    <div class="ext"><img src="__ICON48__"><span class="badge" id="badge">OFF</span></div></div>
  <div id="view"><div id="zoom">
      <img id="pNormal" src="__NORMAL__">
      <img id="pBlocked" src="__BLOCKED__">
      <img id="pHover" src="__HOVER__" style="opacity:0">
      <img id="pLoaded" src="__LOADED__" style="opacity:0">
      <img id="pNormal2" src="__NORMAL__" style="opacity:0">
    </div>
    <div id="edge"></div>
    <span class="tag" id="tOff">Blocking off</span>
    <span class="tag on" id="tOn">Blocking on</span>
  </div>
</div>
<div class="abs pop" id="pop1"><img src="__POPUP__"></div>
<div class="abs pop" id="pop2"><img src="__POPUP__"></div>
<div class="abs pop" id="pop3" style="z-index:2"><img src="__POPUP_PAUSED__"></div>

<div class="abs" id="trust">
  <div class="row"><div class="k">&#10003;</div><b>No account, no sign-up</b></div>
  <div class="row"><div class="k">&#10003;</div><b>No analytics, no server</b></div>
  <div class="row"><div class="k">&#10003;</div><b>Nothing leaves your device</b></div>
</div>

<div class="abs" id="endcard"><img src="__ICON128__">
  <div class="name">Data Saver</div>
  <div class="line">Block ads, images and video. <em>Use less data.</em></div>
  <div class="store">Free on the Chrome Web Store &nbsp;&middot;&nbsp; 25 languages</div>
</div>

<div class="ring" id="ring"></div>
<svg class="abs" id="cursor" viewBox="0 0 34 34"><path d="M6 3 L6 27 L12.5 21 L17 31 L21.5 29 L17 19.5 L26 19.5 Z"
  fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/></svg>

<script>
const C = __CFG__;
const $ = (id) => document.getElementById(id);
const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const seg = (t, a, b) => ease(clamp((t - a) / (b - a)));
// Visible between a and b, fading in just after a and out just before b, so
// two captions sharing a slot never overlap.
const win = (t, a, b, f = .45) => Math.min(seg(t, a + .05, a + .05 + f), 1 - seg(t, b - .35, b));
const lerp = (a, b, f) => a + (b - a) * f;

function cap(id, t, a, b, rise = 18) {
  const o = win(t, a, b);
  const el = $(id);
  el.style.opacity = o;
  el.style.transform = `translateY(${(1 - Math.min(1, seg(t, a, a + .6))) * rise}px)`;
}

function cursorAt(t) {
  const k = C.track;
  if (t <= k[0][0]) return k[0];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const [t0, x0, y0, o0] = k[i - 1], [t1, x1, y1, o1] = k[i];
      const f = ease(clamp((t - t0) / (t1 - t0)));
      return [t, lerp(x0, x1, f), lerp(y0, y1, f), lerp(o0, o1, f)];
    }
  }
  return k[k.length - 1];
}

function render(t) {
  cap('c1', t, 0.2, 4.6, 26);
  cap('c2', t, 4.6, 8.5);
  cap('c3', t, 8.5, 12.4);
  cap('c4', t, 12.4, 18.6);
  cap('c5', t, 18.6, 25.4);
  cap('c6', t, 25.4, 32.0);
  cap('c7', t, 32.0, 35.8);

  // The browser: in at 4.6, out at 31.8.
  const b = win(t, 4.6, 31.9, .6);
  $('browser').style.opacity = b;
  $('browser').style.transform = `scale(${lerp(.965, 1, seg(t, 4.6, 5.4))})`;

  // Before/after wipe.
  const p = seg(t, 8.0, 9.3);
  $('pBlocked').style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
  $('edge').style.left = `${p * __CW__}px`;
  $('edge').style.opacity = p > 0 && p < 1 ? 1 : 0;
  $('tOff').style.opacity = win(t, 5.0, 8.3);
  $('tOn').style.opacity = win(t, 9.1, 12.4);

  // One image: zoom in, hover, load, zoom out.
  const z = 1 + (C.ZOOM - 1) * (seg(t, 18.7, 19.8) - seg(t, 24.6, 25.4));
  const zoom = $('zoom');
  zoom.style.transformOrigin = `${C.origin[0]}px ${C.origin[1]}px`;
  zoom.style.transform = `scale(${z})`;
  $('pHover').style.opacity = t >= 21.0 && t < 22.45 ? 1 : 0;
  $('pLoaded').style.opacity = t >= 22.45 ? 1 : 0;

  // Popups: opened by the cursor clicking the toolbar icon.
  const pop = (id, a, b2) => {
    const o = Math.min(seg(t, a, a + .3), 1 - seg(t, b2 - .3, b2));
    $(id).style.opacity = o;
    $(id).style.transform = `translateY(${(1 - o) * -10}px) scale(${lerp(.98, 1, o)})`;
  };
  pop('pop1', 12.8, 18.4);
  pop('pop2', 26.5, 31.6);
  $('pop3').style.opacity = t >= 27.95 ? $('pop2').style.opacity : 0;
  $('pop3').style.transform = $('pop2').style.transform;

  // Pausing the site: OFF badge, then the page reloads unblocked.
  const badge = seg(t, 28.0, 28.25);
  $('badge').style.opacity = badge;
  $('badge').style.transform = `scale(${lerp(.4, 1, badge)})`;
  $('pNormal2').style.opacity = seg(t, 28.5, 28.9);

  // Trust rows and the end card.
  [33.0, 33.5, 34.0].forEach((a, i) => {
    const row = document.querySelectorAll('.row')[i];
    const o = win(t, a, 35.8);
    row.style.opacity = o;
    row.style.transform = `translateX(${(1 - Math.min(1, seg(t, a, a + .5))) * -26}px)`;
  });
  const e = seg(t, 35.9, 36.6);
  $('endcard').style.opacity = e;
  $('endcard').style.transform = `translateY(${(1 - e) * 22}px)`;

  // Cursor and click rings.
  const [, cx, cy, co] = cursorAt(t);
  let press = 1;
  let ring = 0, rs = 1, rx = 0, ry = 0;
  for (const [ct, x, y] of C.clicks) {
    const d = t - ct;
    if (d > -.08 && d < .12) press = .86;
    if (d >= 0 && d < .55) { ring = 1 - d / .55; rs = .5 + d / .55; rx = x; ry = y; }
  }
  const cur = $('cursor');
  cur.style.opacity = co;
  cur.style.transform = `translate(${cx - 6}px, ${cy - 3}px) scale(${press})`;
  const r = $('ring');
  r.style.opacity = ring * co;
  r.style.left = `${rx}px`; r.style.top = `${ry}px`;
  r.style.transform = `scale(${rs})`;
}
render(0);
</script>"""
    rep = {
        "__W__": W, "__H__": H, "__BG__": BG, "__TEXT__": TEXT, "__ACCENT__": ACCENT,
        "__MUTED__": MUTED, "__BORDER__": BORDER, "__SURFACE__": SURFACE,
        "__BX__": BX, "__BY__": BY, "__CW__": CW, "__CH__": CH, "__TH__": TH,
        "__POPX__": POP_X, "__POPY__": POP_Y, "__POPW__": POP_W,
        "__ICON48__": icon48, "__ICON128__": icon128,
        "__NORMAL__": uri(caps["normal"]), "__BLOCKED__": uri(caps["blocked"]),
        "__HOVER__": uri(caps["hover"]), "__LOADED__": uri(caps["loaded"]),
        "__POPUP__": uri(caps["popup"]), "__POPUP_PAUSED__": uri(caps["popup-paused"]),
        "__CFG__": json.dumps(cfg),
    }
    for k, v in rep.items():
        html = html.replace(k, str(v))
    return html


def render(tmp, html, times, frames_dir):
    page = os.path.join(tmp, "timeline.html")
    open(page, "w", encoding="utf-8").write(html)
    s = Session(extension=False)
    try:
        s.viewport(W, H, 1)
        s.goto("file://" + page, 2.0)
        for i, t in enumerate(times):
            # Two animation frames after the update, so the capture is of the
            # frame that was just laid out, never the one before it.
            s.eval(f"render({t:.4f}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
                   wait=True)
            s.shot(os.path.join(frames_dir, f"f{i:05d}.jpg"), "jpeg", 94)
            if i % 150 == 0:
                print(f"    frame {i}/{len(times)}  t={t:.1f}s")
    finally:
        s.close()


def main():
    stills = "--stills" in sys.argv
    if not os.path.exists(EDGE):
        print("Microsoft Edge not found")
        return 2
    if not stills and not shutil.which("ffmpeg"):
        print("ffmpeg not found (brew install ffmpeg)")
        return 2

    os.makedirs(OUT, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT_WEB), shots.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="ds-video-build-")
    try:
        print("Capturing the real extension …")
        data = capture(tmp)
        caps = {n: os.path.join(tmp, f"{n}.png")
                for n in ("normal", "blocked", "hover", "loaded", "popup", "popup-paused")}
        html = timeline_html(caps, data)

        frames = os.path.join(tmp, "frames")
        os.makedirs(frames)
        if stills:
            times = [2.5, 6.5, 8.6, 10.5, 15.5, 21.4, 22.1, 24.0, 27.7, 30.0, 34.6, 38.5]
            print("Rendering sample frames …")
            render(tmp, html, times, frames)
            dest = os.path.join(OUT, "stills")
            shutil.rmtree(dest, ignore_errors=True)
            os.makedirs(dest)
            for i, t in enumerate(times):
                shutil.copy(os.path.join(frames, f"f{i:05d}.jpg"), os.path.join(dest, f"t{t:04.1f}.jpg"))
            print(f"\nDone — {os.path.relpath(dest, ROOT)}")
            return 0

        times = [i / FPS for i in range(int(END * FPS))]
        print(f"Rendering {len(times)} frames …")
        render(tmp, html, times, frames)

        mp4 = os.path.join(OUT, "data-saver-promo.mp4")
        print("Encoding …")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
                        "-i", os.path.join(frames, "f%05d.jpg"),
                        "-c:v", "libx264", "-preset", "slow", "-crf", "18",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], check=True)
        # A poster for YouTube's custom thumbnail: the moment after the wipe.
        shutil.copy(os.path.join(frames, f"f{int(10.5 * FPS):05d}.jpg"), os.path.join(OUT, "poster.jpg"))
        print(f"\nDone — {os.path.relpath(mp4, ROOT)} ({os.path.getsize(mp4) / 1e6:.1f} MB)")
        return 0
    finally:
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
