"""Prompt Library — универсальная нода-библиотека промптов.

Проводник: папки/подпапки (путь "Фото/Портреты"), имена записей, превью.
Хранение: ComfyUI/user/prompt_library/library.json + previews/.
Режимы execute (v1.24 — одна нода на оба дела):
  📥 Запись             — только сохранение, выход пуст (совместимость: если
                          prompt_out уже подключён проводом, текст идёт сквозь)
  📤 Выдача             — только выдача текста выбранной записи
  📤📥 Выдача + запись  — выдаёт и сохраняет
Обложка сохранённой записи подтягивается ПОСЛЕ прогона (файл из output/temp
по событию `executed`), поэтому IMAGE-провод не нужен и кольцо в графе
невозможно. См. SPECIFICATION.md.
"""

import datetime
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path

MAX_ENTRIES = 500

# Замок на цикл «прочитать library.json -> изменить -> записать» (SPEC §25.3.2).
# Мутации приходят из двух мест: HTTP-роуты (поток event loop) и execute()
# (поток исполнения ComfyUI). Без замка два одновременных цикла теряют чужое
# изменение: сам файл цел (запись атомарна, os.replace), но новая запись или
# удаление пропадает молча. RLock — вложенные захваты (execute -> _load_db)
# не блокируют сами себя.
_DB_LOCK = threading.RLock()

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


def _sanitize_folder_path(path):
    """Санитизирует путь папки для вывода по проводу.
    Заменяет пробелы и нечитаемые символы на '_', исключает служебные ветки.
    Всегда заканчивается на '/' если не пустой.
    Пример: 'Пейзажи/Аляска' → 'Пейзажи/Аляска/', 'Мои Пейзажи' → 'Мои_Пейзажи/'
    """
    if not path or not isinstance(path, str):
        return ""
    parts = path.strip().replace("\\", "/").split("/")
    if any(p.startswith("__") for p in parts if p):
        return ""
    cleaned = []
    for part in parts:
        if not part.strip():
            continue
        s = part.strip()
        s = "".join(c if (c.isalnum() or c in "-_" or ord(c) > 127) else "_" for c in s)
        s = re.sub(r"_+", "_", s)
        s = s.strip("_")
        if s:
            cleaned.append(s)
    result = "/".join(cleaned)
    return result + "/" if result else ""


def _storage_folder(path):
    """Папка для ЗАПИСИ: нормализация + служебные ветки дерева
    (__all/__fav/__root) → корень. Один путь для execute() и роутов,
    иначе " __fav " проходил бы мимо проверки префикса."""
    fld = _norm_folder(path)
    return "" if fld.startswith("__") else fld


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
            e["title"] = _auto_title(e.get("prompt", "") if isinstance(e.get("prompt"), str) else "")
            changed = True
        # prompt обязан быть строкой: иначе `e["prompt"][:120]` в execute уронит
        # генерацию до ручной правки файла. Чиним здесь же, hash пересчитываем.
        if not isinstance(e.get("prompt"), str):
            e["prompt"] = str(e.get("prompt", ""))
            e["hash"] = _dedup_hash(e["prompt"], e.get("folder", ""))
            changed = True
        # Старые записи без media — неизвестно (None). setdefault без changed:
        # отсутствие поля и так трактуется как None, файл не переписываем зря.
        e.setdefault("media", None)
        # То же для закрепа (v1.30): старых записей с pinned нет, отсутствие = False.
        e.setdefault("pinned", False)
        # Счётчик использований (v1.35): старым записям = 0.
        e.setdefault("use_count", 0)

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


