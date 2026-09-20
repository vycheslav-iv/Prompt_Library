# Память сессии — Prompt Library (v1.33, 2026-09-20)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

**Фича v1.33 по просьбе пользователя: кнопка «💾 Сохранить в папку»** в панели
книги (detail-панель). По клику открывается СИСТЕМНЫЙ выбор папки
(`showDirectoryPicker`, File System Access API — Chrome/Edge), в неё пишутся
`<title>.md` (текст + метаданные: категория, дата, тип, избранное) и, если у
записи есть обложка, `<title>.png/.jpg` (байты — роутом `/prompt_library/preview`,
расширение по `blob.type`). Решение пользователя: выбор папки — при каждом
клике (не запоминаем), имя файла — из названия записи (чем-то похоже на `_clean`
в enrichers, но отдельная функция). **Чистый JS, новых Python-роутов/данных не
нужно** (в ранней гипотезе ошибочно думали, что понадобится роут). выбор папки
каждый раз; отмена диалога — тихий выход; браузер без API — стойкая подсказка.

## 2. Итоговое состояние кода

- `web/js/prompt_library.js` (2514 строк), `PL_JS_VERSION = "1.33-export-to-folder"`:
  - кнопка `bExport` создаётся в ряду действий панели (`dBtns`) сразу после
    `bWorkflow` (~:610), в `st` внесена (~:647);
  - `st.sanitizeFileName(name)` (~:2102) — режет `/ \ : * ? " < > |` и
    управляющие, режет точки в начале (не dot-file), фолбэк «запись»;
  - `st.writeEntryToDir(dirHandle, full)` (~:2106) — пишет `.md` + обложку;
  - `st.exportEntry` (~:2149) — выбор папки, запись, подсказки (hintSticky).
- `prompt_library_node.py` — БЕЗ ИЗМЕНЕНИЙ (1303 строки).
- `check.json` — единый чекер: **`python _process/check.py Prompt_Library`**
  (из корня бандла `F:\AI_projects\Custom_node_ComfyUI`).
- `tests/`: Python **244**, смоук **76** (новые фазы «v1.33»: кнопка+экспорт,
  отмена диалога, нет поддержки браузера, `sanitizeFileName`), аудит чист.

## 3. Проблемы, которые встречались (и как решали)

- **Браузер без File System Access API** (Firefox/Safari) — `exportEntry`
  проверяет `typeof window.showDirectoryPicker !== "function"` и ставит
  hintSticky «нужен Chrome или Edge» (не тост, не сломанный клик).
- **Имя файла**: названия записей содержат `/` и другие недопустимые символы —
  `sanitizeFileName` вырезает их (проверено в смоуке, название
  «Запись "важная" / фото?» → `Запись _важная_ _ фото_.md`).
- **Отмена диалога** — `AbortError` ловится отдельно и глотается (клик не
  оставляет ошибок в консоли).

## 4. Что важно не сломать при продолжении работы

- Все проверки зелёные: Python 244 + смоук 76 + аудит. После правок JS всегда
  гонять смоук и аудит (аудит сверяет ст.* и роуты JS ↔ Python).
- `showDirectoryPicker` доступен ТОЛЬКО в secure context (https/localhost) и в
  Chrome/Edge — живая проверка именно там.
- Аудит-тест следит за запрещёнными паттернами sizing (`setInterval`,
  `offsetHeight`, `root.scrollHeight`) — в sizing-код не лезть.
- Синхронизация и коммит обязательны (рабочая копия ComfyUI на
  `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library`).

## 5. Следующие шаги (идеи, не сделано)

- **Живая проверка экспорта** (после рестарта ComfyUI, Ctrl+F5): открыть
  панель книги, «💾 Сохранить в папку», выбрать папку, убедиться что `.md` и
  обложка легли в неё (Chrome/Edge!).
- Первичный смоук в ComfyUI: кнопка не должна лагать, панель не должна менять
  высоту (кнопка добавляется в фиксированную строку `dBtns`).

## 6. Связанные файлы

- `web/js/prompt_library.js` — кнопка ~:610, `st.exportEntry` ~:2149,
  `sanitizeFileName` ~:2102, `writeEntryToDir` ~:2106
- `SPECIFICATION.md` — v1.33 (§38; хроника п.26; §14/§17 обновлены)
- `tests/_smoke_prompt_library.mjs` — фазы «v1.33» (кнопка+экспорт+отмена+браузер)
- `tests/_audit_prompt_library.mjs` — сверка роутов и ст.* (чист)
- `check.json` — `python _process/check.py Prompt_Library`
- `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library` — рабочая копия