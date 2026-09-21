# Память сессии — Prompt Library (v1.42, 2026-09-21)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- **v1.42: legacy `.jpg`-призрак** (закрыт в начале сессии) — замена превью у записи с
  legacy JPG оставляла `previews/{id}.jpg` сиротой навсегда (удаление карточки снимало
  только `.png`). Решено `_drop_legacy_preview_file()` в `_save_preview_upload` +
  `_save_thumbnail`; тест 19.5 (PIL, валидный PNG dataURL). Тесты 305/305.
- **Полный повторный аудит проекта** после фикса: `check.py Prompt_Library --strict`
  — провалов 0; живой аудит базы 8/8 (`changed: false`), сирот нет; живая проба кэша
  зелёная; DOM-замер `--panel` — ширина стабильна по всей цепочке (наш root 976 =
  const), панель не зажимает (hideInPanel v1.32 держится).
- **Ложная находка снята**: категория «Пейзажи» «пустая» оказалась родительской — под
  ней подпапка «Пейзажи/Аляска» (записи «Аляска EN», «Аляска»); «System Prompt» пустая,
  но закреплена вручную. Пустая категория НЕ признак мусора: дерево ветвится подпапками.
- **Прибор DOM-пробы** требует `websockets` (строка 655). В системном `python`
  (F:\Python\Python314) его НЕТ (`ModuleNotFoundError`) — проба стабильно работает
  только под `D:/ComfyUI_windows_portable/python_embeded/python.exe` (websockets 16.1.1).
  Зафиксировано в SPEC §34.2 как урок прибора (не дефект ноды).
- **Health ComfyUI**: внешний пак `comfyui-kjnodes` не грузится (`No module named
  'triton'`) — сторонние узлы, к Prompt_Library отношения не имеет.

## 2. Итоговое состояние кода

- `prompt_library_node.py:555` — `_drop_legacy_preview_file()` (unlink `previews/{id}.jpg`,
  missing_ok=True); вызовы: `_save_thumbnail` (~453) и `_save_preview_upload` (~518)
- `prompt_library_node.py:74` — `_entry_workflow()` (сначала inline, потом файл)
- `prompt_library_node.py:89` — `_workflow_path()` (id строго alfanum, иначе None)
- `prompt_library_node.py:97` — `_save_workflow_file()` (tmp + `os.replace`)
- `prompt_library_node.py:167` — `_trim_entries()` (убирает файл графа И файл превью)
- `prompt_library_node.py:539` — `_remove_preview_file()`
- `prompt_library_node.py:800` — `IS_CHANGED` (только `pickup`; `mode` НЕ проверяется)
- `tests/_test_prompt_library.py:1102` — тест 19.5 (legacy `.jpg` не остаётся сиротой)
- `tests/_probe_live_library.py` — живой аудит базы, v1.42, 8/8 зелёное
- `tests/_probe_live_cache.py` — живая проба кэша, зелёная (в коде: комментарии «правка v1.41»
  не трогать — после неудачного sed они уже возвращены как было)
- `tests/_probe_live_dom.py` — живой замер DOM (запуск только под python_embeded)

## 3. Проблемы, которые встречались (и как решали)

- **`ModuleNotFoundError: websockets`** на системном `python` — DOM-проба падает в
  `main()` строка 655. Решение: запускать под `python_embeded` ComfyUI (там websockets есть).
- **«Пустая категория = мусор» — ложная находка**: «Пейзажи» ветвится подпапкой «Аляска».
  Урок: перед выводом смотреть подпапки дерева, а не только записи текущего уровня.
- **sed-замены по всему файлу опасны**: историческая строка «правка v1.41» в
  `_probe_live_cache.py` была переписана на v1.42 — вернул как было. Точечные правки только.
- **Консоль cp1251 глотает кириллицу** — печать проб ругалась эмодзи; пробы уже форсят
  UTF-8 (`sys.stdout.reconfigure`).
- **Аудит на мутирующей базе невалиден** — `_probe_live_library.py` берёт отпечаток базы
  до/после и снимает находки, не воспроизведённые повторным чтением.

## 4. Что важно не сломать при продолжении работы

- НЕ возвращать проверку `mode` в `IS_CHANGED` (§33.3, §33.6) — ломает кэш ComfyUI.
- Замена превью обязана переносить граф (`_entry_workflow`), иначе карточка теряет воркфлоу.
- `_trim_entries` и удаление убирают и файл графа, и файл превью — сирот быть не должно.
- DOM-пробу гонять ТОЛЬКО под `python_embeded`, системный python не подходит.
- Проба кэша безопасна в режиме «📤 Выдача» с пустым `selected` (`save_on = False`).
- Тесты лежат только в `tests/` и в рабочую копию не копируются (AGENTS.md §1.1).
- После правок: `python sync.py Prompt_Library` → перезапуск ComfyUI → `node --check` для JS.

## 5. Следующие шаги (идеи, не сделано)

- Живьём глазами: удаление карточки с файловым графом убирает `workflows/{id}.json`.
- Живьём: самолечение при дубле — подхват текста, который уже есть карточкой без графа.
- Прогонять `_probe_live_cache.py` после любого изменения `IS_CHANGED` и виджетов.
- Прогонять `_probe_live_library.py` перед/после массовых операций с базой (и после чистки).
- Дальше по масштабированию базы: `_load_db()` читает весь JSON на каждую операцию
  (при 500+ записях — SQLite; обсуждено, не делали).

## 6. Связанные файлы

- `prompt_library_node.py` — `_drop_legacy_preview_file` (555) + вызовы (~453, ~518)
- `SPECIFICATION.md` — v1.42 (шапка, хроника 34, §34.2: интерпретатор DOM-пробы)
- `tests/_test_prompt_library.py` — 305/305 (блоки 25–26 — граф и самоаудит; 19.5 — jpg-призрак)
- `tests/_smoke_prompt_library.mjs` — 83 фазы; `tests/_audit_prompt_library.mjs` — аудит чист
- `tests/_probe_live_cache.py` — живая проба кэша (запуск: `python tests/_probe_live_cache.py`)
- `tests/_probe_live_library.py` — живой аудит данных базы (+фальсификаторы на копиях базы)
- `tests/_probe_live_dom.py`, `tests/_probe_snippet.js` — живые пробы DOM (§34)
- `check.json` — `python _process/check.py Prompt_Library`
- `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library` — рабочая копия (синхронизирована)
- `D:\ComfyUI_windows_portable\ComfyUI\user\prompt_library\` — живая база (`library.json`, `workflows/`, `previews/`)
- `SESSION_MEMORY-history/` — снапшоты (2026-09-21.md, 2026-09-21-audit.md)