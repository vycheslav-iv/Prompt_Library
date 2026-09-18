# Память сессии — Prompt Library (2026-09-18, v1.23)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md` (полная документация).

---

## 1. Что делали в этой сессии (кратко)

- **Глубокий аудит** Python+JS по коду и по исходникам фронтенда 1.52.7 → 10 дефектов,
  исправлены; SPEC §27.
- **v1.22**: broadcast из ВСЕХ мутирующих роутов (не только Queue), синхронизация
  Library-нод одной страницы, снятие слушателей в `onRemoved`, стойкая подсказка о
  дубле, защита служебного префикса `__`, бэкфилл превью.
- **v1.23**: панель книги перекрывала низ списка с кнопками карточек (жалоба живьём) —
  панели теперь сжимаются; кнопки массового удаления вернулись в нижнюю строку. SPEC §28.
- **Тесты перенесены в `Prompt_Library/tests/`** (правило AGENTS.md §1.1: в каждом
  проекте своя папка `tests/`, в корне проекта их больше нет; sync.py их не копирует).
- **v1.24 (§29): одна нода вместо двух.** Третий режим «📤📥 Выдача + запись»;
  обложка сохранённой записи подтягивается ИЗ ПРОГОНА (файл из output/temp по
  событию `executed`) — IMAGE-провод больше не обязателен, кольца в графе нет.
  Совместимость: «Запись» с уже подключённым выходом отдаёт текст сквозь + подсказка.
- Коммиты `17a1794` (v1.22+v1.23) и этот — запушены в `origin master`.
  Тесты 133/133, смоук 53/53, аудит чист.

## 2. Итоговое состояние кода

- `prompt_library_node.py`
  - `MODE_WRITE / MODE_ISSUE / MODE_BOTH`; `execute()` → `issue/both/save_on`,
    `_output_linked(extra_pnginfo, unique_id)` → авто-сквозь для старых графов,
    `preview_target` → `ui.saved_id`, `ui.mode_notice`
  - `_load_image_file()` (декадер, подменяется в тестах) + `_resolve_output_file()`
    (output/temp/input с защитой от traversal) + роут `/prompt_library/attach_preview`
  - `_broadcast_refresh()` вызывается в `execute()` (только `added=True`) и во ВСЕХ
    мутирующих роутах: `/add`, `/favorite`, `/update`, `/delete`, `/delete_many`,
    `/folder_create`, `/folder_rename`, `/folder_delete*` (§26.7)
  - `_storage_folder()` — единая нормализация папки + `__*` → корень (`execute`, `/add`, `/update`);
    `/folder_create` и `/folder_rename` → 400 на `__`-имя
  - `_find_text_match()` — глобальный дубль; бэкфилл превью у найденной записи
  - `_snapshot_workflow()` — только в ветке записи
- `web/js/prompt_library.js` — `PL_JS_VERSION = "1.24-one-node"`
  - `st.pendingPreview` (Map prompt_id → {id, image}) + слушатели `executed` /
    `execution_success` / `execution_error` / `execution_interrupted` →
    `st.attachPreview()` → POST `/prompt_library/attach_preview` + `reload()`
  - `st.execListeners` снимаются в `onRemoved`; в `modeW.callback` оба выдающих
    режима идут через `ensureIssueSafe()`
  - `applyPaneLayout()` (~L603): ОБЕ ветки — `tree`/`listContent` `flex:1 1 0` + `min-height:0`,
    `main` `1 1 0` + `min-height:0` + `overflow:hidden`; разница режимов ровно одна:
    в Vue `main`+`detail` живут в `scrollArea`, в канвасе — прямые дети `root`
  - `hintRow` (нижняя строка 22px, `flex-shrink:0`): подсказка ИЛИ bulk-бар
    (`bulkCount`/`bulkDel`/`bulkClear`, переключаются в `renderHint`); `listHead` — пустой спейсер
  - `st.apiPost()` — единая точка мутаций: любой POST → `plRefreshLocal()` у соседних нод
  - `onRemoved` — снимает WS-слушатель, settings-слушатель, убирает ноду из `plLiveStates`
  - `computeLayoutSize` → `{minHeight: st.minH(), minWidth: MIN_W}`; `BASE_H=596`,
    `DETAIL_H=280`, `INPUT_H=170`
- `tests/_test_prompt_library.py` — 173 проверки (§13 broadcast, §14 `__`, §15 бэкфилл,
  §16 три режима + `_output_linked`, §17 `attach_preview` + `_resolve_output_file`)
- `tests/_smoke_prompt_library.mjs` — 56 фаз (в т.ч. broadcast→reload, снятие слушателя,
  сжатие панелей, bulk-бар внизу, автоподхват обложки, три режима)
- `tests/_audit_prompt_library.mjs` — 12 роутов JS↔Python, 66 обращений `st.*`, локали, PNG-патч
- Все три — в `Prompt_Library/tests/` (AGENTS.md §1.1), пути внутри — от файла
  (`Path(__file__).parent.parent`, `new URL("..", import.meta.url)`), запуск из папки проекта
- `SPECIFICATION.md` — v1.23: §27 (аудит v1.22), §28 (пол на панелях → перекрытие)

