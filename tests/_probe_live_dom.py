"""Живой замер DOM ноды PromptLibrary — в реальном браузере, без догалок.

Зачем: sizing-баги в Nodes 2.0 (Vue) не видны ни в смоуке (там заглушки DOM), ни
в статическом аудите. Причина живёт в цепочке CSS фронтенда, поэтому её надо
ИЗМЕРИТЬ: поднять headless Chrome, открыть работающий ComfyUI, создать ноду и
прочитать ширины всей цепочки (`.lg-node` → inner-wrapper → node-widgets → наш root).

Запуск (ComfyUI должен быть запущен):
    cd Prompt_Library
    python tests/_probe_live_dom.py                 # базовая цепочка
    python tests/_probe_live_dom.py --panel         # + открыть панель свойств
    python tests/_probe_live_dom.py --url http://127.0.0.1:8188/

Зависимости — только те, что уже есть в ComfyUI (websockets, aiohttp).
Профиль Chrome — временный, удаляется в конце; ничего вне проекта не меняется.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

# Замер цепочки: имя → селектор/JS. Возвращаем ширину, высоту и ключевые стили.
MEASURE_JS = r"""
(() => {
  const out = {};
  const px = (v) => Math.round(v * 100) / 100;
  const probe = window.__plProbeNode;
  const node = probe ? document.querySelector(`[data-node-id="${probe.id}"]`) : null;
  const chain = [
    ['lg-node', node],
    ['inner-wrapper', node && node.querySelector('[data-testid="node-inner-wrapper"]')],
    ['node-body', node && node.querySelector('[data-testid^="node-body-"]')],
    ['node-widgets', node && node.querySelector('[data-testid="node-widgets"]')],
    ['widget-row', node && node.querySelector('[data-testid="node-widget"]')],
    ['our-root', node && node.querySelector('.pl-root')],
    ['scroll-area', node && node.querySelector('.pl-scroll')],
    ['main', node && node.querySelector('.pl-main')],
  ];
  for (const [name, el] of chain) {
    if (!el) { out[name] = null; continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[name] = {
      w: px(r.width), h: px(r.height),
      cssW: cs.width, minW: cs.minWidth, maxW: cs.maxWidth,
      display: cs.display, flex: cs.flex,
      cls: String(el.className || '').slice(0, 120),
    };
  }
  out.nodeWidthVar = node ? getComputedStyle(node).getPropertyValue('--node-width').trim() : null;
  out.minNodeWidthVar = node ? getComputedStyle(node).getPropertyValue('--min-node-width').trim() : null;
  out.rootCount = document.querySelectorAll('.pl-root').length;
  const n = window.__plProbeNode;
  out.nodeSize = n ? n.size : null;
  out.widgets = n ? (n.widgets || []).map((w) => ({
    name: w.name, type: w.type, hidden: !!w.hidden,
    hasElement: !!w.element, value: typeof w.value === 'string' ? w.value.slice(0, 24) : w.value,
  })) : null;
  const wg = node && node.querySelector('[data-testid="node-widgets"]');
  out.widgetsHTML = wg ? wg.innerHTML.replace(/\s+/g, ' ').slice(0, 300) : null;
  out.nodeElCount = document.querySelectorAll('[data-node-id]').length;
  out.nodeElIds = Array.from(document.querySelectorAll('[data-node-id]')).map((e) => e.dataset.nodeId);
  const plr = document.querySelector('.pl-root');
  const up = [];
  for (let e = plr; e && e !== document.body; e = e.parentElement) {
    up.push((e.tagName || '') + '.' + String(e.className || '').split(' ').slice(0, 3).join('.')
      + (e.dataset && e.dataset.nodeId ? '#node=' + e.dataset.nodeId : '')
      + (e.dataset && e.dataset.testid ? '#testid=' + e.dataset.testid : ''));
  }
  out.plRootChain = up;
  out.scale = (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) || null;
  const cvs = document.querySelector('.graph-canvas-container');
  if (cvs) {
    const cr = cvs.getBoundingClientRect();
    out.canvasContainer = { w: px(cr.width), h: px(cr.height) };
  }
  const side = document.querySelector('aside, [data-testid="right-side-panel"], #right-side-panel');
  if (side) {
    const sr = side.getBoundingClientRect();
    out.rightPanel = { w: px(sr.width), testid: side.dataset ? side.dataset.testid : null };
  }
  if (plr) {
    const rr = plr.getBoundingClientRect();
    out.plRootRect = { w: px(rr.width), h: px(rr.height), x: px(rr.x), y: px(rr.y) };
  } else out.plRootRect = null;
  return out;
})()
"""


def _force_utf8() -> None:
    """Windows-консоль по умолчанию cp1251 — ломается на кириллице/стрелках."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def find_chrome() -> str:
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for p in CHROME_CANDIDATES:
        if Path(p).exists():
            return p
    raise SystemExit("Chrome не найден (задай CHROME_PATH)")


LOAD_WORKFLOW_JS = r"""
(async (name) => {
  const r = await fetch('/api/userdata/workflows%2F' + encodeURIComponent(name) + '.json');
  if (!r.ok) return 'fetch ' + r.status;
  const data = await r.json();
  await window.app.loadGraphData(data);
  return 'loaded';
})(NAME)
"""

FOCUS_NODE_JS = r"""
(() => {
  const g = window.app && window.app.graph;
  if (!g) return 'no graph';
  const n = (g._nodes || []).find((x) => String(x.type || '').toLowerCase() === 'promptlibrary');
  if (!n) return 'no PromptLibrary node';
  window.__plProbeNode = n;
  window.app.canvas.centerOnNode(n);
  window.app.canvas.setZoom(ZOOM);
  window.app.canvas.setDirty(true, true);
  return 'node ' + n.id + ' size ' + JSON.stringify(n.size);
})()
"""


MEASURE_WIDGET_JS = r"""
(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const n = window.__plProbeNode;
  const out = { mode: window.LiteGraph && window.LiteGraph.vueNodesMode ? 'vue' : 'canvas' };
  if (!n) return { ...out, error: 'no node' };
  const w = (n.widgets || []).find((x) => x.name === 'pl_browser');
  const el = w && w.element;
  out.nodeSize = { w: px(n.size[0]), h: px(n.size[1]) };
  out.widgetComputedHeight = w ? w.computedHeight : null;
  out.widgetLastY = w ? w.last_y : null;
  out.hasElement = !!el;
  if (el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.elementRect = { w: px(r.width), h: px(r.height), x: px(r.x), y: px(r.y) };
    out.elementStyle = { width: cs.width, height: cs.height, minWidth: cs.minWidth };
    out.elementInline = (el.getAttribute('style') || '').slice(0, 300);
    const up = [];
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      up.push((e.tagName || '') + '.' + String(e.className || '').split(' ').slice(0, 2).join('.')
        + (e.dataset && e.dataset.testid ? '#testid=' + e.dataset.testid : ''));
    }
    out.elementParents = up;
    const root = el.querySelector('.pl-root');
    if (root) {
      const rr = root.getBoundingClientRect();
      out.rootRect = { w: px(rr.width), h: px(rr.height) };
    }
  }
  const cvs = document.querySelector('.graph-canvas-container');
  if (cvs) {
    const cr = cvs.getBoundingClientRect();
    out.canvasContainer = { w: px(cr.width), h: px(cr.height) };
  }
  return out;
})()
"""


def wait_devtools(port: int, timeout: float = 30.0) -> dict:
    url = f"http://127.0.0.1:{port}/json/list"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                pages = json.load(r)
            for p in pages:
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    return p
        except Exception:
            pass
        time.sleep(0.3)
    raise SystemExit("CDP не отвечает: страница не найдена")


class CDP:
    """Минимальный клиент протокола: только то, что нужно для замера."""

    def __init__(self, ws):
        self.ws = ws
        self._id = 0

    async def call(self, method: str, params: dict | None = None):
        self._id += 1
        mid = self._id
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def eval(self, expr: str, await_promise: bool = False):
        res = await self.call("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        if "exceptionDetails" in res:
            raise RuntimeError(res["exceptionDetails"].get("exception", {}).get("description", "eval error"))
        return res.get("result", {}).get("value")


FILL_DETAIL_JS = r"""
(async (id) => {
  const n = window.__plProbeNode;
  if (!n || !n._pl || !n._pl.fillDetail) return 'no api';
  const r = await n._pl.fillDetail(id);
  return r ? 'detail opened: ' + id : 'entry not rendered: ' + id;
})(ID)
"""

RESIZE_HANDLE_JS = r"""
(() => {
  const n = window.__plProbeNode;
  if (!n) return null;
  const el = document.querySelector(`[data-node-id="${n.id}"]`);
  if (!el) return null;
  // Ручка ресайза в Vue: absolute h-5 w-5 (SE-угол ноды)
  const handles = Array.from(el.querySelectorAll('div,span'))
    .filter((h) => /h-5/.test(h.className) && /w-5/.test(h.className));
  const box = el.getBoundingClientRect();
  let best = null, bestD = 1e9;
  for (const h of handles) {
    const r = h.getBoundingClientRect();
    const d = Math.abs(r.x + r.width - (box.x + box.width)) + Math.abs(r.y + r.height - (box.y + box.height));
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best) return null;
  return { x: Math.round(best.x + best.width / 2), y: Math.round(best.y + best.height / 2) };
})()
"""


async def drag_mouse(cdp: CDP, x1: int, y1: int, dx: int, dy: int) -> None:
    """Настоящий drag мышью через CDP: pointer-события синтезирует сам браузер."""
    await cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x1, "y": y1})
    await cdp.call("Input.dispatchMouseEvent", {
        "type": "mousePressed", "x": x1, "y": y1, "button": "left", "clickCount": 1, "buttons": 1})
    steps = 8
    for i in range(1, steps + 1):
        await cdp.call("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": x1 + dx * i // steps, "y": y1 + dy * i // steps,
            "button": "left", "buttons": 1})
        await asyncio.sleep(0.05)
    await cdp.call("Input.dispatchMouseEvent", {
        "type": "mouseReleased", "x": x1 + dx, "y": y1 + dy, "button": "left",
        "clickCount": 1, "buttons": 0})


