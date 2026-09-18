"""Глубокий функциональный тест Prompt_Library (Python) — без ComfyUI.

Песочница: `folder_paths` подменяется на временную папку, `server`/`aiohttp` —
заглушки, поэтому регистрируются все HTTP-роуты и их можно вызвать напрямую.
Запуск: python _test_prompt_library.py   (из корня бандла)
"""
import asyncio
import importlib.util
import json
import shutil
import sys
import tempfile
import types
from pathlib import Path

NODE = Path(__file__).resolve().parent / "prompt_library_node.py"

fails = []
oks = []


def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  ok  " if cond else "  FAIL") + f"  {name}" + (f"  [{extra}]" if extra and not cond else ""))


# --- песочница ---------------------------------------------------------------
TMP = Path(tempfile.mkdtemp(prefix="pl_test_"))
user_dir = TMP / "user"
user_dir.mkdir(parents=True)

folder_paths = types.ModuleType("folder_paths")
folder_paths.get_user_directory = lambda: str(user_dir)
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
check("возврат — результат + ui", res["result"] == ("Портрет девушки",) and "ui" in res)
check("входной текст обрезан", res["ui"]["text"] == ["Портрет девушки"])
check("PNG-патч записал widgets_values позиционно",
      workflow["nodes"][0]["widgets_values"] == [node.MODE_WRITE, "", "Фото"],
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

# --- итог -------------------------------------------------------------------
print(f"\n=== ok: {len(oks)} | FAIL: {len(fails)}")
if fails:
    for f in fails:
        print("  - " + f)
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fails else 0)
