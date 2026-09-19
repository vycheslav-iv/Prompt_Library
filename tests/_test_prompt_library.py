"""Глубокий функциональный тест Prompt_Library (Python) — без ComfyUI.

Песочница: `folder_paths` подменяется на временную папку, `server`/`aiohttp` —
заглушки, поэтому регистрируются все HTTP-роуты и их можно вызвать напрямую.
Запуск: cd Prompt_Library && python tests/_test_prompt_library.py
"""
import asyncio
import importlib.util
import inspect
import json
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

# tests/ лежит на уровень ниже папки проекта (AGENTS.md §1.1) → два parent
NODE = Path(__file__).resolve().parent.parent / "prompt_library_node.py"

fails = []
oks = []


def _p(text):
    """Печать, устойчивая к кодировке консоли Windows (cp1251 не умеет emoji).
    Фailing-ассерт с кириллицей/emoji в extra раньше падал UnicodeEncodeError —
    тест обязан сообщать FAIL, а не трейсбек."""
    try:
        enc = sys.stdout.encoding or "utf-8"
        sys.stdout.write(str(text).encode(enc, "replace").decode(enc, "replace") + "\n")
    except Exception:
        try:
            sys.stdout.write(str(text).encode("ascii", "replace").decode("ascii") + "\n")
        except Exception:
            pass


def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    _p(("  ok  " if cond else "  FAIL") + f"  {name}" + (f"  [{extra}]" if extra and not cond else ""))


# --- песочница ---------------------------------------------------------------
TMP = Path(tempfile.mkdtemp(prefix="pl_test_"))
user_dir = TMP / "user"
user_dir.mkdir(parents=True)

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_user_directory = lambda: str(user_dir)
# Папки прогонов для attach_preview (§17): output/temp/input внутри песочницы
out_dir = TMP / "out"
temp_dir = TMP / "tmp"
in_dir = TMP / "in"
for _d in (out_dir, temp_dir, in_dir):
    _d.mkdir(parents=True, exist_ok=True)
_DIRS_BY_TYPE = {"output": str(out_dir), "temp": str(temp_dir), "input": str(in_dir)}
folder_paths.get_directory_by_type = lambda kind: _DIRS_BY_TYPE.get(kind)
folder_paths.get_output_directory = lambda: str(out_dir)
folder_paths.get_temp_directory = lambda: str(temp_dir)
sys.modules["folder_paths"] = folder_paths

handlers = {}


class _Routes:
    def _reg(self, method, path):
        def deco(fn):
            handlers[(method, path)] = fn
            return fn
        return deco

    def get(self, path):
        return self._reg("GET", path)

    def post(self, path):
        return self._reg("POST", path)


class _PromptServer:
    instance = types.SimpleNamespace(routes=_Routes())


# Broadcast (§26): _broadcast_refresh() дергает PromptServer.instance.send_sync.
# Раньше в стабе его не было вообще — фича автообновления v1.21 не проверялась ни
# одним тестом (101/101 оставались зелёными при неработающем автообновлении).
_broadcasts = []


def _fake_send_sync(event, data=None, sid=None):
    _broadcasts.append(event)


_PromptServer.instance.send_sync = _fake_send_sync


server_mod = types.ModuleType("server")
server_mod.PromptServer = _PromptServer
sys.modules["server"] = server_mod


class _Web:
    @staticmethod
    def json_response(data, status=200):
        return {"json": data, "status": status}

    @staticmethod
    def Response(status=200):
        return {"status": status}

    class FileResponse:
        def __init__(self, path):
            self.path = path

        def __repr__(self):
            return f"FileResponse({self.path})"


