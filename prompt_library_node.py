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
    entries = data.get("entries", []) or []
    folders = data.get("folders", []) or []

    changed = False
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


def _save_thumbnail(image, entry_id):
    """Сохранить первый кадр IMAGE-тензора как JPEG-превью. Возвращает имя или None."""
    try:
        from PIL import Image
    except Exception:
        return None
    try:
        arr = image[0].detach().cpu().numpy() if hasattr(image, "detach") else image[0]
        import numpy as np
        arr = (np.asarray(arr) * 255).clip(0, 255).astype("uint8")
        img = Image.fromarray(arr)
        # Запас под крупный показ: исходник 512px, даунскейл только в браузере
        img.thumbnail((512, 512), Image.LANCZOS)
        root = _ensure_dirs()
        name = f"{entry_id}.jpg"
        img.convert("RGB").save(root / "previews" / name, "JPEG", quality=90)
        return name
    except Exception as e:
        print(f"[PromptLibrary] thumbnail failed: {e}", flush=True)
        return None


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _add_entry(entries, prompt, folder, preview=None, title=""):
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
        "preview": f"previews/{preview}" if preview else None,
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
                "image": ("IMAGE", {}),
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
        fld = _norm_folder(folder)
        if not issue and incoming:
            entry_id, added = _add_entry(entries, incoming, fld)
            if added:
                preview = _save_thumbnail(image, entry_id) if image is not None else None
                if preview:
                    for e in entries:
                        if e.get("id") == entry_id:
                            e["preview"] = f"previews/{preview}"
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

    @routes.get("/prompt_library/list")
    async def _pl_list(request):
        entries, folders = _load_db()
        return web.json_response({"entries": entries[:MAX_ENTRIES], "folders": folders})

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
        root = _ensure_dirs()
        f = root / "previews" / f"{entry_id}.jpg"
        if not f.exists():
            return web.Response(status=404)
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
        new_entries = [e for e in entries if e.get("id") != entry_id]
        if len(new_entries) < len(entries):
            _save_db(new_entries, folders)
            try:
                (_ensure_dirs() / "previews" / f"{re.sub(r'[^a-zA-Z0-9]', '', entry_id)}.jpg").unlink(missing_ok=True)
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
