"""Оптическое центрирование крестика в кнопке-кружке PromptLibrary.

Зачем: глиф ✕/✖ в <button> центрируется по LINE BOX (flex + font metrics),
а не по чернилам — у шрифтового глифа асимметричные side bearings, и при
увеличении видно, что крестик смещён относительно кружка. Замеряет это
ПИКСЕЛЬНО: скриншот кнопки в headless Chrome (DPR=4) → bbox нефоновых
пикселей (крестик) vs bbox элемента → dx/dy в CSS px.

Кнопки берутся ИЗ web/js/prompt_library.js (все `del.style.cssText = "..."`
с их `del.textContent`), поэтому прибор всегда меряет то, что шиппится.

Запуск (ComfyUI НЕ нужен; нужен Chrome):
    cd Prompt_Library
    python tests/_probe_unlink_center.py              # DX/DY по каждой кнопке
    python tests/_probe_unlink_center.py --keep       # не удалять временные файлы
    python tests/_probe_unlink_center.py --scale 8    # DPR (по умолчанию 4)

Порог: |dx| <= 0.5px и |dy| <= 0.5px — PASS (при увеличении не бросается).
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "web" / "js" / "prompt_library.js"

CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)

TOL = 0.5  # px (в CSS px при DPR scale)


def find_chrome() -> str:
    import os
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    raise SystemExit("Chrome не найден (задай CHROME_PATH)")


def extract_buttons(src: str) -> list[dict]:
    """Все пары del.style.cssText / del.textContent из исходника (по порядку)."""
    pat_css = re.compile(r'del\.style\.cssText\s*=\s*"([^"]*)"')
    pat_txt = re.compile(r'del\.textContent\s*=\s*"([^"]*)"')
    buttons = []
    for m in pat_css.finditer(src):
        # в коде textContent стоит ПЕРЕД cssText — ищем назад и вперёд
        window = src[max(0, m.start() - 300): m.end() + 300]
        hits = list(pat_txt.finditer(window))
        text = ""
        if hits:
            nearest = min(hits, key=lambda t: abs(t.start() - (m.start() - max(0, m.start() - 300))))
            text = nearest.group(1)
        css = m.group(1)
        # гейтим только кнопки-крестики отвязки (круг или ✕/✖); 🗑 и пр. — инфо
        gated = "border-radius:50%" in css or text in ("✕", "✖")
        buttons.append({
            "line": src[: m.start()].count("\n") + 1,
            "css": css,
            "text": text,
            "gated": gated,
        })
    return buttons


def build_html(buttons: list[dict]) -> str:
    parts = [
        "<!doctype html><meta charset='utf-8'>",
        "<style>body{margin:0;background:#262626;}</style>",
        "<body>",
    ]
    for i, b in enumerate(buttons):
        top = 4 + i * 24
        text = b["text"].replace("&", "&amp;").replace("<", "&lt;")
        parts.append(
            f"<button id='b{i}' style=\"position:absolute;left:4px;top:{top}px;{b['css']}\">{text}</button>"
        )
    parts.append("<pre id='out'></pre>")
    parts.append("""
