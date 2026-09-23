# Память сессии — Prompt Library (v1.57, 2026-09-23)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- **Импорт доведён до конца (v1.56 → v1.57)**: у «📥 Импорт» все 4 источника.
  v1.56 — папка `.md` с обложками (разбор шапки экспорта, цель из проводника,
  дедуп по нормализованному тексту, лимит до записи, обложка возвращает граф
  через `_workflow_chunk_from_bytes`).
  v1.57 — **PNG** (промпт из чанка `workflow` внутри файла: `pngChunks`
  tEXt/iTXt — длина сверяется с остатком буфера, **CRC не проверяется**,
  iTXt несжатый; `promptFromGraph`/`promptFromWorkflow`), **HTML-галерея**
  (`parseGalleryHtml` — round-trip БЕЗ машинного блока в экспорт), **текст**
  (`.txt/.md`, диалог «Абзацы / Строки / Весь файл»). Все три сходятся в единый
  `st.importRun(items, tree, extra)` — рефакторинг .md-потока. **Сервер не менялся.**
- **Аудит v1.57** (документация + код), 3 кодовых фикса:
  1. `promptFromGraph` перебирает сэмплеры — первый с рабочим `positive`
     (`SamplerCustomAdvanced` без `positive` пропускается, не глушит разбор);
  2. PNG-импорт шлёт граф в `items.workflow` (сервер пишет его в
     `workflows/{id}.json`) — тяжёлые PNG >4МБ со сжатой обложкой «Параметры
     генерации» НЕ теряют (обложка ≤4МБ — граф дополнительно из обложки, §49.5);
  3. гард `rep === null` в `importRun` — честное «создано 0» вместо падения.
  + правки документации (пикер = `showDirectoryPicker`, факты `pngChunks`).
- **Закоммичено и запушено**: `24675b6` v1.56+v1.57 (+ аудит-фиксы), last push.
- Проверки: смоук **115 фаз** ✅ (3 красных ДО фиксов), Python 430/430 ✅,
  аудит 21 роут ✅, `check.py` ЗЕЛЁНЫЙ. `sync.py` — рабочая копия синхронизирована.

## 2. Итоговое состояние кода

**Python** (`prompt_library_node.py`): НЕ МЕНЯЛСЯ в v1.57. Роут импорта —
`/prompt_library/import` (:2415), `_norm_import_text` (:393), `_add_entry` с
хвостовыми `created_at/favorite/pinned/import_src`, `attach_preview` (:2243) с
`_workflow_chunk_from_bytes` (граф из обложки ≤4МБ). Запись графа —
`workflows/{id}.json`. Тесты 430/430.

**JS** (`web/js/prompt_library.js`, `PL_JS_VERSION = "1.57-import-sources"`, :148):
- Меню импорта: `st.importStart` + `importGuard` (★/Выходы — отказ, :3428) +
  `importPickTree/Png/Html/Text` (:3437-:3477).
- ОБЩИЙ ПОТОК: `importSummary` (:3278) → `importRun(items, tree, extra)` (:3293) —
  пакетный POST, прогресс, заливка обложек по одной `st.coverDataUrl(it._cover)`,
  `plRefreshLocal`+`reload`, отчёт «создано N / дубликатов M / без текста K»;
  гард `rep === null` → `{}`.
- PNG-блок: `pngChunks` (:3511), `promptFromGraph` (:3549, перебор сэмплеров,
  positive-цепочка `inputs.text` до глубины 4, фолбэк CLIPTextEncode),
  `promptFromWorkflow` (:3579), `importPngFromFolder` (:3604, `showDirectoryPicker` +
  рекурсивный обход всех `*.png`; `workflow` = api (chunks.prompt) || ui (chunks.workflow);
  обложка = файл; граф в записи).
- HTML-блок: `_htmlUnesc`, `_htmlRelDecode`, `parseGalleryHtml`, `collectImportHtml`,
  `importHtmlFromFolder` (:3731, src `htmlRel#idx`).
