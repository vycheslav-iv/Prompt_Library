# Память сессии — Prompt Library (2026-09-19, v1.26)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md` (полная документация).

---

## 1. Что делали в этой сессии (кратко)

- **v1.26 (§31): вся медиа-обложка — без провода.** Три жалобы пользователя:
  «1) не сохраняет видео превью; 2) нельзя добавить превью из видео для ручного
  промпта; 3) нельзя заменить превью существующей записи».
  Корень №1: видео-прогон файл ОТДАЁТ (ядро кладёт видео в то же `images`,
  `PreviewVideo.as_dict()` → `images` + `animated`; VHS-подобные ноды — в
  `video`/`gifs`), но сервер декодировал файл через PIL, а PIL медиаконтейнер не
  открывает → `400 media read failed`, снаружи выглядело как «видео не сохраняется».
  Решено: `_load_video_frame()` через **PyAV** (штатная зависимость ComfyUI, им же
  пользуется `SaveVideo`) + чтение трёх пулов в JS + `preview_data` в
  `/attach_preview` (кадр снимает БРАУЗЕР: файл с диска серверу не виден) +
  кнопка `🖼/🎬 Заменить превью` в панели книги + `media` теперь описывает текущую
  обложку. Маркер JS: `1.26-media`.
- **v1.26b: замена обложки — только в режиме правки.** Пользователь: «слишком
  небезопасно редактируется превью, кнопку надо показывать после ✏️ Редактировать».
  Сделано: `bPreview` скрыта в просмотре (как 💾) и появляется только в режиме
  правки; перед POST — `confirm` (замена НЕОБРАТИМА: `previews/{id}.png`
  перезаписывается), отказ → подпись возвращается к текущему типу; после замены
  обновляются только формуляр/подпись/карточка (`st.fillMeta`), а НЕ `fillDetail` —
  иначе сбрасывался режим правки и терялся несохранённый текст.
- **v1.26c: ✖ Отмена в панели книги.** В режиме правки рядом с 💾 появилась ✖ —
  выход без сохранения: значения берутся из базы через `st.fillDetail` (одна точка
  правды, а не второй ручной сброс полей); диалог — только если правки реально есть
  («зашёл и передумал» — тихо); отказ в диалоге оставляет текст и режим.
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
- Тесты: Python 213/213, смоук 64/64, аудит чист (до v1.26 было 194/61).
- **Добита спецификация v1.25** (сессия прервалась на этом): §3 (роут `save_pickup`),
  §5 (`pickup` в таблице входов + третий режим), §6 (выход в трёх режимах), §7
  (псевдокод `execute()` переписан: `out_linked`, `_pickup_stash`, PNG-патч 4 позиции),
  §10 (`widgets_values` 4 значения), §8.1 (`pickupRow`), §8.2 (слушатели `executed`/
  `execution_success`, автосокеты, confirm для обоих выдающих режимов), §17
  (пункт «разбить на две ноды» помечен отменённым в v1.24).
- **Аудит спеки от последнего коммита и раньше** (просьба пользователя): разделы,
  не тронутые с `2c93d13`, оставались на модели «превью ТОЛЬКО проводом» и «два
  режима» — поправлены: §2 (таблица решений), §3 (схема + три режима + подхват),
  §4.2 (`media`/`preview` без провода), §11 (счётчики 194/61), §12 (автоподхват
  больше не в «не делаем»), §14 (критерии v1.25), §15 (хроника: пункт 17 = v1.25),
  §20.3 (пометка «виджет `prompt` — история»), §25.1 (194/61, 14 роутов, 81/8 `st.*`),
  §16 (нумерация), README (метка `media`).

## 2. Итоговое состояние кода

