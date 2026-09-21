"""Живая проба кэша ComfyUI для ноды PromptLibrary (v1.41).

Зачем: v1.41 убрала проверку `mode` из `IS_CHANGED` — в v1.39 она делала
`float("nan")` безусловным, и ComfyUI перестал кэшировать ноду: каждый Queue
нода исполнялась заново и разбирала `library.json` (~0.165 с на живой базе).
Песочница видит только возвращаемое значение `IS_CHANGED`; сам факт «движок
больше не переисполняет ноду» проверяется ТОЛЬКО на живом ComfyUI, потому что
решение принимает движок, а не наш код.

Чем меряем (валидация прибора, скил comfyui-negative-result-audit):
  • `execution.py:770` шлёт сообщение `execution_cached` со списком id узлов,
    чьи выходы взяты из кэша; `execution.py:446` — если `caches.outputs.get()`
    вернул запись, нода НЕ исполняется (выход из `execute()` сразу);
  • `status.messages` истории прогона — это ПАРЫ `[тип, данные]` (проверено на
    этой сборке живым запросом), поэтому читаются по HTTP: `GET /history/<pid>`;
  • кэшируются и output-ноды (исключения для `OUTPUT_NODE` в `execute()` нет),
    поэтому ожидание «нода закэширована» для нашей ноды законно.

Сценарий (все прогоны — один граф из одной ноды PromptLibrary):
  1) и 2) `pickup` пуст, входы не меняются -> 2-й прогон ОБЯЗАН быть закэширован;
  3)      тот же набор, но другой `mode`    -> прогон ОБЯЗАН исполниться
          (доказывает, что откат проверки `mode` не сломал смену режима);
  4) и 5) `pickup` непустой                 -> 5-й прогон ОБЯЗАН исполниться
          (подхват требует прогона на каждом Queue, §33).

Прогон 1 делается заведомо «холодным»: `save_folder` несёт уникальную метку
запуска пробы. Без этого нода могла бы приехать уже закэшированной от прошлого
запуска пробы, и первая проверка врала бы.

Мерим безопасно: режим «📤 Выдача» + пустое `selected` — записи в базу в этом
режиме не происходит (`save_on = False`, см. `_execute`; `save_folder` в этом
режиме не используется). Живая библиотека пользователя не меняется: ни карточек,
ни файлов графов, ни обложек.

Запуск (ComfyUI запущен; после правок — синхронизирован и перезапущен):
    cd Prompt_Library
    python tests/_probe_live_cache.py
    python tests/_probe_live_cache.py --url http://127.0.0.1:8188 --json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

NODE = "PromptLibrary"
MODE_WRITE = "📥 Запись"
MODE_ISSUE = "📤 Выдача"
NODE_ID = "1"          # id нашей ноды в графе пробы
POLL_TIMEOUT = 60.0    # сколько ждать завершения прогона, с


def _request(url, payload=None, timeout=20.0):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _message_parts(msg):
    """Сообщение прогона: в этой сборке — пара `[тип, данные]`, но принимаем и
    словарь: формат относится к движку, а не к ноде, и может поменяться."""
    if isinstance(msg, (list, tuple)) and len(msg) == 2:
        return msg[0], (msg[1] or {})
    if isinstance(msg, dict):
        return msg.get("type"), (msg.get("data") or {})
    return None, {}


def _queue(base, mode, pickup, save_folder, client_id):
    """Поставить граф в очередь и дождаться записи в истории."""
    prompt = {NODE_ID: {"class_type": NODE, "inputs": {
        "mode": mode, "selected": "", "save_folder": save_folder, "pickup": pickup}}}
    pid = _request(base + "/prompt", {"prompt": prompt, "client_id": client_id})["prompt_id"]
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        hist = _request(base + "/history/" + pid)
        if pid in hist:
            status = hist[pid].get("status", {})
            if status.get("completed"):
                state = _was_cached(status)
                return {"pickup": pickup, "mode": mode, **state}
        time.sleep(0.15)
    raise SystemExit(f"ОШИБКА: прогон {pid} не завершился за {POLL_TIMEOUT:.0f} с")


def _was_cached(status):
    """Исполнилась нода или её выходы взяли из кэша — по сообщениям прогона.

    Единственный надёжный след в истории этой сборки — `execution_cached`:
    события исполнения (`executing`/`executed`) уходят клиенту по websocket и в
    `status.messages` НЕ попадают (проверено живым дампом). Поэтому «исполнена»
    здесь = «есть сообщение о кэше, а нашего id в списке нет». Сообщения нет —
    прогон вообще не доехал до движка, и это признак сломанного прибора, а не
    дефекта ноды, поэтому такой замер помечается недействительным.
    """
    got_report, cached_ids = False, []
    for msg in status.get("messages", []):
        kind, data = _message_parts(msg)
        if kind == "execution_cached":
            got_report = True
            cached_ids = list(data.get("nodes") or [])
    if status.get("status_str") == "error":
        raise SystemExit(f"ОШИБКА прогона: {json.dumps(status, ensure_ascii=False)[:400]}")
    cached = NODE_ID in cached_ids
    return {"in_cached_list": cached, "executed": got_report and not cached,
            "known": got_report}


def main():
    # Консоль Windows — cp866/cp1251: без этого эмодзи режима (📤/📥) роняют печать
    # UnicodeEncodeError уже ПОСЛЕ замеров, и проба выглядит сломанной.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    ap = argparse.ArgumentParser(description="Живая проба кэша PromptLibrary (v1.41)")
    ap.add_argument("--url", default="http://127.0.0.1:8188",
                    help="адрес запущенного ComfyUI (по умолчанию http://127.0.0.1:8188)")
    ap.add_argument("--json", action="store_true", help="машинный вывод")
    args = ap.parse_args()
    base = args.url.rstrip("/")

    try:
        stats = _request(base + "/system_stats", timeout=5.0)
    except (urllib.error.URLError, OSError) as exc:
        raise SystemExit(f"ОШИБКА: ComfyUI недоступен по {base} ({exc}). Запусти ComfyUI.")

    cid = uuid.uuid4().hex
    folder = f"probe-{cid[:8]}"  # холодный старт + изоляция от прошлых запусков пробы
    plan = [
        ("1. pickup пуст (холодный старт)", MODE_ISSUE, "", folder),
        ("2. pickup пуст, ничего не меняли", MODE_ISSUE, "", folder),
        ("3. pickup пуст, сменили mode", MODE_WRITE, "", folder),
        ("4. pickup непустой", MODE_ISSUE, "9999", folder),
        ("5. pickup непустой, ничего не меняли", MODE_ISSUE, "9999", folder),
    ]
    runs = []
    for label, mode, pickup, fld in plan:
        out = _queue(base, mode, pickup, fld, cid)
        out["label"] = label
        runs.append(out)

    r1, r2, r3, _r4, r5 = runs
    verdicts = []
    if not all(r["known"] for r in runs):
        verdicts.append((False, "прибор не увидел ноду в сообщениях прогона — замер недействителен"))
    if r1["executed"] and not r1["in_cached_list"]:
        verdicts.append((True, "холодный прогон исполнился — прибор видит исполнение"))
    else:
        verdicts.append((False, "холодный прогон не исполнился — граф пробы не тот (замер недействителен)"))
    if r2["in_cached_list"]:
        verdicts.append((True, "без подхвата нода ЗАКЭШИРОВАНА — кэш работает (правка v1.41)"))
    else:
        verdicts.append((False, "без подхвата нода НЕ закэширована — кэш всё ещё выключен (баг v1.39)"))
    if r3["executed"] and not r3["in_cached_list"]:
        verdicts.append((True, "смена режима переисполняет ноду — откат проверки `mode` ничего не сломал"))
    else:
        verdicts.append((False, "смена режима НЕ переисполнила ноду — переключение режима может не работать"))
    if r5["executed"] and not r5["in_cached_list"]:
        verdicts.append((True, "с подхватом нода исполняется каждый Queue — подхват жив (§33)"))
    else:
        verdicts.append((False, "с подхватом нода закэширована — подхват сломается (§33)"))

    ok = all(v[0] for v in verdicts)
    if args.json:
        print(json.dumps({
            "comfyui_version": (stats.get("system") or {}).get("comfyui_version"),
            "runs": runs,
            "verdicts": [{"ok": o, "text": t} for o, t in verdicts],
            "ok": ok,
        }, ensure_ascii=False, indent=2))
    else:
        print(f"ComfyUI {base} — версия {(stats.get('system') or {}).get('comfyui_version')}")
        print("Прогоны (pickup / mode -> результат):")
        for r in runs:
            state = "ЗАКЭШИРОВАНА" if r["in_cached_list"] else "исполнена"
            mode = "ВЫДАЧА" if r["mode"] == MODE_ISSUE else "ЗАПИСЬ"
            print(f"  {r['label']:<38} {mode:<8} -> {state}")
        print()
        for good, text in verdicts:
            print(f"  [{'ok' if good else 'FAIL'}] {text}")
        print(f"\nИТОГ: {'ЗЕЛЁНОЕ' if ok else 'КРАСНОЕ'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
