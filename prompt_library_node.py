"""Prompt Library — универсальная нода-библиотека промптов.

Проводник: папки/подпапки (путь "Фото/Портреты"), имена записей, превью.
Хранение: ComfyUI/user/prompt_library/library.json + previews/.
Автосохранение при execute (если auto_save), выдача выбранной записи
(если use_selected). См. SPECIFICATION.md.
"""

import datetime
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

MAX_ENTRIES = 500

# --- Пути хранения -----------------------------------------------------------

def _library_root():
    """ComfyUI/user/prompt_library — переживает обновления ноды."""
    # 1. Штатный folder_paths (в рантайме ComfyUI)
    try:
        import folder_paths  # type: ignore
        user_dir = Path(folder_paths.get_user_directory())
        return user_dir / "prompt_library"
    except Exception:
        pass
    # 2. Фолбэк: <ComfyUI>/custom_nodes/Prompt_Library -> <ComfyUI>/user/...
    # __file__ = .../custom_nodes/Prompt_Library/prompt_library_node.py
    try:
        comfy_root = Path(__file__).resolve().parents[2]
        return comfy_root / "user" / "prompt_library"
    except Exception:
        return Path(tempfile.gettempdir()) / "prompt_library"


def _ensure_dirs():
    root = _library_root()
    (root / "previews").mkdir(parents=True, exist_ok=True)
    return root


# --- Папки -------------------------------------------------------------------

def _norm_folder(path):
    """' Фото//Портреты/ ' -> 'Фото/Портреты'. Пусто -> '' (корень)."""
    parts = [p.strip() for p in str(path or "").replace("\\", "/").split("/") if p.strip()]
    return "/".join(parts)


def _parent_folders(folder):
    parts = folder.split("/") if folder else []
    return ["/".join(parts[:i]) for i in range(1, len(parts))]


def _auto_title(prompt):
    line = (prompt or "").strip().split("\n")[0].strip()
    return line[:60] if line else "Без названия"


# --- База --------------------------------------------------------------------

def _load_db():
    """Возвращает (entries, folders). Мигрирует legacy-формат (список) и
    старые записи (category -> folder, без title)."""
    root = _ensure_dirs()
    lib = root / "library.json"
    data = None
    if lib.exists():
        try:
            data = json.loads(lib.read_text(encoding="utf-8"))
        except Exception:
            data = None
    if isinstance(data, list):  # legacy: голый список записей
        data = {"entries": data, "folders": []}
    if not isinstance(data, dict):
        data = {"entries": [], "folders": []}
    # Устойчивость к битому/чужому файлу: не-словари в списке записей и
    # не-строки в списке папок отбрасываем, иначе любая операция (list/execute)
    # падает на первом же `e.get(...)` до ручного вмешательства в файл.
    raw_entries = data.get("entries", []) or []
    raw_folders = data.get("folders", []) or []
    entries = [e for e in raw_entries if isinstance(e, dict)]
    folders = [f for f in raw_folders if isinstance(f, str)]
    if len(entries) != len(raw_entries) or len(folders) != len(raw_folders):
        # ASCII-only: консоль Windows не всегда умеет cp1251/utf-8 — print с
        # кириллицей здесь мог бы сам уронить _load_db (остальные логи ASCII).
        print("[PromptLibrary] library.json: dropped broken records", flush=True)
        data["broken"] = True

    changed = bool(data.pop("broken", False))
    for e in entries:
        if "folder" not in e:
            e["folder"] = _norm_folder(e.get("category", ""))
            changed = True
        else:
            e["folder"] = _norm_folder(e.get("folder", ""))
        if not e.get("title"):
            e["title"] = _auto_title(e.get("prompt", ""))
            changed = True

    # Папки из записей + родители для дерева
    fset = set(_norm_folder(f) for f in folders if _norm_folder(f))
    for e in entries:
        f = e.get("folder", "")
        if f:
            fset.add(f)
            fset.update(_parent_folders(f))
    folders = sorted(fset)
    if changed or set(data.get("folders", []) or []) != fset:
        _save_db(entries, folders)
    return entries, folders


