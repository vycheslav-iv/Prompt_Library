# Память сессии — Prompt Library (v1.57, 2026-09-23)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- **Импорт доведён до конца (v1.56 → v1.57)**: у «📥 Импорт» теперь все 4 источника.
  v1.56 — папка `.md` с обложками (разбор шапки экспорта, цель из проводника,
  дедуп по нормализованному тексту, лимит до записи, обложка возвращает граф).
v1.57 — **PNG** (промпт из чанка `workflow` внутри файла: `pngChunks`
   tEXt/iTXt (сверка длины, CRC пропускается, iTXt несжатый),
   `promptFromGraph`/`promptFromWorkflow`), **HTML-галерея**
   (`parseGalleryHtml` — round-trip БЕЗ машинного блока в экспорт), **текст**
   (`.txt/.md`, диалог «Абзацы / Строки / Весь файл»). Все три сходятся в единый
   `st.importRun(items, tree, extra)` — рефакторинг .md-потока. **Сервер не менялся.**
- Аудит v1.57 (документация + код): 3 кодовых фикса — `promptFromGraph`
  перебирает сэмплеры (первый без `positive`, напр. `SamplerCustomAdvanced`,
  пропускается); PNG-импорт шлёт граф в `items.workflow` (записи `< 4МБ`
  получают граф и из обложки, тяжёлые >4МБ со сжатой обложкой — из записи, так
  что «Параметры генерации» больше НЕ теряются); гард `rep === null` в
  `importRun` — честное «создано 0» вместо падения. + правки документации
  (пикер `showDirectoryPicker`, CRC не проверяется, iTXt несжатый, граница 4МБ).
- Первые зелёные прогоны: смоук 115 фаз ✅ (аудит добавил 3 фазы), Python
  430/430 ✅, аудит 21 роут ✅, `check.py` ЗЕЛЁНЫЙ.
- Коммиты: до v1.56 всё запушено (последний `2dbe408` = v1.54+v1.55). **v1.56 и
  v1.57 НЕ закоммичены** — предложить коммит.

## 2. Итоговое состояние кода

**Python** (`prompt_library_node.py`): НЕ МЕНЯЛСЯ в v1.57. Роут импорта —
`/prompt_library/import` (:2415), `_norm_import_text` (:393), `_import_target_folder`,
`_add_entry` с хвостовыми `created_at/favorite/pinned/import_src`, `attach_preview`
с `_workflow_chunk_from_bytes` (граф из обложки). Тесты 430/430.

**JS** (`web/js/prompt_library.js`, `PL_JS_VERSION = "1.57-import-sources"`, :148):
- `:PL_JS_VERSION`; меню импорта: `st.importStart` (4 источника) + `importGuard`
  (★/Выходы — отказ) + `importPickTree/Png/Html/Text` (~:3408-3503).
- ОБЩИЙ ПОТОК: `st.importSummary` → `st.importRun(items, tree, extra)` —
  пакетный POST, прогресс, заливка обложек по одной `st.coverDataUrl(it._cover)`,
  `plRefreshLocal`+`reload`, отчёт «создано N / дубликатов M / без текста K».
  `importMdFromFolder` хвост = `await st.importRun(...)`.
- PNG-блок (после пикеров): `pngChunks`, `promptFromGraph` (перебор сэмплеров —
  первый с рабочим `positive`; без `positive` — пропуск, не стоп), `promptFromWorkflow`,
  `collectImportPng`, `importPngFromFolder` (showDirectoryPicker + рекурсивный
  обход всех *.png; обложка = файл ≤4МБ без перекодирования — граф дополнительно
  из обложки, §49.5; сам граф дублируется в `items.workflow` → тяжёлые >4МБ
  (обложка сжата) параметры не теряют — §49.5/§50.2).
- HTML-блок: `_htmlUnesc`, `_htmlRelDecode`, `parseGalleryHtml`, `collectImportHtml`
  (папка + карта images), `importHtmlFromFolder(tree)` (src `htmlRel#idx`).
- Текст: `textEntries(base,text,mode)` (para/line/whole), `textSplitDialog`,
  `importTextRun` — **возвращает `st.importRun(items,false)`**.