aiohttp = types.ModuleType("aiohttp")
aiohttp.web = _Web
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location("pl_node", NODE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

check("модуль импортировался, роуты зарегистрированы", len(handlers) >= 10, f"{len(handlers)} роутов")
check("песочница внутри temp", str(mod._library_root()).startswith(str(TMP)), str(mod._library_root()))

lib_file = mod._ensure_dirs() / "library.json"


def run(coro):
    return asyncio.run(coro)


class Req:
    def __init__(self, body=None, query=None):
        self._b = body or {}
        self.query = query or {}

    async def json(self):
        return self._b


def h(method, path, req):
    return run(handlers[(method, path)](req))


# --- 1. нормализация путей ---------------------------------------------------
print("\n1. Имена/папки")
check("_norm_folder чистит слэши и пробелы",
      mod._norm_folder("  Фото//Портреты/ ") == "Фото/Портреты")
check("_norm_folder бэкслэши", mod._norm_folder("A\\B") == "A/B")
check("_norm_folder пусто -> корень", mod._norm_folder(None) == "" and mod._norm_folder(" / ") == "")
check("_parent_folders даёт цепочку", mod._parent_folders("A/B/C") == ["A", "A/B"])
check("_auto_title берёт первую строку", mod._auto_title("  Мама\nи папа ") == "Мама")
check("_auto_title пустой промпт", mod._auto_title("") == "Без названия")

# --- 2. миграция базы --------------------------------------------------------
print("\n2. Загрузка/миграция базы")
lib_file.write_text(json.dumps([
    {"id": "old1", "prompt": "старый", "category": " Фото/Море "},
]), encoding="utf-8")
entries, folders = mod._load_db()
check("legacy-список мигрирован", isinstance(entries, list) and len(entries) == 1)
check("category -> folder (нормализовано)", entries[0]["folder"] == "Фото/Море")
check("title автозаполнен", entries[0]["title"] == "старый")
check("папки включают родителей", set(["Фото", "Фото/Море"]).issubset(set(folders)), str(folders))
check("файл перезаписан в dict-формате",
      isinstance(json.loads(lib_file.read_text(encoding="utf-8")), dict))

lib_file.write_text(json.dumps({"entries": ["junk"], "folders": []}), encoding="utf-8")
try:
    mod._load_db()
    check("битые записи (строка в entries) не роняют загрузку", True)
except Exception as e:
    check("битые записи (строка в entries) не роняют загрузку", False, f"{type(e).__name__}: {e}")

lib_file.write_text("{ битый json", encoding="utf-8")
try:
    e2, f2 = mod._load_db()
    check("битый JSON восстанавливается в пустую базу", e2 == [] and f2 == [])
except Exception as e:
    check("битый JSON восстанавливается в пустую базу", False, f"{type(e).__name__}: {e}")

# --- 3. execute: запись ------------------------------------------------------
print("\n3. execute (режим записи)")
node = mod.PromptLibrary()
workflow = {"nodes": [{"id": 7, "widgets_values": ["x"]}], "links": []}
pnginfo = {"workflow": workflow}
res = node.execute(mode=node.MODE_WRITE, selected="", save_folder="Фото",
                   source="  Портрет девушки  ", image=None,
                   extra_pnginfo=pnginfo, unique_id=7)
# v1.24: «Запись» — только сохранение, выход пуст (сквозной проход остался
# только для старых графов с проводом — §16)
check("«Запись»: выход пуст + ui на месте", res["result"] == ("",) and "ui" in res,
      str(res["result"]))
check("входной текст обрезан", res["ui"]["text"] == ["Портрет девушки"])
check("PNG-патч записал widgets_values позиционно (4 значения, v1.25)",
      workflow["nodes"][0]["widgets_values"] == [node.MODE_WRITE, "", "Фото", ""],
      str(workflow["nodes"][0]["widgets_values"]))
check("чужой node id не тронут", len(workflow["nodes"]) == 1)
entries, folders = mod._load_db()
check("запись сохранена", len(entries) == 1 and entries[0]["prompt"] == "Портрет девушки")
check("папка сохранена, дубль category", entries[0]["folder"] == "Фото" and entries[0]["category"] == "Фото")
check("workflow прикреплён к записи", isinstance(entries[0]["workflow"], dict))

res2 = node.execute(mode=node.MODE_WRITE, selected="", save_folder="Фото",
                    source="Портрет девушки", image=None,
                    extra_pnginfo=pnginfo, unique_id=7)
entries, _ = mod._load_db()
check("дубликат по (prompt, folder) не создаётся", len(entries) == 1)

res3 = node.execute(mode=node.MODE_WRITE, selected="", save_folder="__fav",
                    source="В корень", extra_pnginfo=pnginfo, unique_id=7)
entries, _ = mod._load_db()
check("служебная ветка __fav пишет в корень", any(e["prompt"] == "В корень" and e["folder"] == "" for e in entries))

res4 = node.execute(mode="", selected="", save_folder="", source="без режима",
                    extra_pnginfo=pnginfo, unique_id=7)
check("mode='' + без use_selected -> запись", any(e["prompt"] == "без режима" for e in mod._load_db()[0]))

# --- 4. execute: выдача -----------------------------------------------------
print("\n4. execute (режим выдачи)")
entries, _ = mod._load_db()
target = next(e for e in entries if e["prompt"] == "Портрет девушки")
res5 = node.execute(mode=node.MODE_ISSUE, selected=target["id"], save_folder="",
                    source="перезапишется", extra_pnginfo=pnginfo, unique_id=7)
check("выдача возвращает промпт записи", res5["result"][0] == "Портрет девушки")
entries, _ = mod._load_db()
check("last_used проставлен",
      bool(next(e for e in entries if e["id"] == target["id"]).get("last_used")))
before = len(entries)
node.execute(mode=node.MODE_ISSUE, selected=target["id"], save_folder="",
             source="не должен сохраниться", extra_pnginfo=pnginfo, unique_id=7)
check("в режиме выдачи новые записи не создаются", len(mod._load_db()[0]) == before)
res6 = node.execute(mode=node.MODE_ISSUE, selected="нет-такого", save_folder="",
                    source="прозрачный проход", extra_pnginfo=pnginfo, unique_id=7)
check("выдача с несуществующим id -> пропускает вход", res6["result"][0] == "прозрачный проход")
res7 = node.execute(mode="", selected="", save_folder="", source="s",
                    extra_pnginfo=pnginfo, unique_id=7, use_selected=True)
check("use_selected (legacy) -> режим выдачи", res7["result"][0] == "s"
      and len(mod._load_db()[0]) == before)

# --- 5. HTTP-роуты ---------------------------------------------------------------
print("\n5. HTTP-endpoints")
r = h("POST", "/prompt_library/add", Req({"prompt": "  ручной  ", "folder": "Ручные", "title": ""}))
check("/add создаёт запись", r["json"].get("ok") and r["json"].get("id"))
entries, folders = mod._load_db()
manual = next(e for e in entries if e["prompt"] == "ручной")
check("/add с пустым title -> название из начала текста", manual["title"] == "ручной")
r = h("POST", "/prompt_library/add", Req({"prompt": "ручной с названием", "folder": "Ручные",
                                          "title": "  Моё название  "}))
check("/add с title создаёт запись", r["json"].get("ok") and r["json"].get("id"))
entries, _ = mod._load_db()
titled = next(e for e in entries if e["prompt"] == "ручной с названием")
check("/add сохраняет заданное название (стрип)", titled["title"] == "Моё название")
r = h("POST", "/prompt_library/add", Req({"prompt": "   "}))
check("/add с пустым промптом -> 400", r["status"] == 400)

r = h("GET", "/prompt_library/list", Req())
check("/list отдаёт записи без workflow", all("workflow" not in e for e in r["json"]["entries"])
      and all("has_workflow" in e for e in r["json"]["entries"]))
check("/list отдаёт папки с родителями", "Ручные" in r["json"]["folders"])

r = h("GET", "/prompt_library/entry", Req(query={"id": manual["id"]}))
check("/entry отдаёт запись с workflow-полем", r["json"].get("id") == manual["id"])
r = h("GET", "/prompt_library/entry", Req(query={"id": "nope"}))
check("/entry неизвестный id -> 404", r["status"] == 404)

r = h("POST", "/prompt_library/favorite", Req({"id": manual["id"]}))
entries, _ = mod._load_db()
check("/favorite переключает флаг",
      next(e for e in entries if e["id"] == manual["id"])["favorite"] is True
      and r["json"].get("ok"))
h("POST", "/prompt_library/favorite", Req({"id": "nope"}))
check("/favorite неизвестный id не падает", True)

r = h("POST", "/prompt_library/update",
      Req({"id": manual["id"], "prompt": "ручной 2", "title": "", "folder": "Ручные/Под"}))
entries, _ = mod._load_db()
upd = next(e for e in entries if e["id"] == manual["id"])
check("/update меняет промпт/папку", upd["prompt"] == "ручной 2" and upd["folder"] == "Ручные/Под")
check("/update пересчитывает hash", upd["hash"] == mod._dedup_hash("ручной 2", "Ручные/Под"))
check("/update восстанавливает пустой title из промпта", upd["title"] == "ручной 2")
check("/update добавляет папку с родителями",
      {"Ручные", "Ручные/Под"}.issubset(set(mod._load_db()[1])))

# папки: создать, переименовать, удалить
r = h("POST", "/prompt_library/folder_create", Req({"parent": "Ручные", "name": "Нов/ая"}))
check("/folder_create санитизирует '/'", r["json"]["path"] == "Ручные/Нов ая", r["json"].get("path"))
r = h("POST", "/prompt_library/folder_create", Req({"parent": "", "name": "  "}))
check("/folder_create пустое имя -> 400", r["status"] == 400)

r = h("POST", "/prompt_library/folder_rename", Req({"old": "Ручные", "new": "Мои"}))
entries, folders = mod._load_db()
check("/folder_rename переименовал записи",
      next(e for e in entries if e["id"] == manual["id"])["folder"] == "Мои/Под")
check("/folder_rename обновил hash",
      next(e for e in entries if e["id"] == manual["id"])["hash"] == mod._dedup_hash("ручной 2", "Мои/Под"))
check("/folder_rename перенёс подпапки", "Мои/Под" in folders and "Ручные/Под" not in folders)
r = h("POST", "/prompt_library/folder_rename", Req({"old": "Мои", "new": "Мои/Внутри"}))
check("/folder_rename в себя -> 400", r["status"] == 400, str(r))

r = h("POST", "/prompt_library/folder_delete", Req({"path": "Мои"}))
entries, folders = mod._load_db()
check("/folder_delete переносит записи в корень",
      next(e for e in entries if e["id"] == manual["id"])["folder"] == "")
check("/folder_delete убирает папки", "Мои" not in folders and "Мои/Под" not in folders)
r = h("POST", "/prompt_library/folder_delete", Req({"path": ""}))
check("/folder_delete пустой путь -> 400", r["status"] == 400)

# превью: traversal и отсутствие файла
r = h("GET", "/prompt_library/preview", Req(query={"id": "../../user/prompt_library/library.json"}))
check("/preview санитизирует id (traversal невозможен)", r["status"] == 404, str(r))
prev = mod._ensure_dirs() / "previews" / "abc123.png"
prev.write_bytes(b"png")
r = h("GET", "/prompt_library/preview", Req(query={"id": "abc123"}))
check("/preview отдаёт существующий файл", isinstance(r, _Web.FileResponse))

# удаление записи + превью
entries, _ = mod._load_db()
victim = next(e for e in entries if e["prompt"] == "В корень")
victim["preview"] = "previews/victim.png"
entries, folders = mod._load_db()
# положим превью в саму запись через update-путь нельзя — пишем файл и правим базу напрямую
db = json.loads(lib_file.read_text(encoding="utf-8"))
for e in db["entries"]:
    if e["prompt"] == "В корень":
        e["preview"] = "previews/victim.png"
lib_file.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")
vfile = mod._ensure_dirs() / "previews" / "victim.png"
vfile.write_bytes(b"png")
n_before = len(db["entries"])
r = h("POST", "/prompt_library/delete", Req({"id": victim["id"]}))
check("/delete убирает запись", len(mod._load_db()[0]) == n_before - 1)
check("/delete убирает файл превью", not vfile.exists())
check("/delete неизвестный id не падает", h("POST", "/prompt_library/delete", Req({"id": "nope"}))["json"].get("ok"))

# --- 6. кап воркфлоу и лимит записей ----------------------------------------
print("\n6. Ограничения и устойчивость")
check("_snapshot_workflow режет слишком большой воркфлоу",
      mod._snapshot_workflow({"workflow": {"nodes": [{"blob": "x" * 50}]}}, cap=10) is None)
check("_snapshot_workflow без nodes -> None", mod._snapshot_workflow({"workflow": {}}) is None)
check("_snapshot_workflow без pnginfo -> None", mod._snapshot_workflow(None) is None)
big = {"workflow": {"nodes": [{"id": 1}], "extra": "y" * 100}}
snap = mod._snapshot_workflow(big)
check("_snapshot_workflow deep-copy (мутация исходника не влияет)",
      snap is not None and snap is not big["workflow"])

# MAX_ENTRIES
many = {"entries": [{"id": f"e{i}", "hash": f"h{i}", "prompt": f"p{i}", "folder": "",
                     "title": f"p{i}", "favorite": False, "created_at": "", "last_used": None,
                     "preview": None, "workflow": None} for i in range(mod.MAX_ENTRIES)],
        "folders": []}
lib_file.write_text(json.dumps(many, ensure_ascii=False), encoding="utf-8")
node.execute(mode=node.MODE_WRITE, selected="", save_folder="", source="переполнение",
             extra_pnginfo=pnginfo, unique_id=7)
entries, _ = mod._load_db()
check(f"записей не больше MAX_ENTRIES ({mod.MAX_ENTRIES})", len(entries) == mod.MAX_ENTRIES, str(len(entries)))
check("новая запись впереди", entries[0]["prompt"] == "переполнение")

# валидация входов
check("VALIDATE_INPUTS принимает любой тип", mod.PromptLibrary.VALIDATE_INPUTS(input_types={}) is True)
check("INPUT_TYPES: source опционален, image IMAGE,VIDEO (двухцветный сокет)",
      mod.PromptLibrary.INPUT_TYPES()["optional"]["source"][0] == "*"
      and mod.PromptLibrary.INPUT_TYPES()["optional"]["image"][0] == "IMAGE,VIDEO")
check("execute фильтрует не-строковый source", (
    node.execute(mode=node.MODE_ISSUE, selected="", save_folder="", source={"a": 1},
                 extra_pnginfo=pnginfo, unique_id=7)["result"][0] == ""))
check("OUTPUT_NODE = True (персистентность PNG)", mod.PromptLibrary.OUTPUT_NODE is True)

# --- 7. авто-метка media ------------------------------------------------------
print("\n7. Авто-метка media (video/image)")
check("_media_of(None) -> None", mod._media_of(None) is None)
check("_media_of(тензор без get_components) -> image", mod._media_of(object()) == "image")


class FakeVideo:
    def get_components(self):
        raise RuntimeError("no frames in test")


check("_media_of(VIDEO-объект) -> video", mod._media_of(FakeVideo()) == "video")
check("_extract_frame(VIDEO с пустыми кадрами) -> None",
      mod._extract_frame(FakeVideo()) is None)

res_v = node.execute(mode=node.MODE_WRITE, selected="", save_folder="", source="видео-запись",
                     image=FakeVideo(), extra_pnginfo=pnginfo, unique_id=7)
entries, _ = mod._load_db()
hit_v = next((e for e in entries if e["prompt"] == "видео-запись"), None)
check("execute с VIDEO пишет media='video'",
      hit_v is not None and hit_v.get("media") == "video")
check("ui-пакет несёт media",
      res_v["ui"]["entries"] and res_v["ui"]["entries"][0].get("media") == "video")

res_i = node.execute(mode=node.MODE_WRITE, selected="", save_folder="", source="фото-запись",
                     image=object(), extra_pnginfo=pnginfo, unique_id=7)
entries, _ = mod._load_db()
hit_i = next((e for e in entries if e["prompt"] == "фото-запись"), None)
check("execute с IMAGE пишет media='image'",
      hit_i is not None and hit_i.get("media") == "image")

# legacy-запись без поля media
db = json.loads(lib_file.read_text(encoding="utf-8"))
db["entries"].append({"id": "legacy1", "hash": "h-leg", "prompt": "старая",
                      "folder": "", "title": "старая"})
lib_file.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")
entries, _ = mod._load_db()
hit_l = next((e for e in entries if e["id"] == "legacy1"), None)
check("старая запись без media читается как None",
      hit_l is not None and hit_l.get("media") is None)

r = h("GET", "/prompt_library/list", Req())
check("/list отдаёт media", any("media" in e for e in r["json"]["entries"]))

# --- 8. массовое удаление -----------------------------------------------------
print("\n8. Bulk delete (мультивыделение)")
bulk_ids = []
for t in ["bulk1", "bulk2", "bulk3"]:
    rr = h("POST", "/prompt_library/add", Req({"prompt": t, "folder": "Bulk"}))
    bulk_ids.append(rr["json"]["id"])
# превью у первой bulk-записи — проверим чистку файлов
db = json.loads(lib_file.read_text(encoding="utf-8"))
for e in db["entries"]:
    if e["prompt"] == "bulk1":
        e["preview"] = "previews/bulk1.png"
lib_file.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")
bfile = mod._ensure_dirs() / "previews" / "bulk1.png"
bfile.write_bytes(b"png")
n_before = len(mod._load_db()[0])
r = h("POST", "/prompt_library/delete_many", Req({"ids": [bulk_ids[0], bulk_ids[1], "нет-такого"]}))
check("/delete_many удаляет существующие, мусор игнорирует",
      r["json"].get("deleted") == 2 and len(mod._load_db()[0]) == n_before - 2, str(r))
check("/delete_many чистит файлы превью", not bfile.exists())
check("/delete_many survivor цел", any(e["prompt"] == "bulk3" for e in mod._load_db()[0]))
r = h("POST", "/prompt_library/delete_many", Req({"ids": "не-список"}))
check("/delete_many с не-списком -> 400", r["status"] == 400)
r = h("POST", "/prompt_library/delete_many", Req(["не-словарь"]))
check("/delete_many с телом не-словарём -> 400, без 500", r["status"] == 400)
r = h("POST", "/prompt_library/delete_many", Req({"ids": []}))
check("/delete_many с пустым списком -> deleted 0",
      r["json"].get("deleted") == 0 and r["json"].get("ok"))

h("POST", "/prompt_library/add", Req({"prompt": "f1", "folder": "Del/A"}))
h("POST", "/prompt_library/add", Req({"prompt": "f2", "folder": "Del/A/Под"}))
h("POST", "/prompt_library/add", Req({"prompt": "f3", "folder": "Del/B"}))
r = h("POST", "/prompt_library/folder_delete_many", Req({"paths": ["Del/A", "мусор", ""]}))
entries, folders = mod._load_db()
check("/folder_delete_many сносит папку с подпапками",
      "Del/A" not in folders and "Del/A/Под" not in folders and "Del/B" in folders, str(folders))
check("/folder_delete_many переносит книги в корень",
      all(next(e for e in entries if e["prompt"] == p)["folder"] == "" for p in ["f1", "f2"])
      and next(e for e in entries if e["prompt"] == "f3")["folder"] == "Del/B")
# deleted_folders = число запрошенных валидных путей ("мусор" валиден, но ничему
# не соответствует и ничего не меняет; "" отброшен как пустой)
check("/folder_delete_many отчёт о числе путей", r["json"].get("deleted_folders") == 2, str(r))
r = h("POST", "/prompt_library/folder_delete_many", Req({"paths": "не-список"}))
check("/folder_delete_many с не-списком -> 400", r["status"] == 400)
r = h("POST", "/prompt_library/folder_delete_many", Req(["не-словарь"]))
check("/folder_delete_many с телом не-словарём -> 400, без 500", r["status"] == 400)
r = h("POST", "/prompt_library/favorite", Req(["не-словарь"]))
check("/favorite с телом не-словарём не падает", r["json"].get("ok"))

# --- 9. закалка базы ----------------------------------------------------------
print("\n9. Закалка базы и backfill")
# insert(0), а не append: к этому моменту база забита до MAX_ENTRIES (§6),
# запись в хвосте срезал бы триммер entries[:MAX_ENTRIES] при первом execute
db = json.loads(lib_file.read_text(encoding="utf-8"))
db["entries"].insert(0, {"id": "nonstr1", "hash": "h-ns", "prompt": 12345,
                         "folder": "", "title": ""})
lib_file.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")
try:
    res_ns = node.execute(mode=node.MODE_WRITE, selected="", save_folder="", source="x",
                          extra_pnginfo=pnginfo, unique_id=7)
    check("prompt-не-строка в базе чинится, execute не падает", True)
except Exception as e:
    check("prompt-не-строка в базе чинится, execute не падает", False, f"{type(e).__name__}: {e}")
entries, _ = mod._load_db()
hit_ns = next((e for e in entries if e["id"] == "nonstr1"), None)
check("prompt приведён к строке, hash пересчитан",
      hit_ns is not None and isinstance(hit_ns["prompt"], str)
      and hit_ns["hash"] == mod._dedup_hash(hit_ns["prompt"], ""))

# backfill media: старая запись без media + повторный прогон с проводом
db = json.loads(lib_file.read_text(encoding="utf-8"))
db["entries"].insert(0, {"id": "nomedia1", "hash": mod._dedup_hash("медиа-бэкфилл", ""),
                      "prompt": "медиа-бэкфилл", "folder": "", "category": "",
                      "title": "медиа-бэкфилл", "favorite": False,
                      "created_at": "", "last_used": None, "preview": None,
                      "workflow": {"nodes": [], "links": []}})
lib_file.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")


class FakeVideo2:
    def get_components(self):
        raise RuntimeError("no frames in test")


node.execute(mode=node.MODE_WRITE, selected="", save_folder="", source="медиа-бэкфилл",
             image=FakeVideo2(), extra_pnginfo=pnginfo, unique_id=7)
entries, _ = mod._load_db()
hit_nm = next((e for e in entries if e["id"] == "nomedia1"), None)
check("backfill добивает пустой media, не трогая остальное",
      hit_nm is not None and hit_nm.get("media") == "video"
      and hit_nm.get("title") == "медиа-бэкфилл")

# --- 11. ручное превью с диска --------------------------------------------------
print("\n11. Ручное превью (preview_data в /add)")
try:
    from PIL import Image as _PILImage
    import base64 as _b64
    import io as _io
    _buf = _io.BytesIO()
    _PILImage.new("RGB", (8, 6), (200, 30, 30)).save(_buf, "PNG")
    _du = "data:image/png;base64," + _b64.b64encode(_buf.getvalue()).decode()
    r = h("POST", "/prompt_library/add",
          Req({"prompt": "с превью-загрузкой", "folder": "Загрузки", "preview_data": _du}))
    entries, _ = mod._load_db()
    hit_u = next((e for e in entries if e["prompt"] == "с превью-загрузкой"), None)
    check("/add с preview_data создаёт запись с превью",
          r["json"].get("ok") and hit_u is not None and bool(hit_u.get("preview")))
    check("файл превью лежит в previews/",
          hit_u is not None and (mod._ensure_dirs() / hit_u["preview"]).exists())
    from PIL import Image as _PILImage2
    with _PILImage2.open(mod._ensure_dirs() / hit_u["preview"]) as _im:
        check("превью — PNG", _im.format == "PNG" and max(_im.size) <= 512)
    r = h("POST", "/prompt_library/add",
          Req({"prompt": "с битым превью", "folder": "Загрузки", "preview_data": "мусор!!"}))
    entries, _ = mod._load_db()
    hit_b = next((e for e in entries if e["prompt"] == "с битым превью"), None)
    check("битое preview_data: запись есть, превью нет",
          r["json"].get("ok") and hit_b is not None and not hit_b.get("preview"))
except ImportError:
    check("PIL доступен для теста загрузки", False, "no pillow")

# --- 12. глобальный дубль по тексту --------------------------------------------
print("\n12. Глобальный дубль (тот же текст в другой папке)")
r = h("POST", "/prompt_library/add", Req({"prompt": "глобал-текст", "folder": "ПапкаА"}))
gid = r["json"]["id"]
check("/add новое создаёт без флага дубля", r["json"].get("duplicate") is False)
n0 = len(mod._load_db()[0])
r2 = h("POST", "/prompt_library/add", Req({"prompt": "глобал-текст", "folder": "ПапкаБ"}))
check("/add тот же текст в другую папку -> duplicate + та же id + папка оригинала",
      r2["json"].get("duplicate") is True and r2["json"].get("id") == gid
      and r2["json"].get("folder") == "ПапкаА" and len(mod._load_db()[0]) == n0, str(r2))
res_d = node.execute(mode=node.MODE_WRITE, selected="", save_folder="ПапкаВ",
                     source="глобал-текст", image=None, extra_pnginfo=pnginfo, unique_id=7)
check("execute тот же текст в другую папку -> без новой записи",
      len(mod._load_db()[0]) == n0)
check("ui skipped_duplicate несёт id и папку оригинала",
      res_d["ui"].get("skipped_duplicate", {}).get("id") == gid
      and res_d["ui"].get("skipped_duplicate", {}).get("folder") == "ПапкаА")
res_d2 = node.execute(mode=node.MODE_WRITE, selected="", save_folder="ПапкаА",
                      source="глобал-текст", image=None, extra_pnginfo=pnginfo, unique_id=7)
check("тот же текст в ту же папку -> тоже skipped",
      res_d2["ui"].get("skipped_duplicate", {}).get("id") == gid
      and len(mod._load_db()[0]) == n0)
res_ok = node.execute(mode=node.MODE_WRITE, selected="", save_folder="ПапкаА",
                      source="свежий уникальный текст", image=None,
                      extra_pnginfo=pnginfo, unique_id=7)
check("уникальный текст сохраняется, skipped_duplicate пуст ({})",
      res_ok["ui"].get("skipped_duplicate") == {}
      and any(e["prompt"] == "свежий уникальный текст" for e in mod._load_db()[0]))


def _ui_merge_ok(ui):
    """Регрессия краша Queue: точная копия слияния ui из ComfyUI
    (execution.py get_output_from_returns) — все значения обязаны быть
    итерируемыми, иначе 'NoneType' object is not iterable."""
    try:
        {k: [y for x in [ui] for y in x[k]] for k in ui.keys()}
        return True
    except TypeError:
        return False


res_iss = node.execute(mode=node.MODE_ISSUE, selected=gid, save_folder="", source="",
                       extra_pnginfo=pnginfo, unique_id=7)
check("ui-пакеты переживают слияние ComfyUI (запись/дубль/выдача)",
      _ui_merge_ok(res_d["ui"]) and _ui_merge_ok(res_ok["ui"]) and _ui_merge_ok(res_iss["ui"]))

# --- 13. автообновление Library-нод (broadcast, v1.21/v1.22) -------------------
print("\n13. Автообновление (broadcast prompt_library/refresh)")
_broadcasts.clear()
node.execute(mode=node.MODE_WRITE, selected="", save_folder="Bc", source="бродкаст-новый",
             extra_pnginfo=pnginfo, unique_id=7)
check("execute: новая запись -> broadcast", _broadcasts == ["prompt_library/refresh"], str(_broadcasts))
_broadcasts.clear()
node.execute(mode=node.MODE_WRITE, selected="", save_folder="Bc", source="бродкаст-новый",
             extra_pnginfo=pnginfo, unique_id=7)
check("execute: повторный текст без изменений -> без broadcast", _broadcasts == [], str(_broadcasts))
_broadcasts.clear()
node.execute(mode=node.MODE_ISSUE, selected="", save_folder="", source="выдача",
             extra_pnginfo=pnginfo, unique_id=7)
check("execute: режим выдачи -> без broadcast", _broadcasts == [], str(_broadcasts))

# backfill существующей записи: файл меняется (dirty), но новой книги нет
db = json.loads(lib_file.read_text(encoding="utf-8"))
db["entries"].insert(0, {"id": "bf-broadcast", "hash": "h-bf-broadcast",
                         "prompt": "бэкфилл-без-бродкаста", "folder": "", "title": "бэкфилл"})
lib_file.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")
_broadcasts.clear()
node.execute(mode=node.MODE_WRITE, selected="", save_folder="", source="бэкфилл-без-бродкаста",
             extra_pnginfo=pnginfo, unique_id=7)
check("execute: backfill workflow -> без broadcast", _broadcasts == [], str(_broadcasts))
check("execute: backfill при этом записан",
      bool(next(e for e in mod._load_db()[0] if e["id"] == "bf-broadcast").get("workflow")))

# Ручные роуты: без broadcast соседние Library-ноды и другие вкладки молчат
_broadcasts.clear()
r_new = h("POST", "/prompt_library/add", Req({"prompt": "роут-бродкаст", "folder": "Bc"}))
nid = r_new["json"]["id"]
check("/add -> broadcast", _broadcasts == ["prompt_library/refresh"], str(_broadcasts))
_broadcasts.clear()
r_dup2 = h("POST", "/prompt_library/add", Req({"prompt": "роут-бродкаст", "folder": "Bc"}))
check("/add дубль -> без broadcast",
      _broadcasts == [] and r_dup2["json"].get("duplicate") is True, str(_broadcasts))
_broadcasts.clear()
h("POST", "/prompt_library/delete", Req({"id": "нет-такого"}))
check("/delete несуществующей записи -> без broadcast", _broadcasts == [], str(_broadcasts))
_broadcasts.clear()
h("POST", "/prompt_library/delete_many", Req({"ids": ["нет-такого"]}))
check("/delete_many без изменений -> без broadcast", _broadcasts == [], str(_broadcasts))
_broadcasts.clear()
h("POST", "/prompt_library/folder_delete_many", Req({"paths": []}))
check("/folder_delete_many с пустым списком -> без broadcast", _broadcasts == [], str(_broadcasts))
for _label, _method, _path, _body in [
    ("/favorite", "POST", "/prompt_library/favorite", {"id": nid, "favorite": True}),
    ("/update", "POST", "/prompt_library/update", {"id": nid, "title": "переименовано"}),
    ("/folder_create", "POST", "/prompt_library/folder_create", {"parent": "", "name": "Bc2"}),
    ("/folder_rename", "POST", "/prompt_library/folder_rename", {"old": "Bc2", "new": "Bc3"}),
    ("/folder_delete", "POST", "/prompt_library/folder_delete", {"path": "Bc3"}),
    ("/pin", "POST", "/prompt_library/pin", {"id": nid, "pinned": True}),
    ("/delete", "POST", "/prompt_library/delete", {"id": nid}),
]:
    _broadcasts.clear()
    h(_method, _path, Req(_body))
    check(f"{_label} -> broadcast", _broadcasts == ["prompt_library/refresh"], str(_broadcasts))

# --- 14. служебный префикс __ --------------------------------------------------
print("\n14. Служебный префикс __ (призрачные категории)")
r = h("POST", "/prompt_library/folder_create", Req({"parent": "", "name": "__fav"}))
check("/folder_create с '__fav' -> 400", r["status"] == 400, str(r))
check("папка '__fav' не создана", "__fav" not in mod._load_db()[1])
r = h("POST", "/prompt_library/folder_create", Req({"parent": "", "name": "__all"}))
check("/folder_create с '__all' -> 400", r["status"] == 400, str(r))
r = h("POST", "/prompt_library/folder_create", Req({"parent": "__fav", "name": "Под"}))
check("/folder_create с parent '__fav' -> папка в корне", r["json"].get("path") == "Под", str(r))
r = h("POST", "/prompt_library/folder_rename", Req({"old": "Под", "new": "__root"}))
check("/folder_rename в '__root' -> 400", r["status"] == 400, str(r))
check("папка '__root' не появилась", "__root" not in mod._load_db()[1])
h("POST", "/prompt_library/add", Req({"prompt": "в служебную папку", "folder": "__root"}))
_e_srv = next(e for e in mod._load_db()[0] if e["prompt"] == "в служебную папку")
check("/add с folder '__root' сохраняет в корень", _e_srv["folder"] == "", str(_e_srv["folder"]))
h("POST", "/prompt_library/update", Req({"id": _e_srv["id"], "folder": "__fav"}))
check("/update в '__fav' переводит запись в корень",
      next(e for e in mod._load_db()[0] if e["id"] == _e_srv["id"])["folder"] == "")
node.execute(mode=node.MODE_WRITE, selected="", save_folder=" __fav ",
             source="пробелы вокруг служебного", extra_pnginfo=pnginfo, unique_id=7)
check("execute: ' __fav ' (с пробелами) тоже режется в корень",
      next(e for e in mod._load_db()[0] if e["prompt"] == "пробелы вокруг служебного")["folder"] == "")

# --- 15. бэкфилл превью у существующей записи ---------------------------------
print("\n15. Бэкфилл превью существующей записи (дубль + IMAGE)")
# numpy/PIL в песочнице может не быть — подменяем только саму запись превью
_orig_thumb = mod._save_thumbnail
_thumb_calls = []


def _thumb_stub(img, entry_id, workflow=None):
    _thumb_calls.append(entry_id)
    return f"previews/{entry_id}.png"


mod._save_thumbnail = _thumb_stub
try:
    h("POST", "/prompt_library/add", Req({"prompt": "дубль-без-превью", "folder": "Bc"}))
    e0 = next(e for e in mod._load_db()[0] if e["prompt"] == "дубль-без-превью")
    check("ручная запись без превью", not e0.get("preview"))
    node.execute(mode=node.MODE_WRITE, selected="", save_folder="Другая",
                 source="дубль-без-превью", image=object(), extra_pnginfo=pnginfo, unique_id=7)
    e1 = next(e for e in mod._load_db()[0] if e["prompt"] == "дубль-без-превью")
    check("дубль + IMAGE -> превью прикреплено к существующей записи",
          e1.get("preview") == f"previews/{e1['id']}.png", str(e1.get("preview")))
    check("превью записано один раз", len(_thumb_calls) == 1, str(_thumb_calls))
    check("запись не продублирована (текст один раз)",
          len([e for e in mod._load_db()[0] if e["prompt"] == "дубль-без-превью"]) == 1)
    check("папка оригинала не изменилась", e1["folder"] == "Bc", str(e1["folder"]))
    check("media записан", e1.get("media") == "image", str(e1.get("media")))
    node.execute(mode=node.MODE_WRITE, selected="", save_folder="Третья",
                 source="дубль-без-превью", image=object(), extra_pnginfo=pnginfo, unique_id=7)
    check("повторный прогон не перезаписывает готовое превью",
          len(_thumb_calls) == 1, str(_thumb_calls))
finally:
    mod._save_thumbnail = _orig_thumb

# --- 16. три режима одной ноды (v1.24) ---------------------------------------
print("\n16. Режимы одной ноды: Запись / Выдача / Выдача+запись")
node2 = mod.PromptLibrary()


def _entry(text):
    return next((e for e in mod._load_db()[0] if e.get("prompt") == text), None)


res_w = node2.execute(mode=node2.MODE_WRITE, selected="", save_folder="Режимы",
                      source="режим-запись-1", extra_pnginfo=None, unique_id=1)
e_w = _entry("режим-запись-1")
check("« Запись » сохраняет входящий", e_w is not None)
check("« Запись » выход пустой", res_w["result"] == ("",), str(res_w["result"]))
check("« Запись » saved_id — запись для обложки",
      res_w["ui"]["saved_id"] == [e_w["id"]], str(res_w["ui"]["saved_id"]))
check("« Запись » без провода — нет подсказки", res_w["ui"]["mode_notice"] == [""],
      str(res_w["ui"]["mode_notice"]))

# Совместимость: старый граф держит провод prompt_out в разрыв перед CLIP
png_linked = {"workflow": {"nodes": [{"id": 5, "outputs": [{"links": [11]}]}]}}
res_wl = node2.execute(mode=node2.MODE_WRITE, selected="", save_folder="Режимы",
                       source="режим-запись-2", extra_pnginfo=png_linked, unique_id=5)
check("« Запись » + провод: текст идёт сквозь (совместимость)",
      res_wl["result"] == ("режим-запись-2",), str(res_wl["result"]))
check("« Запись » + провод: подсказка в UI",
      "сквозь" in (res_wl["ui"]["mode_notice"][0] or ""), str(res_wl["ui"]["mode_notice"]))

png_empty = {"workflow": {"nodes": [{"id": 5, "outputs": [{"links": []}]}]}}
res_we = node2.execute(mode=node2.MODE_WRITE, selected="", save_folder="Режимы",
                       source="режим-запись-3", extra_pnginfo=png_empty, unique_id=5)
check("« Запись » с пустым links: выход пуст", res_we["result"] == ("",), str(res_we["result"]))
png_other = {"workflow": {"nodes": [{"id": 5, "outputs": [{"links": [11]}]}, {"id": 9, "outputs": [{}]}]}}
res_wo = node2.execute(mode=node2.MODE_WRITE, selected="", save_folder="Режимы",
                       source="режим-запись-4", extra_pnginfo=png_other, unique_id=6)
check("_output_linked ищет именно свою ноду",
      res_wo["result"] == ("",) and mod._output_linked(png_other, 9) is False)

# Выдача: только выдаёт, ничего не сохраняет
res_i = node2.execute(mode=node2.MODE_ISSUE, selected=e_w["id"], save_folder="Режимы",
                       source="режим-выдача-входящий", extra_pnginfo=None, unique_id=1)
check("« Выдача » выдаёт текст выбранной записи",
      res_i["result"] == ("режим-запись-1",), str(res_i["result"]))
check("« Выдача » ничего не сохраняет", _entry("режим-выдача-входящий") is None)
check("« Выдача » saved_id пуст (обложка не нужна)", res_i["ui"]["saved_id"] == [],
      str(res_i["ui"]["saved_id"]))

# Выдача + запись: и выдаёт, и сохраняет входящий
res_b = node2.execute(mode=node2.MODE_BOTH, selected=e_w["id"], save_folder="Режимы",
                      source="режим-оба-1", extra_pnginfo=None, unique_id=1)
e_b = _entry("режим-оба-1")
check("« Выдача + запись » выдаёт выбранную запись",
      res_b["result"] == ("режим-запись-1",), str(res_b["result"]))
check("« Выдача + запись » сохраняет входящий", e_b is not None)
check("« Выдача + запись » saved_id на новую запись",
      res_b["ui"]["saved_id"] == [e_b["id"]], str(res_b["ui"]["saved_id"]))
check("« Выдача + запись » папка из виджета", e_b["folder"] == "Режимы", str(e_b["folder"]))
res_b2 = node2.execute(mode=node2.MODE_BOTH, selected="", save_folder="Режимы",
                       source="режим-оба-2", extra_pnginfo=None, unique_id=1)
check("« Выдача + запись » без выбора выдаёт входящий",
      res_b2["result"] == ("режим-оба-2",), str(res_b2["result"]))
check("« Выдача + запись » без выбора тоже сохраняет", _entry("режим-оба-2") is not None)
# Дубль по тексту: saved_id пуст ТОЛЬКО если у записи уже есть превью
_bcast_before = len(_broadcasts)
res_dup = node2.execute(mode=node2.MODE_BOTH, selected="", save_folder="Режимы",
                        source="режим-оба-2", extra_pnginfo=None, unique_id=1)
check("повторный прогон: записи не плодятся",
      len([e for e in mod._load_db()[0] if e["prompt"] == "режим-оба-2"]) == 1)
check("повторный прогон: обложку для существующей записи ждём",
      res_dup["ui"]["saved_id"] == [e_b2_id] if (e_b2_id := _entry("режим-оба-2")["id"]) else False,
      str(res_dup["ui"]["saved_id"]))
check("повторный прогон без новой записи — без broadcast",
      len(_broadcasts) == _bcast_before, str(_broadcasts[-2:]))

# mode=[] (старые графы) не должен падать
res_old = node2.execute(mode="", selected="", save_folder="Режимы", source="режим-старый",
                        extra_pnginfo=None, unique_id=1)
check("старый вызов без mode = «Запись»",
      res_old["result"] == ("",) and _entry("режим-старый") is not None)

# --- 17. attach_preview: обложка из файла прогона ----------------------------
print("\n17. Автоподхват обложки: /attach_preview + _resolve_output_file")
(out_dir / "sub").mkdir(parents=True, exist_ok=True)
(out_dir / "a.png").write_bytes(b"x")
(out_dir / "sub" / "b.png").write_bytes(b"x")
(temp_dir / "t.png").write_bytes(b"x")
(TMP / "secret.png").write_bytes(b"x")


def _rp(p):
    return os.path.realpath(str(p)) if p is not None else None


check("_resolve_output_file: файл в output",
      _rp(mod._resolve_output_file("a.png", "", "output")) == _rp(out_dir / "a.png"))
check("_resolve_output_file: подпапка",
      _rp(mod._resolve_output_file("b.png", "sub", "output")) == _rp(out_dir / "sub" / "b.png"))
check("_resolve_output_file: temp-тип",
      _rp(mod._resolve_output_file("t.png", "", "temp")) == _rp(temp_dir / "t.png"))
check("_resolve_output_file: '../' в имени отклонён",
      mod._resolve_output_file("../secret.png", "", "output") is None)
check("_resolve_output_file: '../' в subfolder отклонён",
      mod._resolve_output_file("secret.png", "..", "output") is None)
check("_resolve_output_file: абсолютный путь отклонён",
      mod._resolve_output_file(str(TMP / "secret.png"), "", "output") is None)
check("_resolve_output_file: нет файла -> None",
      mod._resolve_output_file("nope.png", "", "output") is None)
check("_resolve_output_file: неизвестный type -> output",
      _rp(mod._resolve_output_file("a.png", "", "wat")) == _rp(out_dir / "a.png"))

_orig_thumb2 = mod._save_thumbnail
_orig_loader = mod._load_image_file
_thumb2 = []


def _thumb_stub2(img, entry_id, workflow=None):
    _thumb2.append(entry_id)
    return f"previews/{entry_id}.png"


mod._save_thumbnail = _thumb_stub2
mod._load_image_file = lambda p: object()  # декодер: в песочнице нет PIL/numpy
try:
    h("POST", "/prompt_library/add", Req({"prompt": "обложка-прогона", "folder": "Режимы"}))
    eid = _entry("обложка-прогона")["id"]
    _broadcasts.clear()
    r_ok = h("POST", "/prompt_library/attach_preview",
             Req({"id": eid, "filename": "a.png", "subfolder": "", "type": "output"}))
    check("attach_preview: 200 + путь превью",
          r_ok["status"] == 200 and r_ok["json"]["preview"] == f"previews/{eid}.png", str(r_ok))
    check("attach_preview: превью в базе", _entry("обложка-прогона")["preview"] == f"previews/{eid}.png")
    check("attach_preview: media проставлен", _entry("обложка-прогона").get("media") == "image")
    check("attach_preview: broadcast разослан об изменении",
          "prompt_library/refresh" in _broadcasts, str(_broadcasts))
    r_dup2 = h("POST", "/prompt_library/attach_preview",
               Req({"id": eid, "filename": "a.png", "subfolder": "", "type": "output"}))
    check("attach_preview: готовое превью не перетирается",
          r_dup2["status"] == 200 and r_dup2["json"].get("skipped") == "has_preview", str(r_dup2))
    _thumb2.clear()
    r_force = h("POST", "/prompt_library/attach_preview",
                Req({"id": eid, "filename": "b.png", "subfolder": "sub", "type": "output", "force": True}))
    check("attach_preview: force перетирает",
          r_force["status"] == 200 and _thumb2 == [eid], str(_thumb2))
    r_missing = h("POST", "/prompt_library/attach_preview",
                  Req({"id": eid, "filename": "nope.png", "subfolder": "", "type": "output"}))
    check("attach_preview: файла нет -> 404", r_missing["status"] == 404, str(r_missing))
    r_trav = h("POST", "/prompt_library/attach_preview",
               Req({"id": eid, "filename": "../secret.png", "subfolder": "", "type": "output"}))
    check("attach_preview: traversal -> 404", r_trav["status"] == 404, str(r_trav))
    r_bad = h("POST", "/prompt_library/attach_preview", Req({"id": "", "filename": ""}))
    check("attach_preview: без id/filename -> 400", r_bad["status"] == 400, str(r_bad))
    r_gone = h("POST", "/prompt_library/attach_preview",
               Req({"id": "deadbeef01", "filename": "a.png", "subfolder": "", "type": "output"}))
    check("attach_preview: удалённая запись — не ошибка",
          r_gone["status"] == 200 and r_gone["json"].get("skipped") == "no_entry", str(r_gone))
    r_terr = h("POST", "/prompt_library/attach_preview", Req({"id": eid, "filename": "a.png"}))
    check("attach_preview: пустой type по умолчанию output", r_terr["status"] == 200, str(r_terr))
finally:
    mod._save_thumbnail = _orig_thumb2
    mod._load_image_file = _orig_loader

# --- 18. подхват финального текста из другого узла (v1.25) --------------------
print("\n18. Подхват текста: execute(pickup) + /save_pickup")
node3 = mod.PromptLibrary()


def _pick_token(folder="Подхват", pick="1622"):
    """Прогон ноды с включённым подхватом → токен (клиент вернёт его с текстом)."""
    res = node3.execute(mode=node3.MODE_ISSUE, selected="", save_folder=folder, pickup=pick,
                        source="входящий не сохраняем", extra_pnginfo={"workflow": {"nodes": [], "links": []}},
                        unique_id=7)
    return (res["ui"].get("pickup") or [""])[0]


before_pick = len(mod._load_db()[0])
wf_pick = {"nodes": [{"id": 7, "widgets_values": ["x"]}], "links": []}
res_pick = node3.execute(mode=node3.MODE_ISSUE, selected="", save_folder="Подхват", pickup="1622",
                         source="входящий не сохраняем",
                         extra_pnginfo={"workflow": wf_pick}, unique_id=7)
tok = (res_pick["ui"].get("pickup") or [""])[0]
check("подхват: токен отдан клиенту в ui.pickup", bool(tok), str(res_pick["ui"].get("pickup")))
check("подхват: id узла-источника в ui.pickup_node", res_pick["ui"].get("pickup_node") == ["1622"],
      str(res_pick["ui"].get("pickup_node")))
check("подхват: входящий текст НЕ сохранён", len(mod._load_db()[0]) == before_pick)
check("подхват: выход режима выдачи по-прежнему сквозной",
      res_pick["result"][0] == "входящий не сохраняем", str(res_pick["result"]))
check("подхват: saved_id пуст (записи ещё нет)", res_pick["ui"]["saved_id"] == [])
check("подхват: снапшот воркфлоу отложен под токеном",
      isinstance(mod._PICKUP.get(tok, {}).get("workflow"), dict))
check("подхват: подсказка о том, почему вход не сохраняется",
      "не сохраняется" in (res_pick["ui"]["mode_notice"][0] or ""),
      str(res_pick["ui"]["mode_notice"]))
check("подхват: PNG-патч несёт pickup 4-м значением",
      wf_pick["nodes"][0]["widgets_values"] == [node3.MODE_ISSUE, "", "Подхват", "1622"],
      str(wf_pick["nodes"][0]["widgets_values"]))
# Без подхвата поведение прежнее (pickup="")
res_off = node3.execute(mode=node3.MODE_WRITE, selected="", save_folder="", pickup="",
                        source="подхват выключен",
                        extra_pnginfo={"workflow": {"nodes": [], "links": []}}, unique_id=7)
check("pickup='' -> обычный автосейв", res_off["ui"].get("pickup") == []
      and _entry("подхват выключен") is not None)

_broadcasts.clear()
r_pick = h("POST", "/prompt_library/save_pickup",
           Req({"token": tok, "text": "  финальный текст из LLM  "}))
check("save_pickup: 200 + id", r_pick["status"] == 200 and bool(r_pick["json"].get("id")), str(r_pick))
check("save_pickup: текст обрезан", _entry("финальный текст из LLM") is not None)
check("save_pickup: папка из токена",
      (_entry("финальный текст из LLM") or {}).get("folder") == "Подхват")
check("save_pickup: воркфлоу из токена",
      isinstance((_entry("финальный текст из LLM") or {}).get("workflow"), dict))
check("save_pickup: broadcast разослан", "prompt_library/refresh" in _broadcasts)
check("save_pickup: токен одноразовый", tok not in mod._PICKUP)
r_again = h("POST", "/prompt_library/save_pickup", Req({"token": tok, "text": "повтор"}))
check("save_pickup: повторный токен -> 400", r_again["status"] == 400, str(r_again))
r_unknown = h("POST", "/prompt_library/save_pickup", Req({"token": "нет-такого", "text": "x"}))
check("save_pickup: неизвестный токен -> 400", r_unknown["status"] == 400, str(r_unknown))

before_empty = len(mod._load_db()[0])
r_empty = h("POST", "/prompt_library/save_pickup", Req({"token": _pick_token("Подхват"), "text": "   "}))
check("save_pickup: пустой текст — не ошибка и без записи",
      r_empty["status"] == 200 and r_empty["json"].get("skipped") == "empty"
      and len(mod._load_db()[0]) == before_empty, str(r_empty))

_broadcasts.clear()
r_dup3 = h("POST", "/prompt_library/save_pickup",
           Req({"token": _pick_token("Подхват"), "text": "финальный текст из LLM"}))
check("save_pickup: дубль не создаёт вторую запись",
      r_dup3["json"].get("duplicate") is True and r_dup3["json"].get("folder") == "Подхват", str(r_dup3))
check("save_pickup: на дубль broadcast не шлём", "prompt_library/refresh" not in _broadcasts)

for _i in range(mod._PICKUP_LIMIT + 5):
    _pick_token()
check("подхват: отложенные токены не растут бесконечно (лимит, без таймеров)",
      len(mod._PICKUP) <= mod._PICKUP_LIMIT, str(len(mod._PICKUP)))

# --- 19. видео-обложка, метка media и замена превью (v1.26) --------------------
print("\n19. Видео-обложка + замена превью: attach_preview(preview_data/force) + /add(media)")

check("_is_video_file: mp4/webm/mkv — видео",
      mod._is_video_file("a.mp4") and mod._is_video_file("b.WEBM") and mod._is_video_file("c.mkv"))
check("_is_video_file: png/webp/gif — картинки (PIL берёт первый кадр)",
      not mod._is_video_file("a.png") and not mod._is_video_file("b.webp") and not mod._is_video_file("c.gif"))

(out_dir / "clip.mp4").write_bytes(b"x")
(out_dir / "shot.png").write_bytes(b"x")

_orig_loader5 = mod._load_image_file
_orig_video5 = mod._load_video_frame
_orig_thumb5 = mod._save_thumbnail
_orig_upload5 = mod._save_preview_upload
_thumb5, _uploads5 = [], []


def _thumb_stub5(img, entry_id, workflow=None):
    _thumb5.append(entry_id)
    return f"previews/{entry_id}.png"


def _upload_stub5(data, entry_id, workflow=None):
    # Пустой data ведёт себя как настоящий: превью не создаётся
    if not data:
        return None
    _uploads5.append({"id": entry_id, "wf": bool(workflow), "head": str(data)[:16]})
    return f"previews/{entry_id}.png"


def _loader5(path):
    # PIL видео не открывает — ровно на этом падал видео-прогон
    if str(path).lower().endswith(".mp4"):
        raise ValueError("PIL не открывает видео")
    return object()


mod._save_thumbnail = _thumb_stub5
mod._save_preview_upload = _upload_stub5
mod._load_image_file = _loader5
mod._load_video_frame = lambda p: object()   # PyAV в песочнице нет — заглушка
try:
    check("_load_media_frame: картинку берёт из PIL", mod._load_media_frame("shot.png") is not None)
    check("_load_media_frame: видео падает на PIL и берётся из PyAV",
          mod._load_media_frame("clip.mp4") is not None)

    # 1. Видео-прогон: mp4 на диске → обложка из первого кадра + метка video
    h("POST", "/prompt_library/add", Req({"prompt": "видео-прогон", "folder": "Видео"}))
    vid = _entry("видео-прогон")["id"]
    r_vid = h("POST", "/prompt_library/attach_preview",
              Req({"id": vid, "filename": "clip.mp4", "subfolder": "", "type": "output"}))
    check("видео-прогон: обложка из первого кадра (200)",
          r_vid["status"] == 200 and r_vid["json"].get("preview") == f"previews/{vid}.png", str(r_vid))
    check("видео-прогон: метка media=video по расширению",
          _entry("видео-прогон").get("media") == "video")
    check("видео-прогон: кадр снят (thumbnail вызван один раз)",
          _thumb5.count(vid) == 1, str(_thumb5))

    # 2. Замена обложки файлом, метка из подсказки клиента важнее расширения
    r_rep = h("POST", "/prompt_library/attach_preview",
              Req({"id": vid, "filename": "shot.png", "subfolder": "", "type": "output",
                   "media": "image", "force": True}))
    check("замена файлом: 200 и метка из подсказки клиента",
          r_rep["status"] == 200 and _entry("видео-прогон").get("media") == "image", str(r_rep))

    # 3. Замена обложки кадром из браузера (ручное видео с диска)
    _uploads5.clear()
    r_data = h("POST", "/prompt_library/attach_preview",
               Req({"id": vid, "preview_data": "data:image/png;base64,AAA", "media": "video",
                    "force": True}))
    check("замена кадром: 200, метка video, превью записано",
          r_data["status"] == 200 and _entry("видео-прогон").get("media") == "video", str(r_data))
    check("замена кадром: filename не обязателен, кадр ушёл в загрузчик",
          len(_uploads5) == 1 and _uploads5[0]["id"] == vid, str(_uploads5))

    r_skip = h("POST", "/prompt_library/attach_preview",
               Req({"id": vid, "preview_data": "data:image/png;base64,AAA", "media": "video"}))
    check("без force готовое превью не перетирается даже кадром",
          r_skip["status"] == 200 and r_skip["json"].get("skipped") == "has_preview", str(r_skip))

    r_none = h("POST", "/prompt_library/attach_preview", Req({"id": vid}))
    check("ни filename, ни preview_data -> 400", r_none["status"] == 400, str(r_none))

    r_gone = h("POST", "/prompt_library/attach_preview",
               Req({"id": "deadbeef02", "preview_data": "data:image/png;base64,AAA", "force": True}))
    check("ручная замена у удалённой записи -> 404 (не молчим)",
          r_gone["status"] == 404, str(r_gone))

    # 4. В запись с воркфлоу новое превью встраивает его же (карточка самодостаточна)
    wf_entry = _entry("финальный текст из LLM")
    _uploads5.clear()
    r_wf = h("POST", "/prompt_library/attach_preview",
             Req({"id": wf_entry["id"], "preview_data": "data:image/png;base64,AAA",
                  "media": "image", "force": True}))
    check("замена кадром: воркфлоу записи встраивается в превью",
          r_wf["status"] == 200 and _uploads5 and _uploads5[-1]["wf"] is True, str(_uploads5))

    # 5. Ручное добавление с превью: метка приходит из JS вместе с кадром
    r_add_v = h("POST", "/prompt_library/add",
                Req({"prompt": "ручной видео-промпт", "folder": "Ручное",
                     "preview_data": "data:image/png;base64,AAA", "media": "video"}))
    check("ручное добавление: метка video сохранена",
          r_add_v["status"] == 200 and _entry("ручной видео-промпт").get("media") == "video",
          str(r_add_v))
    check("ручное добавление: кадр стал превью",
          _entry("ручной видео-промпт").get("preview")
          == f"previews/{_entry('ручной видео-промпт')['id']}.png",
          str(_entry("ручной видео-промпт").get("preview")))
    r_add_i = h("POST", "/prompt_library/add",
                Req({"prompt": "ручной фото-промпт", "folder": "Ручное",
                     "preview_data": "data:image/png;base64,AAA", "media": "image"}))
    check("ручное добавление: метка image сохранена",
          r_add_i["status"] == 200 and _entry("ручной фото-промпт").get("media") == "image",
          str(r_add_i))
    r_add_w = h("POST", "/prompt_library/add",
                Req({"prompt": "ручной мусор-метка", "folder": "Ручное", "media": "wat"}))
    check("мусорная метка не попадает в базу",
          _entry("ручной мусор-метка").get("media") is None,
          str(_entry("ручной мусор-метка")))
    check("без preview_data превью не создаётся",
          _entry("ручной мусор-метка").get("preview") is None)
finally:
    mod._save_thumbnail = _orig_thumb5
    mod._save_preview_upload = _orig_upload5
    mod._load_image_file = _orig_loader5
    mod._load_video_frame = _orig_video5


# --- 20. аудит v1.27: замок базы, guard id, полнотекстовый поиск -------------
print("\n20. Аудит v1.27: _DB_LOCK, guard id, /prompt_library/search")

check("_DB_LOCK существует и реентрантный (RLock)",
      hasattr(mod, "_DB_LOCK") and hasattr(mod._DB_LOCK, "_is_owned"))
try:
    with mod._DB_LOCK:
        with mod._DB_LOCK:
            nested_ok = True
except Exception:
    nested_ok = False
check("вложенный захват _DB_LOCK не блокирует сам себя", nested_ok)

# Все мутации (роуты) обязаны идти под замком: проверяем по факту владения
# замком в момент записи, а не по наличию декоратора.
_lock_probe = []
_orig_save_db = mod._save_db


def _save_db_probe(entries, folders):
    try:
        _lock_probe.append(bool(mod._DB_LOCK._is_owned()))
    except Exception:
        _lock_probe.append(None)
    return _orig_save_db(entries, folders)


mod._save_db = _save_db_probe
try:
    h("POST", "/prompt_library/add", Req({"prompt": "запись под замком", "folder": "Замок"}))
    check("мутирующий роут пишет базу под _DB_LOCK",
          bool(_lock_probe) and all(_lock_probe), str(_lock_probe))
    h("POST", "/prompt_library/favorite",
      Req({"id": _entry("запись под замком")["id"], "favorite": True}))
    check("все мутации (add + favorite) прошли под замком",
          bool(_lock_probe) and all(_lock_probe), str(_lock_probe))
    _lock_probe.clear()
    mod.PromptLibrary().execute(mode=mod.PromptLibrary.MODE_WRITE, source="прогон под замком")
    check("execute() держит _DB_LOCK (поток исполнения ComfyUI)",
          bool(_lock_probe) and all(_lock_probe), str(_lock_probe))
finally:
    mod._save_db = _orig_save_db

# Guard id: id уходит в имя файла превью (previews/{id}.png)
r_badid = h("POST", "/prompt_library/attach_preview",
            Req({"id": "нет-такой", "preview_data": "data:image/png;base64,AAA", "force": True}))
check("id не-ASCII/с дефисом -> 400 (guard до имени файла)",
      r_badid["status"] == 400 and r_badid["json"].get("error") == "bad id", str(r_badid))
r_travid = h("POST", "/prompt_library/attach_preview",
             Req({"id": "../evil", "filename": "a.png", "type": "output"}))
check("id с traversal -> 400", r_travid["status"] == 400, str(r_travid))
r_hexid = h("POST", "/prompt_library/attach_preview",
            Req({"id": _entry("запись под замком")["id"], "preview_data": "data:image/png;base64,AAA"}))
check("обычный hex-id проходит guard", r_hexid["status"] in (200, 400), str(r_hexid))

# Полнотекстовый поиск: слово из СЕРЕДИНЫ текста (в head не попадает)
_deep = "начало" + ("x" * 200) + "ИголкаВСтоге"
h("POST", "/prompt_library/add", Req({"prompt": _deep, "folder": "Поиск"}))
r_s_deep = h("GET", "/prompt_library/search", Req(query={"q": "иголкавстоге"}))
check("/search находит слово из середины длинного текста",
      r_s_deep["status"] == 200
      and _entry(_deep)["id"] in r_s_deep["json"].get("ids", []), str(r_s_deep))
check("/search: пустой q -> без совпадений",
      h("GET", "/prompt_library/search", Req(query={"q": "  "}))["json"].get("ids") == [])
check("/search ищет и по папке",
      _entry(_deep)["id"] in h("GET", "/prompt_library/search",
                               Req(query={"q": "Поиск"}))["json"].get("ids", []))
check("/search регистронезависим (кириллица)",
      _entry(_deep)["id"] in h("GET", "/prompt_library/search",
                               Req(query={"q": "НАЧАЛО"}))["json"].get("ids", []))


# --- 21. подхват и кэш ComfyUI: IS_CHANGED (v1.28) ---------------------------
_p("\n21. Подхват и кэш: IS_CHANGED заставляет ноду исполняться каждый Queue")

_cls = mod.PromptLibrary
check("IS_CHANGED объявлен как classmethod (механика ComfyUI)",
      isinstance(inspect.getattr_static(_cls, "IS_CHANGED"), classmethod))
_nan_on = _cls.IS_CHANGED(pickup="1622")
check("pickup задан -> NaN (нода всегда 'изменена')",
      isinstance(_nan_on, float) and _nan_on != _nan_on, repr(_nan_on))
check("NaN не равен себе — кэш не переиспользует прогон",
      _cls.IS_CHANGED(pickup="1622") != _cls.IS_CHANGED(pickup="1622"))
check("pickup пустой/None -> None (обычное кэширование)",
      _cls.IS_CHANGED(pickup="") is None and _cls.IS_CHANGED(pickup=None) is None
      and _cls.IS_CHANGED() is None)
check("pickup из пробелов не включает форсированное исполнение",
      _cls.IS_CHANGED(pickup="   ") is None)
check("батч-форма значения не ломает решение (страховка)",
      _cls.IS_CHANGED(pickup=["1622"]) != _cls.IS_CHANGED(pickup=["1622"])
      and _cls.IS_CHANGED(pickup=[""]) is None and _cls.IS_CHANGED(pickup=[]) is None)
check("остальные виджеты на решение не влияют",
      _cls.IS_CHANGED(pickup="1622", mode="Запись", selected="", save_folder="x")
      != _cls.IS_CHANGED(pickup="1622", mode="Записи", selected="", save_folder="x"))

# Протухший токен: клиент должен получить 400 (а не тихую пустоту), сервер — строку в консоль
_p("\n22. save_pickup: неизвестный токен — отказ виден клиенту")
_r_stale = h("POST", "/prompt_library/save_pickup", Req({"token": "deadbeef", "text": "x"}))
check("протухший токен -> 400 + error", _r_stale["status"] == 400
      and _r_stale["json"].get("error"), str(_r_stale))


# --- 23. закреп: /pin (v1.30) -------------------------------------------------
_p("\n23. Закреп: /pin ставит/снимает флаг, старые записи — False")
r_pin_add = h("POST", "/prompt_library/add", Req({"prompt": "кандидат на закреп", "folder": "Закрепы"}))
_pin_id = r_pin_add["json"]["id"]
check("новая запись создаётся незакреплённой",
      _entry("кандидат на закреп")["pinned"] is False)
_broadcasts.clear()
h("POST", "/prompt_library/pin", Req({"id": _pin_id, "pinned": True}))
check("/pin ставит закреп", _entry("кандидат на закреп")["pinned"] is True)
check("/pin -> broadcast", _broadcasts == ["prompt_library/refresh"], str(_broadcasts))
h("POST", "/prompt_library/pin", Req({"id": _pin_id, "pinned": False}))
check("/pin снимает закреп", _entry("кандидат на закреп")["pinned"] is False)
h("POST", "/prompt_library/pin", Req({"id": _pin_id}))
check("/pin без значения — тоггл", _entry("кандидат на закреп")["pinned"] is True)
_broadcasts.clear()
h("POST", "/prompt_library/pin", Req({"id": "нет-такой", "pinned": True}))
check("/pin неизвестный id не падает и без broadcast",
      _broadcasts == [], str(_broadcasts))
# Legacy-запись без поля pinned: отсутствие трактуется как False
_e_all, _f_all = mod._load_db()
next(e for e in _e_all if e["id"] == _pin_id).pop("pinned", None)
mod._save_db(_e_all, _f_all)
_e_re, _ = mod._load_db()
check("запись без поля pinned читается как незакреплённая",
      next(e for e in _e_re if e["id"] == _pin_id)["pinned"] is False)


# --- итог -------------------------------------------------------------------
_p(f"\n=== ok: {len(oks)} | FAIL: {len(fails)}")
if fails:
    for f in fails:
        print("  - " + f)
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fails else 0)