<script>
const btns = [...document.querySelectorAll('button')].map((el, i) => {
  const r = el.getBoundingClientRect();
  return { i, x: r.x, y: r.y, w: r.width, h: r.height,
           font: getComputedStyle(el).font, text: el.textContent };
});
document.getElementById('out').textContent = "PLJSON" + JSON.stringify(btns) + "PLJSONEND";
</script></body>""")
    return "".join(parts)


def decode_png(data: bytes):
    """Минимальный PNG-ридер: 8-bit, color type 2 (RGB) / 6 (RGBA), не interlaced."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "не PNG"
    pos, w, h, ctype, idat = 8, 0, 0, 0, b""
    while pos < len(data):
        ln, typ = struct.unpack(">I4s", data[pos: pos + 8])
        chunk = data[pos + 8: pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", chunk[:10])
            assert depth == 8 and ctype in (2, 6), f"PNG: depth={depth} ctype={ctype}"
        elif typ == b"IDAT":
            idat += chunk
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = 4 if ctype == 6 else 3
    stride = w * ch
    out = bytearray()
    prev = bytearray(stride)
    p = 0
    for _y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p: p + stride]); p += stride
        if f == 1:
            for x in range(ch, stride):
                line[x] = (line[x] + line[x - ch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line
        prev = line
    return w, h, ch, bytes(out)


def ink_bbox(w: int, h: int, ch: int, pix: bytes, bg=(0x26, 0x26, 0x26), thr=40):
    """BBox пикселей, отличающихся от фона (крестик + его AA)."""
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y * w * ch
        for x in range(w):
            o = row + x * ch
            if max(abs(pix[o] - bg[0]), abs(pix[o + 1] - bg[1]), abs(pix[o + 2] - bg[2])) > thr:
                x0, y0 = min(x0, x), min(y0, y)
                x1, y1 = max(x1, x), max(y1, y)
    if x1 < 0:
        return None
    return x0, y0, x1, y1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=int, default=4, help="DPR скриншота")
    ap.add_argument("--keep", action="store_true", help="не удалять tmp-файлы")
    args = ap.parse_args()
    src = SRC.read_text(encoding="utf-8")
    buttons = extract_buttons(src)
    if not buttons:
        print("FAIL: в web/js/prompt_library.js нет del.style.cssText кнопок")
        return 2
    print(f"Найдено кнопок del в исходнике: {len(buttons)} (scale={args.scale})")
    tmp = Path(tempfile.mkdtemp(prefix="pl_unlink_"))
    html = tmp / "page.html"
    html.write_text(build_html(buttons), encoding="utf-8")
    png = tmp / "shot.png"
    win_w = 24
    win_h = 4 + len(buttons) * 24 + 8
    r = subprocess.run(
        [find_chrome(), "--headless=new", f"--force-device-scale-factor={args.scale}",
         f"--window-size={win_w},{win_h}", f"--screenshot={png}",
         "--virtual-time-budget=2000", "--hide-scrollbars",
         "--dump-dom", str(html)],
        capture_output=True, text=True, timeout=60,
    )
    m = re.search(r"PLJSON(\[.*?\])PLJSONEND", r.stdout, re.S)
    if not m:
        print("FAIL: не собрал метрики из страницы (dump-dom)")
        print(r.stderr[-500:])
        return 2
    rects = json.loads(m.group(1))
    if not png.exists():
        print("FAIL: Chrome не написал скриншот")
        return 2
    w, h, ch, pix = decode_png(png.read_bytes())
    s = args.scale
    fails = 0
    for meta, btn in zip(rects, buttons):
        x0, y0, x1, y1 = int(meta["x"] * s), int(meta["y"] * s), \
            int((meta["x"] + meta["w"]) * s), int((meta["y"] + meta["h"]) * s)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(w - 1, x1), min(h - 1, y1)
        sub_w, sub_h = x1 - x0 + 1, y1 - y0 + 1
        sub = bytearray()
        for yy in range(y0, y1 + 1):
            row = yy * w * ch
            for xx in range(x0, x1 + 1):
                sub += pix[row + xx * ch: row + xx * ch + 3]
        bb = ink_bbox(sub_w, sub_h, 3, bytes(sub))
        el_cx = (meta["x"] + meta["w"] / 2)
        el_cy = (meta["y"] + meta["h"] / 2)
        tag = f"строка {btn['line']}  «{btn['text']}»  {meta['w']:.0f}x{meta['h']:.0f}px"
        if not btn["gated"]:
            note = "чернил не найдено" if bb is None else "вне гейта (🗑-кнопка) — инфо"
            print(f"  info  {tag}  — {note}")
            continue
        if bb is None:
            print(f"  FAIL  {tag}  — чернил не найдено")
            fails += 1
            continue
        ink_cx = x0 + (bb[0] + bb[2] + 1) / 2
        ink_cy = y0 + (bb[1] + bb[3] + 1) / 2
        dx = ink_cx / s - el_cx
        dy = ink_cy / s - el_cy
        ok = abs(dx) <= TOL and abs(dy) <= TOL
        if not ok:
            fails += 1
        print(f"  {'ok  ' if ok else 'FAIL'}  {tag}  dx={dx:+.2f}px dy={dy:+.2f}px")
    print(f"ПОРОГ |dx|,|dy| <= {TOL}px (только кнопки-крестики) → "
          + (f"СМЕЩЕНИЕ ЕСТЬ (мимо порога: {fails})" if fails else "центрировано"))
    if not args.keep:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
