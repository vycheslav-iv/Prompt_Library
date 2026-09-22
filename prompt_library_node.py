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
import math
import os
import re
import tempfile
import threading
import time
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
    # v1.40: снимки графов живут отдельными файлами (§24.2), а не внутри базы
    (root / "workflows").mkdir(parents=True, exist_ok=True)
    return root


# --- Графы записей (v1.40) ----------------------------------------------------
# Снимок графа — это ЗАДУМАННАЯ часть карточки (§24.1): по ней открывается
# воркфлоу кнопкой «📥 Воркфлоу» и перетаскиванием карточки на канвас. Но лежать
# он должен ОТДЕЛЬНЫМ файлом: в library.json снимок весит ~340 КБ на запись
# (замер 2026-09-21: 12.1 МБ из 18.6 МБ — 36 снимков), а база перечитывается
# целиком на каждое действие (§25.3.1).
#
# Записи до v1.40 несут граф inline (`entry["workflow"]`) — их НЕ переделываем:
# `_entry_workflow()` читает сначала inline, потом файл, поэтому старые карточки
# открываются как и раньше. Клиенту разницы нет: /entry отдаёт то же поле
# `workflow` в том же виде (браузерная часть не менялась вовсе).

def _entry_workflow(entry):
    """Граф записи: inline (записи < v1.40) или из workflows/{id}.json."""
    wf = entry.get("workflow")
    if isinstance(wf, dict):
        return wf
    path = _workflow_path(entry.get("id"))
    if path is None or not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _workflow_path(entry_id):
    """Файл графа записи. id идёт в имя файла, поэтому проверяем его как
    везде остальном (алfanum): запись с id из `../x` иначе ушла бы за папку."""
    if not re.fullmatch(r"[a-zA-Z0-9]+", str(entry_id or "")):
        return None
    return _ensure_dirs() / "workflows" / f"{entry_id}.json"


def _save_workflow_file(entry_id, workflow):
    """Положить граф в workflows/{id}.json (компактный JSON, как в снапшоте).
    Возвращает относительный путь для записи или None (нет графа / ошибка)."""
    if not isinstance(workflow, dict):
        return None
    path = _workflow_path(entry_id)
    if path is None:
        return None
    try:
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(workflow, ensure_ascii=False, separators=(",", ":")),
                       encoding="utf-8")
        os.replace(tmp, path)
        return f"workflows/{entry_id}.json"
    except Exception as e:
        print(f"[PromptLibrary] workflow file failed: {e}", flush=True)
        return None


def _remove_workflow_file(entry_id):
    try:
        path = _workflow_path(entry_id)
        if path is not None:
            path.unlink(missing_ok=True)
    except Exception:
        pass


def _attach_workflow(entries, entry_id, workflow):
    """Отметить у записи граф и положить его отдельным файлом (v1.40).
    Возвращает True, если запись изменилась. Запись с уже имеющимся графом
    (inline у старых, файл у новых) не трогаем — чужое не затираем."""
    if not isinstance(workflow, dict):
        return False
    for e in entries:
        if e.get("id") != entry_id:
            continue
        # _entry_has_workflow, а не сырые поля: если файл графа потерян (копию
        # базы перенесли без папки workflows/), отметка врала бы «граф есть» и
        # запись нельзя было бы вылечить — теперь прогон перезапишет файл.
        if _entry_has_workflow(e):
            return False
        rel = _save_workflow_file(entry_id, workflow)
        if rel:
            e["workflow_file"] = rel
        else:
            # Файл не записался: id не годится для имени файла (правленная вручную
            # база вида "bf-broadcast") или на диске нет прав. Лучше старое
            # inline-хранение, чем молчаливая потеря графа — читатель понимает оба вида.
            e["workflow"] = workflow
        return True
    return False


def _entry_has_workflow(entry):
    """Флаг для списка и кнопки «📥 Воркфлоу»: граф ЕСТЬ и он читается.

    Проверяем не только отметку, но и существование файла: `os.path.exists`
    на 500 записей — 1.8 мс (замер), дешевле разбора одной карточки, зато
    список не врёт, если файлы графов потеряны (база восстановлена из бэкапа,
    папку workflows/ не скопировали вручную) — иначе кнопка есть, а графа нет."""
    if entry.get("workflow"):
        return True  # inline (записи < v1.40)
    rel = entry.get("workflow_file")
    if not rel:
        return False
    path = _workflow_path(entry.get("id"))
    return bool(path is not None and path.exists())


def _trim_entries(entries):
    """Обрезка до MAX_ENTRIES: у отброшенных записей убираем файл графа и
    файл превью, иначе они остаются сиротами в workflows/ и previews/."""
    if len(entries) <= MAX_ENTRIES:
        return entries
    for e in entries[MAX_ENTRIES:]:
        _remove_workflow_file(e.get("id"))
        _remove_preview_file(e.get("preview"))
    return entries[:MAX_ENTRIES]


# --- Папки -------------------------------------------------------------------

def _norm_folder(path):
    """' Фото//Портреты/ ' -> 'Фото/Портреты'. Пусто -> '' (корень)."""
    parts = [p.strip() for p in str(path or "").replace("\\", "/").split("/") if p.strip()]
    return "/".join(parts)


def _parse_slots(raw):
    """Парсит JSON-привязки доп. выходов (slots_out, §40).

    Вход: строка JSON (или пусто) → список слотов [{i, kind, ...}].
    Любой мусор (битый JSON, не-список, не-словари) → пустой список:
    мультивывод молча выключен, но нода не падает. Результат чистится от
    невалидных записей: i должен быть int в 2..11, kind — card или folder.
    """
    if isinstance(raw, (list, tuple)):
        if len(raw) == 1:
            raw = raw[0]
        else:
            return []
    if not isinstance(raw, str) or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for s in data:
        if not isinstance(s, dict):
            continue
        i = s.get("i")
        kind = s.get("kind")
        if not isinstance(i, int) or not (2 <= i <= 11):
            continue
        if kind not in ("card", "folder"):
            continue
        if kind == "card" and not isinstance(s.get("id", ""), str):
            continue
        if kind == "folder" and not isinstance(s.get("path", ""), str):
            continue
        out.append(s)
    return out