def _save_db(entries, folders):
    root = _ensure_dirs()
    lib = root / "library.json"
    tmp = root / "library.json.tmp"
    tmp.write_text(json.dumps({"entries": entries, "folders": sorted(set(folders))},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, lib)


def _dedup_hash(prompt, folder):
    return hashlib.md5(f"{prompt}\n{folder}".encode("utf-8")).hexdigest()


def _new_id(*parts):
    base = "|".join(parts) + datetime.datetime.now().isoformat()
    return hashlib.md5(base.encode("utf-8")).hexdigest()[:10]


def _workflow_pnginfo(workflow):
    """PngInfo с чанком workflow — как у SaveImage: файл самодостаточен,
    drag превью из проводника открывает воркфлоу нативно."""
    try:
        from PIL.PngImagePlugin import PngInfo
    except Exception:
        return None
    if not isinstance(workflow, dict):
        return None
    try:
        info = PngInfo()
        info.add_text("workflow", json.dumps(workflow, ensure_ascii=False, separators=(",", ":")))
        return info
    except Exception:
        return None


def _extract_frame(source):
    """Первый кадр из IMAGE-тензора или VIDEO-объекта ядра.

    Сокет объявлен как IMAGE,VIDEO (двухцветный): по синему проводу приходит
    torch-батч (B,H,W,C), по зелёному — VideoInput с get_components().images
    (тот же батч + audio/frame_rate). Возвращает кадр-тензор/ndarray либо None.
    """
    if source is None:
        return None
    get_comp = getattr(source, "get_components", None)
    if callable(get_comp):
        try:
            comp = get_comp()
            imgs = getattr(comp, "images", None)
            if imgs is None and isinstance(comp, (tuple, list)):
                imgs = comp[0] if comp else None
            if imgs is None:
                return None
            return imgs[0] if getattr(imgs, "ndim", 3) == 4 else imgs
        except Exception as e:
            print(f"[PromptLibrary] video frame extract failed: {e}", flush=True)
            return None
    return source


def _save_thumbnail(image, entry_id, workflow=None):
    """Первый кадр IMAGE-тензора как PNG-превью 512px со встроенным workflow
    (как SaveImage). Видео — это тот же IMAGE-батч (B,H,W,C), поэтому берём
    кадр [0]. Возвращает относительный путь 'previews/{id}.png' или None."""
    try:
        from PIL import Image
    except Exception:
        return None
    try:
        import numpy as np
        # Видео/батч может прийти списком — берём первый элемент
        frame = image[0] if isinstance(image, (list, tuple)) else image
        # torch-батч (B,H,W,C) — первый кадр; одиночный кадр (H,W,C) — как есть
        try:
            import torch  # type: ignore
            is_tensor = isinstance(frame, torch.Tensor)
        except Exception:
            is_tensor = hasattr(frame, "detach") or hasattr(frame, "cpu")
        if is_tensor:
            try:
                ndim = frame.ndim  # torch
            except Exception:
                ndim = np.asarray(frame).ndim
            if ndim == 4:
                frame = frame[0]
        else:
            arr_tmp = np.asarray(frame)
            if arr_tmp.ndim == 4:
                frame = frame[0] if not isinstance(frame, np.ndarray) else arr_tmp[0]
        if hasattr(frame, "detach"):
            arr = frame.detach().cpu().numpy()
        elif hasattr(frame, "cpu"):
            arr = frame.cpu().numpy()
        else:
            arr = np.asarray(frame)
        arr = np.asarray(arr)
        # float 0..1 -> 0..255; uint8 и float 0..255 — как есть
        if arr.dtype.kind == "f":
            peak = float(arr.max()) if arr.size else 0.0
            if peak <= 1.5:
                arr = (arr * 255).clip(0, 255).astype("uint8")
            else:
                arr = arr.clip(0, 255).astype("uint8")
        elif arr.dtype != np.uint8:
            arr = np.asarray(arr).clip(0, 255).astype("uint8")
        # grayscale (H,W) -> RGB
        if arr.ndim == 2:
            arr = np.stack([arr] * 3, axis=-1)
        img = Image.fromarray(arr)
        # Запас под крупный показ: исходник 512px, даунскейл только в браузере
        img.thumbnail((512, 512), Image.LANCZOS)
        root = _ensure_dirs()
        name = f"{entry_id}.png"
        pnginfo = _workflow_pnginfo(workflow)
        kw = {"pnginfo": pnginfo} if pnginfo is not None else {}
        img.convert("RGB").save(root / "previews" / name, "PNG", **kw)
        return f"previews/{name}"
    except Exception as e:
        print(f"[PromptLibrary] thumbnail failed: {e}", flush=True)
        return None


def _upgrade_preview_to_png(entry, workflow):
    """Старый JPG без метаданных -> PNG со встроенным workflow (one-time,
    вызывается только при backfill'е workflow в запись)."""
    try:
        from PIL import Image
    except Exception:
        return False
    try:
        old = entry.get("preview") or ""
        entry_id = entry.get("id") or ""
        pnginfo = _workflow_pnginfo(workflow)
        if not old.endswith(".jpg") or pnginfo is None:
            return False
        if not re.fullmatch(r"[a-zA-Z0-9]+", entry_id):
            return False
        root = _ensure_dirs()
        src = root / old
        # guard: файл обязан лежать прямо в previews/
        if src.parent != root / "previews" or not src.exists():
            return False
        with Image.open(src) as img:
            img.convert("RGB").save(root / "previews" / f"{entry_id}.png", "PNG", pnginfo=pnginfo)
        entry["preview"] = f"previews/{entry_id}.png"
        try:
            src.unlink()
        except Exception:
            pass
        return True
    except Exception as e:
        print(f"[PromptLibrary] preview upgrade failed: {e}", flush=True)
        return False


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _preview_path(entry_id):
    """Файл превью по id — напрямую, без чтения базы (записи для отдачи
    байтов не нужны). id уже санитизирован (alnum) — traversal невозможен.
    Порядок: png (новый формат) → jpg (legacy)."""
    root = _ensure_dirs()
    for ext in (".png", ".jpg"):
        f = root / "previews" / f"{entry_id}{ext}"
        if f.exists():
            return f
    return None


def _snapshot_workflow(extra_pnginfo, cap=2_000_000):
    """Снапшот воркфлоу для записи: deep-copy + проверка сериализуемости + кап.
    Возвращает dict или None (нет данных / слишком большой / ошибка)."""
    try:
        wf = (extra_pnginfo or {}).get("workflow")
        if not isinstance(wf, dict) or not isinstance(wf.get("nodes"), list):
            return None
        # Компактная форма (без пробелов): workflow дублируется в запись и в PNG,
        # экономим ~10-20% на каждой копии. Данные идентичны, ComfyUI пробелы не нужны.
        dump = json.dumps(wf, ensure_ascii=False, separators=(",", ":"))
        if len(dump) > cap:
            print(f"[PromptLibrary] workflow too large ({len(dump)}), skipped", flush=True)
            return None
        return json.loads(dump)
    except Exception as e:
        print(f"[PromptLibrary] workflow snapshot failed: {e}", flush=True)
        return None


def _add_entry(entries, prompt, folder, preview=None, title="", workflow=None):
    h = _dedup_hash(prompt, folder)
    for e in entries:
        if e.get("hash") == h:
            return e.get("id"), False
    entry_id = _new_id(h)
    entries.insert(0, {
        "id": entry_id,
        "hash": h,
        "title": title.strip() or _auto_title(prompt),
        "prompt": prompt,
        "folder": folder,
        "category": folder,  # legacy-дубль для совместимости
        "favorite": False,
        "created_at": _now(),
        "last_used": None,  # дата последней выдачи (как в библиотеке)
        "preview": preview,  # уже относительный путь 'previews/{id}.png' или None
        "workflow": workflow,  # снапшот воркфлоу (открытие с канваса); None = нет
    })
    return entry_id, True


class PromptLibrary:
    DESCRIPTION = "Библиотека промптов: категории, имена, автосохранение с превью, поиск и выдача."

    MODE_WRITE = "📥 Запись"
    MODE_ISSUE = "📤 Выдача"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": ([cls.MODE_WRITE, cls.MODE_ISSUE], {"default": cls.MODE_WRITE}),
                "selected": ("STRING", {"multiline": False, "default": ""}),
                "save_folder": ("STRING", {"multiline": False, "default": ""}),
            },
            "optional": {
                "source": ("*", {}),
                # Двухцветный сокет: синий IMAGE-тензор или зелёный VIDEO-объект
                # ядра (VideoInput). Мульти-тип через запятую — штатный механизм
                # ComfyUI (как FLOAT,INT): фронт рисует сокет двумя цветами.
                "image": ("IMAGE,VIDEO", {}),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt_out",)
    FUNCTION = "execute"
    CATEGORY = "My_custom_nodes/Prompts"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs):
        # Вход source — ANY (*): принимаем любой тип без проверки
        return True

    def execute(self, mode="", selected="", save_folder="", source=None, image=None,
                extra_pnginfo=None, unique_id=None, **kwargs):
        # Папка сохранения = выбранная в дереве (скрытый save_folder, пишет JS).
        # Совместимость: старые workflow несли folder/category виджетом
        folder = save_folder or kwargs.get("folder", "") or kwargs.get("category", "")
        # Служебные ключи дерева (__all/__fav/__root) — не папки: виджет несёт их
        # для round-trip выбора, но записи сохраняем в корень
        if str(folder).startswith("__"):
            folder = ""
        if not mode:
            if kwargs.get("use_selected"):
                mode = self.MODE_ISSUE
            else:
                mode = self.MODE_WRITE
        issue = (mode == self.MODE_ISSUE)
        entries, folders = _load_db()

        # Входящий текст: провод source.
        # Защита: source — ANY-тип, нужно фильтровать не-строки (IMAGE, LATENT и т.д.).
        incoming = ""
        if source is not None and isinstance(source, str) and source.strip():
            incoming = source.strip()
        display = incoming

        # 1. Исходящий текст (выдача книги с полки — фиксируем дату)
        out_text = incoming
        sel = (selected or "").strip()
        dirty = False
        if issue and sel:
            for e in entries:
                if e.get("id") == sel:
                    out_text = e.get("prompt", "")
                    e["last_used"] = _now()
                    dirty = True
                    break

        # 2. Автосохранение входящего промпта в папку из виджета (только в режиме записи)
        # Снапшот воркфлоу — в запись и в PNG-превью (как SaveImage): карточка
        # самодостаточна, drag на канвас открывает воркфлоу
        wf_copy = _snapshot_workflow(extra_pnginfo)
        fld = _norm_folder(folder)
        if not issue and incoming:
            entry_id, added = _add_entry(entries, incoming, fld, workflow=wf_copy)
            if added:
                frame = _extract_frame(image) if image is not None else None
                preview = _save_thumbnail(frame, entry_id, wf_copy) if frame is not None else None
                if preview:
                    for e in entries:
                        if e.get("id") == entry_id:
                            e["preview"] = preview
                            break
                dirty = True  # новая запись — сохраняем всегда
            elif wf_copy:
                # Backfill: у старых записей (и ручных) workflow не было —
                # прикрепляем при первом же прогоне того же промпта
                for e in entries:
                    if e.get("id") == entry_id and not e.get("workflow"):
                        e["workflow"] = wf_copy
                        _upgrade_preview_to_png(e, wf_copy)
                        dirty = True
                        break
            if fld and fld not in folders:
                folders.append(fld)
                folders = sorted(set(folders) | set(_parent_folders(fld)))
                dirty = True
            entries = entries[:MAX_ENTRIES]
        if dirty:
            try:
                _save_db(entries, folders)
            except Exception as e:
                print(f"[PromptLibrary] save failed: {e}", flush=True)

        # 3. PNG-персистентность выбора и настроек (паттерн Prompt Keeper)
        if extra_pnginfo and unique_id is not None:
            try:
                workflow = extra_pnginfo.get("workflow")
                if workflow and "nodes" in workflow:
                    for node_data in workflow["nodes"]:
                        if str(node_data.get("id")) == str(unique_id):
                            # Порядок = порядок INPUT_TYPES required:
                            # mode, selected, save_folder (prompt-виджет удалён в v1.7)
                            node_data["widgets_values"] = [mode, selected, save_folder]
                            break
            except Exception:
                pass

        # 4. Лёгкий UI-пакет (без полных текстов — только заголовки, полный текст по клику)
        ui_entries = [
            {
                "id": e.get("id", ""),
                "title": e.get("title", ""),
                "head": (e.get("prompt", "")[:120]),
                "folder": e.get("folder", ""),
                "favorite": bool(e.get("favorite", False)),
                "created_at": e.get("created_at", ""),
                "last_used": e.get("last_used"),
                "has_preview": bool(e.get("preview")),
                "has_workflow": bool(e.get("workflow")),
            }
            for e in entries[:200]
        ]
        return {"ui": {"entries": ui_entries, "folders": folders, "selected": sel, "text": [display]},
                "result": (out_text,)}