def _load_pinned_folders():
    root = _ensure_dirs()
    lib = root / "library.json"
    if not lib.exists():
        return []
    try:
        data = json.loads(lib.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(data, dict) and isinstance(data.get("pinned_folders"), list):
        return [f for f in data["pinned_folders"] if isinstance(f, str) and f]
    return []


def _save_pinned_folders(pinned):
    root = _ensure_dirs()
    lib = root / "library.json"
    if not lib.exists():
        return
    try:
        data = json.loads(lib.read_text(encoding="utf-8"))
    except Exception:
        return
    if isinstance(data, dict):
        data["pinned_folders"] = sorted(set(pinned))
        tmp = root / "library.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, lib)


def _save_db(entries, folders):
    root = _ensure_dirs()
    lib = root / "library.json"
    tmp = root / "library.json.tmp"
    pinned = _load_pinned_folders()
    tmp.write_text(json.dumps({"entries": entries, "folders": sorted(set(folders)),
                                 "pinned_folders": pinned},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, lib)


def _dedup_hash(prompt, folder):
    return hashlib.md5(f"{prompt}\n{folder}".encode("utf-8")).hexdigest()


def _find_text_match(entries, prompt):
    """Тот же текст уже есть в базе (в любой папке)? Возвращает запись или None.
    Сравнение по stripped-тексту: входящий уже обрезан, записи хранятся обрезанными."""
    for e in entries:
        if isinstance(e.get("prompt"), str) and e.get("prompt").strip() == prompt:
            return e
    return None


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


def _save_preview_upload(data_url, entry_id, workflow=None):
    """Превью из ручной загрузки (PNG/JPEG dataURL или голый base64).
    Сохраняет даунскейл 512px в previews/{id}.png. Возвращает относительный
    путь или None (битый файл — запись создаётся и без превью).

    Кадр видео сюда тоже приходит — но уже картинкой: браузер достаёт первый
    кадр через <video>+canvas (файл с диска серверу не виден). Воркфлоу
    встраиваем, если он есть: карточка должна остаться самодостаточной (§24)."""
    try:
        from PIL import Image
    except Exception:
        return None
    try:
        import base64
        import io
        s = str(data_url or "")
        if s.startswith("data:") and "," in s:
            s = s.split(",", 1)[1]
        raw = base64.b64decode(s[:8_000_000], validate=True)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((512, 512), Image.LANCZOS)
        root = _ensure_dirs()
        pnginfo = _workflow_pnginfo(workflow) if workflow else None
        kw = {"pnginfo": pnginfo} if pnginfo is not None else {}
        img.save(root / "previews" / f"{entry_id}.png", "PNG", **kw)
        return f"previews/{entry_id}.png"
    except Exception as e:
        print(f"[PromptLibrary] upload preview failed: {e}", flush=True)
        return None


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


def _media_of(source):
    """Источник превью: 'video' (VIDEO-объект ядра с get_components),
    'image' (IMAGE-тензор/массив) или None (провода нет)."""
    if source is None:
        return None
    get_comp = getattr(source, "get_components", None)
    return "video" if callable(get_comp) else "image"


def _output_linked(extra_pnginfo, unique_id):
    """Есть ли провод из prompt_out этой ноды (по сериализованному графу).

    Нужно для совместимости: до v1.24 режим «Запись» был сквозным — ноду
    ставили в разрыв перед CLIP и архивировали каждый прогон. Теперь «Запись»
    молчит, но если провод уже есть — ведём себя как раньше (и говорим об этом).
    Читаем только workflow JSON из extra_pnginfo, живые ссылки LiteGraph не трогаем.
    """
    try:
        wf = (extra_pnginfo or {}).get("workflow") or {}
        for nd in wf.get("nodes", []) or []:
            if str(nd.get("id")) != str(unique_id):
                continue
            outs = nd.get("outputs") or []
            if not outs:
                return False
            first = outs[0] or {}
            links = first.get("links")
            if isinstance(links, (list, tuple)):
                return len(links) > 0
            return first.get("link") is not None
    except Exception:
        pass
    return False


def _load_image_file(path):
    """Прочитать картинку с диска в RGB-массив (обложка из прогона).

    Отдельная функция, чтобы песочница без PIL/numpy могла подменить декодер
    и проверять логику роута отдельно от декодирования.
    """
    from PIL import Image
    import numpy as np
    with Image.open(str(path)) as im:
        return np.asarray(im.convert("RGB"))


# Расширения, которые PIL не откроет: кадр достаёт PyAV (та же зависимость, что
# у SaveVideo). Анимированные GIF/WEBP остаются картинками — PIL берёт первый кадр.
_VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".wmv", ".mpg", ".mpeg", ".flv"}


def _is_video_file(path):
    """По имени файла понятно, что это видео (обложку берём первым кадром)."""
    try:
        return os.path.splitext(str(path))[1].lower() in _VIDEO_EXT
    except Exception:
        return False


def _load_video_frame(path):
    """Первый кадр видеофайла как RGB-массив (или None).

    PyAV — штатная зависимость ComfyUI (им же пользуются SaveVideo/VideoInput),
    поэтому новых пакетов не тянем; декодируем ЛЕНИВО: нужен только кадр [0].
    """
    try:
        import av  # type: ignore
    except Exception as exc:
        print(f"[PromptLibrary] video frame: PyAV недоступен ({exc})", flush=True)
        return None
    try:
        import numpy as np
        with av.open(str(path)) as container:
            for frame in container.decode(video=0):
                return np.asarray(frame.to_ndarray(format="rgb24"))
    except Exception as exc:
        print(f"[PromptLibrary] video frame failed: {exc}", flush=True)
    return None


def _load_media_frame(path):
    """Кадр для обложки из файла прогона: картинка (PIL) или первый кадр видео (PyAV).

    Порядок именно такой: PIL первым — в песочнице тестов он подменяется, поэтому
    логика роута проверяется без реального декодирования.
    """
    try:
        return _load_image_file(path)
    except Exception:
        arr = _load_video_frame(path)
        if arr is None:
            raise
        return arr


def _resolve_output_file(filename, subfolder, kind):
    """Найти файл прогона в output/input/temp, не выходя за пределы папки.

    JS присылает `{filename, subfolder, type}` из события `executed` — ровно то,
    что сервер отдаёт для SaveImage/PreviewImage. Защита от traversal: имя +
    подпапка склеиваются, приводятся к realpath и проверяются на вложенность
    в базовую директорию типа.
    """
    try:
        import folder_paths  # type: ignore
        base = folder_paths.get_directory_by_type(kind or "output")
        if not base:
            base = folder_paths.get_output_directory()
    except Exception:
        return None
    try:
        base = os.path.realpath(str(base))
        cand = os.path.realpath(os.path.join(base, subfolder or "", filename))
        if os.path.commonpath([base, cand]) != base:
            return None
        if not os.path.isfile(cand):
            return None
        return Path(cand)
    except Exception:
        return None


def _broadcast_refresh():
    """Broadcast 'prompt_library/refresh' to all connected WebSocket
    clients so their Library nodes auto-reload the list. Вызывается и из
    execute() (новая запись), и из мутирующих роутов (/add, /favorite,
    /update, /delete*, /folder_*) — иначе соседние Library-ноды молчат."""
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("prompt_library/refresh", {})
    except Exception:
        pass


# --- Подхват финального текста (v1.25) ---------------------------------------
# Нода-«выдача» отдаёт карточку в LLM-цепочку, а её результат в библиотеку
# приходит НЕ проводом: провод «финальный текст → сюда» вместе с выходом в ту же
# цепочку замыкает граф в кольцо, а ComfyUI исполняет только ацикличный граф
# (именно поэтому раньше требовались две ноды). Вместо провода текст забирает JS
# после прогона и присылает его на /prompt_library/save_pickup вместе с токеном.
# В токене лежат снапшот воркфлоу и папка: в момент прихода текста взять их
# неоткуда — execute() этой ноды давно отработал.
_PICKUP = {}
_PICKUP_LIMIT = 20


def _pickup_stash(node, folder, workflow):
    """Отложить снапшот воркфлоу и папку под токеном подхвата.
    Возвращает токен (он уходит клиенту в ui.pickup)."""
    token = _new_id("pickup", str(node))
    _PICKUP[token] = {"node": str(node), "folder": folder or "", "workflow": workflow}
    # Без таймеров: чистим по количеству (прогон мог упасть — токен не забрали)
    while len(_PICKUP) > _PICKUP_LIMIT:
        _PICKUP.pop(next(iter(_PICKUP)), None)
    return token


def _add_entry(entries, prompt, folder, preview=None, title="", workflow=None, media=None):
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
            "pinned": False,  # закреп вверху папки (v1.30, §36)
            "created_at": _now(),
            "last_used": None,  # дата последней выдачи (как в библиотеке)
            "use_count": 0,  # счётчик выдач (для сортировки «Частые»)
            "preview": preview,  # уже относительный путь 'previews/{id}.png' или None
            "workflow": workflow,  # снапшот воркфлоу (открытие с канваса); None = нет
            "media": media,  # 'video' / 'image' / None (старые записи — None = неизвестно)
        })
    return entry_id, True