def _sanitize_folder_path(path):
    """Санитизирует путь папки для вывода по проводу.
    Сохраняет пробелы и нечитаемые символы заменяет на '_', исключает
    служебные ветки. Повторы пробелов/подчёркиваний сжимаются до одного.
    Всегда заканчивается на '/' если не пустой.
    Пример: 'Пейзажи/Аляска' → 'Пейзажи/Аляска/', 'Мои Пейзажи' → 'Мои Пейзажи/'
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
        s = "".join(c if (c.isalnum() or c in " _-" or ord(c) > 127) else "_" for c in s)
        s = re.sub(r"_+", "_", s)
        s = re.sub(r" +", " ", s)
        s = s.strip(" _")
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
        _drop_legacy_preview_file(entry_id)
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
        _drop_legacy_preview_file(entry_id)
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


def _preview_workflow_chunk(path):
    """Workflow-чанк (tEXt 'workflow') из PNG-превью записи.

    Строка JSON → dict; чанка нет / битый / не-PNG → None. Так делается
    чанк при сохранении (`_workflow_pnginfo`) — превью самодостаточно:
    HTML-галерея читает параметры генерации прямо из него, без базы.
    """
    if path is None or path.suffix.lower() != ".png":
        return None
    try:
        from PIL import Image
        raw = Image.open(path).info.get("workflow")
        if isinstance(raw, str):
            wf = json.loads(raw)
            return wf if isinstance(wf, dict) else None
    except Exception:
        pass
    return None


# Имя файла модели по расширению (имена папок/подпапок внутри models/ не важны).
_MODEL_FILE_RE = re.compile(r"\.(safetensors|ckpt|gguf|sft|pt|pth|bin)$", re.I)

# Папки ComfyUI → роль файла. Файлы прочих папок (vae_approx, upscale_models,
# text_encoders, controlnet…) моделью генерации / LoRA не считаются вовсе.
# Порядок важен: LoRA перекрывает одноимённый файл (setdefault ниже).
_ROLE_FOLDERS = (
    (("loras",), "lora"),
    (("checkpoints", "unet", "diffusion_models", "diffusion_models_gguf"), "model"),
    (("vae",), "vae"),
)
_ROLE_INDEX = {"stamp": 0.0, "map": {}}

# Узлы-заметки и превью: в их тексте бывают имена файлов, но это НЕ использование
# модели (MarkdownNote с таблицей LoRA давал ложные «использованные лоры»).
_TEXT_NODE_RE = re.compile(r"(?i)(note|markdown)|^(preview|show|display)")


def _file_role_index():
    """{имя файла (lower): "lora"/"model"/"vae"} по спискам ComfyUI.

    Роль файла берётся из РАСКЛАДКИ моделей на диске, а не из имени узла: в
    живых графах модель лежит в `models/diffusion_models`, LoRA — в
    `models/loras`, а узлы называются `SeedVR2LoadDiTModel` или UUID-сабграфом
    — по типам узлов модель не найти (SPEC §41.2, v1.47).
    Кэш на процесс, пересборка раз в 60 с (folder_paths сам кэширует списки)."""
    now = time.time()
    if _ROLE_INDEX["map"] and (now - _ROLE_INDEX["stamp"]) < 60:
        return _ROLE_INDEX["map"]
    out = {}
    try:
        import folder_paths  # type: ignore

        for folders, role in _ROLE_FOLDERS:
            for folder in folders:
                try:
                    names = folder_paths.get_filename_list(folder)
                except Exception:
                    continue
                for rel in names or []:
                    key = Path(str(rel).replace("\\", "/")).name.lower()
                    if key:
                        out.setdefault(key, role)
    except Exception:
        out = {}
    _ROLE_INDEX["map"] = out
    _ROLE_INDEX["stamp"] = now
    return out


def _file_role(name, hint="", role_of=None):
    """Роль файла → ("lora"/"model"/"vae"/"other"/None, по_диску).

    Сначала раскладка на диске (точная роль), иначе подсказки — имя узла,
    заголовок и имя файла: `lora` → LoRA, слова про VAE/апскейл/CLIP/аппроксиматор
    → `other` (не модель генерации), checkpoint/unet/dit/diffusion/model →
    модель-фолбэк (второй сорт: показываем только если точной модели нет).
    Неизвестное имя файла без подсказок → None (не выдумываем)."""
    text = str(name or "")
    base = Path(text.replace("\\", "/")).name.lower()
    try:
        role = (role_of or _file_role_index().get)(base)
    except Exception:
        role = None
    if role:
        return role, True
    hint_l = f"{hint} {text}".lower()
    if "lora" in hint_l:
        return "lora", False
    if any(w in hint_l for w in ("vae", "upscal", "clip", "controlnet",
                                "text_encoder", "audio", "embedding", "preview")):
        return "other", False
    if any(w in hint_l for w in ("checkpoint", "unet", "dit", "diffusion", "model")):
        return "model", False
    return None, False


def _iter_nodes(workflow):
    """Узлы UI-графа, включая внутренности сабграфов.

    Сабграф ComfyUI хранит в `definitions.subgraphs`: его ноды не видны в
    `workflow["nodes"]`, а узел-экземпляр имеет тип-UUID. Обходим и то, и то
    (вложенность ограничена, чтобы битый/огромный граф не подвесил разбор)."""
    if not isinstance(workflow, dict):
        return []
    out = []
    pending = [workflow.get("definitions")]
    for nd in workflow.get("nodes") or []:
        if isinstance(nd, dict):
            out.append(nd)
            pending.append(nd.get("definitions"))
    seen = 0
    while pending and seen < 5000:
        defs = pending.pop(0)
        seen += 1
        if not isinstance(defs, dict):
            continue
        for sg in defs.get("subgraphs") or []:
            if not isinstance(sg, dict):
                continue
            out.append(sg)
            pending.append(sg.get("definitions"))
            for nd in sg.get("nodes") or []:
                if isinstance(nd, dict):
                    out.append(nd)
                    pending.append(nd.get("definitions"))
    return out


def _iter_widget_files(value, label, out, depth=0):
    """Разобрать widgets_values узла → список кандидатов.

    Кандидат — `{"name", "on", "strength"}`: имя файла модели (строка с
    модельным расширением) или LoRA-слот (`Power Lora Loader (rgthree)` хранит
    `{"on": bool, "lora": "…", "strength": N}`). Строки многострочного
    текста пропускаем: имя модели в промпте — не загрузка модели."""
    if depth > 6:
        return
    if isinstance(value, str):
        s = value.strip()
        if len(s) <= 300 and "\n" not in s and _MODEL_FILE_RE.search(s):
            out.append({"name": s, "on": None, "strength": None})
    elif isinstance(value, (list, tuple)):
        for v in value:
            _iter_widget_files(v, label, out, depth + 1)
    elif isinstance(value, dict):
        lora = value.get("lora") if isinstance(value.get("lora"), str) else value.get("lora_name")
        if isinstance(lora, str) and lora.strip():
            out.append({"name": lora.strip(),
                        "on": value.get("on", True),
                        "strength": value.get("strength")})
        for k, v in value.items():
            if k in ("lora", "lora_name"):
                continue
            _iter_widget_files(v, f"{label}.{k}", out, depth + 1)


def _uniq_names(names):
    """Уникальные имена с сохранением порядка (регистр не учитываем)."""
    seen, out = set(), []
    for n in names:
        key = str(n).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
    return out


def _graph_of(container):
    """(узлы, провода, сабграфы) одного уровня UI-графа.

    Провода в UI-схеме ComfyUI — `[link_id, from_id, from_slot, to_id, to_slot,
    type]`; попадаются и объектные записи — читаем обе формы."""
    nodes = {}
    for n in container.get("nodes") or []:
        if isinstance(n, dict) and n.get("id") is not None:
            nodes[n["id"]] = n
    links = {}
    for l in container.get("links") or []:
        if isinstance(l, (list, tuple)) and len(l) >= 5:
            links[l[0]] = {"from": l[1], "from_slot": l[2], "to": l[3], "to_slot": l[4]}
        elif isinstance(l, dict) and l.get("id") is not None:
            links[l["id"]] = {"from": l.get("origin_id"), "from_slot": l.get("origin_slot"),
                              "to": l.get("target_id"), "to_slot": l.get("target_slot")}
    defs = {}
    for sg in (container.get("definitions") or {}).get("subgraphs") or []:
        if isinstance(sg, dict) and sg.get("id"):
            defs[sg["id"]] = sg
    return nodes, links, defs


_SAMPLER_RE = re.compile(r"(?i)sampler")
_NOT_SAMPLER_RE = re.compile(r"(?i)(upscal|seedvr|preview|note|detail|facerestore)")

# Типы входов, по которым идёт обход «что дошло до сэмплера». Без этого фильтра
# обход заходил в посторонние ветки (апскейлеры, библиотеки LoRA, заглушки) и
# тянул оттуда файлы как «использованные» (v1.49).
_CHAIN_TYPES = {"MODEL", "CLIP", "CONDITIONING", "LATENT", "VAE", "GUIDER",
                "SAMPLER", "SIGMAS", "NOISE", "CLIP_VISION"}


def _chain_inputs(node):
    """Входы узла, несущие модель/условие/латент (остальные — чужие ветки)."""
    out = []
    for i in node.get("inputs") or []:
        if isinstance(i, dict) and (i.get("type") in _CHAIN_TYPES or not i.get("type")):
            out.append(i.get("link"))
    return out


def _promoted_overrides(subgraph, instance):
    """Значения promoted-входов: {(id_внутреннего_узла, слот | "@имя_входа"): значение}.

    У экземпляра сабграфа виджеты идут в порядке `subgraph["inputs"]`
    (slot k ↔ `widgets_values[k]`), а каждый promoted-вход связан ВНУТРЕННИМ
    проводом с конкретным (узел, слот) определения. Значит значение, которое
    реально увидит внутренний загрузчик, — из виджета ЭКЗЕМПЛЯРА, а не из его
    собственного (живой пример: в слоте «unet_name_1» лежит
    `jibMixKrea2_v40Habanero_3135300.safetensors`, а в самом UNETLoader
    прописан `krea2_turbo_int8_convrot` — v1.49).

    Ключ по ИМЕНИ входа (v1.50) — потому что «номер входа» не равен позиции в
    `widgets_values`: у `LoraLoaderModelOnly` виджетов два (`lora_name`, 
    `strength_model`), а вход с виджетом один — и позиционная подстановка
    перекрывала имя LoRA её же силой (турбо-LoRA из сабграфа пропадала вовсе)."""
    out = {}
    if not isinstance(instance, dict):
        return out
    wv = instance.get("widgets_values")
    named = instance.get("widgets_values_named")
    inodes, ilinks, _ = _graph_of(subgraph)
    for slot, spec in enumerate(subgraph.get("inputs") or []):
        if not isinstance(spec, dict):
            continue
        value, found = None, False
        if isinstance(named, dict) and spec.get("name") in named:
            value, found = named[spec["name"]], True
        elif isinstance(wv, list) and slot < len(wv):
            value, found = wv[slot], True
        if not found:
            continue
        for lid in spec.get("linkIds") or []:
            link = ilinks.get(lid)
            if not isinstance(link, dict) or link.get("to") is None:
                continue
            tgt = inodes.get(link.get("to"))
            name = None
            if isinstance(tgt, dict):
                for i, inp in enumerate(tgt.get("inputs") or []):
                    if i == link.get("to_slot") and isinstance(inp, dict):
                        name = inp.get("name")
            if name:
                out[(link["to"], "@" + str(name))] = value
            out[(link["to"], link.get("to_slot"))] = value
    return out


def _effective_widgets(node, overrides):
    """`widgets_values` узла с учётом перекрытий сабграфа (v1.49 → v1.50).

    Виджет-вход, подключённый к promoted-входу, получает значение ЭКЗЕМПЛЯРА —
    именно оно уходит в генерацию, поэтому и показываем его.

    Основной путь — по ИМЕНИ виджета (`widgets_values_named`, есть во всех
    актуальных графах): тогда позиция виджета внутри `widgets_values` роли не
    играет. Позиционная подстановка по номеру входа осталась фолбэком для
    старых снимков без named-формы."""
    wv = node.get("widgets_values")
    if not overrides:
        return wv
    named = node.get("widgets_values_named")
    if isinstance(named, dict) and named:
        out = dict(named)
        changed = False
        for inp in node.get("inputs") or []:
            if not isinstance(inp, dict) or not inp.get("widget"):
                continue
            widget = inp.get("widget") if isinstance(inp.get("widget"), dict) else {}
            wname = widget.get("name") or inp.get("name")
            key = (node.get("id"), "@" + str(wname))
            if wname and key in overrides:
                out[wname] = overrides[key]
                changed = True
        if changed:
            # Порядок named-формы = порядок виджетов узла.
            return list(out.values())
        return wv
    if not isinstance(wv, list):
        return wv
    out = list(wv)
    widx = 0
    for slot, inp in enumerate(node.get("inputs") or []):
        if not isinstance(inp, dict) or not inp.get("widget"):
            continue
        key = (node.get("id"), slot)
        if key in overrides and widx < len(out):
            out[widx] = overrides[key]
        widx += 1
    return out


# Узлы-константы: их значение и есть «положение переключателя».
_VALUE_NODE_RE = re.compile(r"(?i)^(primitive|int|integer|float|number|bool|boolean|string|text|value)")
_SELECTOR_NAMES = ("switch", "condition", "select", "state", "boolean", "enable", "use")
_SWITCH_RE = re.compile(r"(?i)switch")
_LORA_NODE_RE = re.compile(r"(?i)lora")


def _shown_value(value):
    """Значение виджета → bool/int/str, пустая строка и мусор → None."""
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value.strip() or None
    return None


def _const_value(nodes, overrides, nid):
    """Значение узла-константы по id (с учётом перекрытий сабграфа) или None."""
    nd = nodes.get(nid)
    if not isinstance(nd, dict):
        return None
    if not _VALUE_NODE_RE.search(str(nd.get("type") or "")):
        return None
    wv = _effective_widgets(nd, overrides)
    if isinstance(wv, list) and wv:
        return _shown_value(wv[0])
    return None


def _truthy(value):
    """BOOLEAN/INT-селектор → bool; None — не понять."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "1", "on", "yes", "да", "вкл"):
            return True
        if v in ("false", "0", "off", "no", "нет", "выкл", ""):
            return False
    return None