**Тесты**: `_smoke_prompt_library.mjs` 115 фаз (v1.57-фазы ~:3308-:3440; PNG-хелперы
`crcDummy/rawPngChunk/pngTexT/pngITxt/makePng` ~:3317; sandbox с TextDecoder/TextEncoder :218),
`_test_prompt_library.py` 430, `_audit_prompt_library.mjs` 21 роут; живая
`_probe_live_dom.py` (требует питон ComfyUI — `python_embeded`, на системном нет websockets).

## 3. Проблемы, которые встречались (и как решали)

- **«создано 2» при двух записях с ОДНИМ src**: стуб смоука возвращал одну строку,
  hint застревал на «Импортирую 2 записей…». Два шага: (1) `importTextRun` НЕ
  возвращал promise `importRun` → фаза проверяла hint до отчёта → `return` нужен
  (правило на async-хелперы импорта!); (2) эталон «создано 2» — счёт по
  `rep.created.length`, а сервер дедуплицирует по НОРМАЛИЗОВАННОМУ ТЕКСТУ, не по
  `src` → обе записи создаются, отчёт правдив; починен стуб, а не импорт (§50.5).
- **Сервер vs «сколько создать»**: НЕ «сколько насчитали в браузере» — дедуп на
  сервере по тексту; отчёт честный, молчаливый подсчёт items дал бы вруньё при
  дублях. Сохраняем `rep.created.length`.
- Более раннее (v1.44–v1.55) — в стр. памятях в `SESSION_MEMORY-history/`.

## 4. Что важно не сломать при продолжении работы

- **Async-хелперы импорта обязаны ВОЗВРАЩАТЬ promise** (`importTextRun`, любые
  новые) — иначе смоук-фаза проверяет состояние ноды раньше времени.
- **Отчёт «создано N» = `rep.created.length`** — не items.length (сервер
  дедуплицирует по тексту, частичную запись семантику не менять).
- **`st.importRun`** — единая точка импорта; .md/PNG/HTML/текст зовут её; сервер
  не трогать (роут/`_add_entry`/лимит работают).
- Меню импорта: `importGuard` ПЕРВЫМ (★/Выходы — отказ словами); «Без категории»
  — диалог «плоско / структура» (importTreeDefault).
- Акт. семантика: `folder` из карточки HTML — как есть; PNG — `folder:""`,
  `media:"image"`, обложка = сам файл; текст — `folder:""`, `media:null`.
- `pngChunks`/`promptFromGraph` — глубина цепочек ≤4 (защита от циклов), фолбэк
  единственный CLIPTextEncode, пустой граф → «"» (не выдумывать).
- Правки Python видны только после **перезапуска ComfyUI**; JS — **Ctrl+F5**.
- Проба `_probe_live_dom.py` требует питон ComfyUI.

## 5. Следующие шаги (идеи, не сделано)

- **drag&drop файлов на ноду** как вход импорта (остаток §49.7/§50).
- **Закоммитить v1.56 + v1.57** (не запушено; последний коммит `2dbe408`).
- Шаги из сигма-сэмплеров (`SamplerCustomAdvanced` + `ManualSigmas`, LTX-видео) —
  поля пустые (честное ограничение, §44.2.1).
- Осветлить остальные значки дерева (📚 ★ 📄 📁) — сейчас фильтр только у `🔌`.
- Если подписи кнопок в ряду начнут резаться — компактная `🗑` без подписи (§46.3).

## 6. Связанные файлы

- `Prompt_Library/SPECIFICATION.md` — §17 (состояние), §18.4 (высоты), §40.6 (иконки),
  §41–§48, **§49 (импорт .md), §50 (импорт PNG/HTML/текст)**, хроника §15 (запись 49).
- `Prompt_Library/README.md` — карта и правила для пользователя (раздел «📥 Импорт»).
- `Prompt_Library/SESSION_MEMORY-history/` — снапшот прежней памяти:
  `2026-09-23-v1.56-копия-до-перезаписи.md`; более ранние — по датам/версиям.
- Скилы: `comfyui-workflow-graph-parsing`, `comfyui-negative-result-audit`,
  `comfyui-dom-widget-sizing`, `comfyui-frontend-sources`.