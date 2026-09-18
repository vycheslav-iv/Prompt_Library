# Память сессии — Prompt Library (2026-09-18, v1.16 + видео-сокет + скилл)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.16: вход `image` → `IMAGE,VIDEO` (двухцветный сокет, синий+зелёный провода); `_extract_frame()` разворачивает `VideoInput` в первый кадр; `_save_thumbnail()` закалён (батч/список/uint8/grayscale). Закоммичено и запушено (`d270d46`).
- Создали скилл `comfyui-video-socket` (3 папки: `.opencode` + `.kilo` + `.agents`), строка в `AGENTS.md` §3.
- SPECIFICATION.md обновлена до v1.16 (§5, §15, §17).
- Обсудили авто-метку `media` (video/image) — следующий шаг, ещё не реализована.

## 2. Итоговое состояние кода

- `prompt_library_node.py:189` — `_extract_frame()` (VideoInput → первый кадр)
- `prompt_library_node.py:211` — `_save_thumbnail()` (батч/список/uint8/grayscale)
- `prompt_library_node.py:359` — `INPUT_TYPES`: `image: ("IMAGE,VIDEO", {})`
- `prompt_library_node.py:422` — `execute()`: `frame = _extract_frame(image)`
- `_test_prompt_library.py` — 66 проверок, тест сокета `IMAGE,VIDEO`
- `SPECIFICATION.md` — v1.16
- Скилл: `.opencode/.kilo/.agents/skills/comfyui-video-socket/SKILL.md` (идентичны)

## 3. Проблемы, которые встречались (и как решали)

- Зелёный VIDEO-провод не втыкался в синий IMAGE-вход — разные типы ядра. Решение: мульти-тип через запятую (`IMAGE,VIDEO`, как `FLOAT,INT` в `node_typing.py`), фронт рисует двухцветный сокет. `*` не использовать (ядро предупреждает: ломает рероуты).
- Системный Python без numpy/torch — видео-проверки гнали на встроенном Python ComfyUI (`python_embeded/python.exe`) + стаб `FakeVideo`.

## 4. Что важно не сломать при продолжении работы

- **Canvas-ветку `applyPaneLayout` и `computeLayoutSize`** — проверены живьём
- Порядок INPUT_TYPES `[mode, selected, save_folder]`; `widget.serialize = false` свойством
- Сокет `image` — connector-only, в `widgets_values` не входит; JS `dropAutoSockets` по имени — не трогать
- Не возвращать `autoFitHeight`/`calibrateFloor`/`_vueFloor`
- Не перезаписывать `this.computeSize` на ноде
- Синк: `python sync.py Prompt_Library` → `D:\ComfyUI_windows_portable\...` → **Ctrl+F5**
- Дедупликация `(prompt, folder)` — поле `media` в неё НЕ входит (решено)

## 5. Следующие шаги (идеи, не сделано)

1. **Авто-метка `media`** (принято, делать первым): `video`/`image`/`null` в `_add_entry` (источник известен в `execute`); бейдж 🎬/🖼 на карточке + фильтр Все/Фото/Видео в тулбаре; старые записи без поля → unknown без бейджа; бэкфилл по workflow НЕ делать (хрупко)
2. Вынести воркфлоу из `library.json` (2.9 МБ / 92 записи, лимит 500)
3. Разбить на две ноды: **Prompt Library** + **Prompt Saver**
4. Постраничность списка (~20 записей)

## 6. Связанные файлы

- `web/js/prompt_library.js` — нода (JS-расширение, без изменений в v1.16)
- `prompt_library_node.py` — Python-нода (сокет + extract + thumbnail)
- `_test_prompt_library.py` — Python-тест (66 проверок)
- `_smoke_prompt_library.mjs` — JS-смоук (45 фаз)
- `_audit_prompt_library.mjs` — аудит связности
- `SPECIFICATION.md` — v1.16 (§5, §15, §17)
- Скилл `comfyui-video-socket` в корне бандла (3 папки)