def _input_slot(node, target):
    """Индекс входа узла (нужен для перекрытий сабграфа)."""
    for i, inp in enumerate(node.get("inputs") or []):
        if inp is target:
            return i
    return None


def _selector_value(node, sel, nodes, links, overrides):
    """Значение селектора переключателя: провод → узел-константа, иначе виджет."""
    if not isinstance(sel, dict):
        return None
    lid = sel.get("link")
    if lid is not None:
        link = links.get(lid)
        if not isinstance(link, dict):
            return None
        return _const_value(nodes, overrides, link.get("from"))
    key = (node.get("id"), _input_slot(node, sel))
    if key in overrides:
        return _shown_value(overrides[key])
    widget_inputs = [i for i in (node.get("inputs") or [])
                     if isinstance(i, dict) and i.get("widget")]
    if sel in widget_inputs:
        wv = node.get("widgets_values")
        widx = widget_inputs.index(sel)
        if isinstance(wv, list) and widx < len(wv):
            return _shown_value(wv[widx])
    return None


def _active_links(node, nodes, links, overrides):
    """Активные входы узла → (список link_id, разрешено_ли).

    Переключатели (v1.49): `ComfySwitchNode` (`on_true`/`on_false` + селектор) и
    `DeggSwitch` (`select` = номер входа `input_N`). Не разрешился селектор —
    возвращаются ОБА входа и False: в галерее появится честная пометка
    «показаны все ветки». Не переключатель → (None, True): идём по всем входам,
    как раньше."""
    if not _SWITCH_RE.search(str(node.get("type") or "")):
        return None, True
    inputs = [i for i in (node.get("inputs") or []) if isinstance(i, dict)]
    by_name = {str(i.get("name") or "").lower(): i for i in inputs}
    on_true, on_false = by_name.get("on_true"), by_name.get("on_false")
    if on_true is not None and on_false is not None:
        sel = next((by_name[nm] for nm in _SELECTOR_NAMES if nm in by_name), None)
        if sel is None:
            sel = next((i for i in inputs if i is not on_true and i is not on_false), None)
        truth = _truthy(_selector_value(node, sel, nodes, links, overrides)) if sel else None
        if truth is None:
            return [on_true.get("link"), on_false.get("link")], False
        return [(on_true if truth else on_false).get("link")], True
    if "select" in by_name and any(n.startswith("input_") for n in by_name):
        num = _selector_value(node, by_name["select"], nodes, links, overrides)
        chosen = None
        try:
            chosen = by_name.get(f"input_{int(num)}")
        except Exception:
            chosen = None
        if chosen is None:
            return [i.get("link") for i in inputs
                    if str(i.get("name") or "").startswith("input_")], False
        return [chosen.get("link")], True
    return [i.get("link") for i in inputs], False


