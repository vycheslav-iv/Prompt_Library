# Память сессии — Prompt Library (2026-09-18, v1.21 — автообновление Library)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.20 (`9b83387`, запушена): глобальный дубль по тексту; фикс краша Queue; возврат высоты; bulk-бар в listHead.
- v1.21 (`e7de7d4` — docs; `9a8dd61` — fix; `fe18635` — feature): **автообновление Library-нод** при записи через Saver — решена главная проблема: раньше Library не обновлялась без нажатия «новая генерация».
  - Python: `_broadcast_refresh()` после `_save_db()` в `execute()`; флаг `need_broadcast` (только при `added=True`); вызов `PromptServer.instance.send_sync("prompt_library/refresh", {})`
  - JS: `app.api.addEventListener("prompt_library/refresh", plListener)` в `onNodeCreated` → `this._pl.reload()`; мёртвый `window.addEventListener` fallback удалён
  - Все 101 Python-тест и 48 JS-смоук проходят
- SPECIFICATION.md обновлена: v1.21, §26 (auto-refresh), §8.2, §15, §17.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `_broadcast_refresh()` + `need_broadcast` flag; `_save_db()` + broadcast on new entry only; `_add_entry()` + `_broadcast_refresh` import; все эндпоинты; сокет IMAGE,VIDEO; media; bulk; `_req_body()`
- `web/js/prompt_library.js` — `PL_JS_VERSION = "1.20-dup-warn"` (JS не менял версию в v1.21!); broadcast listener; attach-блок; `INPUT_H = 170`; мультивыделение; inlineEdit; verTag; DOM-виджет
- `_test_prompt_library.py` — 101 проверка (§11: 4 по загрузке превью)
- `_smoke_prompt_library.mjs` — 48 фаз
- `_audit_prompt_library.mjs` — чист
- `SPECIFICATION.md` — v1.21 (§26 auto-refresh, §8.2, §15, §17)
- Скилл `comfyui-video-socket` в корне бандла (3 папки)

## 3. Проблемы, которые встречались (и как решали)

- **Library не обновлялась при записи через Saver** (главная проблема этой сессии): нет broadcast → `onExecuted` на Library не вызывается → список молчит. Решение: WebSocket broadcast `prompt_library/refresh` через `send_sync` + JS listener.
- **`_broadcast_refresh()` при любом dirty**: backfill/смена папки вызывали ненужные broadcast → исправлено через `need_broadcast=True` только при `added=True`.
- **Мёртвый `window.addEventListener` fallback**: `window` не получает ComfyUI WebSocket-события; `app.api` (ComfyApi extends EventTarget) рассылает CustomEvent для зарегистрированных типов через `_registered`.
- Петля «выход → … → вход-картинка»: структурная, кодом не лечится → Saver без выходов.
- 🖼 мутно на Windows → везде 📷.
- Маркер версии забыли поднять → PL_JS_VERSION + verTag в тулбаре.
- Системный Python без numpy/torch — видео-проверки на `python_embeded/python.exe` + стаб `FakeVideo`.
- База в §6 забита до MAX_ENTRIES — тестовые записи через `insert(0)`.

## 4. Что важно не сломать при продолжении работы

- **Canvas-ветку `applyPaneLayout` и `computeLayoutSize`** — проверены живьём; только boolean-стейт в sizing, никаких замеров DOM
- `need_broadcast` flag: broadcast ТОЛЬКО при `added=True`; не трогать без причины
- `_broadcast_refresh()` / `send_sync`: если PromptServer недоступен → pass (тесты, ранняя загрузка)
- Порядок INPUT_TYPES `[mode, selected, save_folder]`; `widget.serialize = false` свойством
- Сокет `image` — connector-only, в `widgets_values` не входит
- Бейдж/метка/полоса — только текст/фон/`box-shadow: inset`; не перезаписывать `this.computeSize`
- Неизвестный `media` — только во «Все», без бейджа; не в дедупликацию
- Метки session-only; `ev.target === zone` для пустого места; Esc гасить на месте
- Не возвращать `autoFitHeight`/`calibrateFloor`/`_vueFloor`
- JS broadcast listener: `app.api.addEventListener` (НЕ window.addEventListener)
- Синк: `python sync.py Prompt_Library` (из корня!) → рестарт ComfyUI + Ctrl+F5
- Коммиты: из папки ноды, `gh` авторизован

## 5. Следующие шаги (идеи, не сделано)

1. **Saver** (согласован в принципе): минимум vs +статус vs +ручной ввод — ждёт выбора и команды «строй»
2. Разбить Library на выдачу / Saver на приём (стратегия из §17)
3. Постраничность списка (~20 записей)
4. Вынести воркфлоу из `library.json` (растёт; лимит 500)
5. Inline-создание папки

## 6. Связанные файлы

- `web/js/prompt_library.js` — нода (JS-расширение, маркер 1.20-dup-warn, broadcast listener)
- `prompt_library_node.py` — Python-нода (_broadcast_refresh, need_broadcast, все эндпоинты)
- `_test_prompt_library.py` — Python-тест (101 проверка)
- `_smoke_prompt_library.mjs` — JS-смоук (48 фаз)
- `_audit_prompt_library.mjs` — аудит (12 роутов)
- `SPECIFICATION.md` — v1.21 (§26, §8.2, §15, §17)
- Скилл `comfyui-video-socket` в корне бандла (3 папки)
- `sync.py` в корне бандла (F:\AI_projects\Custom_node_ComfyUI\)
- `SESSION_MEMORY-history/2026-09-18-0845.md` — снапшот предыдущей сессии (v1.20)

## 7. Коммиты

| Хэш | Описание |
|-----|----------|
| `fe18635` | v1.20+: auto-refresh Library nodes via broadcast refresh |
| `9a8dd61` | fix: auto-refresh only on new entry, remove broken window fallback |
| `e7de7d4` | docs: SPECIFICATION.md v1.21 — §26, fix notes, history |

Все запушены на `origin master`. Синк последний — 5 файлов.