- Текст: `textSplitDialog` (:3823), `textEntries` (para/line/whole),
  `importTextRun` (:3839) — **возвращает `st.importRun(items,false)`**.

**Тесты**: `_smoke_prompt_library.mjs` 115 фаз (v1.57-фазы ~:3308-:3440; PNG-хелперы
`crcDummy/rawPngChunk/pngTexT/pngITxt/makePng` ~:3317; sandbox TextDecoder/TextEncoder :218),
`_test_prompt_library.py` 430, `_audit_prompt_library.mjs` 21 роут; живая
`_probe_live_dom.py` (требует питон ComfyUI — `python_embeded`, на системном нет websockets).

## 3. Проблемы, которые встречались (и как решали)

- **«создано 2» при двух записях с ОДНИМ src**: `importTextRun` НЕ возвращал
  promise `importRun` → фаза проверяла hint до отчёта → `return` обязателен
  (правило на async-хелперы импорта!); эталон — по `rep.created.length`, сервер
  дедуплицирует по ТЕКСТУ (§50.5).
- **Заблуждения в документации** (исправлены аудитом): «CRC-аргумент zip» —
  выдумка, CRC просто пропускается (`p += len + 4`); «диалог файлов» — на деле
  `showDirectoryPicker` + рекурсивный обход; «PNG >4МБ теряют граф» — теперь
  граф в записи, терялась только обложка-чанк.
- Более раннее (v1.44–v1.55) — в стр. памятях в `SESSION_MEMORY-history/`.

## 4. Что важно не сломать при продолжении работы

- **Async-хелперы импорта обязаны ВОЗВРАЩАТЬ promise** (`importTextRun`, любые
  новые) — иначе смоук-фаза проверяет состояние ноды раньше времени.
- **Отчёт «создано N» = `rep.created.length`** — не items.length (сервер
  дедуплицирует по тексту; частичную запись не менять).
- **`st.importRun`** — единая точка импорта; .md/PNG/HTML/текст зовут её; сервер
  не трогать (роут/`_add_entry`/лимит работают). Граф записи — в `items.workflow`.
- Меню импорта: `importGuard` ПЕРВЫМ (★/Выходы — отказ словами); «Без категории»
  — диалог «плоско / структура» (importTreeDefault).
- Семантика: HTML `folder` из карточки — как есть; PNG — `folder:""`,
  `media:"image"`, обложка = файл; текст — `folder:""`, `media:null`.
- `pngChunks`/`promptFromGraph` — глубина цепочек ≤4 (защита от циклов), фолбэк
  единственный CLIPTextEncode, пустой граф → `""` (не выдумывать).
- Python-правки видны только после **перезапуска ComfyUI**; JS — **Ctrl+F5**.

## 5. Следующие шаги (идеи, не сделано)

- **drag&drop файлов на ноду** как вход импорта (остаток §49.7/§50).
- Шаги из сигма-сэмплеров (`SamplerCustomAdvanced` + `ManualSigmas`, LTX-видео) —
  поля пустые (честное ограничение, §44.2.1).
- Осветлить остальные значки дерева (📚 ★ 📄 📁) — сейчас фильтр только у `🔌`.
- Если подписи кнопок в ряду начнут резаться — компактная `🗑` без подписи (§46.3).

## 6. Связанные файлы

- `Prompt_Library/SPECIFICATION.md` — §17 (состояние), §18.4 (высоты), §40.6 (иконки),
  §41–§48, **§49 (импорт .md), §50 (импорт PNG/HTML/текст)**, хроника §15 (записи 48–49).
- `Prompt_Library/README.md` — карта и правила для пользователя (раздел «📥 Импорт»).
- `Prompt_Library/SESSION_MEMORY-history/` — снапшот прежней памяти:
  `2026-09-23-v1.57.md` (перед этой перезаписью); ранние — по датам/версиям.
- Скилы: `comfyui-workflow-graph-parsing`, `comfyui-negative-result-audit`,
  `comfyui-dom-widget-sizing`, `comfyui-frontend-sources`.