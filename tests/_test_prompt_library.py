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
check("«Запись»: выход пуст + ui на месте", res["result"][1] == "" and "ui" in res,
      str(res["result"]))
check("входной текст обрезан", res["ui"]["text"] == ["Портрет девушки"])
check("PNG-патч записал widgets_values позиционно (5 значений, v1.44)",
      workflow["nodes"][0]["widgets_values"] == [node.MODE_WRITE, "", "Фото", "", ""],
      str(workflow["nodes"][0]["widgets_values"]))
check("чужой node id не тронут", len(workflow["nodes"]) == 1)
entries, folders = mod._load_db()
check("запись сохранена", len(entries) == 1 and entries[0]["prompt"] == "Портрет девушки")
check("папка сохранена, дубль category", entries[0]["folder"] == "Фото" and entries[0]["category"] == "Фото")
# v1.40: граф лежит отдельным файлом (workflows/{id}.json), а не внутри базы;
# для читателя разницы нет — _entry_workflow() отдаёт тот же dict.
check("workflow прикреплён к записи (отдельным файлом)",
      not entries[0].get("workflow")
      and entries[0].get("workflow_file") == f"workflows/{entries[0]['id']}.json"
      and isinstance(mod._entry_workflow(entries[0]), dict))

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
check("выдача возвращает промпт записи", res5["result"][1] == "Портрет девушки")
entries, _ = mod._load_db()
check("last_used проставлен",
      bool(next(e for e in entries if e["id"] == target["id"]).get("last_used")))
before = len(entries)
node.execute(mode=node.MODE_ISSUE, selected=target["id"], save_folder="",
             source="не должен сохраниться", extra_pnginfo=pnginfo, unique_id=7)
check("в режиме выдачи новые записи не создаются", len(mod._load_db()[0]) == before)
res6 = node.execute(mode=node.MODE_ISSUE, selected="нет-такого", save_folder="",
                    source="прозрачный проход", extra_pnginfo=pnginfo, unique_id=7)
check("выдача с несуществующим id -> пропускает вход", res6["result"][1] == "прозрачный проход")
res7 = node.execute(mode="", selected="", save_folder="", source="s",
                    extra_pnginfo=pnginfo, unique_id=7, use_selected=True)
check("use_selected (legacy) -> режим выдачи", res7["result"][1] == "s"
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
                 extra_pnginfo=pnginfo, unique_id=7)["result"][1] == ""))
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
check("execute: backfill при этом записан (файлом графа)",
      bool(mod._entry_workflow(next(e for e in mod._load_db()[0] if e["id"] == "bf-broadcast"))))

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
check("« Запись » выход пустой", res_w["result"][1] == "", str(res_w["result"]))
check("« Запись » saved_id — запись для обложки",
      res_w["ui"]["saved_id"] == [e_w["id"]], str(res_w["ui"]["saved_id"]))
check("« Запись » без провода — нет подсказки", res_w["ui"]["mode_notice"] == [""],
      str(res_w["ui"]["mode_notice"]))

# Совместимость: старый граф держит провод prompt_out в разрыв перед CLIP
# Провод считается по выходу 1 (prompt_1): выход 0 занят путём категории (§40)
png_linked = {"workflow": {"nodes": [{"id": 5, "outputs": [{}, {"links": [11]}]}]}}
res_wl = node2.execute(mode=node2.MODE_WRITE, selected="", save_folder="Режимы",
                       source="режим-запись-2", extra_pnginfo=png_linked, unique_id=5)
check("« Запись » + провод: текст идёт сквозь (совместимость)",
      res_wl["result"][1] == "режим-запись-2", str(res_wl["result"]))
check("« Запись » + провод: подсказка в UI",
      "сквозь" in (res_wl["ui"]["mode_notice"][0] or ""), str(res_wl["ui"]["mode_notice"]))

png_empty = {"workflow": {"nodes": [{"id": 5, "outputs": [{"links": []}]}]}}
res_we = node2.execute(mode=node2.MODE_WRITE, selected="", save_folder="Режимы",
                       source="режим-запись-3", extra_pnginfo=png_empty, unique_id=5)
check("« Запись » с пустым links: выход пуст", res_we["result"][1] == "", str(res_we["result"]))
png_other = {"workflow": {"nodes": [{"id": 5, "outputs": [{"links": [11]}]}, {"id": 9, "outputs": [{}]}]}}
res_wo = node2.execute(mode=node2.MODE_WRITE, selected="", save_folder="Режимы",
                       source="режим-запись-4", extra_pnginfo=png_other, unique_id=6)
check("_output_linked ищет именно свою ноду",
      res_wo["result"][1] == "" and mod._output_linked(png_other, 9) is False)

# Выдача: только выдаёт, ничего не сохраняет
res_i = node2.execute(mode=node2.MODE_ISSUE, selected=e_w["id"], save_folder="Режимы",
                       source="режим-выдача-входящий", extra_pnginfo=None, unique_id=1)
check("« Выдача » выдаёт текст выбранной записи",
      res_i["result"][1] == "режим-запись-1", str(res_i["result"]))
check("« Выдача » ничего не сохраняет", _entry("режим-выдача-входящий") is None)
check("« Выдача » saved_id пуст (обложка не нужна)", res_i["ui"]["saved_id"] == [],
      str(res_i["ui"]["saved_id"]))

# Выдача + запись: и выдаёт, и сохраняет входящий
res_b = node2.execute(mode=node2.MODE_BOTH, selected=e_w["id"], save_folder="Режимы",
                      source="режим-оба-1", extra_pnginfo=None, unique_id=1)
e_b = _entry("режим-оба-1")
check("« Выдача + запись » выдаёт выбранную запись",
      res_b["result"][1] == "режим-запись-1", str(res_b["result"]))
check("« Выдача + запись » сохраняет входящий", e_b is not None)
check("« Выдача + запись » saved_id на новую запись",
      res_b["ui"]["saved_id"] == [e_b["id"]], str(res_b["ui"]["saved_id"]))
check("« Выдача + запись » папка из виджета", e_b["folder"] == "Режимы", str(e_b["folder"]))
res_b2 = node2.execute(mode=node2.MODE_BOTH, selected="", save_folder="Режимы",
                       source="режим-оба-2", extra_pnginfo=None, unique_id=1)
check("« Выдача + запись » без выбора выдаёт входящий",
      res_b2["result"][1] == "режим-оба-2", str(res_b2["result"]))
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
      res_old["result"][1] == "" and _entry("режим-старый") is not None)

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
    """Прогон ноды с включённым подхватом → токен (клиент вернёт его с текстом).

    Режим «📤📥 Выдача + запись»: подхват — это ЗАПИСЬ, в чистой выдаче он
    выключен (v1.38, см. проверки ниже).
    """
    res = node3.execute(mode=node3.MODE_BOTH, selected="", save_folder=folder, pickup=pick,
                        source="входящий не сохраняем", extra_pnginfo={"workflow": {"nodes": [], "links": []}},
                        unique_id=7)
    return (res["ui"].get("pickup") or [""])[0]


# v1.38: подхват — это ЗАПИСЬ (токен -> /save_pickup -> новая запись), поэтому он
# подчиняется режиму. До фикса «📤 Выдача» тоже отдавала токен: каждый Queue в
# выдаче плодил записи из узла-источника вместе с обложкой (поймано на живой базе:
# 4 записи за 03:31-03:43 с mode = «📤 Выдача» в снапшоте и pickup = 1622).
before_block = len(mod._load_db()[0])
wf_block = {"nodes": [{"id": 7, "widgets_values": ["x"]}], "links": []}
res_block = node3.execute(mode=node3.MODE_ISSUE, selected="", save_folder="Подхват", pickup="1622",
                          source="входящий не сохраняем",
                          extra_pnginfo={"workflow": wf_block}, unique_id=7)
check("выдача + подхват: токен НЕ отдан (записи не будет)",
      res_block["ui"].get("pickup") == [], str(res_block["ui"].get("pickup")))
check("выдача + подхват: клиенту сказано, что подхват выключен",
      res_block["ui"].get("pickup_blocked") == ["1622"],
      str(res_block["ui"].get("pickup_blocked")))
check("выдача + подхват: saved_id пуст (обложку вешать не на что)",
      res_block["ui"]["saved_id"] == [], str(res_block["ui"]["saved_id"]))
check("выдача + подхват: в базе ничего не появилось",
      len(mod._load_db()[0]) == before_block)
check("выдача + подхват: подсказка объясняет, как сохранять",
      "выключен" in (res_block["ui"]["mode_notice"][0] or "")
      and node3.MODE_BOTH in (res_block["ui"]["mode_notice"][0] or ""),
      str(res_block["ui"]["mode_notice"]))
check("выдача + подхват: токенов в отложке нет",
      not any(v.get("node") == "1622" for v in mod._PICKUP.values()))
check("выдача: выход по-прежнему выдаёт входящий текст",
      res_block["result"][1] == "входящий не сохраняем", str(res_block["result"]))

before_pick = len(mod._load_db()[0])
wf_pick = {"nodes": [{"id": 7, "widgets_values": ["x"]}], "links": []}
res_pick = node3.execute(mode=node3.MODE_BOTH, selected="", save_folder="Подхват", pickup="1622",
                         source="входящий не сохраняем",
                         extra_pnginfo={"workflow": wf_pick}, unique_id=7)
tok = (res_pick["ui"].get("pickup") or [""])[0]
check("подхват: токен отдан клиенту в ui.pickup", bool(tok), str(res_pick["ui"].get("pickup")))
check("подхват: id узла-источника в ui.pickup_node", res_pick["ui"].get("pickup_node") == ["1622"],
      str(res_pick["ui"].get("pickup_node")))
check("подхват: в выдающем режиме подхват не заблокирован",
      res_pick["ui"].get("pickup_blocked") == [], str(res_pick["ui"].get("pickup_blocked")))
