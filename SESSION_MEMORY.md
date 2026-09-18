# Память сессии — Prompt Library (2026-09-18, v1.25)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md` (полная документация).

---

## 1. Что делали в этой сессии (кратко)

- **v1.24 (§29): одна нода вместо двух.** Третий режим «📤📥 Выдача + запись»;
  обложка сохранённой записи подтягивается ИЗ ПРОГОНА (файл из output/temp по
  событию `executed`) — IMAGE-провод больше не обязателен, кольца в графе нет.
- **v1.25 (§30): подхват финального текста.** Живая жалоба: пользователь собрал
  «карточка → LLM-цепочка → финальный текст → обратно в ту же ноду» и получил
  «Недопустимый рабочий процесс: циклическое соединение узлов». Это НЕ баг ноды:
  граф обязан быть ацикличным, нода не может быть началом и концом одной цепочки.
  Решение: поле `📎 Текст в базу` (`pickup`) + токен в `ui` + роут
  `/prompt_library/save_pickup` — текст узла-источника забирается ПОСЛЕ прогона
  (из `executed.ui.text` либо виджета живого графа) и сохраняется с обложкой прогона.
  Маркер JS: `1.25-pickup`.
- Разбор живого графа делался по файлу воркфлоу пользователя
  (`ComfyUI\user\default\workflows\Krea2_MY2.json`) — цикл найден в графе (2 Library-ноды:
  `1904` Выдача → `PreviewAny → Promt в LLM → … → 1622 Итоговый Promt → 1750 → 1903 Запись`;
  цикл появился, когда финальный текст подали НА ВХОД той же ноды).
- Тесты: Python 194/194, смоук 61/61, аудит чист.
- **Добита спецификация v1.25** (сессия прервалась на этом): §3 (роут `save_pickup`),
  §5 (`pickup` в таблице входов + третий режим), §6 (выход в трёх режимах), §7
  (псевдокод `execute()` переписан: `out_linked`, `_pickup_stash`, PNG-патч 4 позиции),
  §10 (`widgets_values` 4 значения), §8.1 (`pickupRow`), §8.2 (слушатели `executed`/
  `execution_success`, автосокеты, confirm для обоих выдающих режимов), §17
  (пункт «разбить на две ноды» помечен отменённым в v1.24).

## 2. Итоговое состояние кода

- `prompt_library_node.py`
  - `MODE_WRITE / MODE_ISSUE / MODE_BOTH`; `execute()` → `issue/both/save_on`,
    `_output_linked(extra_pnginfo, unique_id)` → авто-сквозь для старых графов,
    `preview_target` → `ui.saved_id`, `ui.mode_notice`
  - **v1.25:** `execute(self, mode, selected, save_folder, pickup="", source, image, …)`;
    при `pickup` входящий текст НЕ сохраняется (+ `mode_notice`), вместо сохранения
    `_pickup_stash(node, folder, workflow)` → токен в `_PICKUP` (лимит 20, без таймеров)
    → `ui.pickup` + `ui.pickup_node`; PNG-патч `[mode, selected, save_folder, pickup]`
  - `_load_image_file()` (декадер, подменяется в тестах) + `_resolve_output_file()`
    (output/temp/input с защитой от traversal)
  - роуты: `/prompt_library/save_pickup` (v1.25, токен одноразовый: нет токена → 400,
    пустой текст → `skipped: "empty"`, дубль → `duplicate: true`) и
    `/prompt_library/attach_preview` (v1.24)
  - `_broadcast_refresh()` — в `execute()` (только `added=True`) и во ВСЕХ
    мутирующих роутах (§26.7)
  - `_storage_folder()` — нормализация папки + `__*` → корень; `_find_text_match()` —
    глобальный дубль; `_snapshot_workflow()` — в ветке записи и в подхвате