- `prompt_library_node.py`
  - `MODE_WRITE / MODE_ISSUE / MODE_BOTH`; `execute()` → `issue/both/save_on`,
    `_output_linked(extra_pnginfo, unique_id)` → авто-сквозь для старых графов,
    `preview_target` → `ui.saved_id`, `ui.mode_notice`
  - **v1.25:** `execute(self, mode, selected, save_folder, pickup="", source, image, …)`;
    при `pickup` входящий текст НЕ сохраняется (+ `mode_notice`), вместо сохранения
    `_pickup_stash(node, folder, workflow)` → токен в `_PICKUP` (лимит 20, без таймеров)
    → `ui.pickup` + `ui.pickup_node`; PNG-патч `[mode, selected, save_folder, pickup]`
  - **v1.26:** `_VIDEO_EXT`/`_is_video_file()` (по расширению), `_load_video_frame()`
    (PyAV, первый кадр, лениво), `_load_media_frame()` (PIL → при ошибке PyAV);
    `_save_preview_upload(data_url, entry_id, workflow=None)` — теперь встраивает
    воркфлоу в PNG
  - `_load_image_file()` (декадер, подменяется в тестах) + `_resolve_output_file()`
    (output/temp/input с защитой от traversal)
  - роуты: `/prompt_library/save_pickup` (v1.25, токен одноразовый: нет токена → 400,
    пустой текст → `skipped: "empty"`, дубль → `duplicate: true`);
    `/prompt_library/attach_preview` (v1.24 + v1.26: два источника — файл прогона
    ИЛИ `preview_data`; `media` (hint важнее расширения) и `force`; без обоих
    источников → 400, ручная замена у удалённой записи → 404, авто-подхват →
    `skipped: no_entry`); `/add` принимает `media` (`image`/`video`, мусор → None)
  - `_broadcast_refresh()` — в `execute()` (только `added=True`) и во ВСЕХ
    мутирующих роутах (§26.7)
  - `_storage_folder()` — нормализация папки + `__*` → корень; `_find_text_match()` —
    глобальный дубль; `_snapshot_workflow()` — в ветке записи и в подхвате
- `web/js/prompt_library.js` — `PL_JS_VERSION = "1.26-media"`
  - **v1.26:** `st.readPreviewFile(file)` (картинка — canvas-даунскейл 512px; видео —
    первый кадр через `<video>`+canvas, `media` в ответе; один одноразовый
    `setTimeout`-предохранитель вместо наблюдателей); пулы файлов прогона
    `images → video → gifs`; ручное превью принимает `image/*,video/*` (+ миниатюра
    `<img>`/`<video>`); `st.fillDetail(id)` (общая точка панели книги: клик по
    карточке И обновление после замены), `st.bPreview` + скрытый `dPreviewFile`
    (замена обложки: `preview_data` + `media` + `force: true`), `st.previewStamp`
    (локальный `&r=` к URL превью — без него браузер показывает старую картинку)
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
- `tests/_test_prompt_library.py` — 213 проверок (§16 три режима, §17 `attach_preview`,
  §18 подхват: токен/стэш/роут/дубль/лимит, §19 медиа: снифф расширений, видео
  через PyAV, `preview_data`/`force`/404, воркфлоу в новом превью, `media` из `/add`;
  `_p()` — печать без падения на cp1251)
- `tests/_smoke_prompt_library.mjs` — 65 фаз (в т.ч. id=-1 → назначение, subgraph-id,
  позиция после узлов вывода, три фазы подхвата, bulk-бар, три режима, четыре фазы
  v1.26: пулы `images`/`video`/`gifs`, кадр из файла, гейт замены обложки с
  подтверждением, ✖ Отмена). В заглушке DOM есть `madeEls`-реестр и `drawImage` —
  без них кадры из файла не проверить
- `tests/_audit_prompt_library.mjs` — роуты JS↔Python, `st.*`, локали, PNG-патч
- Все три — в `Prompt_Library/tests/` (AGENTS.md §1.1), пути от файла, запуск из папки проекта
- `SPECIFICATION.md` — **v1.26**: §31 (медиа-обложка), §30 (подхват), §29 (одна нода),
  §28 (пол на панелях)

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
- **«Видео-превью не сохраняется»** (живая жалоба) — файл прогона был на месте,
  но сервер звал PIL (`_load_image_file`), а PIL не открывает mp4/webm: ошибка видна
  только в F12 (`attach_preview failed: 400 media read failed`). Лечится PyAV (§31).
- **Замена обложки не видна в карточке** — URL превью кэшируется по `t=created_at`,
  который при замене не меняется → браузер отдаёт старую картинку. Лечится локальной
  меткой `st.previewStamp` (`&r=`), §31.2.
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
- **PIL ≠ медиа.** Любой «файл прогона» может быть видео: сначала PIL, при ошибке
  PyAV; не терять три пула (`images`/`video`/`gifs`) — иначе видео-прогон молча без обложки.
- **`media` описывает ТЕКУЩУЮ обложку** и обновляется вместе с ней (заменили видео на
  фото — метка меняется), иначе фильтр «Тип» и 🎬/📷-бейдж врут.
- Обложка записи = ОДИН PNG 512px (файл видео в базу не копируется); новый кадр
  обязан нести вшитый воркфлоу (`_save_preview_upload(..., workflow=)`).
