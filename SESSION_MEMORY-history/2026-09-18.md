# Память сессии — Prompt Library (2026-09-17, v1.15 + тесты + скилы)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Закоммичили и запушили v1.15: Vue-фиксы §22.10 + аудит §25.2 (`292ceb3`).
- Создали скилл `comfyui-node-testing` — шаблоны Python-песочницы, JS-смоук-теста,
  статического аудита для тестирования нод без ComfyUI.
- Создали скилл `comfyui-frontend-sources` — шлюз: где исходники фронтенда
  (`.map` → `sourcesContent`), когда читать перед CSS/правками.
- Расширили AGENTS.md: §5 (типичные проблемы + sizing + «НЕ ДЕЛАЙ» из §20 SPEC),
  §4.1 (правило «читай исходники перед sizing»), таблица скилов.
- Перенесли тесты из `tests/` (корень) → `Prompt_Library/` (рядом с кодом).
  Каждый репозиторий теперь автономен: клонировал — получил и код, и тесты.
- Обновили SPECIFICATION.md §25.1 (тесты теперь в папке ноды).

## 2. Итоговое состояние кода

- `web/js/prompt_library.js:52` — `PL_JS_VERSION = "1.15-vue-floor480"`
- `_test_prompt_library.py` — 66 проверок Python (в папке ноды)
- `_smoke_prompt_library.mjs` — 45 фаз JS (в папке ноды)
- `_audit_prompt_library.mjs` — статический аудит (в папке ноды)
- `SPECIFICATION.md` — v1.15, §25.1 обновлена (тесты в папке ноды)

## 3. Новые скилы (корень бандла)

- `.agents/skills/comfyui-node-testing/SKILL.md` — шаблоны тестов (Python sandbox,
  JS smoke с DOM-заглушками, статический аудит). Запуск: `cd <NodeName> && python/node`.
- `.agents/skills/comfyui-frontend-sources/SKILL.md` — шлюз перед CSS/JS-sizing:
  где `.map` файлы, как извлекать TS/Vue, что grep'ать.

## 4. Что важно не сломать при продолжении работы

- **Canvas-ветку `applyPaneLayout` и `computeLayoutSize`** — проверены живьём
- Порядок INPUT_TYPES `[mode, selected, save_folder]`; `widget.serialize = false` свойством
- Не возвращать `autoFitHeight`/`calibrateFloor`/`_vueFloor`
- Не перезаписывать `this.computeSize` на ноде
- Синк: `python sync.py Prompt_Library` → `D:\ComfyUI_windows_portable\...` → **Ctrl+F5**

## 5. Следующие шаги (идеи, не сделано)

1. **Вынести воркфлоу из `library.json`** (главный риск §25.3): `workflows/{id}.json`
   или SQLite; сейчас 2.9 МБ / 92 записи (6 воркфлоу = 1.72 МБ), лимит — 500 записей
2. Разбить на две ноды: **Prompt Library** + **Prompt Saver**
3. Постраничность списка (~20 записей)
4. Создать `_test_*/_smoke_*/_audit_*` для Degg_Switch или другой ноды

## 6. Связанные файлы

- `web/js/prompt_library.js` — нода (JS-расширение, v1.15)
- `prompt_library_node.py` — Python-нода
- `_test_prompt_library.py` — Python-тест (66 проверок, в папке ноды)
- `_smoke_prompt_library.mjs` — JS-смоук (45 фаз, в папке ноды)
- `_audit_prompt_library.mjs` — аудит связности (в папке ноды)
- `SPECIFICATION.md` — §22.9-11 (Vue), §25 (аудит + тесты)
- `.agents/skills/comfyui-node-testing/` — скилл тестирования нод
- `.agents/skills/comfyui-frontend-sources/` — скилл чтения исходников фронтенда
