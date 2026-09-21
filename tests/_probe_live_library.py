"""Живой аудит данных библиотеки PromptLibrary v1.42 — с защитой от правки базы.

Зачем: согласованность РЕАЛЬНЫХ данных пользователя (`user/prompt_library/`) —
существует ли файл графа, нет ли сирот в `workflows/` и `previews/`, не врёт ли
флаг `has_workflow` в списке — головным тестом не доказывается: там своя
временная папка. Но аудит на ЖИВОЙ базе опасен: пока он читает, база может
меняться (пользователь чистит карточки), и расхождения между двумя чтениями
выглядят как дефекты хранения. Ровно на это попался аудит v1.40: он шёл во время
чистки базы, и «потерянные записи» оказались артефактом (скил
comfyui-negative-result-audit, раздел «Обратная сторона: ложное „дефект найден“»).

Две защиты в самой пробе:

1. **Отпечаток базы** (хэш `library.json` + имена и размеры файлов `workflows/`,
   `previews/`) снимается до и после проверок. Изменился — вердикт «замер
   недействителен» (код возврата 2), а не список «находок».
2. **Подтверждение повторным чтением**: каждая провалившаяся проверка выполняется
   ещё раз на свежем снимке. Не подтвердилась — это было переходное состояние
   (например, файл писался в этот момент), и находка **снимается**, а не
   публикуется. Подтвердилась — настоящий дефект.

Проба ничего не меняет — только читает.

Что проверяет:
  • `library.json` разбирается, записи на месте;
  • нет дублей id;
  • `workflow_file` = `workflows/{id}.json` (id alfanum) и файл существует;
  • `preview` указывает на существующий файл в `previews/`;
  • в `workflows/` и `previews/` нет сирот;
  • флаг `has_workflow` в `/list` согласован с данными (если ComfyUI запущен) —
    та самая дыра, что нашлась в самоаудите v1.40 (§26). Про обложку: в `/list`
    поля `has_preview` НЕТ (оно есть только в ui-пакете `execute`) — признаком
    служит само поле `preview`;
  • справочно: `folder` нормализован, `pinned_folders` ⊆ `folders`.

Запуск (сервер можно не запускать — API-проверки тогда пропускаются):
    cd Prompt_Library
    python tests/_probe_live_library.py
    python tests/_probe_live_library.py --root "D:\\...\\user\\prompt_library" --json

Коды возврата: 0 — зелёное, 1 — есть подтверждённые находки, 2 — замер
недействителен (база менялась во время проверки).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

BUNDLE = Path(__file__).resolve().parents[2]
ID_RE = re.compile(r"[a-zA-Z0-9]+\Z")
API_LIMIT = 200  # /list отдаёт первые 200 записей


def _norm_folder(path):
    """Копия `_norm_folder()` ноды — независимая проверка, а не вызов того же кода."""
    parts = [p.strip() for p in str(path or "").replace("\\", "/").split("/") if p.strip()]
    return "/".join(parts)


def _find_root(explicit=None):
    if explicit:
        return Path(explicit)
    env = os.environ.get("PL_LIBRARY_ROOT")
    if env:
        return Path(env)
    # Рабочая копия из sync.py: <comfyui>/custom_nodes → <comfyui>/user/prompt_library
    spec = importlib.util.spec_from_file_location("_sync_cfg", BUNDLE / "sync.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return Path(mod.DST_ROOT).parent / "user" / "prompt_library"


def _files(root, sub):
    """Имена и размеры файлов подпапки — размер ловит и перезапись, не только появление."""
    d = root / sub
    if not d.is_dir():
        return []
    return sorted(f"{p.name}:{p.stat().st_size}" for p in d.iterdir() if p.is_file())


def _fingerprint(root):
    """Состояние базы: содержимое library.json + состав workflows/ и previews/."""
    lib = root / "library.json"
    data = lib.read_bytes() if lib.exists() else b""
    h = hashlib.sha256()
    h.update(str(len(data)).encode())
    h.update(hashlib.sha256(data).digest())
    for sub in ("workflows", "previews"):
        h.update(sub.encode())
        h.update("\n".join(_files(root, sub)).encode())
    return h.hexdigest()


def _snapshot(root):
    """Свежий снимок базы для одного прохода проверок."""
    db = json.loads((root / "library.json").read_text(encoding="utf-8"))
    return {
        "entries": db.get("entries") or [],
        "folders": db.get("folders") or [],
        "pinned": db.get("pinned_folders") or [],
        "wf": {n.split(":")[0] for n in _files(root, "workflows")},
        "pv": {n.split(":")[0] for n in _files(root, "previews")},
    }


def _build_checks(root, api_entries_of):
    """Проверки как функции: их можно выполнить второй раз на свежем снимке."""
    def wf_refs(snap):
        wanted, bad = set(), []
        for e in snap["entries"]:
            rel = e.get("workflow_file")
            if not rel:
                continue
            name = Path(rel).name
            if rel != f"workflows/{name}" or not ID_RE.match(str(e.get("id") or "")) or name != f"{e.get('id')}.json":
                bad.append((e.get("id"), rel))
            wanted.add(name)
        return wanted, bad

    def check_parse(snap):
        return len(snap["entries"]) > 0, f"library.json разобран: записей {len(snap['entries'])}"

    def check_dupes(snap):
        ids = [e.get("id") for e in snap["entries"]]
        dupes = sorted(i for i, n in Counter(ids).items() if n > 1)
        return not dupes, "дублей id нет" if not dupes else f"дубли id: {dupes[:3]}"

    def check_wf_form(snap):
        _, bad = wf_refs(snap)
        return not bad, ("все workflow_file вида workflows/{id}.json" if not bad
                         else f"чужая форма workflow_file: {bad[:3]}")

    def check_wf_files(snap):
        wanted, _ = wf_refs(snap)
        gone = sorted(n for n in wanted if not (root / "workflows" / n).exists())
        return not gone, ("файлы графов на месте" if not gone
                          else f"workflow_file без файла (кнопка «Воркфлоу» соврёт): {gone[:3]}")

    def check_pv_files(snap):
        gone = sorted({Path(e["preview"]).name for e in snap["entries"] if e.get("preview")} - snap["pv"])
        return not gone, "файлы превью на месте" if not gone else f"preview без файла: {gone[:3]}"

    def check_wf_orphans(snap):
        wanted, _ = wf_refs(snap)
        orphans = sorted(snap["wf"] - wanted)
        return not orphans, "в workflows/ нет сирот" if not orphans else f"сироты в workflows/: {orphans[:3]}"

    def check_pv_orphans(snap):
        used = {Path(e["preview"]).name for e in snap["entries"] if e.get("preview")}
        orphans = sorted(snap["pv"] - used)
        return not orphans, "в previews/ нет сирот" if not orphans else f"сироты в previews/: {orphans[:3]}"

    def check_api_flags(snap):
        api_entries = api_entries_of()
        if api_entries is None:
            return True, "API недоступен — проверка флагов /list пропущена"
        by_id = {e.get("id"): e for e in api_entries}
        bad = []
        for e in snap["entries"][:API_LIMIT]:
            api = by_id.get(e.get("id"))
            if api is None:
                bad.append((e.get("id"), "нет в /list"))
                continue
            want_wf = bool(e.get("workflow")) or bool(e.get("workflow_file")
                                                      and (root / e["workflow_file"]).exists())
            want_pv = bool(e.get("preview"))
            got_pv = api.get("has_preview") if "has_preview" in api else bool(api.get("preview"))
            if bool(api.get("has_workflow")) != want_wf:
                bad.append((e.get("id"), f"has_workflow={api.get('has_workflow')}, ожидалось {want_wf}"))
            elif bool(got_pv) != want_pv:
                bad.append((e.get("id"), f"has_preview={got_pv}, ожидалось {want_pv}"))
        return not bad, "флаги /list согласованы с данными" if not bad else f"флаги /list врут: {bad[:3]}"

    return [
        ("parse", check_parse), ("dupes", check_dupes), ("wf_form", check_wf_form),
        ("wf_files", check_wf_files), ("pv_files", check_pv_files),
        ("wf_orphans", check_wf_orphans), ("pv_orphans", check_pv_orphans),
        ("api_flags", check_api_flags),
    ]


def _run_pass(checks, snap):
    return [(name, *fn(snap)) for name, fn in checks]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    ap = argparse.ArgumentParser(description="Живой аудит данных PromptLibrary v1.42")
    ap.add_argument("--root", help="папка базы (по умолчанию берётся из sync.py)")
    ap.add_argument("--url", default="http://127.0.0.1:8188", help="адрес ComfyUI для API-проверок")
    ap.add_argument("--no-api", action="store_true", help="не ходить на сервер вовсе")
    ap.add_argument("--json", action="store_true", help="машинный вывод")
    args = ap.parse_args()

    root = _find_root(args.root)
    if not (root / "library.json").exists():
        raise SystemExit(f"ОШИБКА: нет {root / 'library.json'} — укажи --root")

    api_cache = {}

    def api_entries_of():
        if args.no_api:
            return None
        if "v" not in api_cache:
            try:
                with urllib.request.urlopen(args.url.rstrip("/") + "/prompt_library/list", timeout=10) as resp:
                    api_cache["v"] = json.loads(resp.read().decode("utf-8")).get("entries") or []
            except (urllib.error.URLError, OSError, ValueError):
                api_cache["v"] = None
        return api_cache["v"]

    checks = _build_checks(root, api_entries_of)
    stamp_before = _fingerprint(root)
    try:
        snap = _snapshot(root)
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        print(f"НЕДЕЙСТВИТЕЛЬНО: library.json не разобрался ({exc}) — базу правили во время замера")
        return 2

    results = _run_pass(checks, snap)
    failures = [r for r in results if not r[1]]
    retracted, unresolved = [], []
    if failures:
        # Повторное чтение: находка, которая на свежем снимке не воспроизводится,
        # была переходным состоянием (файл писали в этот момент), а не дефектом.
        try:
            snap2 = _snapshot(root)
            again = {name: (ok, text) for name, ok, text in _run_pass(checks, snap2)}
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            again = {}
        for name, ok, text in failures:
            if again.get(name, (False, ""))[0]:
                retracted.append(text)
            else:
                unresolved.append(text)

    info = []
    if snap["entries"]:
        info.append(f"состав: inline-граф {sum(1 for e in snap['entries'] if e.get('workflow'))}, "
                    f"файловый {sum(1 for e in snap['entries'] if e.get('workflow_file'))}, "
                    f"без графа {sum(1 for e in snap['entries'] if not e.get('workflow') and not e.get('workflow_file'))}, "
                    f"файлов графов на диске {len(snap['wf'])}, превью на диске {len(snap['pv'])}")
        raw = [e.get("id") for e in snap["entries"] if (e.get("folder") or "") != _norm_folder(e.get("folder"))]
        if raw:
            info.append(f"folder не нормализован у {len(raw)} записей (нормализуется при чтении): {raw[:3]}")
        stray = [f for f in snap["pinned"] if f not in snap["folders"]]
        if stray:
            info.append(f"pinned_folders вне folders ({len(stray)}): {stray[:3]} — чистится при операциях с папками")
    if retracted:
        info.append(f"снято повторным чтением (переходное состояние, не дефект): {retracted}")
    if args.no_api:
        info.append("API отключён флагом --no-api")

    changed = stamp_before != _fingerprint(root)
    if args.json:
        print(json.dumps({
            "root": str(root), "changed": changed, "entries": len(snap["entries"]),
            "results": [{"name": n, "ok": ok, "text": t} for n, ok, t in results],
            "retracted": retracted, "failed": unresolved, "info": info,
        }, ensure_ascii=False, indent=2))
    else:
        print(f"База: {root}")
        for _name, ok, text in results:
            print(f"  [{'ok' if ok else 'FAIL'}] {text}")
        for text in info:
            print(f"  [info] {text}")
        if changed:
            print("\n  [!!] база ИЗМЕНИЛАСЬ во время проверки — выводы недействительны")
        verdict = "НЕДЕЙСТВИТЕЛЬНО (базу правили во время проверки)" if changed else ("КРАСНОЕ" if unresolved else "ЗЕЛЁНОЕ")
        print(f"\nИТОГ: {verdict}")
    if changed:
        return 2
    return 1 if unresolved else 0


if __name__ == "__main__":
    sys.exit(main())