- Не удалять «лишний» `previewStamp` — без него заменённая обложка не появится в UI.
- **Правка карточки: вход — ✏️, выход — 💾 ИЛИ ✖.** ✖ не сбрасывает поля
  вручную — зовёт `st.fillDetail` (значения из базы); спрашивает только при реальных
  правках. Не удалять гейт: в просмотре действия записи не показываем.
- **Замена обложки: кнопка только в режиме правки + `confirm`.** После неё НЕ звать
  `st.fillDetail` (он включает просмотр: поля readOnly и текст из кэша) — только
  `st.fillMeta` + `previewStamp` + `reload()`. Обратной силы у замены нет:
  `previews/{id}.png` перезаписывается на месте.
- **Тесты — только в `NodeName/tests/`** (AGENTS.md §1.1); `sync.py` их не копирует.
- Синк: `python sync.py Prompt_Library` из корня бандла → рестарт ComfyUI + Ctrl+F5.
  `SPECIFICATION.md`/`README.md`/`tests/`/`SESSION_MEMORY*` sync.py НЕ копирует.
- Коммиты/пуши — из папки ноды (`gh` авторизован, `origin master`).

## 5. Следующие шаги (идеи, не сделано)

1. **Живая проверка v1.26** — рестарт + Ctrl+F5, маркер `v1.26-media`:
   (а) прогон с видео-выходом → запись с обложкой-первым кадром;
   (б) `➕ Добавить промпт` + `📷 Прикрепить превью` с mp4 → запись с меткой 🎬;
   (в) панель книги → `🖼 Заменить превью` картинкой и видео → обложка и метка меняются
   (важно проверить именно СМЕНУ картинки в карточке — кэш `&r=`);
   диагностика — `[PromptLibrary] media read failed / replace preview failed` в F12.
2. **Живая проверка v1.25** — маркер `v1.25-pickup`; режим «📤 Выдача» +
   «📎 Текст в базу» = «Итоговый Prompt» → Queue: запись с обложкой, кольца нет.
3. **Живая проверка v1.24** (если ещё не проходила): режимы, обложка без IMAGE-провода,
   старый граф с Saver.
4. Постраничность списка (~20 записей).
5. Вынести воркфлоу из `library.json` (растёт; `MAX_ENTRIES` 500, обрезка → сироты превью).
6. Открытое из §27.3: `threading.Lock` на read-modify-write; `/update` без проверки
   глобального дубля; записи без `media` видны только во «Всё».
7. Возможное расширение подхвата: перечислять и узлы внутри subgraph (сейчас только
   верхний уровень графа).

## 6. Связанные файлы

- `web/js/prompt_library.js` — JS-расширение ноды (маркер `1.26-media`)
- `prompt_library_node.py` — Python-нода (роуты, broadcast, база, подхват, медиа-обложка)
- `tests/` — `_test_prompt_library.py` / `_smoke_prompt_library.mjs` / `_audit_prompt_library.mjs`
- `SPECIFICATION.md` — полная документация (v1.26, §28–§31)
- Скил `comfyui-deferred-capture` (3 папки в корне бандла) — §3 дополнен видео
  (PyAV, три пула, кадр из браузера) и ловушками 10–11 (кэш замены, метка типа)
- `README.md` — пользовательское описание
- `SESSION_MEMORY-history/2026-09-18-v1.24-one-node.md` — снапшот предыдущей памяти
- `sync.py` — в корне бандла `F:\AI_projects\Custom_node_ComfyUI\`

## 7. Коммиты

| Хэш | Описание |
|-----|----------|
| `2ab44f4` | fix: gate the cover replacement behind edit mode and a confirm (v1.26b) |
| `dc19600` | memory: v1.26 media covers, manual video preview, cover replacement |
| `d72a685` | feat: video covers without a wire, manual video preview, cover replacement (v1.26) |
| `765888d` | docs: bring the pre-v1.24 spec sections up to date |
| `a4e613d` | feat: pick up the final text from a source node after the run (v1.25) |
| `6172e4d` | fix: cover handshake read a stale node id (v1.24b) |
| `9dd6424` | docs: note the subgraph id prefix trap and the deferred-cover rule |
| `9faef0c` | fix: recognise own node id inside subgraphs |
| `3b4a2cc` | feat: one node instead of two — mode switch and cover from the run |
| `fe06de8` | refactor: move tests into tests/ per project structure rule |
| `17a1794` | fix: sync all mutations, and stop panels from covering the list bottom |
| `4b2fbda` | memory: v1.22 audit + v1.23 panels-fit session |

Все запушены в `origin master`, ветка чистая.
