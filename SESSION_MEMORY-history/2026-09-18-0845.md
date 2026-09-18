# Память сессии — Prompt Library (2026-09-18, v1.18 запушена + память)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.18 (`affee09`, запушена): мультивыделение Ctrl/Shift (карточки + папки) с bulk-баром и массовым удалением (`delete_many`/`folder_delete_many`); переименование на месте (`st.inlineEdit`, без `prompt()`/`alert()`); акцент-полоса `box-shadow: inset`; эксклюзив (чужой тип с модификаторами — игнор, сброс только обычным кликом/пустым местом/Esc); видимая версия `v1.18-multiselect` в тулбаре; закалка (`_req_body`, коэрсия `prompt`, backfill `media`, чистка протухших меток).
- Глубокие ревизии без колхоза (маркеры чистые, весь дифф вычитан).
- SPECIFICATION.md v1.18 (§4.2, §5, §8, §15 п.10, §17). Память сохранена.
- Дерево чистое, `origin/master` вровень.

## 2. Итоговое состояние кода

- `prompt_library_node.py:155` — `_extract_frame()`; `:180` — `_save_thumbnail()`; `:310` — `_media_of()`; `:319` — `_add_entry(media=)`; `:361` — сокет `IMAGE,VIDEO`; `:505` — `_req_body()`; bulk-endpoint'ы `delete_many`/`folder_delete_many`
- `web/js/prompt_library.js:58` — `PL_JS_VERSION = "1.18-multiselect"`; `plMap`/`plBadge`/`mediaSel`/фильтр; метки (`markEntryToggle`/`markFolderToggle`/`rangeApply`/`clearMarks`/`bulkDelete`/`renderHint`); `inlineEdit`; видимый `verTag` в тулбаре
- `_test_prompt_library.py` — 90 проверок (§7 media, §8 bulk, §9 закалка)
- `_smoke_prompt_library.mjs` — 47 фаз (метки + inlineEdit исполнением)
- `SPECIFICATION.md` — v1.18
- Скилл `comfyui-video-socket` в корне бандла (3 папки, идентичны)

## 3. Проблемы, которые встречались (и как решали)

- Зелёный VIDEO не втыкался в синий IMAGE → мульти-тип `IMAGE,VIDEO` (как `FLOAT,INT`); `*` не использовать (ломает рероуты).
- Эксклюзив сначала сбрасывал чужие метки при модификаторах (баг) → теперь игнор с модификаторами, сброс только обычным кликом.
- Якорь Shift-диапазона ставил только Ctrl-клик → ставит и обычный клик (как в проводнике).
- 🖼 мутно на Windows → везде 📷 (проверено grep, `U+1F5BC` отсутствует).
- Маркер версии забыли поднять под новый JS → теперь `PL_JS_VERSION` + видимый verTag в тулбаре; смоук сверяет маркер.
- Системный Python без numpy/torch — видео-проверки на `python_embeded/python.exe` + стаб `FakeVideo`.
- `node --check` / смоук — из папки ноды; `sync.py` — из корня бандла.
- База в §6 теста забита до MAX_ENTRIES — новые тестовые записи вставлять через `insert(0)`, иначе срежет триммер.

## 4. Что важно не сломать при продолжении работы

- **Canvas-ветку `applyPaneLayout` и `computeLayoutSize`** — проверены живьём; только boolean-стейт в sizing, никаких замеров DOM
- Порядок INPUT_TYPES `[mode, selected, save_folder]`; `widget.serialize = false` свойством
- Сокет `image` — connector-only, в `widgets_values` не входит
- Бейдж/метка/полоса — только текст/фон/`box-shadow: inset` (размер не меняется!); не перезаписывать `this.computeSize`
- Неизвестный `media` — только во «Все», без бейджа; `media` не входит в дедупликацию
- Метки session-only (в PNG не персистить); `ev.target === zone` для пустого места; Esc в input гасить на месте
- Не возвращать `autoFitHeight`/`calibrateFloor`/`_vueFloor`
- Синк: `python sync.py Prompt_Library` (из корня!) → **рестарт ComfyUI + Ctrl+F5** (маркер в F12 и в тулбаре)
- Коммиты: из папки ноды (`git add -A && git commit && git push origin master`), `gh` авторизован

## 5. Следующие шаги (идеи, не сделано)

1. Разбить на две ноды: **Prompt Library** + **Prompt Saver**
2. Постраничность списка (~20 записей)
3. Вынести воркфлоу из `library.json` (растёт; лимит 500)
4. Inline-создание папки (сейчас `prompt()` — последний модальный диалог)
5. Живой тест мультивыделения пользователем

## 6. Связанные файлы

- `web/js/prompt_library.js` — нода (JS-расширение, v1.18)
- `prompt_library_node.py` — Python-нода (сокет + extract + media + thumbnail + bulk)
- `_test_prompt_library.py` — Python-тест (90 проверок)
- `_smoke_prompt_library.mjs` — JS-смоук (47 фаз)
- `_audit_prompt_library.mjs` — аудит связности (12 роутов)
- `SPECIFICATION.md` — v1.18 (§4.2, §5, §8, §15 п.10, §17)
- Скилл `comfyui-video-socket` в корне бандла (3 папки)