## 3. Проблемы, которые встречались (и как решали)

- **Две Library-ноды не синхронны при удалении** — сервер не рассылал событие из роутов
  (+ на странице был свой путь) → broadcast везде + `plLiveStates`/`apiPost`.
- **Панель книги перекрывала низ списка** (жалоба пользователем) — `min-height:480px` на
  панелях: реального места меньше пола (панель до 320px против `DETAIL_H=280`, шрифт/зум),
  переполнение не уходило в скролл, а перекрывалось следующим сиблингом (`detail`). Решение:
  пол один — `computeLayoutSize`; панели сжимаются (§28).
- **Кнопки массового удаления обрезались** — счётчик в `listHead` без `flex`/`min-width:0`
  (в flex-строке `min-width:auto` = ширина текста) выдавливал кнопки за край. Решение:
  счётчик `flex:1 1 auto;min-width:0`, кнопки `flex-shrink:0`, строка `hintRow` фиксирована.
- **Вечный repaint канваса** — `checkCycle` звал `setDirtyCanvas` в `onDrawForeground`
  каждый кадр → перерисовка только при смене состояния.
- **Битый `library.json` ронял всё** — не-словари/не-строки отбрасываются, база
  перезаписывается очищенной (лог ASCII-only — кириллица в Windows-консоли).
- Python-консоль Windows: вывод кириллицы в тестах выглядит мусором (`??????`) — не баг.

## 4. Что важно не сломать при продолжении работы

- **Правило §28**: внутри `root` (высота = `computedHeight`, `overflow:hidden`) ни один
  ребёнок не ставит CSS-пол, не помещающийся в бюджет — дефицит не уходит в скролл,
  а перекрывается следующим сиблингом. Пол — только в `computeLayoutSize`.
- Sizing читает ТОЛЬКО boolean-стейт (`display`-флаги), никогда размеры DOM
  (запрещено: `offsetHeight`/`scrollHeight`/`plScale`/`setInterval`/`MutationObserver`).
- Не возвращать `autoFitHeight`/`calibrateFloor`/`_vueFloor`; не задавать legacy `computeSize`.
- Broadcast — `send_sync` + `app.api.addEventListener` (НЕ `window`); из роутов не забывать.
- Порядок INPUT_TYPES `[mode, selected, save_folder]`; `widgets_values` в PNG — позиционно.
- Метки — session-only; `__`-префикс зарезервирован (клиент + сервер).
- **Тесты — только в `NodeName/tests/`** (AGENTS.md §1.1): в корне проекта их быть не должно.
  Запуск: `cd Prompt_Library && python tests/_test_prompt_library.py` (аналогично `.mjs`).
  `sync.py` папку `tests/` и legacy `_test_*`/`_smoke_*`/`_audit_*` в корне НЕ копирует.
- Синк: `python sync.py Prompt_Library` из корня бандла → рестарт ComfyUI + Ctrl+F5;
  диска: `SPECIFICATION.md`/`README.md`/`tests/` sync.py НЕ копирует (только `.py/.js/.json` без тестов).
- Коммиты/пуши — из папки ноды (`gh` авторизован, `origin master`).

## 5. Следующие шаги (идеи, не сделано)

1. **Живая проверка v1.23** — рестарт + Ctrl+F5, маркер `v1.23-panes-fit`; открыть панель
   книги, Ctrl+клик по карточкам → кнопки внизу, низ списка не перекрыт (§17 п.4).
2. **Saver** (согласован в принципе): минимум / +статус / +ручной ввод — ждёт выбора.
3. Постраничность списка (~20 записей).
4. Вынести воркфлоу из `library.json` (растёт; `MAX_ENTRIES` 500, обрезка → сироты превью).
5. Решённое-но-не-сделанное (SPEC §27.3): `threading.Lock` на read-modify-write;
   `/update` не проверяет глобальный дубль; записи без метки `media` видны только во «Всё».
6. **Предложено пользователю**: добавить ловушку §28 в скил `comfyui-dom-widget-sizing`
   (ждёт «да»).

## 6. Связанные файлы

- `web/js/prompt_library.js` — JS-расширение ноды (маркер `1.23-panes-fit`)
- `prompt_library_node.py` — Python-нода (роуты, broadcast, база)
- `tests/` — `_test_prompt_library.py` / `_smoke_prompt_library.mjs` / `_audit_prompt_library.mjs` (только здесь тесты проекта)
- `SPECIFICATION.md` — полная документация (v1.23, §27–§28)
- `README.md` — пользовательское описание
- `SESSION_MEMORY-history/2026-09-18-1021.md` — снапшот предыдущей памяти (v1.21)
- `sync.py` — в корне бандла `F:\AI_projects\Custom_node_ComfyUI\`

## 7. Коммиты

| Хэш | Описание |
|-----|----------|
| `17a1794` | fix: sync all mutations, and stop panels from covering the list bottom (v1.22 + v1.23) |
| `9fbcab5` | memory snapshot: v1.21 auto-refresh session |
| `b2a38b3` | docs: move §26 to end of SPECIFICATION.md |

Все запушены в `origin master`. Синк рабочих копий — сделан (5 файлов, `__pycache__` очищен).