# --- HTTP-endpoints для JS ---------------------------------------------------

try:
    from server import PromptServer  # type: ignore
    from aiohttp import web  # type: ignore

    routes = PromptServer.instance.routes

    def _strip_entry(e):
        """Лёгкая проекция для списка: без workflow (тяжёлый), но с флагами."""
        c = {k: v for k, v in e.items() if k != "workflow"}
        c["has_workflow"] = bool(e.get("workflow"))
        return c

    @routes.get("/prompt_library/list")
    async def _pl_list(request):
        entries, folders = _load_db()
        return web.json_response({"entries": [_strip_entry(e) for e in entries[:MAX_ENTRIES]],
                                  "folders": folders})

    @routes.get("/prompt_library/entry")
    async def _pl_entry(request):
        entry_id = request.query.get("id", "")
        entries, _ = _load_db()
        for e in entries:
            if e.get("id") == entry_id:
                return web.json_response(e)
        return web.json_response({"error": "not found"}, status=404)

    @routes.get("/prompt_library/preview")
    async def _pl_preview(request):
        entry_id = re.sub(r"[^a-zA-Z0-9]", "", request.query.get("id", ""))
        f = _preview_path(entry_id)
        if f is None:
            return web.Response(status=404)
        # FileResponse отдаёт Last-Modified → повторные запросы закрываются
        # дешёвым 304 (см. стабильный t= в JS)
        return web.FileResponse(str(f))

    @routes.post("/prompt_library/add")
    async def _pl_add(request):
        """Ручное сохранение из виджетов (кнопка «Сохранить») — без запуска Queue."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        prompt = str(body.get("prompt", "")).strip()
        if not prompt:
            return web.json_response({"error": "empty prompt"}, status=400)
        folder = _norm_folder(body.get("folder", body.get("category", "")))
        title = str(body.get("title", "")).strip()
        entries, folders = _load_db()
        entry_id, created = _add_entry(entries, prompt, folder, title=title)
        if created:
            entries = entries[:MAX_ENTRIES]
            if folder and folder not in folders:
                folders = sorted(set(folders) | {folder} | set(_parent_folders(folder)))
            _save_db(entries, folders)
        return web.json_response({"ok": True, "id": entry_id})

    @routes.post("/prompt_library/favorite")
    async def _pl_favorite(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        entry_id = body.get("id", "")
        entries, folders = _load_db()
        found = False
        for e in entries:
            if e.get("id") == entry_id:
                found = True
                e["favorite"] = bool(body.get("favorite", not e.get("favorite", False)))
                break
        if found:
            _save_db(entries, folders)
        return web.json_response({"ok": True})

    @routes.post("/prompt_library/update")
    async def _pl_update(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        entry_id = body.get("id", "")
        entries, folders = _load_db()
        found = False
        for e in entries:
            if e.get("id") == entry_id:
                found = True
                if "prompt" in body and str(body["prompt"]).strip():
                    e["prompt"] = str(body["prompt"])
                if "title" in body:
                    e["title"] = str(body["title"]).strip() or _auto_title(e["prompt"])
                if "folder" in body or "category" in body:
                    e["folder"] = _norm_folder(body.get("folder", body.get("category", "")))
                    e["category"] = e["folder"]
                e["hash"] = _dedup_hash(e["prompt"], e.get("folder", ""))
                if e["folder"]:
                    folders = sorted(set(folders) | {e["folder"]} | set(_parent_folders(e["folder"])))
                break
        if found:
            _save_db(entries, folders)
        return web.json_response({"ok": True})

    @routes.post("/prompt_library/delete")
    async def _pl_delete(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        entry_id = body.get("id", "")
        entries, folders = _load_db()
        victim = None
        for e in entries:
            if e.get("id") == entry_id:
                victim = e.get("preview")
                break
        new_entries = [e for e in entries if e.get("id") != entry_id]
        if len(new_entries) < len(entries):
            _save_db(new_entries, folders)
            try:
                root = _ensure_dirs()
                cand = root / (victim or "")
                # guard: удаляем только файл прямо в previews/
                if (victim and cand.parent == root / "previews"
                        and cand.suffix.lower() in (".jpg", ".jpeg", ".png")):
                    cand.unlink(missing_ok=True)
            except Exception:
                pass
        return web.json_response({"ok": True})

    @routes.post("/prompt_library/folder_create")
    async def _pl_folder_create(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        parent = _norm_folder(body.get("parent", ""))
        name = str(body.get("name", "")).strip().replace("/", " ").replace("\\", " ")
        if not name:
            return web.json_response({"error": "empty name"}, status=400)
        path = f"{parent}/{name}" if parent else name
        entries, folders = _load_db()
        folders = sorted(set(folders) | {path} | set(_parent_folders(path)))
        _save_db(entries, folders)
        return web.json_response({"ok": True, "path": path})

    @routes.post("/prompt_library/folder_rename")
    async def _pl_folder_rename(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        old = _norm_folder(body.get("old", ""))
        new = _norm_folder(body.get("new", ""))
        if not old or not new or old == new:
            return web.json_response({"error": "bad rename"}, status=400)
        if new == old or new.startswith(old + "/"):
            return web.json_response({"error": "cannot move into itself"}, status=400)
        entries, folders = _load_db()
        new_folders = set()
        for f in folders:
            if f == old or f.startswith(old + "/"):
                new_folders.add(new + f[len(old):])
            else:
                new_folders.add(f)
        new_folders.add(new)
        new_folders.update(_parent_folders(new))
        for e in entries:
            ef = e.get("folder", "")
            if ef == old or ef.startswith(old + "/"):
                e["folder"] = new + ef[len(old):]
                e["category"] = e["folder"]
                e["hash"] = _dedup_hash(e["prompt"], e["folder"])
        _save_db(entries, sorted(new_folders))
        return web.json_response({"ok": True, "path": new})

    @routes.post("/prompt_library/folder_delete")
    async def _pl_folder_delete(request):
        """Удаление папки: записи из неё и подпапок переносятся в корень (не теряются)."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        path = _norm_folder(body.get("path", ""))
        if not path:
            return web.json_response({"error": "empty path"}, status=400)
        entries, folders = _load_db()
        folders = [f for f in folders if not (f == path or f.startswith(path + "/"))]
        for e in entries:
            ef = e.get("folder", "")
            if ef == path or ef.startswith(path + "/"):
                e["folder"] = ""
                e["category"] = ""
                e["hash"] = _dedup_hash(e["prompt"], "")
        _save_db(entries, folders)
        return web.json_response({"ok": True})

except Exception as e:
    print(f"[PromptLibrary] routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {
    "PromptLibrary": PromptLibrary,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptLibrary": "Prompt Library",
}