class PromptLibrary:
    DESCRIPTION = "Библиотека промптов: категории, имена, автосохранение с превью, поиск и выдача."

    MODE_WRITE = "📥 Запись"
    MODE_ISSUE = "📤 Выдача"
    # v1.24: третий режим — выдать и сохранить в один прогон (раньше это
    # требовало двух нод из-за кольца IMAGE-провода).
    MODE_BOTH = "📤📥 Выдача + запись"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": ([cls.MODE_WRITE, cls.MODE_ISSUE, cls.MODE_BOTH], {"default": cls.MODE_WRITE}),
                "selected": ("STRING", {"multiline": False, "default": ""}),
                "save_folder": ("STRING", {"multiline": False, "default": ""}),
                # id узла, из которого брать текст для сохранения после прогона
                # (подхват, v1.25). Виджет скрыт: значение пишет DOM-селектор.
                "pickup": ("STRING", {"multiline": False, "default": ""}),
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

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt_out", "category_out")
    FUNCTION = "execute"
    CATEGORY = "My_custom_nodes/Prompts"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None, **kwargs):
        # Вход source — ANY (*): принимаем любой тип без проверки
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """Подхват требует, чтобы нода исполнялась в КАЖДОМ прогоне (SPEC §33).

        Токен подхвата выдаётся только из `execute()`, а у ноды с подхватом нет
        проводов: ComfyUI кэширует ноду по значениям её входов, и после первого
        же прогона с тем же набором (mode/selected/save_folder/pickup) `execute()`
        больше не вызывается. Токена нет → клиенту нечего вернуть вместе с текстом
        узла-источника → запись молча не создаётся. Живая эксплуатация выглядит
        как «то добавляет, то не добавляет»: сохранение работает только в прогоне
        сразу после смены любого виджета ноды либо холодного старта ComfyUI.

        `float("nan")` не равен сам себе — ComfyUI считает ноду изменившейся и
        исполняет её каждый Queue (штатный механизм IS_CHANGED). Без подхвата
        возвращаем None — нода кэшируется как обычно.
        """
        val = kwargs.get("pickup")
        if isinstance(val, (list, tuple)):
            # Страховка: до разворачивания ComfyUI держит виджетные входы
            # 1-элементными списками (map-over-list); если форма когда-нибудь
            # доедет сюда списком, решение не должно поменяться.
            val = val[0] if len(val) else ""
        if str(val or "").strip():
            return float("nan")
        return None

    def execute(self, mode="", selected="", save_folder="", pickup="", source=None, image=None,
                extra_pnginfo=None, unique_id=None, **kwargs):
        # Весь прогон узла держит общий с HTTP-роутами замок (§25.3.2): execute()
        # исполняется в потоке ComfyUI, а роуты — в event loop; без замка их циклы
        # «load -> mutate -> save» могли наложиться и потерять чужое изменение
        # (например, только что созданную вручную запись или удаление).
        with _DB_LOCK:
            return self._execute(mode, selected, save_folder, pickup, source, image,
                                 extra_pnginfo, unique_id, **kwargs)

    def _execute(self, mode="", selected="", save_folder="", pickup="", source=None, image=None,
                 extra_pnginfo=None, unique_id=None, **kwargs):
        # Папка сохранения = выбранная в дереве (скрытый save_folder, пишет JS).
        # Совместимость: старые workflow несли folder/category виджетом
        folder = save_folder or kwargs.get("folder", "") or kwargs.get("category", "")
        # Служебные ключи дерева (__all/__fav/__root) — не папки: виджет несёт их
        # для round-trip выбора, но записи сохраняем в корень (_storage_folder)
        if not mode:
            if kwargs.get("use_selected"):
                mode = self.MODE_ISSUE
            else:
                mode = self.MODE_WRITE
        # v1.24: три режима — «Запись» (только сохраняет), «Выдача» (только
        # выдаёт), «Выдача + запись» (и то и другое в одном прогоне).
        issue = (mode == self.MODE_ISSUE)
        both = (mode == self.MODE_BOTH)
        save_on = (mode == self.MODE_WRITE) or both
        # Совместимость: раньше «Запись» была сквозной (её ставили в разрыв
        # перед CLIP и архивировали каждый прогон) — если у выхода уже есть
        # провод, продолжаем пропускать текст сквозь и говорим об этом в UI.
        # Смотрим сериализованный граф, а не живые ссылки LiteGraph.
        out_linked = _output_linked(extra_pnginfo, unique_id)
        # Подхват (v1.25): сохраняем не входящий текст, а текст выбранного узла —
        # он появится только после прогона (см. _pickup_stash и §30). Пока подхват
        # включён, входящий текст не сохраняем: иначе на каждый Queue плодилась бы
        # запись из провода, которого для этого случая и не подключают.
        pickup_node = (pickup or "").strip()
        pickup_token = ""
        entries, folders = _load_db()

        # Входящий текст: провод source.
        # Защита: source — ANY-тип, нужно фильтровать не-строки (IMAGE, LATENT и т.д.).
        incoming = ""
        if source is not None and isinstance(source, str) and source.strip():
            incoming = source.strip()
        display = incoming

        # 1. Исходящий текст (выдача книги с полки — фиксируем дату)
        #  • Выдача / Выдача+запись — текст выбранной записи (иначе входящий);
        #  • Запись — пусто, чтобы нода-сейвер ничего не выдавала дальше
        #    (кроме случая провода на выходе, см. out_linked выше).
        out_text = incoming
        if mode == self.MODE_WRITE and not out_linked:
            out_text = ""
        sel = (selected or "").strip()
        dirty = False
        if (issue or both) and sel:
            for e in entries:
                if e.get("id") == sel:
                    out_text = e.get("prompt", "")
                    e["last_used"] = _now()
                    e["use_count"] = e.get("use_count", 0) + 1
                    dirty = True
                    break

        # 2. Автосохранение входящего промпта в папку из виджета
        #    (в режимах «Запись» и «Выдача + запись»)
        fld = _storage_folder(folder)
        need_broadcast = False
        skipped = None
        preview_target = ""  # запись, которой стоит прикрепить обложку из прогона
        if save_on and incoming and not pickup_node:
            # Снапшот воркфлоу — в запись и в PNG-превью (как SaveImage): карточка
            # самодостаточна, drag на канвас открывает воркфлоу. Считаем его только
            # здесь: в режиме выдачи и без входящего текста он не нужен — иначе
            # deep-copy целого графа делался на каждом Queue впустую.
            wf_copy = _snapshot_workflow(extra_pnginfo)
            # Глобальный дубликат: тот же текст уже есть в базе (хоть в другой папке) —
            # не плодим запись с другим превью, а предупреждаем где лежит.
            dup = _find_text_match(entries, incoming)
            media = _media_of(image)
            frame = _extract_frame(image) if image is not None else None
            if dup is not None:
                skipped = {"folder": dup.get("folder", ""), "id": dup.get("id", "")}
                print(f"[PromptLibrary] duplicate skipped (already in '{skipped['folder'] or 'root'}')", flush=True)
                entry_id, added = dup.get("id"), False
            else:
                entry_id, added = _add_entry(entries, incoming, fld, workflow=wf_copy, media=media)
            if added:
                need_broadcast = True
                preview = _save_thumbnail(frame, entry_id, wf_copy) if frame is not None else None
                if preview:
                    for e in entries:
                        if e.get("id") == entry_id:
                            e["preview"] = preview
                            break
                # Обложки нет (провода тоже нет) — подтянем картинку ЭТОГО
                # прогона после его окончания (JS -> attach_preview, §29).
                preview_target = entry_id
                dirty = True  # новая запись — сохраняем всегда
            else:
                # Backfill существующей записи (дубль по тексту или тот же hash):
                # у старых и ручных записей workflow/превью нет — прикрепляем при
                # первом же прогоне того же промпта. Только в пустое — не затираем.
                for e in entries:
                    if e.get("id") != entry_id:
                        continue
                    if not e.get("workflow") and wf_copy:
                        e["workflow"] = wf_copy
                        _upgrade_preview_to_png(e, wf_copy)
                        dirty = True
                    if not e.get("media") and media:
                        e["media"] = media
                        dirty = True
                    if not e.get("preview") and frame is not None:
                        prev = _save_thumbnail(frame, entry_id, wf_copy)
                        if prev:
                            e["preview"] = prev
                            dirty = True
                    if not e.get("preview"):
                        # Старая/ручная запись без обложки — возьмём картинку прогона
                        preview_target = entry_id
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
            if need_broadcast:
                _broadcast_refresh()

        # 2.1. Подхват: сохранять сейчас нечего — текст выбранного узла появится
        # только после прогона. Откладываем воркфлоу и папку под токен, клиент
        # вернёт токен вместе с текстом (роут /prompt_library/save_pickup).
        if pickup_node:
            pickup_token = _pickup_stash(pickup_node, fld, _snapshot_workflow(extra_pnginfo))

        # 3. PNG-персистентность выбора и настроек (паттерн Prompt Keeper)
        if extra_pnginfo and unique_id is not None:
            try:
                workflow = extra_pnginfo.get("workflow")
                if workflow and "nodes" in workflow:
                    for node_data in workflow["nodes"]:
                        if str(node_data.get("id")) == str(unique_id):
                            # Порядок = порядок INPUT_TYPES required:
                            # mode, selected, save_folder (prompt-виджет удалён в v1.7)
                            node_data["widgets_values"] = [mode, selected, save_folder, pickup]
                            break
            except Exception:
                pass

        # Подсказка о неочевидном поведении выхода (совместимость со старыми
        # графами, где «Запись» стояла в разрыв перед CLIP).
        notice = ""
        if mode == self.MODE_WRITE and out_linked:
            notice = ("Режим «Запись»: провод от выхода подключён — текст идёт сквозь, "
                      "как раньше. Отключите провод, чтобы нода только сохраняла.")
        elif pickup_node and incoming:
            # Иначе выглядит как молчаливая потеря: на входе текст есть, а записи
            # из него нет (подхват берёт текст из другого узла после прогона).
            notice = (f"Подхват включён: входящий текст не сохраняется — запись "
                      f"берётся из узла №{pickup_node} после прогона.")

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
                "use_count": e.get("use_count", 0),
                "has_preview": bool(e.get("preview")),
                "has_workflow": bool(e.get("workflow")),
                "media": e.get("media"),
            }
            for e in entries[:200]
        ]
        # ВАЖНО: все значения ui обязаны быть итерируемыми — ComfyUI
        # (get_output_from_returns) сливает их перебором; None здесь ронял
        # Queue с TypeError: 'NoneType' object is not iterable.
        # saved_id — запись, которой стоит прикрепить обложку из этого прогона
        # (JS ждёт `executed` с картинками и зовёт /attach_preview после успеха).
        # mode_notice — подсказка в нижней строке ноды.
        return {"ui": {"entries": ui_entries, "folders": folders, "selected": sel, "text": [display],
                        "skipped_duplicate": skipped or {},
                        "saved_id": [preview_target] if preview_target else [],
                        "pickup": [pickup_token] if pickup_token else [],
                        "pickup_node": [pickup_node] if pickup_token else [],
                        "mode_notice": [notice]},
                "result": (out_text, _sanitize_folder_path(folder))}