check("подхват: входящий текст НЕ сохранён", len(mod._load_db()[0]) == before_pick)
check("подхват: выход выдающего режима по-прежнему сквозной",
      res_pick["result"][1] == "входящий не сохраняем", str(res_pick["result"]))
check("подхват: saved_id пуст (записи ещё нет)", res_pick["ui"]["saved_id"] == [])
check("подхват: снапшот воркфлоу отложен под токеном",
      isinstance(mod._PICKUP.get(tok, {}).get("workflow"), dict))
check("подхват: подсказка о том, почему вход не сохраняется",
      "не сохраняется" in (res_pick["ui"]["mode_notice"][0] or ""),
      str(res_pick["ui"]["mode_notice"]))
check("подхват: PNG-патч несёт pickup 4-м значением, slots_out 5-м",
      wf_pick["nodes"][0]["widgets_values"] == [node3.MODE_BOTH, "", "Подхват", "1622", ""],
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
check("save_pickup: воркфлоу из токена (файлом графа)",
      isinstance(mod._entry_workflow(_entry("финальный текст из LLM") or {}), dict))
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


# 19.5. замена превью у записи с legacy JPG — старый файл не остаётся сиротой
# (моки секции 19 выше уже сняты — тут боевые функции)
print("\n19.5. замена превью у legacy-JPG записи")
from PIL import Image as _PIL195
import io as _io195, base64 as _b64195
_buf195 = _io195.BytesIO()
_PIL195.new("RGB", (1, 1), (255, 0, 255)).save(_buf195, "PNG")
_png195 = "data:image/png;base64," + _b64195.b64encode(_buf195.getvalue()).decode()
_legacy5 = _entry("видео-прогон")
_prev_dir5 = mod._ensure_dirs() / "previews"
(_prev_dir5 / f"{_legacy5['id']}.jpg").write_bytes(b"legacy-jpeg")
r_legacy = h("POST", "/prompt_library/attach_preview",
             Req({"id": _legacy5["id"], "preview_data": _png195,
                  "media": "video", "force": True}))
check("замена превью у legacy-JPG: старый .jpg удалён (не сирота)",
      r_legacy["status"] == 200
      and not (_prev_dir5 / f"{_legacy5['id']}.jpg").exists()
      and (_prev_dir5 / f"{_legacy5['id']}.png").exists(), str(r_legacy))


# 19.6. санитизация пути категории (v1.43): пробелы сохраняются, не `_`
print("\n19.6. _sanitize_folder_path: пробелы сохраняются")
_san = mod._sanitize_folder_path
check("простая папка со слэшем в конце", _san("Пейзажи") == "Пейзажи/")
check("вложенность", _san("Пейзажи/Аляска") == "Пейзажи/Аляска/")
check("пробел между словами сохраняется", _san("Мои Пейзажи") == "Мои Пейзажи/")
check("повтор пробелов сжимается до одного", _san("Аляска   Западная") == "Аляска Западная/")
check("кириллица сохраняется", _san("Горы и Озёра") == "Горы и Озёра/")
check("бэкслэш -> слэш", _san("Фото\\Портреты") == "Фото/Портреты/")
check("спецсимволы -> _", _san("Горы&Озёра") == "Горы_Озёра/")
check("служебная ветка -> пусто", _san("__fav") == "")
check("служебная ветка внутри -> пусто", _san("__all/Пейзажи") == "")
check("не строка -> пусто", _san(None) == "" and _san("") == "")
check("пробелы+подчёркивания по краям обрезаны",
      _san("  Мои Пейзажи  ") == "Мои Пейзажи/" and _san("_Мои_") == "Мои/")


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


def _is_nan(v):
    """NaN не равен сам себе — единственный надёжный признак форсированного прогона."""
    return isinstance(v, float) and v != v


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
check("остальные виджеты не отменяют NaN при подхвате",
      _is_nan(_cls.IS_CHANGED(pickup="1622", mode="Запись", selected="", save_folder="x")))
# ГЛАВНОЕ (v1.41): непустой mode — НЕ повод выключать кэш. `mode` есть всегда,
# поэтому проверка `if str(mode).strip(): return nan` (v1.39) делала NaN
# безусловным: докстрока и §33.3 обещают None без подхвата, а ComfyUI
# перестал кэшировать ноду в «Записи»/«Выдаче» и разбирал базу на каждом Queue.
# Смена режима и без того меняет значение виджета → ключ кэша → перепрогон.
check("непустой mode без подхвата -> None: кэш работает (§33.3)",
      _cls.IS_CHANGED(mode="📥 Запись", pickup="") is None
      and _cls.IS_CHANGED(mode="📤 Выдача", pickup="") is None)
check("mode списком без подхвата -> None",
      _cls.IS_CHANGED(mode=["📤 Выдача"], pickup="") is None)
check("mode списком не мешает NaN при подхвате",
      _is_nan(_cls.IS_CHANGED(mode=["📥 Запись"], pickup="1622")))

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


# --- 24. массовые действия: move_many / favorite_many / folder_pin (v1.39) ----
# Раньше эти три роута (v1.36–v1.37) не проверял НИ ОДИН набор: ни песочница,
# ни смоук, ни аудит. Именно здесь нашлись два дефекта: фантомная категория
# и «Избранное» без вложенных папок.
_p("\n24. Массовые действия: move_many / favorite_many / folder_pin")
node4 = mod.PromptLibrary()

h("POST", "/prompt_library/folder_create", Req({"parent": "", "name": "МассФото"}))
h("POST", "/prompt_library/folder_create", Req({"parent": "МассФото", "name": "Портреты"}))
h("POST", "/prompt_library/folder_create", Req({"parent": "", "name": "МассПрочее"}))


for _t, _fld in (("масс-фото", "МассФото"), ("масс-портрет", "МассФото/Портреты"),
                 ("масс-перенос", "МассФото")):
    h("POST", "/prompt_library/add", Req({"prompt": _t, "folder": _fld}))
_mass_ids = {e["prompt"]: e["id"] for e in mod._load_db()[0]}

# 24.1. Фантомная категория: пустой/устаревший id не должен заводить папку
folders_before = set(mod._load_db()[1])
r_ghost = h("POST", "/prompt_library/move_many",
            Req({"entry_ids": ["нет-такого-id"], "folder": "КатегорияПризрак"}))
check("move_many: устаревший id -> ничего не переехало",
      r_ghost["json"].get("moved_entries") == 0, str(r_ghost))
check("move_many: пустая категория-фантом НЕ создаётся",
      "КатегорияПризрак" not in set(mod._load_db()[1]),
      str(sorted(set(mod._load_db()[1]) - folders_before)))
r_empty_ids = h("POST", "/prompt_library/move_many", Req({"entry_ids": [], "folder": "ЕщёПризрак"}))
check("move_many: пустой список id тоже без папки",
      "ЕщёПризрак" not in set(mod._load_db()[1]) and r_empty_ids["json"].get("moved_entries") == 0)

# 24.2. Перенос записи в реальную новую папку — папка заводится (не сломали)
r_move = h("POST", "/prompt_library/move_many",
           Req({"entry_ids": [_mass_ids["масс-перенос"]], "folder": "МассПрочее"}))
check("move_many: запись переехала", r_move["json"].get("moved_entries") == 1, str(r_move))
check("move_many: папка назначения появилась",
      "МассПрочее" in mod._load_db()[1])
check("move_many: hash пересчитан под новую папку",
      (_entry("масс-перенос") or {}).get("hash") == mod._dedup_hash("масс-перенос", "МассПрочее"))

# 24.3. Избранное по категории: подпапки входят в поддерево (v1.39)
r_fav = h("POST", "/prompt_library/favorite_many", Req({"folder_paths": ["МассФото"]}))
check("favorite_many: папка + вложенная подпапка (2 записи)",
      r_fav["json"].get("marked") == 2, str(r_fav))
check("favorite_many: запись из подпапки отмечена",
      (_entry("масс-портрет") or {}).get("favorite") is True)
r_fav2 = h("POST", "/prompt_library/favorite_many", Req({"folder_paths": ["МассФото"]}))
check("favorite_many: повторно ничего не меняет (marked=0)",
      r_fav2["json"].get("marked") == 0, str(r_fav2))
check("favorite_many: папка вне запроса не затронута",
      (_entry("масс-перенос") or {}).get("favorite") is not True,
      str((_entry("масс-перенос") or {}).get("favorite")))
_broadcasts.clear()
r_fav_noop = h("POST", "/prompt_library/favorite_many", Req({"ids": ["нет-такого"]}))
check("favorite_many: нечего менять -> без записи и без broadcast",
      r_fav_noop["json"].get("marked") == 0 and _broadcasts == [], str(_broadcasts))

# 24.4. Закреп папки: тоггл, валидация, чужие данные целы
_broadcasts.clear()
r_fpin = h("POST", "/prompt_library/folder_pin", Req({"path": "МассФото"}))
check("folder_pin: закрепили папку",
      r_fpin["json"].get("pinned") is True and mod._load_pinned_folders() == ["МассФото"],
      str(mod._load_pinned_folders()))
check("folder_pin: записи и папки при этом целы",
      len(mod._load_db()[0]) > 0 and "МассФото" in mod._load_db()[1])
check("folder_pin: broadcast разослан", "prompt_library/refresh" in _broadcasts)
r_fpin2 = h("POST", "/prompt_library/folder_pin", Req({"path": "МассФото"}))
check("folder_pin: повторный клик = откреп",
      r_fpin2["json"].get("pinned") is False and mod._load_pinned_folders() == [])
r_fpin3 = h("POST", "/prompt_library/folder_pin", Req({"path": "НетТакойПапки"}))
check("folder_pin: несуществующая папка -> 404", r_fpin3["status"] == 404, str(r_fpin3))
r_fpin4 = h("POST", "/prompt_library/folder_pin", Req({"path": "__fav"}))
check("folder_pin: служебная ветка -> 400", r_fpin4["status"] == 400, str(r_fpin4))
# Закреп переживает переименование/удаление папки (v1.37 cleanup)
h("POST", "/prompt_library/folder_pin", Req({"path": "МассФото", "pinned": True}))
h("POST", "/prompt_library/folder_rename", Req({"old": "МассФото", "new": "МассФото2"}))
check("folder_pin: переименование двигает закреп",
      mod._load_pinned_folders() == ["МассФото2"], str(mod._load_pinned_folders()))
h("POST", "/prompt_library/folder_delete", Req({"path": "МассФото2"}))
check("folder_pin: удаление папки чистит закреп",
      mod._load_pinned_folders() == [], str(mod._load_pinned_folders()))
check("folder_pin: записи удалённой папки переехали в корень",
      (_entry("масс-портрет") or {}).get("folder") == "")


# --- 25. граф записи отдельным файлом (v1.40) --------------------------------
# Снимок графа — ЗАДУМАННАЯ часть карточки (§24.1), но хранить его внутри
# library.json нельзя: 340 КБ на запись (12 МБ из 18 на живой базе) делали
# тяжёлой каждую операцию. Теперь граф лежит в workflows/{id}.json, а клиент
# получает то же поле workflow от /entry (JS не менялся). Старые записи с
# inline-графом НЕ переделываем — читаются сначала inline, потом файл.
_p("\n25. Граф записи: workflows/{id}.json + совместимость со старыми записями")
node5 = mod.PromptLibrary()
wf_dir = mod._ensure_dirs() / "workflows"
check("папка workflows/ создаётся вместе с базой", wf_dir.is_dir())

before5 = len(mod._load_db()[0])
res40 = node5.execute(mode=node5.MODE_WRITE, selected="", save_folder="Графы",
                      source="промпт с графом v1.40",
                      extra_pnginfo={"workflow": {"nodes": [{"id": 1}], "links": []}},
                      unique_id=9, image=None)
check("v1.40: запись создана",
      any(e.get("prompt") == "промпт с графом v1.40" for e in mod._load_db()[0]),
      str(res40["ui"]["saved_id"]))
_e40 = _entry("промпт с графом v1.40") or {}
check("v1.40: inline-граф в записи НЕ пишется", not _e40.get("workflow"),
      str(bool(_e40.get("workflow"))))
check("v1.40: в записи — отметка файла графа",
      _e40.get("workflow_file") == f"workflows/{_e40.get('id')}.json",
      str(_e40.get("workflow_file")))
check("v1.40: файл графа существует и читается",
      isinstance(mod._entry_workflow(_e40), dict)
      and isinstance(mod._entry_workflow(_e40).get("nodes"), list))
check("v1.40: GET /list сразу знает про граф (без чтения файлов)",
      any(e["id"] == _e40["id"] and e["has_workflow"] for e in h("GET", "/prompt_library/list", Req())["json"]["entries"]))
_r_entry40 = h("GET", "/prompt_library/entry", Req(query={"id": _e40["id"]}))
check("v1.40: /entry отдаёт то же поле workflow (клиент не менялся)",
      isinstance(_r_entry40["json"].get("workflow"), dict)
      and _r_entry40["json"]["workflow"].get("nodes"), str(_r_entry40["json"].get("workflow"))[:80])

# Старые записи: inline-граф читается как раньше, в файлы ничего не двигаем
# (файл от прошлой проверки убираем — он не часть «старой» записи)
mod._remove_workflow_file(_e40["id"])
_e_all5, _f_all5 = mod._load_db()
for _e in _e_all5:
    if _e["id"] == _e40["id"]:
        _e.pop("workflow_file", None)
        _e["workflow"] = {"nodes": [{"id": 7}], "links": []}
mod._save_db(_e_all5, _f_all5)
_legacy = _entry("промпт с графом v1.40")
check("старая запись с inline-графом читается без файла",
      mod._entry_workflow(_legacy) == {"nodes": [{"id": 7}], "links": []},
      str(mod._entry_workflow(_legacy)))
check("старая запись: has_workflow в списке",
      any(e["id"] == _legacy["id"] and e["has_workflow"]
          for e in h("GET", "/prompt_library/list", Req())["json"]["entries"]))
check("старая запись: файл графа задним числом НЕ создаётся",
      not (wf_dir / f"{_legacy['id']}.json").exists())
# Вернём запись в новый формат для дальнейших проверок
mod._remove_workflow_file(_legacy["id"])
_e_all5, _f_all5 = mod._load_db()
for _e in _e_all5:
    if _e["id"] == _legacy["id"]:
        _e.pop("workflow", None)
mod._save_db(_e_all5, _f_all5)
mod._attach_workflow(_e_all5, _legacy["id"], {"nodes": [{"id": 3}], "links": []})
mod._save_db(*mod._load_db())

# Битый/чужой файл графа не должен ронять ноду
_wf_file = wf_dir / f"{_legacy['id']}.json"
_wf_backup = _wf_file.read_text(encoding="utf-8")
_wf_file.write_text("{{ это не json", encoding="utf-8")
check("битый файл графа -> None, без исключения",
      mod._entry_workflow(_entry("промпт с графом v1.40")) is None)
_wf_file.write_text(_wf_backup, encoding="utf-8")
check("id не alfanum -> файл не адресуется (traversal закрыт)",
      mod._workflow_path("../secret") is None and mod._workflow_path("") is None)

# Замена превью обязана перенести граф в новую картинку (ловушка §24.2)
_orig_thumb40 = mod._save_thumbnail
_seen40 = []

def _thumb_stub40(img, entry_id, workflow=None):
    _seen40.append(workflow)
    return f"previews/{entry_id}.png"


mod._save_thumbnail = _thumb_stub40
_orig_loader40 = mod._load_image_file
mod._load_image_file = lambda path: [[[0, 0, 0]]]
(out_dir / "run40.png").write_bytes(b"x")
try:
    _r_repl = h("POST", "/prompt_library/attach_preview", Req(
        {"id": _legacy["id"], "filename": "run40.png", "subfolder": "", "type": "output", "force": True}))
    check("замена превью прошла", _r_repl["status"] == 200, str(_r_repl))
    check("замена превью перенесла граф (чанк в новой картинке)",
          bool(_seen40) and isinstance(_seen40[0], dict) and _seen40[0].get("nodes"),
          str(_seen40[:1])[:80])
finally:
    mod._save_thumbnail = _orig_thumb40
    mod._load_image_file = _orig_loader40

# Подхват и удаление — тоже с файлами графов
_tok40 = node5.execute(mode=node5.MODE_BOTH, selected="", save_folder="Графы", pickup="1622",
                       source="", extra_pnginfo={"workflow": {"nodes": [{"id": 2}], "links": []}},
                       unique_id=9)["ui"].get("pickup") or [""]
_r_pick40 = h("POST", "/prompt_library/save_pickup",
              Req({"token": _tok40[0], "text": "подхваченный текст с графом"}))
_pick40 = _entry("подхваченный текст с графом") or {}
check("подхват: запись создана", bool(_pick40.get("id")), str(_r_pick40))
check("подхват: граф тоже файлом, без inline",
      bool(_pick40.get("workflow_file")) and not _pick40.get("workflow"),
      str(_pick40.get("workflow_file")))
check("подхват: файл графа на месте", (wf_dir / f"{_pick40['id']}.json").exists())

_prev_file40 = _ensure_preview_file = ""
for _e in mod._load_db()[0]:
    if _e.get("preview"):
        _prev_file40 = mod._ensure_dirs() / _e["preview"]
        break
h("POST", "/prompt_library/delete", Req({"id": _pick40["id"]}))
check("удаление записи убирает файл графа",
      not (wf_dir / f"{_pick40['id']}.json").exists())

# Обрезка MAX_ENTRIES не оставляет сирот в workflows/
_orig_max = mod.MAX_ENTRIES
mod.MAX_ENTRIES = 3
_trim_probe = [{"id": f"trim{i:04d}", "workflow_file": f"workflows/trim{i:04d}.json"} for i in range(6)]
for _e in _trim_probe:
    mod._save_workflow_file(_e["id"], {"nodes": [{"id": 1}], "links": []})
_left = mod._trim_entries(_trim_probe)
check("обрезка списка возвращает не больше MAX_ENTRIES", len(_left) == 3, str(len(_left)))
check("обрезка убирает файлы графов отброшенных записей",
      not (wf_dir / "trim0005.json").exists() and (wf_dir / "trim0002.json").exists())
mod.MAX_ENTRIES = _orig_max


# --- 26. Самоаудит хранения графа (v1.40) ------------------------------------
# Три дыры, найденные чтением кода после внедрения файлового хранения:
#   (а) ui.entries в execute отдавал has_workflow по inline-полю — для новых
#       записей это ВСЕГДА false, хотя граф есть (у /list флаг честный);
#   (б) потерянный файл графа (копия базы без workflows/, восстановление из
#       бэкапа) — /list врал «граф есть», а вылечить запись было нечем;
#   (в) обрезка MAX_ENTRIES убирала файл графа, но оставляла файл превью.
_p("\n26. Самоаудит: флаг графа в ui, потерянный файл, сирота-превью")
node26 = mod.PromptLibrary()
res26 = node26.execute(mode=node26.MODE_WRITE, selected="", save_folder="Аудит",
                       source="прогон для проверки флага графа",
                       extra_pnginfo={"workflow": {"nodes": [{"id": 1}], "links": []}},
                       unique_id=26, image=None)
_e26 = _entry("прогон для проверки флага графа") or {}
check("26: запись с графом создана (граф — файлом)",
      bool(_e26.get("workflow_file")) and not _e26.get("workflow"),
      str(_e26.get("workflow_file")))
_ui26 = [e for e in res26["ui"]["entries"] if e.get("id") == _e26.get("id")]
check("26: ui.entries говорит has_workflow=true, а не по inline-полю",
      bool(_ui26) and _ui26[0].get("has_workflow") is True, str(_ui26[:1]))

# (б) файл графа пропал — список не должен врать, а прогон обязан вылечить запись
_wf26 = wf_dir / f"{_e26['id']}.json"
check("26: файл графа на месте до потери", _wf26.exists())
_wf26.unlink()
check("26: потерянный файл -> /list не врёт про has_workflow",
      not any(e["id"] == _e26["id"] and e["has_workflow"]
              for e in h("GET", "/prompt_library/list", Req())["json"]["entries"]))
check("26: потерянный файл -> /entry отдаёт None, без исключения",
      h("GET", "/prompt_library/entry", Req(query={"id": _e26["id"]}))["json"].get("workflow") is None)
node26.execute(mode=node26.MODE_WRITE, selected="", save_folder="Аудит",
               source="прогон для проверки флага графа",
               extra_pnginfo={"workflow": {"nodes": [{"id": 5}], "links": []}},
               unique_id=26, image=None)
check("26: повторный прогон того же текста вылечил файл графа", _wf26.exists())
check("26: после лечения /entry снова отдаёт граф",
      isinstance(h("GET", "/prompt_library/entry", Req(query={"id": _e26["id"]}))
                 ["json"].get("workflow"), dict))

# папка в favorite_many нормализуется (как во всех остальных роутах)
h("POST", "/prompt_library/favorite_many", Req({"folder_paths": [" Аудит "]}))
check("26: favorite_many нормализует путь папки",
      (_entry("прогон для проверки флага графа") or {}).get("favorite") is True)

# (в) обрезка MAX_ENTRIES не оставляет сирот-превью
_prev_dir26 = mod._ensure_dirs() / "previews"
_prev_dir26.mkdir(parents=True, exist_ok=True)
_orig_max26 = mod.MAX_ENTRIES
mod.MAX_ENTRIES = 3
_trim26 = [{"id": f"trim26{i:04d}", "preview": f"previews/trim26{i:04d}.png"} for i in range(6)]
for _e in _trim26:
    (_prev_dir26 / f"{_e['id']}.png").write_bytes(b"x")
mod._trim_entries(_trim26)
check("26: обрезка убирает и файлы превью отброшенных записей",
      not (_prev_dir26 / "trim260005.png").exists() and (_prev_dir26 / "trim260002.png").exists())
mod.MAX_ENTRIES = _orig_max26


print("\n27. Мультивывод (§40): 12 выходов, slots_out")
check("27: RETURN_TYPES — 12 STRING", mod.PromptLibrary.RETURN_TYPES == tuple(["STRING"] * 12),
      str(mod.PromptLibrary.RETURN_TYPES))
check("27: RETURN_NAMES — category_path, prompt_1, prompt_2..prompt_11",
      mod.PromptLibrary.RETURN_NAMES == ("category_path", "prompt_1",
                                        *[f"prompt_{i}" for i in range(2, 12)]),
      str(mod.PromptLibrary.RETURN_NAMES))

node27 = mod.PromptLibrary()

# Базовые записи для слотов
node27.execute(mode=node27.MODE_WRITE, selected="", save_folder="Слоты",
               source="текст-карточки-1", extra_pnginfo=None, unique_id=1)
node27.execute(mode=node27.MODE_WRITE, selected="", save_folder="Слоты/Под",
               source="текст-карточки-2", extra_pnginfo=None, unique_id=2)
_e27a = _entry("текст-карточки-1")
_e27b = _entry("текст-карточки-2")

# Пустой slots_out → пустые дополнительные выходы
res27 = node27.execute(mode=node27.MODE_ISSUE, selected="", save_folder="", slots_out="",
                       extra_pnginfo=None, unique_id=1)
check("27: пустой slots_out → слоты пусты", len(res27["result"]) == 12
      and all(s == "" for s in res27["result"][2:]), str(len(res27["result"])))
check("27: 0-1 выходы на месте", res27["result"][0] == "" and res27["result"][1] == "",
      str(res27["result"][:2]))

# Порядок 0/1 (§40, v1.45.1): 0 — путь категории, 1 — основной текст.
# Имена сокетов в UI («путь категории» / «промпт 1 (основной)») обязаны совпадать
# с тем, что реально едет по проводу — на этом стоял дефект v1.44.
res27o2 = node27.execute(mode=node27.MODE_ISSUE, selected=_e27a["id"], save_folder="Слоты/Под",
                         extra_pnginfo=None, unique_id=1)
check("27: выход 0 — путь категории, выход 1 — текст записи",
      res27o2["result"][0] == "Слоты/Под/" and res27o2["result"][1] == "текст-карточки-1",
      str(res27o2["result"][:2]))

# Битый JSON не роняет ноду
res27x = node27.execute(mode=node27.MODE_ISSUE, selected="", save_folder="", slots_out="{{{",
                        extra_pnginfo=None, unique_id=1)
check("27: битый JSON → слоты пусты, нода не падает", len(res27x["result"]) == 12
      and all(s == "" for s in res27x["result"][2:]))

# Карточка в слоте 2, папка в слоте 3 (active_id — выбранная запись папки)
slots27 = json.dumps([
    {"i": 2, "kind": "card", "id": _e27a["id"], "name": "Карточка 1"},
    {"i": 3, "kind": "folder", "path": "Слоты/Под", "active_id": _e27b["id"], "name": "Под"},
])
res27s = node27.execute(mode=node27.MODE_ISSUE, selected="", save_folder="", slots_out=slots27,
                        extra_pnginfo=None, unique_id=1)
check("27: слот-карточка выдаёт prompt записи", res27s["result"][2] == "текст-карточки-1",
      str(res27s["result"][2]))
check("27: слот-папка выдаёт prompt active_id", res27s["result"][3] == "текст-карточки-2",
      str(res27s["result"][3]))
check("27: незанятые слоты пусты", res27s["result"][4] == "" and res27s["result"][11] == "")

# Удалённая запись → «(запись удалена)»
slots27g = json.dumps([
    {"i": 5, "kind": "card", "id": "нет-такого-id", "name": "Потеряшка"},
    {"i": 6, "kind": "folder", "path": "Слоты", "active_id": "нет-такого-id", "name": "Слоты"},
])
res27g = node27.execute(mode=node27.MODE_ISSUE, selected="", save_folder="", slots_out=slots27g,
                        extra_pnginfo=None, unique_id=1)
check("27: карточка без записи → «(запись удалена)»", res27g["result"][5] == "(запись удалена)",
      str(res27g["result"][5]))
check("27: папка с несуществующим active_id → пусто", res27g["result"][6] == "",
      str(res27g["result"][6]))

# Индекс вне диапазона и не-int игнорируются
slots27o = json.dumps([
    {"i": 0, "kind": "card", "id": _e27a["id"]},
    {"i": 12, "kind": "card", "id": _e27a["id"]},
    {"i": "2", "kind": "card", "id": _e27a["id"]},
    {"i": 7, "kind": "unknown", "id": _e27a["id"]},
])
res27o = node27.execute(mode=node27.MODE_ISSUE, selected="", save_folder="", slots_out=slots27o,
                        extra_pnginfo=None, unique_id=1)
check("27: вне 2..11 / не-int / незнакомый kind отброшены",
      all(s == "" for s in res27o["result"][2:]), str(res27o["result"][2:]))

# List-форма (map-over-list) — как pickup
res27l = node27.execute(mode=node27.MODE_ISSUE, selected="", save_folder="", slots_out=[slots27],
                        extra_pnginfo=None, unique_id=1)
check("27: slots_out списком (map-over-list) работает", len(res27l["result"]) == 12
      and res27l["result"][2] == "текст-карточки-1", str(res27l["result"][:4]))

# PNG-патч несёт slots_out 5-м значением
wf27 = {"nodes": [{"id": 7, "widgets_values": ["x"]}], "links": []}
node27.execute(mode=node27.MODE_ISSUE, selected="", save_folder="", slots_out=slots27,
               extra_pnginfo={"workflow": wf27}, unique_id=7)
check("27: PNG-патч несёт slots_out 5-м значением",
      wf27["nodes"][0]["widgets_values"] == [node27.MODE_ISSUE, "", "", "", slots27],
      str(wf27["nodes"][0]["widgets_values"]))

# Выдача + слоты одновременно: prompt_out своим, слоты своими
res27x2 = node27.execute(mode=node27.MODE_ISSUE, selected=_e27a["id"], save_folder="",
                         slots_out=slots27, extra_pnginfo=None, unique_id=1)
check("27: prompt_out (выбор) и слот (та же запись) не конфликтуют",
      res27x2["result"][1] == "текст-карточки-1" and res27x2["result"][2] == "текст-карточки-1",
      str(res27x2["result"][:3]))


# --- 41. HTML-галерея: метаданные генерации (v1.46, §41) ----------------------
print("\n41. /meta + _gen_meta + _preview_workflow_chunk")
# Узлы: модель, lora, сэмплер, латент, vae — как в реальном UI-графе
_wf41 = {"nodes": [
    {"id": 1, "type": "CheckpointLoaderSimple",
     "widgets_values": ["dreamshaper_8.safetensors"]},
    {"id": 2, "type": "LoraLoader",
     "widgets_values": ["detail.safetensors", 0.8, 0.8]},
    {"id": 3, "type": "KSampler",
     "widgets_values": [1234, "fixed", 28, 7.5, "euler", "normal", 0.6]},
    {"id": 4, "type": "EmptyLatentImage",
     "widgets_values": [768, 512, 1]},
    {"id": 5, "type": "VAELoader",
     "widgets_values": ["vae-ft-mse.safetensors"]},
], "links": []}

meta41 = mod._gen_meta(_wf41)
check("41: модель из CheckpointLoaderSimple", meta41.get("model") == "dreamshaper_8.safetensors",
      str(meta41))
check("41: сэмплер из KSampler (name/шаги/cfg/denoise/сид)",
      meta41.get("sampler") == "euler" and meta41.get("steps") == 28
      and meta41.get("cfg") == 7.5 and meta41.get("denoise") == 0.6
      and meta41.get("seed") == 1234, str(meta41))
check("41: scheduler из KSampler", meta41.get("scheduler") == "normal", str(meta41))
check("41: разрешение из EmptyLatentImage", meta41.get("width") == 768
      and meta41.get("height") == 512, str(meta41))
check("41: vae из VAELoader", meta41.get("vae") == "vae-ft-mse.safetensors", str(meta41))
check("41: lora c силой", meta41.get("loras") == [{"name": "detail.safetensors", "strength": 0.8}],
      str(meta41.get("loras")))

# KSamplerAdvanced: сид на индексе 1, denoise нет
_wf41a = {"nodes": [
    {"id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["m.safetensors"]},
    {"id": 2, "type": "KSamplerAdvanced",
     "widgets_values": ["enable", 42, "fixed", 20, 6.0, "dpmpp_2m", "karras", 0, 20, "disable"]},
], "links": []}
meta41a = mod._gen_meta(_wf41a)
check("41: KSamplerAdvanced (сид 1, шаги 3, cfg 4, имя 5, расписание 6)",
      meta41a.get("seed") == 42 and meta41a.get("steps") == 20
      and meta41a.get("cfg") == 6.0 and meta41a.get("sampler") == "dpmpp_2m"
      and meta41a.get("scheduler") == "karras", str(meta41a))

# UNETLoader-модель (Flux и Ко) и LoraLoaderModelOnly (две силы)
_wf41b = {"nodes": [
    {"id": 1, "type": "UNETLoader", "widgets_values": ["flux1-dev.safetensors", "default"]},
    {"id": 2, "type": "LoraLoaderModelOnly", "widgets_values": ["lora.safetensors", 1.0]},
], "links": []}
meta41b = mod._gen_meta(_wf41b)
check("41: UNETLoader даёт модель", meta41b.get("model") == "flux1-dev.safetensors", str(meta41b))
check("41: LoraLoaderModelOnly (одна сила)", meta41b.get("loras")[0]["strength"] == 1.0,
      str(meta41b.get("loras")))

# Пустой / битый граф: не падает, {} (галерея скажет «нет данных прогона»)
check("41: пустой граф -> {}", mod._gen_meta(None) == {} and mod._gen_meta({"nodes": []}) == {}
      and mod._gen_meta([1, 2]) == {})
_wf41bad = {"nodes": [{"type": "KSampler", "widgets_values": "не-список"}]}
check("41: widgets_values не-список не роняет", mod._gen_meta(_wf41bad) == {})
_wf41bad2 = {"nodes": [{"type": "CheckpointLoaderSimple"}]}
check("41: узел без widgets_values пропущен", mod._gen_meta(_wf41bad2) == {})

# Чанк workflow из PNG: пишем настоящий файл через PngInfo
_tmpwf_dir = TMP / "previews"
_tmpwf_dir.mkdir(parents=True, exist_ok=True)
_chunk_f = _tmpwf_dir / "chunk41.png"
try:
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    _info = PngInfo()
    _info.add_text("workflow", json.dumps({"nodes": [{"type": "KSampler",
                                                      "widgets_values": [7, "x", 21, 6, "euler", "normal", 1.0]}]}))
    Image.new("RGB", (8, 8), (10, 20, 30)).save(_chunk_f, "PNG", pnginfo=_info)
    _wf_from_chunk = mod._preview_workflow_chunk(_chunk_f)
    check("41: _preview_workflow_chunk читает чанк из PNG",
          isinstance(_wf_from_chunk, dict) and _wf_from_chunk["nodes"][0]["widgets_values"][2] == 21,
          str(_wf_from_chunk))
    check("41: _gen_meta из чанка даёт параметры",
          mod._gen_meta(_wf_from_chunk).get("steps") == 21)
except Exception as e:
    check("41: _preview_workflow_chunk/PngInfo", False, f"{type(e).__name__}: {e}")

# JPEG-чанк не несёт → None; отсутствующий файл → None
check("41: чанк из не-PNG/jpg -> None", mod._preview_workflow_chunk(_chunk_f.with_suffix(".jpg")) is None)
check("41: чанк из отсутствующего файла -> None",
      mod._preview_workflow_chunk(_tmpwf_dir / "нету.png") is None)
_chunk_junk = _tmpwf_dir / "junk41.png"
Image.new("RGB", (4, 4)).save(_chunk_junk, "PNG")
check("41: PNG без чанка workflow -> None", mod._preview_workflow_chunk(_chunk_junk) is None)

# Роут /meta: (1) превью с чанком побеждает; (2) без превью/чанка — фолбэк
# на граф из /entry (inline); (3) ничего нет -> {};  (4) битый превью -> фолбэк.
_e41 = h("POST", "/prompt_library/add", Req({"prompt": "карточка для метаданных", "folder": "Мета"}))
_e41id = _e41["json"]["id"]
# (1) пишем превью с настоящим чанком
_prev41 = mod._ensure_dirs() / "previews" / f"{_e41id}.png"
Image.new("RGB", (6, 6), (1, 2, 3)).save(_prev41, "PNG", pnginfo=_info)
checks_success = _prev41.exists()
r41 = h("GET", "/prompt_library/meta", Req(query={"id": _e41id}))
check("41: /meta читает параметры из чанка превью",
      r41["json"]["meta"].get("steps") == 21 and r41["json"]["meta"].get("seed") == 7,
      str(r41["json"]))
check("41: /meta отдаёт тот же id", r41["json"]["id"] == _e41id, str(r41["json"]))
# (2) запись без превью и с inline-графом
_e41b = h("POST", "/prompt_library/add", Req({"prompt": "запись с inline-графом", "folder": "Мета"}))
_e41bid = _e41b["json"]["id"]
db41 = json.loads(lib_file.read_text(encoding="utf-8"))
for e in db41["entries"]:
    if e["id"] == _e41bid:
        e["workflow"] = {"nodes": [{"type": "CheckpointLoaderSimple",
                                    "widgets_values": ["inline-model.safetensors"]}]}
lib_file.write_text(json.dumps(db41, ensure_ascii=False), encoding="utf-8")
r41b = h("GET", "/prompt_library/meta", Req(query={"id": _e41bid}))
check("41: /meta без превью -> фолбэк на inline-граф",
      r41b["json"]["meta"].get("model") == "inline-model.safetensors", str(r41b["json"]))
# (3) запись вообще без графа
_e41c = h("POST", "/prompt_library/add", Req({"prompt": "без графа", "folder": "Мета"}))
r41c = h("GET", "/prompt_library/meta", Req(query={"id": _e41c["json"]["id"]}))
check("41: /meta без графа -> {}", r41c["json"]["meta"] == {}, str(r41c["json"]))

r41ie = h("GET", "/prompt_library/meta", Req(query={"id": "нет-такого"}))
check("41: /meta неизвестной записи -> {} (без ошибки)", r41ie["json"]["meta"] == {}, str(r41ie["json"]))


# --- 41b. Модель/LoRA из ЧУЖИХ узлов и сабграфов (v1.47) ----------------------
# Живой случай пользователя: штатных CheckpointLoaderSimple/LoraLoader в графе
# НЕТ. Модель — в сабграфе со свитчем (узел с типом-UUID + definitions.subgraphs),
# LoRA — слоты Power Lora Loader (rgthree), рядом стоит апскейлер SeedVR2 со
# своей моделью. До v1.47 поля model/loras в таких графах были пустыми.
print("\n41b. _file_role / _chain_meta / _generic_meta (модель и LoRA)")

_ROLE_OF_41B = {
    "merged.safetensors": "model",
    "raw_int8.safetensors": "model",
    "turbo_int8.safetensors": "model",
    "on_lora.safetensors": "lora",
    "off_lora.safetensors": "lora",
    "hidden_lora.safetensors": "lora",
    "r4b_lora.safetensors": "lora",
    "vae_chain.safetensors": "vae",
    "vae_offchain.safetensors": "vae",
}
_role41b = _ROLE_OF_41B.get


# Сабграф (definitions.subgraphs): внутри — два UNETLoader'а (свитч моделей).
_SUB47_ID = "8dcc0000-subgraph-model-switch"
# Внутри — как в ЖИВОМ графе пользователя: два UNETLoader'а, ComfySwitchNode
# (`on_true`/`on_false` + селектор от PrimitiveBoolean), LoRA только на ветке RAW,
# а имена моделей и положение селектора подняты в promoted-входы ЭКЗЕМПЛЯРА.
_sub47 = {"id": _SUB47_ID, "name": "MODEL SWITCH", "nodes": [
    {"id": 11, "type": "UNETLoader",
     "inputs": [{"name": "unet_name", "widget": {"name": "unet_name"}}],
     "widgets_values": ["raw_int8.safetensors", "default"],
     "outputs": [{"name": "MODEL", "links": [3011]}]},
    {"id": 12, "type": "UNETLoader",
     "inputs": [{"name": "unet_name", "widget": {"name": "unet_name"}, "link": 3001}],
     "widgets_values": ["turbo_int8.safetensors", "default"],
     "outputs": [{"name": "MODEL", "links": [3012]}]},
    {"id": 14, "type": "LoraLoaderModelOnly",
     "inputs": [{"name": "model", "type": "MODEL", "link": 3011}],
     "widgets_values": ["r4b_lora.safetensors", 0.6],
     "outputs": [{"name": "MODEL", "links": [3013]}]},
    {"id": 16, "type": "PrimitiveBoolean",
     "inputs": [{"name": "value", "widget": {"name": "value"}, "link": 3003}],
     "widgets_values": [True], "outputs": [{"name": "BOOLEAN", "links": [3014]}]},
    {"id": 15, "type": "ComfySwitchNode",
     "inputs": [{"name": "on_false", "type": "MODEL", "link": 3012},
                 {"name": "on_true", "type": "MODEL", "link": 3013},
                 {"name": "switch", "type": "BOOLEAN", "widget": {"name": "switch"}, "link": 3014}],
     "widgets_values": [False], "outputs": [{"name": "output", "type": "MODEL", "links": [3015]}]},
    {"id": 13, "type": "VAELoader", "widgets_values": ["vae_chain.safetensors"],
     "outputs": [{"name": "VAE", "links": [3016]}]},
], "outputNode": {"id": -20, "inputs": [{"name": "MODEL", "link": 3015},
                                              {"name": "VAE", "link": 3016}]},
   "inputs": [{"name": "unet_name_1", "linkIds": [3001]},
              {"name": "value_2", "linkIds": [3003]}],
   "links": [[3001, -10, 0, 12, 0, "COMBO"],
             [3003, -10, 1, 16, 0, "BOOLEAN"],
             [3011, 11, 0, 14, 0, "MODEL"],
             [3012, 12, 0, 15, 0, "MODEL"],
             [3013, 14, 0, 15, 1, "MODEL"],
             [3014, 16, 0, 15, 2, "BOOLEAN"],
             [3015, 15, 0, -20, 0, "MODEL"],
             [3016, 13, 0, -20, 1, "VAE"]]}


_wf47 = {
    "nodes": [
        {"id": 1, "type": "KSampler", "inputs": [{"name": "model", "type": "MODEL", "link": 100}],
         "widgets_values": [7, "fixed", 8, 1, "euler", "beta", 1]},
        {"id": 2, "type": "Power Lora Loader (rgthree)",
         "inputs": [{"name": "model", "type": "MODEL", "link": 101}],
         "widgets_values": [
             {}, {"type": "PowerLoraLoaderHeaderWidget"},
             {"on": False, "lora": "off_lora.safetensors", "strength": 1},
             {"on": True, "lora": "on_lora.safetensors", "strength": 0.75},
         ]},
        # Экземпляр сабграфа: widgets_values идут по его promoted-входам
        # [имя модели для ветки TURBO, переключатель RAW]
        {"id": 3, "type": _SUB47_ID, "widgets_values": ["merged.safetensors", False],
         "outputs": [{"name": "MODEL", "links": [101]}]},
        # Апскейлер стоит в стороне от цепочки — его модель к генерации не относится
        {"id": 4, "type": "SeedVR2LoadDiTModel", "widgets_values": ["upscaler_7b.safetensors"]},
        # Заметка с именем файла — не использование модели
        {"id": 5, "type": "MarkdownNote", "widgets_values": ["Таблица LoRA: hidden_lora.safetensors"]},
        {"id": 6, "type": "VAELoader", "widgets_values": ["vae_offchain.safetensors"]},
    ],
    "links": [[100, 2, 0, 1, 0, "MODEL"], [101, 3, 0, 2, 0, "MODEL"]],
    "definitions": {"subgraphs": [_sub47]},
}
_meta47 = mod._gen_meta(_wf47, role_of=_role41b)
check("41b: модель — ТОЛЬКО активная ветка (имя перекрыто promoted-входом)",
      _meta47.get("model") == "merged.safetensors", str(_meta47.get("model")))
check("41b: модели неактивной ветки не попадают в галерею (raw/turbo)",
      "raw_int8.safetensors" not in json.dumps(_meta47, ensure_ascii=False)
      and "turbo_int8.safetensors" not in json.dumps(_meta47, ensure_ascii=False), str(_meta47))
check("41b: LoRA неактивной ветки НЕ показывается, включённый слот — да",
      _meta47.get("loras") == [{"name": "on_lora.safetensors", "strength": 0.75}],
      str(_meta47.get("loras")))
check("41b: апскейлер вне цепочки моделью НЕ считается",
      "upscaler_7b.safetensors" not in ( _meta47.get("model") or ""), str(_meta47.get("model")))
check("41b: заметка MarkdownNote не источник моделей и LoRA",
      "hidden_lora.safetensors" not in json.dumps(_meta47, ensure_ascii=False), str(_meta47))
check("41b: VAE — из цепочки (в сабграфе), а не первый попавшийся в графе",
      _meta47.get("vae") == "vae_chain.safetensors", str(_meta47.get("vae")))
check("41b: позиционные параметры KSampler на месте (сид/шаги/cfg)",
      _meta47.get("steps") == 8 and _meta47.get("cfg") == 1 and _meta47.get("seed") == 7,
      str(_meta47))
check("41b: разрешённый переключатель — без пометки «туманность»",
      not _meta47.get("ambiguous"), str(_meta47))

# Тот же граф, но переключатель поднят в положение RAW: активна ветка с LoRA
_wf47t = json.loads(json.dumps(_wf47))
for _n in _wf47t["nodes"]:
    if _n["type"] == _SUB47_ID:
        _n["widgets_values"] = ["merged.safetensors", True]
_meta47t = mod._gen_meta(_wf47t, role_of=_role41b)
check("41b: переключатель на RAW -> модель ветки RAW и её LoRA",
      _meta47t.get("model") == "raw_int8.safetensors"
      and sorted(l["name"] for l in _meta47t.get("loras", []))
      == ["on_lora.safetensors", "r4b_lora.safetensors"], str(_meta47t))
check("41b: сила LoRA берётся из позиционного виджета (0.6)",
      any(l.get("strength") == 0.6 for l in _meta47t.get("loras", [])), str(_meta47t.get("loras")))

# Селектор, значение которого не понять → обе ветки + пометка (не врём)
_wf47u = json.loads(json.dumps(_wf47))
for _n in _wf47u["nodes"]:
    if _n["type"] == _SUB47_ID:
        _n["widgets_values"] = ["merged.safetensors", "???"]
_meta47u = mod._gen_meta(_wf47u, role_of=_role41b)
check("41b: неразрешённый селектор -> обе модели и пометка ambiguous",
      _meta47u.get("ambiguous") is True
      and "merged.safetensors" in str(_meta47u.get("model"))
      and "raw_int8.safetensors" in str(_meta47u.get("model")), str(_meta47u))

# DeggSwitch: активен вход с номером из виджета `select`
_wf47d2 = {"nodes": [
    {"id": 1, "type": "KSampler", "inputs": [{"name": "model", "type": "MODEL", "link": 401}],
     "widgets_values": [1, "fixed", 4, 1, "euler", "normal", 1]},
    {"id": 2, "type": "DeggSwitch",
     "inputs": [{"name": "input_1", "type": "MODEL", "link": 402},
                 {"name": "input_2", "type": "MODEL", "link": 403},
                 {"name": "select", "type": "INT", "widget": {"name": "select"}}],
     "widgets_values": [2], "outputs": [{"name": "output", "links": [401]}]},
    {"id": 3, "type": "UNETLoader", "widgets_values": ["first_model.safetensors", "x"],
     "outputs": [{"name": "MODEL", "links": [402]}]},
    {"id": 4, "type": "UNETLoader", "widgets_values": ["second_model.safetensors", "x"],
     "outputs": [{"name": "MODEL", "links": [403]}]},
], "links": [[401, 2, 0, 1, 0, "MODEL"], [402, 3, 0, 2, 0, "MODEL"], [403, 4, 0, 2, 1, "MODEL"]]}
_meta47d2 = mod._gen_meta(_wf47d2, role_of={"first_model.safetensors": "model",
                                             "second_model.safetensors": "model"}.get)
check("41b: DeggSwitch select=2 -> модель только второго входа",
      _meta47d2.get("model") == "second_model.safetensors"
      and not _meta47d2.get("ambiguous"), str(_meta47d2))

# Без сэмплера цепочки нет — включается поиск по всему графу (фолбэк)
_wf47b = {"nodes": [
    {"id": 1, "type": "UNETLoader", "widgets_values": ["lonely.safetensors", "default"]},
    {"id": 2, "type": "Power Lora Loader (rgthree)",
     "widgets_values": [{"on": True, "lora": "solo_lora.safetensors", "strength": 1}]},
], "links": []}
_meta47b = mod._gen_meta(_wf47b, role_of=_role41b)
check("41b: без сэмплера модель берётся по всему графу (фолбэк)",
      _meta47b.get("model") == "lonely.safetensors", str(_meta47b))
check("41b: без сэмплера LoRA тоже находится",
      [l["name"] for l in _meta47b.get("loras", [])] == ["solo_lora.safetensors"], str(_meta47b))

# Роли файлов: раскладка на диске важнее подсказок, иначе — по подсказкам типа узла
check("41b: _file_role — роль по диску важнее имени узла",
      mod._file_role("x.safetensors", "SeedVR2LoadDiTModel", role_of={"x.safetensors": "vae"}.get)
      == ("vae", True))
check("41b: _file_role — lora по имени узла",
      mod._file_role("y.safetensors", "Power Lora Loader (rgthree)", role_of=lambda b: None)
      == ("lora", False))
check("41b: _file_role — DiT-лоадер как модель-фолбэк",
      mod._file_role("z.safetensors", "SeedVR2LoadDiTModel", role_of=lambda b: None)
      == ("model", False))
check("41b: _file_role — апскейлер/VAE-аппроксиматор это НЕ модель",
      mod._file_role("up.pth", "UpscaleModelLoader", role_of=lambda b: None) == ("other", False)
      and mod._file_role("t.safetensors", "ModelPreviewOverrideKJ", role_of=lambda b: None)
      == ("other", False))
check("41b: _file_role — непонятное имя без подсказок не выдумываем",
      mod._file_role("q.safetensors", "SomeUnknownNode", role_of=lambda b: None) == (None, False))

# Многострочный текст (промпт со списком моделей) кандидатом не считается
_wf47c = {"nodes": [{"id": 1, "type": "PrimitiveStringMultiline",
                     "widgets_values": ["модель a.safetensors\n и ещё b.safetensors"]}],
          "links": []}
check("41b: имя файла внутри многострочного текста не кандидат",
      mod._gen_meta(_wf47c, role_of=_role41b) == {}, str(mod._gen_meta(_wf47c, role_of=_role41b)))

# Кольцо в проводах не подвешивает разбор (защита seen)
_wf47d = {"nodes": [
    {"id": 1, "type": "KSampler", "inputs": [{"name": "model", "type": "MODEL", "link": 1}],
     "widgets_values": [1, "fixed", 1, 1, "euler", "normal", 1]},
    {"id": 2, "type": "ComfySwitchNode",
     "inputs": [{"name": "model", "type": "MODEL", "link": 2}],
     "widgets_values": [False]},
], "links": [[1, 2, 0, 1, 0, "MODEL"], [2, 1, 0, 2, 0, "MODEL"]]}
_meta47d = mod._gen_meta(_wf47d, role_of=_role41b)
check("41b: кольцо в проводах не подвешивает (модель не выдумана)",
      "model" not in _meta47d and "loras" not in _meta47d and _meta47d.get("steps") == 1,
      str(_meta47d))

# Сабграф с моделью, которой нет на диске: точная модель из цепочки не подменяется
_wf47e = {"nodes": [
    {"id": 1, "type": "KSampler", "inputs": [{"name": "model", "type": "MODEL", "link": 1}],
     "widgets_values": [1, "fixed", 1, 1, "euler", "normal", 1]},
    {"id": 2, "type": "b7aa0000-sub-unknown", "outputs": [{"name": "MODEL", "links": [1]}]},
], "links": [[1, 2, 0, 1, 0, "MODEL"]],
    "definitions": {"subgraphs": [
        {"id": "b7aa0000-sub-unknown", "nodes": [
            {"id": 21, "type": "UNETLoader", "widgets_values": ["known_model.safetensors", "x"]},
            {"id": 22, "type": "SeedVR2LoadDiTModel", "widgets_values": ["unknown_upscaler.safetensors"]},
        ]}]}}
_meta47e = mod._gen_meta(_wf47e, role_of={"known_model.safetensors": "model"}.get)
check("41b: точная модель из цепочки не подменяется ненайденной",
      _meta47e.get("model") == "known_model.safetensors", str(_meta47e))



# --- 41c. Параметры, заданные ПРОВОДОМ, и LoRA после не-виджет-входа (v1.50) ---
# Два живых бага пользователя (запись 8931bb73c1, сабграф «KREA 2 RAW MODEL»):
#  1) Turbo-LoRA внутри сабграфа пропадала: у `LoraLoaderModelOnly` виджетов ДВА
#     (`lora_name`, `strength_model`), а вход с виджетом ОДИН — позиционная
#     подстановка перекрывала имя LoRA её же силой;`
#  2) шаги шли из УСТАРЕВШЕГО виджета `KSampler` (8), а реально приходят проводом
#     из сабграфа (`output_2` — 12 для RAW / 10 для TURBO), т.е. показывались
#     неправильные данные. Фикстура повторяет живой граф 1:1.
print("\n41c. Провода параметров и LoRA после не-виджет-входа (v1.50)")

_R41C = {
    "merged.safetensors": "model",
    "raw_int8.safetensors": "model",
    "on_lora.safetensors": "lora",
    "turbo_lora.safetensors": "lora",
    "vae_chain.safetensors": "vae",
}
_role41c = _R41C.get

_SUB50_ID = "bcf8cc67-live-krea-raw"
_sub50 = {
    "id": _SUB50_ID, "name": "KREA 2 RAW MODEL",
    "nodes": [
        {"id": 1143, "type": "UNETLoader",
         "inputs": [{"name": "unet_name", "type": "COMBO",
                     "widget": {"name": "unet_name"}, "link": 2835}],
         "widgets_values": ["raw_int8.safetensors", "default"],
         "outputs": [{"name": "MODEL", "type": "MODEL", "links": [2113]}]},
        # ВАЖНО: первым идёт вход без виджета — именно на нём ломался старый код
        {"id": 1145, "type": "LoraLoaderModelOnly",
         "inputs": [{"name": "model", "type": "MODEL", "link": 2113},
                     {"name": "strength_model", "type": "FLOAT",
                      "widget": {"name": "strength_model"}, "link": 2837}],
         "widgets_values": ["turbo_lora.safetensors", 0.6],
         "widgets_values_named": {"lora_name": "turbo_lora.safetensors",
                                  "strength_model": 0.6},
         "outputs": [{"name": "MODEL", "type": "MODEL", "links": [2114]}]},
        {"id": 1519, "type": "UNETLoader",
         "inputs": [{"name": "unet_name", "type": "COMBO",
                     "widget": {"name": "unet_name"}, "link": 2858}],
         "widgets_values": ["turbo_int8.safetensors", "default"],
         "outputs": [{"name": "MODEL", "type": "MODEL", "links": [2853]}]},
        {"id": 1144, "type": "ComfySwitchNode",
         "inputs": [{"name": "on_false", "type": "MODEL", "link": 2853},
                     {"name": "on_true", "type": "MODEL", "link": 2114},
                     {"name": "switch", "type": "BOOLEAN", "link": 2116}],
         "widgets_values": [False],
         "outputs": [{"name": "output", "type": "MODEL", "links": [2124]}]},
        {"id": 1151, "type": "PrimitiveBoolean", "title": "RAW Model",
         "inputs": [{"name": "value", "type": "BOOLEAN",
                     "widget": {"name": "value"}, "link": 2839}],
         "widgets_values": [True],
         "outputs": [{"name": "BOOLEAN", "type": "BOOLEAN", "links": [2116, 2117]}]},
        {"id": 1147, "type": "PrimitiveInt", "title": "Шаги RAW",
         "inputs": [{"name": "value", "type": "INT",
                     "widget": {"name": "value"}, "link": 2836}],
         "widgets_values": [12, "fixed"],
         "widgets_values_named": {"value": 12, "fixed": "fixed"},
         "outputs": [{"name": "INT", "type": "INT", "links": [2119]}]},
        {"id": 1149, "type": "PrimitiveInt", "title": "Шаги TURBO",
         "inputs": [{"name": "value", "type": "INT",
                     "widget": {"name": "value"}, "link": 2838}],
         "widgets_values": [10, "fixed"],
         "widgets_values_named": {"value": 10, "fixed": "fixed"},
         "outputs": [{"name": "INT", "type": "INT", "links": [2120]}]},
        {"id": 1150, "type": "ComfySwitchNode", "title": "Шаги",
         "inputs": [{"name": "on_false", "type": "INT", "link": 2120},
                     {"name": "on_true", "type": "INT", "link": 2119},
                     {"name": "switch", "type": "BOOLEAN", "link": 2117}],
         "widgets_values": [False],
         "outputs": [{"name": "output", "type": "INT", "links": [2857]}]},
        {"id": 1521, "type": "VAELoader", "widgets_values": ["vae_chain.safetensors"],
         "outputs": [{"name": "VAE", "type": "VAE", "links": [2855]}]},
    ],
    "outputNode": {"id": -20},
    "inputs": [{"name": "unet_name_1", "linkIds": [2858]},
               {"name": "value_1", "linkIds": [2838]},
               {"name": "unet_name", "linkIds": [2835]},
               {"name": "value", "linkIds": [2836]},
               {"name": "strength_model", "linkIds": [2837]},
               {"name": "value_2", "linkIds": [2839]}],
    "outputs": [{"name": "output", "type": "MODEL", "linkIds": [2124]},
                {"name": "CLIP", "type": "CLIP", "linkIds": [2854]},
                {"name": "VAE", "type": "VAE", "linkIds": [2855]},
                {"name": "output_1", "type": "STRING", "linkIds": [2856]},
                {"name": "output_2", "type": "INT", "linkIds": [2857]}],
    "links": [[2113, 1143, 0, 1145, 0, "MODEL"],
              [2114, 1145, 0, 1144, 1, "MODEL"],
              [2116, 1151, 0, 1144, 2, "BOOLEAN"],
              [2117, 1151, 0, 1150, 2, "BOOLEAN"],
              [2119, 1147, 0, 1150, 1, "INT"],
              [2120, 1149, 0, 1150, 0, "INT"],
              [2124, 1144, 0, -20, 0, "MODEL"],
              [2853, 1519, 0, 1144, 0, "MODEL"],
              [2855, 1521, 0, -20, 2, "VAE"],
              [2857, 1150, 0, -20, 4, "INT"],
              [2835, -10, 2, 1143, 0, "COMBO"],
              [2836, -10, 3, 1147, 0, "INT"],
              [2837, -10, 4, 1145, 1, "FLOAT"],
              [2838, -10, 1, 1149, 0, "INT"],
              [2839, -10, 5, 1151, 0, "BOOLEAN"],
              [2858, -10, 0, 1519, 0, "COMBO"]],
}


def _wf50(raw=True):
    """Живой граф пользователя: KSampler, rgthree-лоадер, сабграф со свитчем."""
    return {
        "nodes": [
            {"id": 1, "type": "KSampler",
             "inputs": [{"name": "model", "type": "MODEL", "link": 100},
                         {"name": "steps", "type": "INT",
                          "widget": {"name": "steps"}, "link": 102}],
             "widgets_values": [8007355321346, "randomize", 8, 1, "euler", "beta", 1]},
            {"id": 2, "type": "Power Lora Loader (rgthree)",
             "inputs": [{"name": "model", "type": "MODEL", "link": 101}],
             "widgets_values": [
                 {}, {"type": "PowerLoraLoaderHeaderWidget"},
                 {"on": False, "lora": "off_lora.safetensors", "strength": 1},
                 {"on": True, "lora": "on_lora.safetensors", "strength": 1},
             ]},
            # Экземпляр сабграфа: widgets_values + named-форма (как в живом снимке)
            {"id": 3, "type": _SUB50_ID,
             "widgets_values": ["merged.safetensors", 10, "raw_int8.safetensors",
                                12, 0.6, raw],
             "widgets_values_named": {"unet_name_1": "merged.safetensors", "value_1": 10,
                                      "unet_name": "raw_int8.safetensors", "value": 12,
                                      "strength_model": 0.6, "value_2": raw},
             "outputs": [{"name": "output", "type": "MODEL", "links": [101]},
                         {"name": "CLIP", "type": "CLIP", "links": []},
                         {"name": "VAE", "type": "VAE", "links": []},
                         {"name": "output_1", "type": "STRING", "links": []},
                         {"name": "output_2", "type": "INT", "links": [102]}]},
        ],
        "links": [[100, 2, 0, 1, 0, "MODEL"],
                  [101, 3, 0, 2, 0, "MODEL"],
                  [102, 3, 4, 1, 4, "INT"]],
        "definitions": {"subgraphs": [_sub50]},
    }


_meta50 = mod._gen_meta(_wf50(True), role_of=_role41c)
check("41c: шаги — из ПРОВОДА (сабграф->свитч), а не из устаревшего виджета 8",
      _meta50.get("steps") == 12, str(_meta50))
check("41c: LoRA внутри сабграфа видна и с верной силой (не затёрта своей же силой)",
      {"name": "turbo_lora.safetensors", "strength": 0.6} in (_meta50.get("loras") or []),
      str(_meta50.get("loras")))
check("41c: модель — активной ветки RAW",
      _meta50.get("model") == "raw_int8.safetensors", str(_meta50.get("model")))
check("41c: включённый слот rgthree и LoRA сабграфа вместе",
      sorted(l["name"] for l in _meta50.get("loras", []))
      == ["on_lora.safetensors", "turbo_lora.safetensors"], str(_meta50.get("loras")))
check("41c: VAE из цепочки (в сабграфе)",
      _meta50.get("vae") == "vae_chain.safetensors", str(_meta50.get("vae")))

_meta50t = mod._gen_meta(_wf50(False), role_of=_role41c)
check("41c: свитч на TURBO -> модель и ШАГИ другой ветки (10), LoRA RAW не участвует",
      _meta50t.get("steps") == 10 and _meta50t.get("model") == "merged.safetensors"
      and "turbo_lora.safetensors" not in json.dumps(_meta50t.get("loras"), ensure_ascii=False),
      str(_meta50t))

# Простые провода параметров на верхнем уровне: шаги/cfg/denoise/разрешение
_p50a = {"id": 10, "type": "PrimitiveInt", "widgets_values": [24, "fixed"],
         "outputs": [{"name": "INT", "links": [501]}]}
_p50b = {"id": 11, "type": "PrimitiveFloat", "widgets_values": [2.5],
         "outputs": [{"name": "FLOAT", "links": [502]}]}
_p50c = {"id": 12, "type": "PrimitiveInt", "widgets_values": [1860],
         "outputs": [{"name": "INT", "links": [503]}]}
_wf50w = {"nodes": [_p50a, _p50b, _p50c,
    {"id": 1, "type": "KSampler",
     "inputs": [{"name": "model", "type": "MODEL", "link": None},
                 {"name": "steps", "type": "INT", "widget": {"name": "steps"}, "link": 501},
                 {"name": "cfg", "type": "FLOAT", "widget": {"name": "cfg"}, "link": 502}],
     "widgets_values": [7, "randomize", 8, 1, "euler", "beta", 1]},
    {"id": 2, "type": "EmptyLatentImage",
     "inputs": [{"name": "width", "type": "INT", "widget": {"name": "width"}, "link": 503}],
     "widgets_values": [1024, 1024, 1]},
    ],
    "links": [[501, 10, 0, 1, 2, "INT"], [502, 11, 0, 1, 3, "FLOAT"],
              [503, 12, 0, 2, 0, "INT"]]}
_meta50w = mod._gen_meta(_wf50w, role_of=_role41c)
check("41c: провод шагов важнее виджета (24, а не 8)", _meta50w.get("steps") == 24, str(_meta50w))
check("41c: провод cfg важнее виджета (2.5, а не 1)", _meta50w.get("cfg") == 2.5, str(_meta50w))
check("41c: провод ширины латента важнее виджета (1860)",
      _meta50w.get("width") == 1860 and _meta50w.get("height") == 1024, str(_meta50w))
check("41c: непроводной параметр остаётся из виджета (denoise=1)",
      _meta50w.get("denoise") == 1, str(_meta50w))

# Провод от непонятного узла: не выдумываем — остаётся виджет
_wf50x = {"nodes": [
    {"id": 1, "type": "KSampler",
     "inputs": [{"name": "steps", "type": "INT", "widget": {"name": "steps"}, "link": 601}],
     "widgets_values": [7, "randomize", 8, 1, "euler", "beta", 1]},
    {"id": 2, "type": "ComfyMathExpression", "widgets_values": ["a * b + 1"],
     "outputs": [{"name": "INT", "type": "INT", "links": [601]}]},
], "links": [[601, 2, 0, 1, 2, "INT"]]}
_meta50x = mod._gen_meta(_wf50x, role_of=_role41c)
check("41c: непонятный источник провода -> шаги остаются из виджета (8)",
      _meta50x.get("steps") == 8, str(_meta50x))

# Запись экземпляра сабграфа берётся ПО ИМЕНИ виджета, а не по позиции
check("41c: _promoted_overrides кладёт значение и по имени, и по слоту",
      mod._promoted_overrides(_sub50, {"id": 3, "widgets_values": ["m", 10, "r", 12, 0.6, True],
                                       "widgets_values_named": {"strength_model": 0.6,
                                                                "value_2": True}}).get((1145, "@strength_model")) == 0.6)
check("41c: _effective_widgets не перекрывает имя LoRA её же силой",
      mod._effective_widgets(_sub50["nodes"][1], {(1145, "@strength_model"): 0.6})[0]
      == "turbo_lora.safetensors")
_n50, _l50, _d50 = mod._graph_of(_sub50)
_ov50raw = mod._promoted_overrides(_sub50, {"widgets_values_named": {"value": 12, "value_1": 10,
                                                                 "value_2": True}})
_ov50turbo = mod._promoted_overrides(_sub50, {"widgets_values_named": {"value": 12, "value_1": 10,
                                                                   "value_2": False}})
check("41c: _output_value по свитчу: RAW -> 12",
      mod._output_value(_n50, _l50, _d50, _ov50raw, 1150, 0) == 12)
check("41c: _output_value по свитчу: TURBO -> 10",
      mod._output_value(_n50, _l50, _d50, _ov50turbo, 1150, 0) == 10)
check("41c: _output_value не выдумывает для чужого узла",
      mod._output_value({9: {"id": 9, "type": "SomeUnknownNode", "widgets_values": ["x"]}},
                        {}, {}, {}, 9, 0) is None)


# Главный живой баг v1.51: активная ветка БЕЗ LoRA, а фолбэк «по всему графу»
# подставлял лору из ВЫКЛЮЧЕННОЙ ветки сабграфа. Пользователь переключился с RAW
# (с turbo-LoRA) на TURBO и без лоры — а галерея писала, что turbo-LoRA была.
_wf51 = mod_c51 = json.loads(json.dumps(_wf50(False)))
for _n in _wf51["nodes"]:
    if _n["type"] == "Power Lora Loader (rgthree)":
        for _slot in _n["widgets_values"]:
            if isinstance(_slot, dict) and "lora" in _slot:
                _slot["on"] = False
_meta51 = mod._gen_meta(_wf51, role_of=_role41c)
check("41c: TURBO без лоры -> LoRA НЕ показывается (неактивная ветка сабграфа не подмешивается)",
      not _meta51.get("loras"), str(_meta51.get("loras")))
check("41c: тот же случай — модель и шаги всё равно верные",
      _meta51.get("model") == "merged.safetensors" and _meta51.get("steps") == 10, str(_meta51))

# Разрешение тоже бывает ПРОВОДОМ — из своей ноды Degg Res Set (Degg_Res_Set)
_drs50 = {"id": 20, "type": "DeggResSet",
          "widgets_values": [1, None, "16:9 (Widescreen)", 0.5, 8, None, 512, 512,
                              None, 768, 768, None, 1088, 2336],
          "widgets_values_named": {"select": 1, "__grp": None,
                                   "aspect_ratio": "16:9 (Widescreen)", "megapixels": 0.5,
                                   "multiple": 8, "__grp#1": None, "w1": 512, "h1": 512,
                                   "__grp#2": None, "w2": 768, "h2": 768,
                                   "__grp#3": None, "w3": 1088, "h3": 2336},
          "outputs": [{"name": "width", "links": [701]},
                      {"name": "height", "links": [702]}]}
_wf50r = {"nodes": [
    _drs50,
    {"id": 1, "type": "KSampler", "widgets_values": [7, "randomize", 8, 1, "euler", "beta", 1]},
    {"id": 2, "type": "EmptySD3LatentImage",
     "inputs": [{"name": "width", "type": "INT", "widget": {"name": "width"}, "link": 701},
                 {"name": "height", "type": "INT", "widget": {"name": "height"}, "link": 702}],
     "widgets_values": [1024, 1840, 1]},
], "links": [[701, 20, 0, 2, 0, "INT"], [702, 20, 1, 2, 1, "INT"]]}
_meta50r = mod._gen_meta(_wf50r, role_of=_role41c)
check("41c: разрешение из Degg Res Set (preset 1: 16:9, 0.5 МП) — 960x536, а не виджет 1024x1840",
      (_meta50r.get("width"), _meta50r.get("height")) == (960, 536), str(_meta50r))
_drs50b = dict(_drs50, widgets_values_named={"select": 3, "aspect_ratio": "1:1 (Square)",
                                              "megapixels": 1.0, "multiple": 8,
                                              "w1": 512, "h1": 512, "w2": 768, "h2": 768,
                                              "w3": 1088, "h3": 2336})
check("41c: Degg Res Set preset 3/4 — ручные w/h (768x768), без расчёта",
      (mod._degg_res_set_output(_drs50b, 0), mod._degg_res_set_output(_drs50b, 1)) == (768, 768))
check("41c: Degg Res Set без named-формы не выдумывает",
      mod._degg_res_set_output({"widgets_values": [1]}, 0) is None
      and mod._degg_res_set_output(_drs50, 5) is None)


# --- итог -------------------------------------------------------------------
_p(f"\n=== ok: {len(oks)} | FAIL: {len(fails)}")
if fails:
    for f in fails:
        print("  - " + f)
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fails else 0)