- `web/js/prompt_library.js` — `PL_JS_VERSION = "1.25-pickup"`
  - **v1.25:** `pickupRow` (первый ребёнок `root`, 22px, `flex-shrink:0`) с
    `pickupSel`; `st.pickupWidget/pickupNode/setPickup/pickupCandidates/
    refreshPickupOptions` (кандидаты — STRING-выход или строковый виджет; своя нода,
    другие `PromptLibrary` и mute не предлагаются; пересборка на создании, `onConfigure`
    и перед открытием селектора — без таймеров); `st.runTexts` + `st.pendingPickup`
    + `st.pickupText` + `st.savePickup`; `st.attachPreview` (v1.24)
  - `st.attachPreview()` → POST `/prompt_library/attach_preview` + `reload()`
  - `st.execListeners` снимаются в `onRemoved` (плюс `pendingPickup`/`runTexts` clear)
  - `applyPaneLayout()` — ОБЕ ветки: `tree`/`listContent` `flex:1 1 0` + `min-height:0`,
    `main` `1 1 0` + `min-height:0` + `overflow:hidden`; разница режимов ровно одна:
    в Vue `main`+`detail` живут в `scrollArea`, в канвасе — прямые дети `root`
  - `hintRow` (22px, `flex-shrink:0`): подсказка ИЛИ bulk-бар; `listHead` — пустой спейсер
  - `st.apiPost()` — единая точка мутаций (POST → `plRefreshLocal()` у соседних нод)
  - `computeLayoutSize` → `{minHeight: st.minH(), minWidth: MIN_W}`; `BASE_H=624` (v1.25),
    `DETAIL_H=280`, `INPUT_H=170`
- `tests/_test_prompt_library.py` — 194 проверки (§16 три режима, §17 `attach_preview`,
  §18 подхват: токен/стэш/роут/дубль/лимит; `_p()` — печать без падения на cp1251)
- `tests/_smoke_prompt_library.mjs` — 61 фаза (в т.ч. id=-1 → назначение, subgraph-id,
  позиция после узлов вывода, три фазы подхвата, bulk-бар, три режима)
- `tests/_audit_prompt_library.mjs` — роуты JS↔Python, `st.*`, локали, PNG-патч
- Все три — в `Prompt_Library/tests/` (AGENTS.md §1.1), пути от файла, запуск из папки проекта
- `SPECIFICATION.md` — **v1.25**: §30 (подхват), §29 (одна нода), §28 (пол на панелях)

## 3. Проблемы, которые встречались (и как решали)

- **«Цикл при подключении выхода»** (живая жалоба) — в графе пользователя одна нода
  была и источником карточки для LLM, и приёмником финального текста. Провод назад =
  кольцо, ComfyUI исполняет только DAG. Решение — подхват из событий прогона (§30).
- **Ловушка id (кусалась на живой в v1.24b):** в `onNodeCreated` `this.id` ещё `-1`
  (`LGraphNode` ставит `UNASSIGNED_NODE_ID`, реальный id — при `graph.add`).
  Свой id читать только через `st.ownId()` В МОМЕНТ события.
- **Subgraph:** id приходит с префиксом (`"5:12"`) — сверять `display_node` и
  последний сегмент id (и для своей ноды, и для текста подхвата).
- **Панель книги перекрывала низ списка** (жалоба) — CSS-пол `min-height:480px` на
  панелях больше бюджета `root`; пол один — `computeLayoutSize` (§28).
- **Кнопки массового удаления обрезались** — счётчик без `flex`/`min-width:0`
  выдавливал кнопки; строка `hintRow` фиксирована, кнопки `flex-shrink:0`.
- **Вечный repaint канваса** — `checkCycle` в `onDrawForeground` дёргал `setDirtyCanvas`.
- **Python-консоль Windows:** кириллица в тестах выглядит мусором; падение
  `UnicodeEncodeError` на emoji в `extra` лечится `_p()` (encode с `replace`).

## 4. Что важно не сломать при продолжении работы

- **Не замыкать обратную петлю проводом.** Значение, которое появляется только в
  момент прогона (обложка, финальный текст), забирается из событий (`executed`) и
  отправляется с токеном. Провод назад = кольцо = Queue не запустится.