# --- HTTP-endpoints для JS ---------------------------------------------------

try:
    from server import PromptServer  # type: ignore
    from aiohttp import web  # type: ignore

    routes = PromptServer.instance.routes

    async def _req_body(request):
        """Тело POST-запроса как dict; мусор (не-JSON, не-словарь) → {}."""
        try:
            body = await request.json()
        except Exception:
            return {}
        return body if isinstance(body, dict) else {}

    def _strip_entry(e):
        """Лёгкая проекция для списка: без workflow (тяжёлый), но с флагами."""
        c = {k: v for k, v in e.items() if k != "workflow"}
        c["has_workflow"] = bool(e.get("workflow"))
        return c

    def _locked(handler):
        """POST-роут под _DB_LOCK: тело читаем ДО замка, дальше — только sync-код.

        Тело запроса читается в начале (это может тянуть сокет), а в замке
        остаётся исключительно работа с library.json. Внутри хендлеров нет
        `await`, поэтому цикл «load -> mutate -> save» не может быть прерван
        ни другим роутом (event loop однопоточный), ни потоком исполнения
        ComfyUI (общий _DB_LOCK).
        """
        async def _wrapped(request, body=None, *args, **kwargs):
            if body is None:
                body = await _req_body(request)
            with _DB_LOCK:
                return await handler(request, body)
        _wrapped.__name__ = getattr(handler, "__name__", "_wrapped")
        return _wrapped

    def _locked_get(handler):
        """GET-роут под тем же замком: `_load_db()` умеет ПИСАТЬ (миграции
        формата и починка битых записей), поэтому чтение тоже сериализуем."""
        async def _wrapped(request, *args, **kwargs):
            with _DB_LOCK:
                return await handler(request)
        _wrapped.__name__ = getattr(handler, "__name__", "_wrapped")
        return _wrapped

    @routes.post("/prompt_library/attach_preview")
    @_locked
    async def _pl_attach_preview(request, body=None):
        """Обложка записи: автоподхват из прогона (v1.24) ИЛИ замена кадром (v1.26).

        Провода IMAGE для этого не нужно: после Queue клиент присылает то, что
        сервер сам рассылает в событии `executed` — {filename, subfolder, type}
        созданного файла. Файл берём из output/temp, делаем 512px PNG и
        встраиваем workflow (он уже есть в записи). Видео (mp4/webm/…) — первый
        кадр через PyAV (v1.26): до этого такой прогон оставался без обложки,
        потому что PIL медиафайл не открывает.

        Второй источник — `preview_data` (PNG-dataURL от браузера): так приходит
        кадр видеофайла, выбранного на диске (сервер такого файла не видит),
        и замена обложки существующей записи. Уже готовое превью не перетираем
        без `force`.
        """
        entry_id = str(body.get("id") or "").strip()
        filename = str(body.get("filename") or "").strip()
        subfolder = str(body.get("subfolder") or "").strip()
        kind = str(body.get("type") or "output").strip() or "output"
        preview_data = str(body.get("preview_data") or "").strip()
        media_hint = str(body.get("media") or "").strip().lower()
        if media_hint not in ("image", "video"):
            media_hint = ""
        force = bool(body.get("force"))
        if not entry_id or not (filename or preview_data):
            return web.json_response(
                {"error": "id and filename or preview_data required"}, status=400)
        # id уходит прямо в имя файла превью (previews/{id}.png), поэтому проверяем
        # его ровно как /preview и _upgrade_preview_to_png: только буквы/цифры.
        # Легитимные id это всегда (hex из _new_id) и проходят; guard закрывает
        # правленый вручную library.json с id вида "../x".
        if not re.fullmatch(r"[a-zA-Z0-9]+", entry_id):
            return web.json_response({"error": "bad id"}, status=400)
        src = None
        if filename:
            src = _resolve_output_file(filename, subfolder, kind)
            if src is None:
                return web.json_response({"error": "file not found"}, status=404)
        entries, folders = _load_db()
        target = None
        for e in entries:
            if e.get("id") == entry_id:
                target = e
                break
        if target is None:
            # Запись могли удалить между Queue и завершением прогона — не ошибка.
            # Для ручной замены (force) этого не должно случаться — говорим прямо.
            if force:
                return web.json_response({"error": "entry not found"}, status=404)
            return web.json_response({"ok": True, "skipped": "no_entry"})
        if target.get("preview") and not force:
            return web.json_response({"ok": True, "skipped": "has_preview"})
        if preview_data:
            # Кадр, снятый браузером: первый кадр видео с диска или замена обложки
            media = media_hint or "image"
            prev = _save_preview_upload(preview_data, entry_id, target.get("workflow") or None)
            if not prev:
                return web.json_response({"error": "preview_data rejected"}, status=400)
        else:
            media = media_hint or ("video" if _is_video_file(src) else "image")
            try:
                arr = _load_media_frame(src)
            except Exception as exc:
                return web.json_response({"error": f"media read failed: {exc}"}, status=400)
            prev = _save_thumbnail(arr, entry_id, target.get("workflow") or None)
            if not prev:
                return web.json_response({"error": "thumbnail failed"}, status=500)
        target["preview"] = prev
        # Метка типа описывает ТЕКУЩУЮ обложку: заменили видео на картинку —
        # метка меняется, иначе фильтр «Видео» показывал бы не то.
        target["media"] = media
        try:
            _save_db(entries, folders)
        except Exception as exc:
            return web.json_response({"error": f"save failed: {exc}"}, status=500)
        _broadcast_refresh()
        return web.json_response({"ok": True, "preview": prev})

    @routes.post("/prompt_library/save_pickup")
    @_locked
    async def _pl_save_pickup(request, body=None):
        """Запись текста, подхваченного из другого узла после прогона (v1.25).

        Провод «финальный текст -> библиотека» замыкает граф в кольцо, если
        карточку в LLM-цепочку отдаёт эта же нода, поэтому текст приходит сюда
        уже после `execution_success` — вместе с токеном, под которым в execute()
        отложены снапшот воркфлоу и папка (в момент сохранения взять их неоткуда).
        Обложку клиент прикрепляет следом через attach_preview.
        """
        token = str(body.get("token") or "").strip()
        text = str(body.get("text") or "").strip()
        rec = _PICKUP.pop(token, None)
        if not token or rec is None:
            # Токена нет: прогон состоялся без execute() нашей ноды (кэш, mute,
            # interrupt) либо токен уже забрали — это не ошибка базы.
            # Печатаем в консоль ComfyUI: без этого «запись не создалась» не видно
            # вообще нигде, кроме F12 (§33). При кэше ComfyUI пере-рассылает старый
            # `ui` — токен приходит уже потраченным, отсюда эта ветка.
            print("[PromptLibrary] save_pickup: token unknown or already used "
                  "(node was cached? see SPEC section 33)", flush=True)
            return web.json_response({"error": "unknown token"}, status=400)
        if not text:
            return web.json_response({"ok": True, "skipped": "empty"})
        folder = _storage_folder(rec.get("folder", ""))
        entries, folders = _load_db()
        dup = _find_text_match(entries, text)
        if dup is not None:
            print(f"[PromptLibrary] duplicate skipped (already in '{dup.get('folder', '') or 'root'}')", flush=True)
            return web.json_response({"ok": True, "id": dup.get("id"), "duplicate": True,
                                      "folder": dup.get("folder", "")})
        # Воркфлоу из токена: запись самодостаточна, как у автосейва из execute()
        entry_id, created = _add_entry(entries, text, folder, workflow=rec.get("workflow"))
        if created:
            entries = entries[:MAX_ENTRIES]
            if folder and folder not in folders:
                folders = sorted(set(folders) | {folder} | set(_parent_folders(folder)))
            try:
                _save_db(entries, folders)
            except Exception as exc:
                return web.json_response({"error": f"save failed: {exc}"}, status=500)
            _broadcast_refresh()
        return web.json_response({"ok": True, "id": entry_id, "duplicate": False})

    @routes.get("/prompt_library/search")
    @_locked_get
    async def _pl_search(request):
        """Полнотекстовый поиск по базе (v1.27).

        `/list` отдаёт только `head` (первые 120 символов текста), поэтому слово
        из середины длинного промпта клиент сам найти не может (§8.1 обещает
        «поиск по названию и тексту»). Возвращаем ТОЛЬКО id совпавших записей:
        payload копеечный, а решение «показывать или нет» клиент принимает вместе
        со своим локальным фильтром (название / начало текста / папка).
        """
        q = str(request.query.get("q", "") or "").strip().lower()
        if not q:
            return web.json_response({"ids": []})
        entries, _ = _load_db()
        ids = [e.get("id", "") for e in entries
               if q in str(e.get("title", "")).lower()
               or q in str(e.get("prompt", "")).lower()
               or q in str(e.get("folder", "")).lower()]
        return web.json_response({"ids": ids})

    @routes.get("/prompt_library/list")
    @_locked_get
    async def _pl_list(request):
        entries, folders = _load_db()
        pinned_folders = _load_pinned_folders()
        return web.json_response({"entries": [_strip_entry(e) for e in entries[:MAX_ENTRIES]],
                                  "folders": folders,
                                  "pinned_folders": pinned_folders})

    @routes.get("/prompt_library/entry")
    @_locked_get
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
    @_locked
    async def _pl_add(request, body=None):
        """Ручное сохранение из виджетов (кнопка «Сохранить») — без запуска Queue."""
        prompt = str(body.get("prompt", "")).strip()
        if not prompt:
            return web.json_response({"error": "empty prompt"}, status=400)
        folder = _storage_folder(body.get("folder", body.get("category", "")))
        title = str(body.get("title", "")).strip()
        entries, folders = _load_db()
        dup = _find_text_match(entries, prompt)
        if dup is not None:
            print(f"[PromptLibrary] duplicate skipped (already in '{dup.get('folder', '') or 'root'}')", flush=True)
            return web.json_response({"ok": True, "id": dup.get("id"), "duplicate": True,
                                      "folder": dup.get("folder", "")})
        # Тип превью: браузер уже знает, картинку он выбрал или видео (снял кадр),
        # и передаёт метку — по ней работают 🎬/📷-бейдж и фильтр «Тип».
        media = str(body.get("media") or "").strip().lower()
        if media not in ("image", "video"):
            media = None
        entry_id, created = _add_entry(entries, prompt, folder, title=title, media=media)
        if created:
            # Превью с диска (без провода): прикрепляем как PNG 512px
            prev = _save_preview_upload(body.get("preview_data"), entry_id)
            if prev:
                for e in entries:
                    if e.get("id") == entry_id:
                        e["preview"] = prev
                        break
            entries = entries[:MAX_ENTRIES]
            if folder and folder not in folders:
                folders = sorted(set(folders) | {folder} | set(_parent_folders(folder)))
            _save_db(entries, folders)
            # Ручное сохранение (кнопка) рассылает тот же сигнал, что и Queue:
            # без него соседние Library-ноды и другие вкладки остаются со старым списком.
            _broadcast_refresh()
        return web.json_response({"ok": True, "id": entry_id, "duplicate": False})

    @routes.post("/prompt_library/favorite")
    @_locked
    async def _pl_favorite(request, body=None):
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
            _broadcast_refresh()
        return web.json_response({"ok": True})

    @routes.post("/prompt_library/favorite_many")
    @_locked
    async def _pl_favorite_many(request, body=None):
        """Массовая отметка записей как избранных (v1.36, §drag→★).
        Тело: { ids: [...] } или { folder_paths: [...] }"""
        ids = body.get("ids", None)
        folder_paths = body.get("folder_paths", None)
        want = set()
        if isinstance(ids, list):
            want.update(i for i in ids if isinstance(i, str) and i)
        entries, folders = _load_db()
        marked = 0
        if folder_paths and isinstance(folder_paths, list):
            fp_set = set(f for f in folder_paths if isinstance(f, str) and f)
            for e in entries:
                if e.get("folder") in fp_set and not e.get("favorite"):
                    e["favorite"] = True
                    marked += 1
        for e in entries:
            if e.get("id") in want and not e.get("favorite"):
                e["favorite"] = True
                marked += 1
        if marked:
            _save_db(entries, folders)
            _broadcast_refresh()
        return web.json_response({"ok": True, "marked": marked})

    @routes.post("/prompt_library/folder_pin")
    @_locked
    async def _pl_folder_pin(request, body=None):
        """Закреп/откреп папки в дереве проводника (v1.37)."""
        folder_path = _norm_folder(body.get("path", ""))
        pinned = body.get("pinned", None)
        if not folder_path or folder_path.startswith("__"):
            return web.json_response({"error": "path required"}, status=400)
        entries, folders = _load_db()
        if folder_path not in folders:
            return web.json_response({"error": "folder not found"}, status=404)
        pinned_folders = _load_pinned_folders()
        fp_set = set(pinned_folders)
        if pinned is None:
            pinned = folder_path not in fp_set
        if pinned:
            fp_set.add(folder_path)
        else:
            fp_set.discard(folder_path)
        _save_pinned_folders(fp_set)
        _broadcast_refresh()
        return web.json_response({"ok": True, "pinned": folder_path in fp_set})

    @routes.post("/prompt_library/pin")
    @_locked
    async def _pl_pin(request, body=None):
        """Закреп/откреп записи (v1.30, §36): закреплённые — вверху своей папки."""
        entry_id = body.get("id", "")
        entries, folders = _load_db()
        found = False
        for e in entries:
            if e.get("id") == entry_id:
                found = True
                e["pinned"] = bool(body.get("pinned", not e.get("pinned", False)))
                break
        if found:
            _save_db(entries, folders)
            _broadcast_refresh()
        return web.json_response({"ok": True})

    @routes.post("/prompt_library/update")
    @_locked
    async def _pl_update(request, body=None):
        entry_id = body.get("id", "")
        entries, folders = _load_db()
        found = False
        for e in entries:
            if e.get("id") == entry_id:
                found = True
                if "prompt" in body and str(body["prompt"]).strip():
                    e["prompt"] = str(body["prompt"]).strip()
                if "title" in body:
                    e["title"] = str(body["title"]).strip() or _auto_title(e["prompt"])
                if "folder" in body or "category" in body:
                    e["folder"] = _storage_folder(body.get("folder", body.get("category", "")))
                    e["category"] = e["folder"]
                e["hash"] = _dedup_hash(e["prompt"], e.get("folder", ""))
                if e["folder"]:
                    folders = sorted(set(folders) | {e["folder"]} | set(_parent_folders(e["folder"])))
                break
        if found:
            _save_db(entries, folders)
            _broadcast_refresh()
        return web.json_response({"ok": True})

    def _remove_preview_file(victim):
        try:
            root = _ensure_dirs()
            cand = root / (victim or "")
            # guard: удаляем только файл прямо в previews/
            if (victim and cand.parent == root / "previews"
                    and cand.suffix.lower() in (".jpg", ".jpeg", ".png")):
                cand.unlink(missing_ok=True)
        except Exception:
            pass

    @routes.post("/prompt_library/delete")
    @_locked
    async def _pl_delete(request, body=None):
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
            _remove_preview_file(victim)
            _broadcast_refresh()
        return web.json_response({"ok": True})

    @routes.post("/prompt_library/delete_many")
    @_locked
    async def _pl_delete_many(request, body=None):
        """Массовое удаление записей (мультивыделение Ctrl/Shift).
        Неизвестные id молча игнорируются. Файлы превью чистятся тем же guard'ом."""
        ids = body.get("ids", None)
        if not isinstance(ids, list):
            return web.json_response({"error": "ids must be a list"}, status=400)
        want = {i for i in ids if isinstance(i, str) and i}
        if not want:
            return web.json_response({"ok": True, "deleted": 0})
        entries, folders = _load_db()
        victims = [e.get("preview") for e in entries if e.get("id") in want]
        new_entries = [e for e in entries if e.get("id") not in want]
        deleted = len(entries) - len(new_entries)
        if deleted:
            _save_db(new_entries, folders)
            for v in victims:
                _remove_preview_file(v)
            _broadcast_refresh()
        return web.json_response({"ok": True, "deleted": deleted})

    @routes.post("/prompt_library/folder_create")
    @_locked
    async def _pl_folder_create(request, body=None):
        parent = _storage_folder(body.get("parent", ""))
        name = str(body.get("name", "")).strip().replace("/", " ").replace("\\", " ")
        if not name:
            return web.json_response({"error": "empty name"}, status=400)
        # Префикс "__" зарезервирован под служебные ветки дерева (__all/__fav/__root):
        # такая «папка» стала бы призраком — записи в неё не попадают (execute режет
        # их в корень), клик перехватывает служебная ветка, а из UI её не удалить.
        if name.startswith("__"):
            return web.json_response({"error": "reserved name"}, status=400)
        path = f"{parent}/{name}" if parent else name
        entries, folders = _load_db()
        folders = sorted(set(folders) | {path} | set(_parent_folders(path)))
        _save_db(entries, folders)
        _broadcast_refresh()
        return web.json_response({"ok": True, "path": path})

    @routes.post("/prompt_library/folder_rename")
    @_locked
    async def _pl_folder_rename(request, body=None):
        old = _norm_folder(body.get("old", ""))
        new = _norm_folder(body.get("new", ""))
        if not old or not new or old == new:
            return web.json_response({"error": "bad rename"}, status=400)
        if new.startswith("__"):
            return web.json_response({"error": "reserved name"}, status=400)
        if new.startswith(old + "/"):
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
        # Обновляем закреплённые папки: переименованная папка и подпапки
        _rename_pinned = lambda f: new + f[len(old):] if (f == old or f.startswith(old + "/")) else f
        _save_pinned_folders([_rename_pinned(f) for f in _load_pinned_folders()])
        _broadcast_refresh()
        return web.json_response({"ok": True, "path": new})

    @routes.post("/prompt_library/move_many")
    @_locked
    async def _pl_move_many(request, body=None):
        """Массовое перемещение записей и/или папок.
        Тело: { entry_ids: [...], folder: dest } или { folder_paths: [...], new_parent: dest }"""
        entry_ids = body.get("entry_ids", None)
        folder_dest = body.get("folder", None)
        folder_paths = body.get("folder_paths", None)
        new_parent = body.get("new_parent", None)

        entries, folders = _load_db()
        moved_entries = 0
        moved_folders = 0

        # Перемещение записей в папку
        if isinstance(entry_ids, list) and folder_dest is not None:
            folder_dest = _storage_folder(folder_dest)
            want = {i for i in entry_ids if isinstance(i, str) and i}
            for e in entries:
                if e.get("id") in want and e.get("folder", "") != folder_dest:
                    e["folder"] = folder_dest
                    e["category"] = e["folder"]
                    e["hash"] = _dedup_hash(e["prompt"], e["folder"])
                    moved_entries += 1
            if want:
                folders = sorted(set(folders) | {folder_dest} | set(_parent_folders(folder_dest)))

        # Перемещение папок в новый родитель
        if isinstance(folder_paths, list) and new_parent is not None:
            new_parent = _norm_folder(new_parent)
            if new_parent.startswith("__"):
                return web.json_response({"error": "reserved name"}, status=400)
            paths = {_norm_folder(p) for p in folder_paths if isinstance(p, str) and p}
            # Сначала собираем все переименования (чтобы не конфликтовали)
            renames = {}
            for f in sorted(paths):
                leaf = f.split("/")[-1]
                new_f = f"{new_parent}/{leaf}" if new_parent else leaf
                if new_f == f or new_f.startswith(f + "/"):
                    continue
                renames[f] = new_f
            # Применяем переименования
            for e in entries:
                ef = e.get("folder", "")
                for old_f, new_f in renames.items():
                    if ef == old_f or ef.startswith(old_f + "/"):
                        e["folder"] = new_f + ef[len(old_f):]
                        e["category"] = e["folder"]
                        e["hash"] = _dedup_hash(e["prompt"], e["folder"])
            # Обновляем список папок
            new_folders = set()
            for f in folders:
                found = False
                for old_f, new_f in renames.items():
                    if f == old_f:
                        new_folders.add(new_f)
                        found = True
                        break
                    if f.startswith(old_f + "/"):
                        new_folders.add(new_f + f[len(old_f):])
                        found = True
                        break
                if not found:
                    new_folders.add(f)
            folders = sorted(new_folders)
            moved_folders = len(renames)

        _save_db(entries, folders)
        # Обновляем закреплённые папки: перемещённые папки получают новые пути
        if isinstance(folder_paths, list) and new_parent is not None:
            _rename_pinned = lambda f: next((new_f + f[len(old_f):] for old_f, new_f in renames.items() if f == old_f or f.startswith(old_f + "/")), f)
            _save_pinned_folders([_rename_pinned(f) for f in _load_pinned_folders()])
        _broadcast_refresh()
        return web.json_response({"ok": True, "moved_entries": moved_entries, "moved_folders": moved_folders})

    @routes.post("/prompt_library/folder_delete")
    @_locked
    async def _pl_folder_delete(request, body=None):
        """Удаление папки: записи из неё и подпапок переносятся в корень (не теряются)."""
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
        _save_pinned_folders([f for f in _load_pinned_folders() if f != path and not f.startswith(path + "/")])
        _broadcast_refresh()
        return web.json_response({"ok": True})

    @routes.post("/prompt_library/folder_delete_many")
    @_locked
    async def _pl_folder_delete_many(request, body=None):
        """Массовое удаление категорий (мультивыделение Ctrl/Shift).
        Семантика как у одиночного: записи из сносимых папок и подпапок
        переносятся в корень, не теряются. Мусор в paths игнорируется."""
        raw = body.get("paths", None)
        if not isinstance(raw, list):
            return web.json_response({"error": "paths must be a list"}, status=400)
        paths = {p for p in (_norm_folder(x) for x in raw if isinstance(x, str)) if p}
        if not paths:
            return web.json_response({"ok": True, "deleted_folders": 0})

        def _killed(folder):
            return any(folder == p or folder.startswith(p + "/") for p in paths)

        entries, folders = _load_db()
        folders = [f for f in folders if not _killed(f)]
        for e in entries:
            if _killed(e.get("folder", "")):
                e["folder"] = ""
                e["category"] = ""
                e["hash"] = _dedup_hash(e["prompt"], "")
        _save_db(entries, folders)
        # Чистим закреплённые папки: удалённая папка и все подпапки больше не существуют
        _save_pinned_folders([f for f in _load_pinned_folders() if not _killed(f)])
        _broadcast_refresh()
        return web.json_response({"ok": True, "deleted_folders": len(paths)})

except Exception as e:
    print(f"[PromptLibrary] routes not registered: {e}", flush=True)


NODE_CLASS_MAPPINGS = {
    "PromptLibrary": PromptLibrary,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptLibrary": "Prompt Library",
}
