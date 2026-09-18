# Память сессии — Prompt Library (2026-09-18, v1.19 запушена + память)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.19 (`9b83387`, запушена): ручное превью с диска — кнопка `📷 Прикрепить превью` в ручном вводе (даунскейл до 512px через canvas в браузере → PNG dataURL), сервер `_save_preview_upload` + `preview_data` в `/add` (битый файл — запись без превью); `INPUT_H` 130→170.
- Откат always-save: v1.19-always-save убрана в `stash@{0}` (петля структурная — провода, не код; лечится Saver'ом, не режимом).
- Обсуждён Saver (мертвая нода-приёмник после VAE, без выходов): дизайн согласован до «минимум vs обвязка», строить — по команде.
- SPECIFICATION.md v1.19 (п.11, §8, §17). Дерево чистое, `origin/master` вровень.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `_save_preview_upload()` + `preview_data` в `_pl_add`; сокет `IMAGE,VIDEO`; `_media_of`; bulk-endpoint'ы; `_req_body()`
- `web/js/prompt_library.js:58` — `PL_JS_VERSION = "1.18-multiselect"` (JS не менял версию в v1.19!); attach-блок (кнопка/тамб/крест/даунскейл); `INPUT_H = 170`; метки; `inlineEdit`; verTag
- `_test_prompt_library.py` — 94 проверки (§11: 4 по загрузке превью)
- `_smoke_prompt_library.mjs` — 47 фаз; `_audit_prompt_library.mjs` — чист (12 роутов)
- `SPECIFICATION.md` — v1.19 (п.11, §8 ручной ввод, §17)
- Скилл `comfyui-video-socket` в корне бандла (3 папки, идентичны)

## 3. Проблемы, которые встречались (и как решали)

- Петля «выход → … → вход-картинка»: структурная (ComfyUI смотрит на рисунок), кодом ноды не лечится → always-save откачен в стеш, путь — Saver без выходов.
- OUTPUT_NODE выполняется даже с неподключённым выходом (корень исполнения) — ручной флоу без круга работает уже сейчас.
- 🖼 мутно на Windows → везде 📷 (`U+1F5BC` отсутствует, проверено grep).
- Маркер версии забыли поднять под новый JS → `PL_JS_VERSION` + видимый verTag в тулбаре; смоук сверяет маркер.
- Системный Python без numpy/torch — видео-проверки на `python_embeded/python.exe` + стаб `FakeVideo`.
- `node --check` / смоук — из папки ноды; `sync.py` — из корня бандла.
- База в §6 забита до MAX_ENTRIES — тестовые записи через `insert(0)`, иначе срежет триммер.

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
- Стеш `stash@{0}` — откаченный always-save, не удалять молча

## 5. Следующие шаги (идеи, не сделано)

1. **Saver** (согласован в принципе): минимум (2 провода + поле «Папка», без выходов) vs +статус vs +ручной ввод — ждёт выбора и команды «строй»
2. Разбить Library на выдачу / Saver на приём (стратегия из §17)
3. Постраничность списка (~20 записей)
4. Вынести воркфлоу из `library.json` (растёт; лимит 500)
5. Inline-создание папки (последний `prompt()`)

## 6. Связанные файлы

- `web/js/prompt_library.js` — нода (JS-расширение, маркер 1.18-multiselect)
- `prompt_library_node.py` — Python-нода (сокет + extract + media + thumbnail + bulk + upload)
- `_test_prompt_library.py` — Python-тест (94 проверки)
- `_smoke_prompt_library.mjs` — JS-смоук (47 фаз)
- `_audit_prompt_library.mjs` — аудит связности (12 роутов)
- `SPECIFICATION.md` — v1.19 (п.11, §8, §17)
- Скилл `comfyui-video-socket` в корне бандла (3 папки)
