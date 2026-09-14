# Память сессии — Prompt Library (2026-09-14, вечер)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Долгая доводка по скринам: входы/окна/фантомные точки. Финал: подписанный `source` («Промт (вход)») + одно нативное окно + MODE + категории + DnD + сторож цикла. Всё запушено (коммит `7962be8`).
- Главный урок сессии: фронтенд 1.52 игнорирует `computeSize`/`hidden` у multiline — скрытия убраны, только штатные механизмы.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `PromptLibrary` (INPUT_TYPES: prompt/mode/selected/save_folder + optional source/image; `OUTPUT_NODE=True`; `VALIDATE_INPUTS` для `*`).
- `execute()`: incoming = source ?? prompt; выдача обновляет `last_used`; автосейв с дедупом по hash(prompt+folder); патч `[display, mode, selected, save_folder]`.
- Endpoints: `list/entry/preview/add/favorite/update/delete/folder_create/folder_rename/folder_delete`.
- `_load_db/_save_db`: формат `{entries, folders}`, миграция legacy-списка и `category→folder`, авто-title, превью 512px/LANCZOS/q90.
- `web/js/prompt_library.js` — DOM: поиск+сортировка+вид (163/109/82), дерево категорий (слева список, справа дерево), панель книги, `💾 Сохранить` после окна, DnD, сторож цикла + confirm IMAGE, `dropAutoSockets` (prompt/selected/save_folder), `fixTextarea` (160px max-height).
- База рантайма: `ComfyUI/user/prompt_library/library.json` + `previews/` (не в репозитории).
- Репозиторий: `https://github.com/vycheslav-iv/Prompt_Library.git`, master, чисто (3 коммита).

## 3. Проблемы, которые встречались (и как решали)

- Цикл IMAGE→выход→CLIP: две копии ноды с общей базой (в README). Переключатель MODE цикл не лечит — цикл в проводах, не в поведении.
- Каждый виджет фронтенда 1.52 получает автосокет (`getWidgetConfig`, проверено в бандле) — убраны `dropAutoSockets`, остались `source` + `image`. Зафиксировано в скиле `comfyui-cycle-guard`.
- Скрытие multiline не работает на 1.52 — убраны плашка/`prompt_height`/скрытия; высота окна фиксирована CSS (`fixTextarea`).
- Фантом: сконвертированный во вход виджет из старых workflow — лечится пересозданием ноды.
- Процессный провал: «готово» заявлялось без скрина-подтверждения. Правило: вердикт только по скрину пользователя.

## 4. Что важно не сломать при продолжении работы

- Порядок `widgets_values` в патче = порядок INPUT_TYPES.
- Удаление категории НЕ теряет книги (переезд в корень) — спека §4.2.
- Внутреннее поле `folder` в базе/API не переименовывать (данные пользователя).
- `D:\ComfyUI_windows_portable_old\` — архив, не трогать и не синкать туда.
- Рабочий процесс: исходник → `python sync.py Prompt_Library` → рестарт + Ctrl+F5 + пересоздать ноду.
- gh-аккаунт: `vycheslav-iv` (было `Degg254` в кэше hosts.yml — исправлено); `git config user.name` — `vycheslav-iv`.

## 5. Следующие шаги (идеи, не сделано)

- Дождаться вердикта пользователя по свежей сборке (одно окно + source).
- Экспорт/импорт базы (JSON/TXT).
- Теги отдельно от категорий (если понадобится).
- Виртуализация списка при >200 записей.
- Английская локализация `locales/en/nodeDefs.json`.

## 6. Связанные файлы

- `F:\AI_projects\Custom_node_ComfyUI\Prompt_Library\SPECIFICATION.md`
- `F:\AI_projects\Custom_node_ComfyUI\Prompt_Library\README.md`
- `F:\AI_projects\Custom_node_ComfyUI\AGENTS.md` (таблица §6.1)
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
- Скил: `comfyui-cycle-guard` (автосокеты + живучесть при обновлениях)