- **Всё, что нужно после прогона, живёт в токене** (`_PICKUP`), а не в URL/памяти
  клиента: `execute()` к моменту прихода текста уже отработал.
- **Порядок INPUT_TYPES `[mode, selected, save_folder, pickup]`**; `widgets_values` в
  PNG — позиционно (старые массивы из 3 значений читаются).
- **Правило §28:** внутри `root` (высота = `computedHeight`, `overflow:hidden`) ни один
  ребёнок не ставит CSS-пол, не помещающийся в бюджет; пол — только в `computeLayoutSize`.
- Sizing читает ТОЛЬКО boolean-стейт, никогда размеры DOM (запрещено:
  `offsetHeight`/`scrollHeight`/`plScale`/`setInterval`/`MutationObserver`).
- Не задавать legacy `computeSize`; не возвращать `autoFitHeight`/`_vueFloor`.
- Broadcast — `send_sync` + `app.api.addEventListener` (НЕ `window`); из новых роутов не забывать.
- Подхват: не тостить дубль (срабатывает на КАЖДЫЙ Queue) — только `hintSticky` + F12.
- **Тесты — только в `NodeName/tests/`** (AGENTS.md §1.1); `sync.py` их не копирует.
- Синк: `python sync.py Prompt_Library` из корня бандла → рестарт ComfyUI + Ctrl+F5.
  `SPECIFICATION.md`/`README.md`/`tests/`/`SESSION_MEMORY*` sync.py НЕ копирует.
- Коммиты/пуши — из папки ноды (`gh` авторизован, `origin master`).

## 5. Следующие шаги (идеи, не сделано)

1. **Живая проверка v1.25** — рестарт + Ctrl+F5, маркер `v1.25-pickup`; нода в режиме
   «📤 Выдача» + поле «📎 Текст в базу» = «Итоговый Prompt» → Queue: запись с обложкой,
   кольца нет. Диагностика при сбое — строки `[PromptLibrary] pickup: …` в F12.
2. **Живая проверка v1.24** (если ещё не проходила): режимы, обложка без IMAGE-провода,
   старый граф с Saver.
3. Постраничность списка (~20 записей).
4. Вынести воркфлоу из `library.json` (растёт; `MAX_ENTRIES` 500, обрезка → сироты превью).
5. Открытое из §27.3: `threading.Lock` на read-modify-write; `/update` без проверки
   глобального дубля; записи без `media` видны только во «Всё».
6. Возможное расширение подхвата: перечислять и узлы внутри subgraph (сейчас только
   верхний уровень графа).

## 6. Связанные файлы

- `web/js/prompt_library.js` — JS-расширение ноды (маркер `1.25-pickup`)
- `prompt_library_node.py` — Python-нода (роуты, broadcast, база, подхват)
- `tests/` — `_test_prompt_library.py` / `_smoke_prompt_library.mjs` / `_audit_prompt_library.mjs`
- `SPECIFICATION.md` — полная документация (v1.25, §28–§30)
- `README.md` — пользовательское описание
- `SESSION_MEMORY-history/2026-09-18-v1.24-one-node.md` — снапшот предыдущей памяти
- `sync.py` — в корне бандла `F:\AI_projects\Custom_node_ComfyUI\`

## 7. Коммиты

| Хэш | Описание |
|-----|----------|
| `a4e613d` | feat: pick up the final text from a source node after the run (v1.25) |
| `6172e4d` | fix: cover handshake read a stale node id (v1.24b) |
| `9dd6424` | docs: note the subgraph id prefix trap and the deferred-cover rule |
| `9faef0c` | fix: recognise own node id inside subgraphs |
| `3b4a2cc` | feat: one node instead of two — mode switch and cover from the run |
| `fe06de8` | refactor: move tests into tests/ per project structure rule |
| `17a1794` | fix: sync all mutations, and stop panels from covering the list bottom |
| `4b2fbda` | memory: v1.22 audit + v1.23 panels-fit session |

Все запушены в `origin master`, ветка чистая.