def _is_switch_node(node):
    """Узел — переключатель (по типу/имени входа `select`+`input_N`)."""
    kind = str(node.get("type") or "")
    if _SWITCH_RE.search(kind):
        return True
    names = {str(i.get("name") or "").lower()
             for i in node.get("inputs") or [] if isinstance(i, dict)}
    return "select" in names and any(n.startswith("input_") for n in names)


def _lora_strength(node, wv_eff):
    """Сила LoRA: из named-виджета, иначе из позиции `widgets_values[1]`."""
    named = node.get("widgets_values_named")
    if isinstance(named, dict):
        for k in ("strength_model", "strength"):
            v = named.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return v
    if isinstance(wv_eff, list) and len(wv_eff) > 1:
        v = wv_eff[1]
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return v
    return None


_DEGG_RES_ASPECT_RE = re.compile(r"^(\d+)\s*:\s*(\d+)")


def _degg_res_set_output(node, out_slot):
    """width/height узла `DeggResSet` (нода проекта Degg_Res_Set).

    Зеркалит `DeggResSet.process` (deg_res_set.py): preset 1 — расчёт из
    аспекта/мегапикселей/кратности, 2–4 — ручные w/h. Именно зеркало, а не
    импорт: нода лежит отдельным плагином ComfyUI и по имени не импортируется.
    ⚠ При правке формулы в deg_res_set.py поправить и здесь — иначе галерея
    начнёт показывать устаревшее разрешение. Значения берём из
    `widgets_values_named` (по ИМЕНИ), а не из позиций: фронтенд вставляет в
    список группы-плейсхолдеры `__grp` и позиции съезжают."""
    named = node.get("widgets_values_named")
    if not isinstance(named, dict):
        return None
    if out_slot not in (0, 1):
        return None
    try:
        select = int(named.get("select") or 1)
    except (TypeError, ValueError):
        return None
    try:
        if select == 1:
            m = _DEGG_RES_ASPECT_RE.match(str(named.get("aspect_ratio") or ""))
            megapixels = float(named.get("megapixels") or 0)
            multiple = int(named.get("multiple") or 8)
            if not m or megapixels <= 0 or multiple <= 0:
                return None
            ratio_w, ratio_h = int(m.group(1)), int(m.group(2))
            total = megapixels * 1048576
            w = int(math.sqrt(total * ratio_w / ratio_h))
            h = int(math.sqrt(total * ratio_h / ratio_w))
            return (max((w // multiple) * multiple, multiple),
                    max((h // multiple) * multiple, multiple))[out_slot]
        keys = {2: ("w1", "h1"), 3: ("w2", "h2")}.get(select, ("w3", "h3"))
        value = named.get(keys[out_slot])
        return int(value) if value is not None else None
    except Exception:
        return None


def _output_value(nodes, links, defs, overrides, nid, out_slot, depth=0):
    """Значение, выходящее с выхода `out_slot` узла `nid`, или None.

    Нужно для ПАРАМЕТРОВ генерации, заданных ПРОВОДОМ (v1.50): шаги/разрешение
    часто приходят не из виджета сэмплера, а из константы, переключателя или
    сабграфа — в самом `KSampler` при этом остаётся старый виджет. Живой пример:
    сабграф «KREA 2 RAW MODEL» отдаёт `output_2` («Шаги») — 12 для RAW и 10 для
    TURBO, а виджет сэмплера хранит 8; если верить виджету, в галерее врёт число
    шагов. Понимает: сабграф (внутренний провод в выходной слот), узел-константу
    (`Primitive*`/`Int`/…) и переключатель (`ComfySwitchNode`/`DeggSwitch`).
    Непонятное (чужой узел/неразрешённый свитч) → None: параметр останется из
    виджета, выдумывать не будем."""
    if nid is None or depth > 30:
        return None
    nd = nodes.get(nid)
    if not isinstance(nd, dict):
        return None
    kind = str(nd.get("type") or "")
    sg = defs.get(kind)
    if sg is not None:
        inodes, ilinks, idefs = _graph_of(sg)
        ioverrides = _promoted_overrides(sg, nd)
        out_node = sg.get("outputNode")
        out_id = out_node.get("id") if isinstance(out_node, dict) else None
        if out_id is None:
            return None
        for _lid, link in ilinks.items():
            if (isinstance(link, dict) and link.get("to") == out_id
                    and link.get("to_slot") == out_slot):
                return _output_value(inodes, ilinks, idefs, ioverrides,
                                     link.get("from"), link.get("from_slot"), depth + 1)
        return None
    if kind == "DeggResSet":
        return _degg_res_set_output(nd, out_slot)
    if _is_switch_node(nd):
        active, resolved = _active_links(nd, nodes, links, overrides)
        if active and resolved and len(active) == 1 and active[0] is not None:
            link = links.get(active[0])
            if isinstance(link, dict):
                return _output_value(nodes, links, defs, overrides,
                                     link.get("from"), link.get("from_slot"), depth + 1)
        return None
    # Значение из виджета берём только у узлов-КОНСТАНТ (`Primitive*`/`Int`/…):
    # у вычислителя (`ComfyMathExpression`), счётчика кадров и прочих «умных»
    # узлов первый виджет ("a * b + 1") значением не является — не выдумываем.
    if not _VALUE_NODE_RE.search(kind):
        return None
    wv = _effective_widgets(nd, overrides)
    if isinstance(wv, list) and wv:
        return _shown_value(wv[0])
    return None


# Имена входов сэмплера/латента → какие поля метаданных они задают (v1.50).
_PARAM_INPUTS = {
    "sampler": ("sampler", "sampler_name"),
    "scheduler": ("scheduler", "scheduler_name"),
    "steps": ("steps",),
    "cfg": ("cfg",),
    "denoise": ("denoise",),
    "seed": ("seed", "noise_seed"),
    "width": ("width",),
    "height": ("height",),
}


def _wired_param(nodes, links, defs, node, key):
    """Значение параметра `key`, пришедшее ПРОВОДОМ (иначе None)."""
    want = {n.lower() for n in _PARAM_INPUTS.get(key, (key,))}
    for inp in node.get("inputs") or []:
        if not isinstance(inp, dict) or inp.get("link") is None:
            continue
        widget = inp.get("widget") if isinstance(inp.get("widget"), dict) else {}
        names = {str(inp.get("name") or "").lower(), str(widget.get("name") or "").lower()}
        if not (names & want):
            continue
        link = links.get(inp["link"])
        if isinstance(link, dict):
            value = _output_value(nodes, links, defs, {}, link.get("from"),
                                  link.get("from_slot"))
            if value is not None:
                return value
    return None


def _param(nodes, links, defs, node, wv, key, pos=None):
    """Значение параметра генерации: ПРОВОД важнее виджета (v1.50).

    Если вход подключён проводом и источник понятен — берём его значение
    (иначе виджет сэмплера хранит устаревшее число). Не поняли → виджет."""
    value = _wired_param(nodes, links, defs, node, key)
    if value is not None:
        return value
    if isinstance(wv, list) and pos is not None and pos < len(wv):
        return wv[pos]
    return None


def _sampler_starts(nodes):
    """id узлов-сэмплеров верхнего уровня (без апскейлеров/превью)."""
    return [n.get("id") for n in nodes.values()
            if _SAMPLER_RE.search(str(n.get("type") or ""))
            and not _NOT_SAMPLER_RE.search(str(n.get("type") or ""))]


def _active_chain(workflow, limit=800):
    """Обход АКТИВНОЙ части графа вверх от сэмплеров.

    Возвращает `(кандидаты, флаг_неразрешённого_свитча, узлы_верхнего_уровня)`.
    Третий элемент — id ВЕРХНИХ узлов, реально пройденных обходом: по нему
    `_gen_meta` решает, можно ли вообще дополнять ответ фолбэком «по всему
    графу» (v1.51). Пустое множество = сэмплеров на верхнем уровне нет.

    Отличие от простого обхода (v1.47): переключатели РАЗРЕШАЮТСЯ (`_active_links`),
    а сабграф разворачивается не целиком, а со своего ВЫХОДНОГО узла — с учётом
    перекрытий promoted-входов (`_promoted_overrides`). Поэтому в результат
    попадают только те загрузчики модели/LoRA, что реально дошли до сэмплера:
    в живом графе пользователя ветка с `krea2_turbo` и её LoRA — невидимы,
    когда переключатель стоит на RAW-модели (v1.49).
    Флаг «туманность» — был переключатель, значение которого не понять."""
    nodes, links, defs = _graph_of(workflow)
    starts = _sampler_starts(nodes)
    if not starts:
        return [], False, set()
    cands, seen, unresolved = [], set(), [False]

    def visit(scope, nodes, links, defs, overrides, nid, depth):
        if nid is None or depth > 40 or len(cands) > limit:
            return
        key = (scope, nid)
        if key in seen:
            return
        seen.add(key)
        nd = nodes.get(nid)
        if not isinstance(nd, dict):
            return
        kind = str(nd.get("type") or "")
        sg = defs.get(kind)
        if sg is not None:
            inodes, ilinks, idefs = _graph_of(sg)
            ioverrides = _promoted_overrides(sg, nd)
            out_node = sg.get("outputNode")
            out_id = out_node.get("id") if isinstance(out_node, dict) else None
            out_links = [inp.get("link") for inp in
                         ((out_node.get("inputs") if isinstance(out_node, dict) else None) or [])
                         if isinstance(inp, dict)]
            if not out_links and out_id is not None:
                # В живых графах у выходного узла сабграфа нет своего `inputs`:
                # его входы — это провода, ЦЕЛЬ которых и есть этот узел.
                out_links = [lid for lid, link in ilinks.items()
                             if isinstance(link, dict) and link.get("to") == out_id]
            for lid in out_links:
                if lid is None:
                    continue
                src = ilinks.get(lid)
                if isinstance(src, dict) and src.get("from") is not None:
                    visit(kind, inodes, ilinks, idefs, ioverrides, src["from"], depth + 1)
            # внешние провода, входящие в promoted-входы экземпляра
            for inp in nd.get("inputs") or []:
                if not isinstance(inp, dict) or inp.get("link") is None:
                    continue
                src = links.get(inp["link"])
                if isinstance(src, dict) and src.get("from") is not None:
                    visit(scope, nodes, links, defs, overrides, src["from"], depth + 1)
            return
        if not _TEXT_NODE_RE.search(kind):
            wv_eff = _effective_widgets(nd, overrides)
            cand = []
            _iter_widget_files(wv_eff, kind, cand)
            # Штатный лоадер LoRA держит силу виджетом (`strength_model`) —
            # без этого LoRA из сабграфа шла без силы (v1.49).
            strength = _lora_strength(nd, wv_eff) if _LORA_NODE_RE.search(kind) else None
            hint = f"{kind} {nd.get('title') or ''}"
            for c in cand:
                c["hint"] = hint
                if (c.get("strength") is None and strength is not None
                        and isinstance(strength, (int, float)) and not isinstance(strength, bool)):
                    c["strength"] = strength
                cands.append(c)
        active, resolved = _active_links(nd, nodes, links, overrides)
        allowed = _chain_inputs(nd)
        if active is None:
            active = allowed
        else:
            active = [lid for lid in active if lid in allowed]
            if not resolved:
                unresolved[0] = True
        for lid in active:
            if lid is None:
                continue
            src = links.get(lid)
            if isinstance(src, dict) and src.get("from") is not None:
                visit(scope, nodes, links, defs, overrides, src["from"], depth + 1)

    for sid in starts:
        visit("top", nodes, links, defs, {}, sid, 0)
    visited_top = {nid for scope, nid in seen if scope == "top"}
    return cands, unresolved[0], visited_top


def _chain_meta(workflow, role_of=None):
    """Модель / VAE / LoRA, реально дошедшие до СЭМПЛЕРА (v1.47 → v1.51).

    Идём только по АКТИВНОЙ части графа: переключатели разрешаются, сабграфы
    разворачиваются через выходной узел с перекрытиями promoted-входов.
    Поэтому в «Модели» оказывается задействованная модель, а LoRA — только те,
    что стоят на активной ветке.
    Возвращает `(meta, флаг_неразрешённого_свитча, узлы_верхнего_уровня)`:
    третий элемент нужен `_gen_meta`, чтобы понять, можно ли дополнять
    параметры фолбэком (v1.51)."""
    cands, unresolved, visited_top = _active_chain(workflow)
    models, hint_models, vaes, loras = [], [], [], []
    for c in cands:
        role, exact = _file_role(c["name"], c.get("hint") or "", role_of=role_of)
        base = Path(str(c["name"]).replace("\\", "/")).name
        if role == "model":
            (models if exact else hint_models).append(base)
        elif role == "vae":
            vaes.append(base)
        elif role == "lora":
            loras.append({"name": base, "on": c.get("on"), "strength": c.get("strength")})
    meta = {}
    ms = _uniq_names(models) or _uniq_names(hint_models)
    if ms:
        meta["model"] = ", ".join(ms[:4])
    out_loras, seen = [], set()
    for l in loras:
        if l.get("on") is False:
            continue
        key = (str(l["name"]).lower(), l.get("strength"))
        if key in seen:
            continue
        seen.add(key)
        out_loras.append({"name": l["name"], "strength": l.get("strength")})
    if out_loras:
        meta["loras"] = out_loras
    if vaes:
        meta["vae"] = _uniq_names(vaes)[0]
    return meta, unresolved, visited_top


def _generic_meta(workflow, role_of=None):
    """Модель / LoRA / VAE из ЛЮБЫХ узлов графа (включая сабграфы).

    Живой случай (граф пользователя): модель — в `models/diffusion_models`,
    подключённая через сабграф (тип узла — UUID), LoRA — слоты
    `Power Lora Loader (rgthree)`, штатного `CheckpointLoaderSimple` нет вовсе.
    Поэтому роль файла берётся из раскладки моделей (см. `_file_role`), а не из
    имени узла. Выключенные LoRA-слоты (`on: false`) не показываем — они
    в генерации не участвовали; заметки/превью пропускаем (§41.2, v1.47)."""
    disk_models, hint_models, loras, vaes = [], [], [], []
    for nd in _iter_nodes(workflow):
        kind = str(nd.get("type") or "")
        if _TEXT_NODE_RE.search(kind):
            continue
        cand = []
        _iter_widget_files(nd.get("widgets_values"), kind, cand)
        hint = f"{kind} {nd.get('title') or ''}"
        for c in cand:
            role, exact = _file_role(c["name"], hint, role_of=role_of)
            base = Path(str(c["name"]).replace("\\", "/")).name
            if role == "lora":
                loras.append({"name": base, "on": c.get("on"), "strength": c.get("strength")})
            elif role == "model":
                (disk_models if exact else hint_models).append(base)
            elif role == "vae":
                vaes.append(base)
    meta = {}
    models = _uniq_names(disk_models) or _uniq_names(hint_models)
    if models:
        meta["model"] = ", ".join(models[:4])
    out_loras, seen = [], set()
    for l in loras:
        if l.get("on") is False:
            continue
        key = (str(l["name"]).lower(), l.get("strength"))
        if key in seen:
            continue
        seen.add(key)
        out_loras.append({"name": l["name"], "strength": l.get("strength")})
    if out_loras:
        meta["loras"] = out_loras
    if vaes:
        meta["vae"] = _uniq_names(vaes)[0]
    return meta


def _gen_meta(workflow, role_of=None):
    """Параметры генерации из UI-графа записи (метаданные для HTML-галереи).

    Два прохода (v1.47 → v1.50):
    1. Известные типы узлов — `KSampler`, `KSamplerAdvanced`, `EmptyLatentImage`/
       `EmptySD3LatentImage`, штатные лоадеры. Каждый параметр: ПРОВОД важнее
       виджета (v1.50 — иначе в галерею уходит устаревшее число из виджета,
       когда шаги/размер заданы свитчем в сабграфе), непонятный источник —
       фолбэк на виджет по позиции.
    2. Общий проход `_generic_meta` — модель/VAE/LoRA из ЛЮБЫХ узлов и сабграфов,
       заполняет только то, чего не дал первый (setdefault): в живых графах
       штатных лоадеров нет вовсе (модель в сабграфе, LoRA в rgthree-лоадере).
    Поля фиксированным порядком: модель → VAE → LoRA → сэмплер/шаги/cfg/denoise/сид
    → разрешение. Ничего не нашлось → {}."""
    meta = {}
    if not isinstance(workflow, dict):
        return meta
    # Сначала главное: модель/VAE/LoRA по ЦЕПОЧКЕ к сэмплеру (что реально генерило),
    # фолбэк «по всему графу» — только когда цепочки НЕТ вовсе.
    chain, unresolved, chain_top = _chain_meta(workflow, role_of=role_of)
    for key, value in chain.items():
        meta.setdefault(key, value)
    # ВАЖНО (v1.51): если цепочка вообще что-то нашла (модель/LoRA), она
    # АВТОРИТЕТНА — фолбэк «по всему графу» не подмешивается. Он видит и
    # ВЫКЛЮЧЕННЫЕ ветки: живой случай — переключились с RAW на TURBO, в активной
    # ветке LoRA нет, а фолбэк подставлял turbo-LoRA из неактивной ветки
    # сабграфа, и галерея врала. Пустой список LoRA — это тоже ответ: «лоры не было».
    # Цепочка не нашла ничего → старое поведение (плоский граф без проводов).
    chain_found = bool(chain.get("model") or chain.get("loras"))
    if not chain_found:
        for key, value in _generic_meta(workflow, role_of=role_of).items():
            meta.setdefault(key, value)
    if unresolved:
        # Переключатель был, но его значение не понять: показаны обе ветки —
        # галерея обязана об этом сказать, а не делать вид, что знает.
        meta["ambiguous"] = True
    explicit_loras = []
    gnodes, glinks, gdefs = _graph_of(workflow)

    def param(nd, wv, key, pos):
        return _param(gnodes, glinks, gdefs, nd, wv, key, pos)

    for nd in workflow.get("nodes", []) or []:
        kind = nd.get("type")
        wv = nd.get("widgets_values")
        if kind is None or not isinstance(wv, list):
            continue
        # Цепочка нашла модель/LoRA → читаем ТОЛЬКО её узлы: лоадер в стороне
        # (или на выключенной ветке сабграфа) к генерации не относится (v1.51).
        if chain_found and nd.get("id") not in chain_top:
            continue
        try:
            if kind == "CheckpointLoaderSimple":
                meta.setdefault("model", str(wv[0]))
            elif kind in ("UNETLoader", "DiffusionModelLoader", "CheckpointLoader"):
                meta.setdefault("model", str(wv[0]))
            elif kind == "KSampler":
                # Позиции виджетов: seed, control, steps, cfg, sampler, scheduler, denoise.
                # Подключённый вход важнее виджета (v1.50): у живых графов в виджете
                # легко остаётся устаревшее число (шаги приходят из сабграфа).
                meta.setdefault("sampler", str(param(nd, wv, "sampler", 4) or ""))
                meta.setdefault("scheduler", str(param(nd, wv, "scheduler", 5) or ""))
                meta.setdefault("steps", param(nd, wv, "steps", 2))
                meta.setdefault("cfg", param(nd, wv, "cfg", 3))
                meta.setdefault("denoise", param(nd, wv, "denoise", 6))
                meta.setdefault("seed", param(nd, wv, "seed", 0))
            elif kind == "KSamplerAdvanced":
                meta.setdefault("sampler", str(param(nd, wv, "sampler", 5) or ""))
                meta.setdefault("scheduler", str(param(nd, wv, "scheduler", 6) or ""))
                meta.setdefault("steps", param(nd, wv, "steps", 3))
                meta.setdefault("cfg", param(nd, wv, "cfg", 4))
                meta.setdefault("denoise", param(nd, wv, "denoise", 7))
                meta.setdefault("seed", param(nd, wv, "seed", 1))
            elif kind in ("LoraLoader", "LoraLoaderModelOnly"):
                lora = {"name": str(wv[0]) if wv else ""}
                strength = _lora_strength(nd, wv)
                if strength is not None:
                    lora["strength"] = strength
                explicit_loras.append(lora)
            elif kind in ("EmptyLatentImage", "EmptySD3LatentImage"):
                # Размер часто подключён проводом (живой случай: из `Degg Res Set`) —
                # виджет при этом хранит устаревшее число (v1.50).
                meta.setdefault("width", param(nd, wv, "width", 0))
                meta.setdefault("height", param(nd, wv, "height", 1))
            elif kind == "VAELoader":
                meta.setdefault("vae", str(wv[0]) if wv else "")
        except Exception:
            continue
    # LoRA из штатных лоадеров ДОПОЛНЯЮТ найденные по графу (не заменяют):
    # у них есть сила, но их может не быть в rgthree-слотах и наоборот.
    if explicit_loras:
        merged = list(meta.get("loras") or [])
        by_name = {str(l.get("name", "")).lower(): l for l in merged}
        for l in explicit_loras:
            key = str(l.get("name", "")).lower()
            if key in by_name:
                if by_name[key].get("strength") is None and l.get("strength") is not None:
                    by_name[key]["strength"] = l["strength"]
            else:
                merged.append(l)
                by_name[key] = l
        meta["loras"] = merged
    return meta


def _remove_preview_file(victim):
    """Удалить файл превью по относительному пути из записи ("previews/x.png").
    Guard: только файл прямо в previews/ с картинковым расширением — значение
    приходит из базы (её правят и руками), выйти за папку нельзя."""
    try:
        root = _ensure_dirs()
        cand = root / (victim or "")
        if (victim and cand.parent == root / "previews"
                and cand.suffix.lower() in (".jpg", ".jpeg", ".png")):
            cand.unlink(missing_ok=True)
    except Exception:
        pass


def _drop_legacy_preview_file(entry_id):
    """После записи нового PNG-превью снести legacy JPG того же id, если он есть
    (карточки < v1.26 могут нести `previews/{id}.jpg`). Раньше замена обложки
    оставляла старый JPG на диске навсегда — удаление карточки снимало только PNG."""
    try:
        root = _ensure_dirs()
        f = root / "previews" / f"{entry_id}.jpg"
        if f.parent == root / "previews":
            f.unlink(missing_ok=True)
    except Exception:
        pass


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
    Основной текст (prompt_1) — индекс 1: индекс 0 занят путём категории.
    """
    try:
        wf = (extra_pnginfo or {}).get("workflow") or {}
        for nd in wf.get("nodes", []) or []:
            if str(nd.get("id")) != str(unique_id):
                continue
            outs = nd.get("outputs") or []
            if len(outs) < 2:
                return False
            prompt_out = outs[1] or {}
            links = prompt_out.get("links")
            if isinstance(links, (list, tuple)):
                return len(links) > 0
            return prompt_out.get("link") is not None
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
                # v1.44 (§40, мультивывод): JSON-привязки доп. выходов. Скрытый
                # виджет — значение пишет JS по дропам в категории «Выходы».
                "slots_out": ("STRING", {"multiline": False, "default": "[]"}),
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

    # v1.45.1 (§40, мультивывод): 12 STRING-выходов. Индексы 0-1 — путь
    # категории и основной текст (решение пользователя 2026-09-22: путь первым,
    # основной промпт — вторым, он же и подписан «промпт 1 (основной)», чтобы
    # не путался с доп. промптами 2..11). 2-11 — доп. выходы из категории
    # «Выходы»: номер провода = индекс, сокет создаётся дропом/кнопкой в ней.
    # Неиспользуемые слоты возвращают "".
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING", "STRING",
                    "STRING", "STRING", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("category_path", "prompt_1", "prompt_2", "prompt_3", "prompt_4",
                    "prompt_5", "prompt_6", "prompt_7", "prompt_8", "prompt_9",
                    "prompt_10", "prompt_11")
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

        v1.41: проверки `mode` здесь БОЛЬШЕ НЕТ. В v1.39 было
        `if str(mode).strip(): return nan`, а `mode` непустой всегда — получался
        NaN при любом запуске (докстрока и §33.3 при этом обещают None). Это
        выключало кэш ComfyUI для всей ноды и заставляло её на каждом Queue
        заново разбирать library.json (замер: 0.165 с на живой базе). Для смены
        режима отдельная проверка не нужна: `mode` — виджет, его значение входит
        в ключ кэша, поэтому переключение режима и без IS_CHANGED даёт перепрогон.
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

    def execute(self, mode="", selected="", save_folder="", pickup="", slots_out="", source=None, image=None,
                extra_pnginfo=None, unique_id=None, **kwargs):
        # Весь прогон узла держит общий с HTTP-роутами замок (§25.3.2): execute()
        # исполняется в потоке ComfyUI, а роуты — в event loop; без замка их циклы
        # «load -> mutate -> save» могли наложиться и потерять чужое изменение
        # (например, только что созданную вручную запись или удаление).
        with _DB_LOCK:
            return self._execute(mode, selected, save_folder, pickup, slots_out, source, image,
                                 extra_pnginfo, unique_id, **kwargs)

    def _execute(self, mode="", selected="", save_folder="", pickup="", slots_out="", source=None, image=None,
                 extra_pnginfo=None, unique_id=None, **kwargs):
        # mode может прийти как список (ComfyUI COMBO через map-over-list) —
        # приводим к строке, как уже делаем для pickup.
        if isinstance(mode, (list, tuple)):
            mode = mode[0] if len(mode) else ""
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
        # Подхват — это ЗАПИСЬ: токен ведёт в роут /save_pickup, а тот создаёт
        # запись и обложку. Значит он подчиняется режиму так же, как автосейв из
        # входа («Выдача» базу не трогает, §29.3). До v1.38 подхват режим
        # игнорировал: каждый Queue в «📤 Выдача» плодил записи из узла-источника
        # вместе с превью (поймано на живой базе — 4 записи за 03:31–03:43 со
        # снапшотом режима «📤 Выдача» и pickup = 1622).
        pickup_blocked = bool(pickup_node) and not save_on
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
                # v1.40: граф НЕ пишем inline (он тяжёлый) — ниже он уйдёт файлом
                entry_id, added = _add_entry(entries, incoming, fld, media=media)
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
                    if not _entry_has_workflow(e) and wf_copy:
                        # сам граф приедет отдельным файлом ниже (v1.40)
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
            # Граф — отдельным файлом (v1.40): старые записи с inline не трогаем
            if _attach_workflow(entries, entry_id, wf_copy):
                dirty = True
            if fld and fld not in folders:
                folders.append(fld)
                folders = sorted(set(folders) | set(_parent_folders(fld)))
                dirty = True
            entries = _trim_entries(entries)
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
        # Токена нет — сохранять нечего: в выдаче подхват выключен (см. выше).
        if pickup_node and not pickup_blocked:
            pickup_token = _pickup_stash(pickup_node, fld, _snapshot_workflow(extra_pnginfo))

        # 3. PNG-персистентность выбора и настроек (паттерн Prompt Keeper)
        if extra_pnginfo and unique_id is not None:
            try:
                workflow = extra_pnginfo.get("workflow")
                if workflow and "nodes" in workflow:
                    for node_data in workflow["nodes"]:
                        if str(node_data.get("id")) == str(unique_id):
                            # Порядок = порядок INPUT_TYPES required:
                            # mode, selected, save_folder, pickup, slots_out
                            # (prompt-виджет удалён в v1.7; slots_out — v1.44)
                            node_data["widgets_values"] = [mode, selected, save_folder, pickup, slots_out]
                            break
            except Exception:
                pass

        # Подсказка о неочевидном поведении выхода (совместимость со старыми
        # графами, где «Запись» стояла в разрыв перед CLIP).
        notice = ""
        if mode == self.MODE_WRITE and out_linked:
            notice = ("Режим «Запись»: провод от выхода подключён — текст идёт сквозь, "
                      "как раньше. Отключите провод, чтобы нода только сохраняла.")
        elif pickup_blocked:
            # Подхват настроен, а режим не пишет: молчать нельзя — выглядит как
            # «подхват сломался». Здесь же объясняем, что за это отвечает режим.
            notice = (f"Режим «{mode}» ничего не сохраняет: подхват из узла №{pickup_node} "
                      f"выключен. Чтобы сохранять финальный текст — «{self.MODE_BOTH}».")
        elif pickup_node and incoming:
            # Иначе выглядит как молчаливая потеря: на входе текст есть, а записи
            # из него нет (подхват берёт текст из другого узла после прогона).
            notice = (f"Подхват включён: входящий текст не сохраняется — запись "
                      f"берётся из узла №{pickup_node} после прогона.")

        # 3.2. Мультивывод (§40): доп. слоты 2-11 из категории «Выходы».
        # slots_out — JSON: [{i, kind: "card"|"folder", id или path+active_id}].
        # Текст слота = prompt записи; карточка без записи → «(запись удалена)».
        slot_texts = [""] * 10
        try:
            slots = _parse_slots(slots_out)
        except Exception:
            slots = []
        for s in slots:
            i = s.get("i")
            if not isinstance(i, int) or not (2 <= i <= 11):
                continue
            text = ""
            if s.get("kind") == "card":
                eid = s.get("id", "")
                for e in entries:
                    if e.get("id") == eid:
                        text = e.get("prompt", "")
                        break
                if not text:
                    text = "(запись удалена)"
            elif s.get("kind") == "folder":
                aid = s.get("active_id", "")
                for e in entries:
                    if e.get("id") == aid:
                        text = e.get("prompt", "")
                        break
            slot_texts[i - 2] = text

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
                # Тот же флаг, что у /list: для новых записей граф лежит файлом,
                # поэтому сырое e.get("workflow") здесь всегда давало false.
                "has_workflow": _entry_has_workflow(e),
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
                        # Подхват настроен, но режим ничего не сохраняет: клиент по
                        # этому флагу не выдаёт ложное «нода не исполнялась (кэш)».
                        "pickup_blocked": [pickup_node] if pickup_blocked else [],
                        "mode_notice": [notice]},
                # Порядок = порядок RETURN_NAMES: 0 — путь категории, 1 — основной
                # текст (prompt_1), дальше доп. слоты 2..11.
                "result": (_sanitize_folder_path(folder), out_text, *slot_texts)}


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
        # v1.40: граф лежит файлом (workflow_file); inline остаётся у старых
        c["has_workflow"] = _entry_has_workflow(e)
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
            # v1.40: граф может лежать файлом — чанк в новом превью обязан его
            # перенести, иначе карточка потеряет воркфлоу (§24.2)
            prev = _save_preview_upload(preview_data, entry_id, _entry_workflow(target))
            if not prev:
                return web.json_response({"error": "preview_data rejected"}, status=400)
        else:
            media = media_hint or ("video" if _is_video_file(src) else "image")
            try:
                arr = _load_media_frame(src)
            except Exception as exc:
                return web.json_response({"error": f"media read failed: {exc}"}, status=400)
            prev = _save_thumbnail(arr, entry_id, _entry_workflow(target))
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
        # Воркфлоу из токена: запись самодостаточна, как у автосейва из execute().
        # v1.40: граф — отдельным файлом, а не внутри library.json
        entry_id, created = _add_entry(entries, text, folder)
        if created:
            _attach_workflow(entries, entry_id, rec.get("workflow"))
            entries = _trim_entries(entries)
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
                # v1.40: граф досыпаем из workflows/{id}.json — клиент получает
                # ТО ЖЕ поле в том же виде, что и раньше (JS не менялся)
                out = dict(e)
                out["workflow"] = _entry_workflow(e)
                return web.json_response(out)
        return web.json_response({"error": "not found"}, status=404)

    @routes.get("/prompt_library/meta")
    @_locked_get
    async def _pl_meta(request):
        """Метаданные для HTML-галереи (v1.46, §41): читаем workflow-чанк
        прямо из превью-файла записи, без загрузки базы. Фолбэк — граф
        из /entry (`_entry_workflow`): для записей без PNG-чанка (legacy jpg,
        превью без workflow) галерея всё равно получит параметры.

        Возвращает {"id", "meta": {...}} — поля параметров (§41.2) или
        пустой dict, если распарсить нечего (тогда галерея говорит
        «нет данных прогона»)."""
        entry_id = request.query.get("id", "")
        f = _preview_path(entry_id)
        workflow = _preview_workflow_chunk(f)
        if workflow is None:
            entries, _ = _load_db()
            for e in entries:
                if e.get("id") == entry_id:
                    workflow = _entry_workflow(e)
                    break
        return web.json_response({"id": entry_id, "meta": _gen_meta(workflow) if workflow else {}})

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
            entries = _trim_entries(entries)
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
            # _norm_folder: " Фото/ " из чужого/устаревшего клиента не совпало бы
            # ни с одной записью (folder в базе уже нормализован _load_db)
            fp_set = {_norm_folder(f) for f in folder_paths if isinstance(f, str) and f}
            fp_set.discard("")
            for e in entries:
                if e.get("favorite"):
                    continue
                # Папка — это ПОДДЕРЕВО, как и везде остальном: перемещение,
                # удаление и экспорт категории берут и вложенные подпапки. До
                # v1.39 здесь было точное сравнение — бросок папки на ★ Избранное
                # отмечал только записи самой папки, а «Фото/Портреты» оставались
                # неотмеченными (ловилось прогоном: marked=1 при двух записях).
                ef = e.get("folder", "")
                if any(ef == f or ef.startswith(f + "/") for f in fp_set):
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
            _remove_workflow_file(entry_id)  # v1.40: и файл графа
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
        gone = [e for e in entries if e.get("id") in want]
        victims = [e.get("preview") for e in gone]
        new_entries = [e for e in entries if e.get("id") not in want]
        deleted = len(entries) - len(new_entries)
        if deleted:
            _save_db(new_entries, folders)
            for v in victims:
                _remove_preview_file(v)
            for e in gone:  # v1.40: файлы графов удалённых записей
                _remove_workflow_file(e.get("id"))
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
            # Папку заводим ТОЛЬКО если запись реально переехала (v1.39):
            # раньше условие было `if want` — по непустому списку id, и тогда
            # при устаревшем id (запись удалили в другой вкладке/ноде) в дереве
            # появлялась пустая категория-фантом и оставалась навсегда.
            if moved_entries:
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