async def wait_for(cdp: CDP, expr: str, timeout: float = 120.0, label: str = ""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = await cdp.eval(expr)
            if last:
                return last
        except Exception as e:
            last = repr(e)
        await asyncio.sleep(0.5)
    raise SystemExit(f"не дождались: {label or expr} (последнее: {last!r})")


DIAG_JS = r"""
(() => {
  const em = window.app && window.app.extensionManager;
  let setting = null;
  try { setting = em && em.setting ? em.setting.get("Comfy.VueNodes.Enabled") : null; } catch (e) {}
  return {
    vueNodesMode: !!(window.LiteGraph && window.LiteGraph.vueNodesMode),
    settingVue: setting,
    hasSettingApi: !!(em && em.setting && typeof em.setting.set === "function"),
    nodeEls: document.querySelectorAll("[data-node-id]").length,
  };
})()
"""

SET_VUE_JS = r"""
(() => {
  const em = window.app && window.app.extensionManager;
  if (!em || !em.setting) return "no setting api";
  try {
    em.setting.set("Comfy.VueNodes.Enabled", FLAG);
    return "set to FLAG";
  } catch (e) { return "error: " + e.message; }
})()
"""

CREATE_NODE_JS = r"""
(() => {
  const g = window.app && window.app.graph;
  if (!g) return "no graph";
  const type = window.LiteGraph.createNode("PromptLibrary");
  if (!type) return "no node type";
  g.add(type);
  type.pos = [60, 60];
  type.setSize([1000, 1200]);
  window.app.canvas.setZoom(1);
  window.app.canvas.setDirty(true, true);
  setTimeout(() => { try { type.setSize([1000, 1200]); } catch (e) {} }, 400);
  window.app.canvas.setDirty(true, true);
  window.__plProbeNode = type;
  return String(type.id);
})()
"""

OPEN_PANEL_JS = r"""
(() => {
  const n = window.__plProbeNode;
  if (!n) return "no node";
  // Сначала выделяем ноду ТЕМ ЖЕ путём, что и мышь: клик по её элементу
  // (панель показывает параметры именно выбранного узла — без выделения
  // она рисует глобальные параметры, и сценарий пользователя не повторяется).
  const el = document.querySelector(`[data-node-id="${n.id}"]`);
  if (el) {
    const box = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
                   button: 0, buttons: 1, clientX: Math.round(box.x + box.width / 2),
                   clientY: Math.round(box.y + 12), pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  }
  // Точный путь без угадывания кнопок: стор панели через pinia (TopMenuSection
  // вызывает rightSidePanelStore.togglePanel()). Ищем приложение Vue перебором.
  // Имя стора менялось между сборками ('rightSidePanel' не найден в текущей),
  // поэтому ищем ЛЮБОЙ стор с методом togglePanel, а запасной путь — клик по
  // настоящей кнопке-переключателю панели в топбаре.
  const piniaOf = (app) => app && app.config && app.config.globalProperties
    && app.config.globalProperties.$pinia;
  let pinia = null;
  for (const el of document.querySelectorAll('*')) {
    const app = el.__vue_app__;
    if (piniaOf(app)) { pinia = piniaOf(app); break; }
  }
  if (pinia && pinia._s) {
    for (const [key, store] of pinia._s) {
      if (store && typeof store.togglePanel === 'function'
          && /panel/i.test(key || '')) {
        try { store.togglePanel(); return 'pinia:' + key; }
        catch (e) { /* не тот стор (нужен аргумент) — дальше */ }
      }
    }
  }
  // Кнопка-переключатель панели в топбаре: иконка lucide panel-right
  // (класс стабилен между языками, в отличие от aria-label).
  const icon = document.querySelector('i[class*="panel-right"]');
  const btn = (icon && icon.closest('button'))
    || Array.from(document.querySelectorAll('button')).find((b) => {
      const r = b.getBoundingClientRect();
      if (!(r.top < 90 && r.width > 0)) return false;
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      return /панель|panel/i.test(label);
    });
  if (btn) { btn.click(); return 'button:' + (btn.getAttribute('aria-label') || btn.textContent || '').slice(0, 40); }
  return 'no store, no button (pinia=' + !!pinia + ')';
})()
"""

LIST_BUTTONS_JS = r"""
(() => {
  const top = document.querySelector('[data-testid="legacy-topbar-container"]') || document.body;
  const sec = top.closest('div') || top;
  const out = [];
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect();
    if (r.top < 90 && r.width > 0) {
      out.push({ label: (b.getAttribute('aria-label') || b.textContent || '').slice(0, 50),
                 x: Math.round(r.x), y: Math.round(r.y) });
    }
  }
  return out;
})()
"""

PANEL_DIAG_JS = r"""(() => {
  const rootEl = document.getElementById('app') || document.querySelector('#app');
  const pinia = rootEl && rootEl.__vue_app__ && rootEl.__vue_app__.config.globalProperties.$pinia;
  const store = pinia && pinia._s && pinia._s.get('rightSidePanel');
  const panel = document.querySelector('[data-testid="properties-panel"]');
  return {
    storeFound: !!store,
    isOpen: store ? !!store.isOpen : null,
    activeTab: store ? store.activeTab : null,
    panelText: panel ? panel.textContent.replace(/\s+/g, ' ').slice(0, 160) : null,
    panelHasOurWidget: panel ? /pl_browser|Подхват/.test(panel.textContent) : null,
    selectedIds: (() => {
      try { return Object.keys(window.app.canvas.selected_nodes || {}); } catch (e) { return null; }
    })(),
    panelNodes: Array.from(document.querySelectorAll('[data-node-id]'))
      .filter((e) => !e.closest('[data-testid="properties-panel"]')).length,
  };
})()
"""


TRAP_JS = r"""
(() => {
  const ns = (window.app && window.app.graph && window.app.graph._nodes) || [];
  const n = ns.find((x) => String((x && x.type) || "").toLowerCase() === "promptlibrary");
  const w = n && (n.widgets || []).find((x) => x.name === "pl_browser");
  if (!w) return "no widget";
  delete w.width;
  const hits = (window.__widthTrap = []);
  try {
    Object.defineProperty(w, "width", {
      configurable: true,
      get() { return this.__trapVal; },
      set(v) {
        this.__trapVal = v;
        try {
          hits.push({ value: v,
            stack: new Error("trap").stack.split("\n").slice(1, 7).join(" | ") });
        } catch (e) { /* silent */ }
      },
    });
  } catch (e) { return "defineProperty failed: " + e.message; }
  return "trap set on node " + n.id;
})()
"""

TRAP_DUMP_JS = r"""
(() => {
  const hits = window.__widthTrap || [];
  const ns = (window.app && window.app.graph && window.app.graph._nodes) || [];
  const n = ns.find((x) => String((x && x.type) || "").toLowerCase() === "promptlibrary");
  const w = n && (n.widgets || []).find((x) => x.name === "pl_browser");
  let desc = null;
  try { desc = Object.getOwnPropertyDescriptor(w, "width"); } catch (e) { /* silent */ }
  return { hits, stillTrapped: !!(desc && desc.set),
    wWidth: w ? (w.width ?? null) : null,
    nodeW: n ? Math.round(n.size[0] * 100) / 100 : null };
})()
"""


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8188/")
    ap.add_argument("--port", type=int, default=9333)
    ap.add_argument("--panel", action="store_true", help="дополнительно открыть панель свойств и замерить снова")
    ap.add_argument("--workflow", default="", help="имя воркфлоу из user/default/workflows без .json")
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--window", default="1920,1080", help="размер окна Chrome (как у пользователя)")
    ap.add_argument("--canvas", action="store_true", help="переключить страницу в режим канваса (не Vue)")
    ap.add_argument("--resize", action="store_true", help="растянуть ноду мышью (как за угол)")
    ap.add_argument("--select", default="", help="открыть панель книги по id записи (как клик по карточке)")
    ap.add_argument("--keep", action="store_true", help="не закрывать Chrome в конце")
    ap.add_argument("--trap", action="store_true",
                    help="ловушка на widget.width: ставит accessor-trap и долбит UI "
                         "(панель ×3, зум, ресайз ноды) — кто запишет width, тот и писатель")
    args = ap.parse_args()

    import websockets  # noqa: WPS433 — зависимость ComfyUI

    profile = Path(tempfile.mkdtemp(prefix="pl-probe-"))
    chrome = subprocess.Popen([
        find_chrome(),
        "--headless=new",
        f"--remote-debugging-port={args.port}",
        f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
        f"--window-size={args.window}",
        "--disable-features=Translate",
        args.url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        page = wait_devtools(args.port)
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=32 * 1024 * 1024) as ws:
            cdp = CDP(ws)
            await cdp.call("Runtime.enable")
            print("→ ждём загрузку фронтенда…")
            await wait_for(cdp, "!!(window.app && window.app.isGraphReady)", 180, "app.isGraphReady")

            diag = await cdp.eval(DIAG_JS)
            print(f"→ режим рендера: {json.dumps(diag, ensure_ascii=False)}")
            want_vue = not args.canvas
            if bool(diag.get("vueNodesMode")) != want_vue:
                print(f"→ переключаем рендер в {'Vue' if want_vue else 'канвас'}: "
                      f"{await cdp.eval(SET_VUE_JS.replace('FLAG', 'true' if want_vue else 'false'))}")
                await asyncio.sleep(2.5)

            if args.workflow:
                loaded = await cdp.eval(
                    LOAD_WORKFLOW_JS.replace("NAME", json.dumps(args.workflow)), await_promise=True)
                print(f"→ воркфлоу «{args.workflow}»: {loaded}")
                await asyncio.sleep(2.0)
                focused = await cdp.eval(FOCUS_NODE_JS.replace("ZOOM", str(args.zoom)))
                print(f"→ фокус: {focused}")
                await asyncio.sleep(1.5)
            else:
                created = await cdp.eval(CREATE_NODE_JS)
                print(f"→ нода создана: {created}")
                await asyncio.sleep(1.5)

            if args.trap:
                print(f"→ ловушка: {await cdp.eval(TRAP_JS)}")
                # Долбёжка UI: панель открыть/закрыть ×3, зум туда-сюда,
                # программный ресайз ноды (как тяга за угол)
                for i in range(3):
                    await cdp.eval(OPEN_PANEL_JS)
                    await asyncio.sleep(1.5)
                    await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
                    await asyncio.sleep(1.0)
                for zv in ("0.76", "1.5", "1.0"):
                    await cdp.eval(
                        "(() => { try { window.app.canvas.setZoom(__ZV__); "
                        "window.app.canvas.setDirty(true, true); return __ZV__; } "
                        "catch (e) { return 'err'; } })()".replace("__ZV__", zv))
                    await asyncio.sleep(1.0)
                await cdp.eval(
                    "(() => { const n = window.__plProbeNode; if (!n) return 'no node'; "
                    "n.setSize([n.size[0] + 150, n.size[1]]); return 'resized'; })()")
                await asyncio.sleep(1.5)
                dump = await cdp.eval(TRAP_DUMP_JS)
                print("\n=== ЛОВУШКА: итог ===")
                print(json.dumps(dump, ensure_ascii=False, indent=2))
                if not dump.get("hits"):
                    print("→ вывод: писатель НЕ сработал за сессию долбёжки "
                          "(панель ×3, зум, ресайз). Значение — ископаемое, страж достаточен.")

            base = await cdp.eval(MEASURE_JS)
            print("\n=== ДО открытия панели ===")
            print(json.dumps(base, ensure_ascii=False, indent=2))

            if args.select:
                await asyncio.sleep(1.0)
                print("→ карточка: " + str(await cdp.eval(
                    FILL_DETAIL_JS.replace("ID", json.dumps(args.select)), await_promise=True)))
                await asyncio.sleep(1.0)

            # Замер по элементу виджета — работает в ОБОИХ режимах рендера
            wbase = await cdp.eval(MEASURE_WIDGET_JS)
            print("\n=== виджет до панели ===")
            print(json.dumps(wbase, ensure_ascii=False, indent=2))

            if args.panel:
                trigger = await cdp.eval(OPEN_PANEL_JS)
                print(f"\n→ панель: {trigger}")
                await asyncio.sleep(2.0)
                diag = await cdp.eval(PANEL_DIAG_JS)
                print(f"→ состояние панели: {json.dumps(diag, ensure_ascii=False)}")
                if not diag.get("panelText"):
                    # Тоггл мог закрыть вместо открыть (состояние гонки) — дёргаем ещё раз
                    print("→ панель не открылась, повторный триггер…")
                    print(f"→ панель(2): {await cdp.eval(OPEN_PANEL_JS)}")
                    await asyncio.sleep(2.0)
                    diag = await cdp.eval(PANEL_DIAG_JS)
                    print(f"→ состояние панели(2): {json.dumps(diag, ensure_ascii=False)}")
                after = await cdp.eval(MEASURE_JS)
                print("\n=== ПОСЛЕ открытия панели ===")
                print(json.dumps(after, ensure_ascii=False, indent=2))

                # И обратно: закрыть панель (повторный клик/escape) и замерить ещё раз
                await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
                await asyncio.sleep(1.5)
                closed = await cdp.eval(MEASURE_JS)
                print("\n=== ПОСЛЕ закрытия панели ===")
                print(json.dumps(closed, ensure_ascii=False, indent=2))

                print("\n=== СВОДКА (до → после панели → после закрытия) ===")
                if args.resize:
                    handle = await cdp.eval(RESIZE_HANDLE_JS)
                    print(f"\n→ ручка ресайза: {handle}")
                    if handle:
                        await drag_mouse(cdp, handle["x"], handle["y"], 300, 0)
                        await asyncio.sleep(1.0)
                        print("→ после растягивания: "
                              + json.dumps(await cdp.eval(MEASURE_WIDGET_JS), ensure_ascii=False))

                for label, snap in (("виджет до", wbase), ("виджет панель", await cdp.eval(MEASURE_WIDGET_JS))):
                    print(f"[{label}] {json.dumps(snap, ensure_ascii=False)}")
                print(f"{'элемент':<18}{'до':>12}{'панель':>12}{'закрыто':>12}")
                for name in ("canvasContainer", "lg-node", "node-widgets", "widget-row",
                             "our-root", "scroll-area", "main"):
                    vals = []
                    for snap in (base, after, closed):
                        item = snap.get(name)
                        vals.append(f"{item['w']:.0f}" if item else "-")
                    print(f"{name:<18}{vals[0]:>12}{vals[1]:>12}{vals[2]:>12}")
                print("nodeWidthVar:", base.get("nodeWidthVar"), "→", after.get("nodeWidthVar"),
                      "→", closed.get("nodeWidthVar"))
                for label, snap in (("до", base), ("панель", after), ("закрыто", closed)):
                    print(f"\n[{label}] rootCount={snap.get('rootCount')} rect={snap.get('plRootRect')}")
                    print("      parents: " + " < ".join(snap.get("plRootChain") or []))
    finally:
        if not args.keep:
            chrome.terminate()
            try:
                chrome.wait(timeout=10)
            except Exception:
                chrome.kill()
            shutil.rmtree(profile, ignore_errors=True)
    return 0


if __name__ == "__main__":
    _force_utf8()
    sys.exit(asyncio.run(main()))
