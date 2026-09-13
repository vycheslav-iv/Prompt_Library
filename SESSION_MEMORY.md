# Память сессии — Prompt Library (2026-09-14)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Спроектировали и реализовали ноду Prompt Library (продолжение Prompt Keeper): автосохранение промптов с превью, проводник с папками, имена записей, поиск/сортировка/виды, выдача в CLIP.
- Прошли 4 итерации правок по скринам пользователя (source-вход, превью 96→192, панель книги, фикс высоты окна, кнопка сохранения, проводник).
- Обновили SPECIFICATION.md/README.md, создали GitHub-репозиторий и запушили.

## 2. Итоговое состояние кода

- `prompt_library_node.py:87` — `PromptLibrary` (INPUT_TYPES: prompt/folder/auto_save/use_selected/prompt_height/selected + optional source/IMAGE; `OUTPUT_NODE=True`).
- `prompt_library_node.py:117` — `execute()`: source приоритетнее виджета; выдача обновляет `last_used`; автосейв с дедупом по hash(prompt+folder); `extra_pnginfo`-патч `[display, folder, auto_save, use_selected, prompt_height, selected]`.
- `prompt_library_node.py:184` — endpoints: `list/entry/preview/add/favorite/update/delete/folder_create/folder_rename/folder_delete`.
- `prompt_library_node.py:36` — `_load_db/_save_db`: формат `{entries, folders}`, миграция legacy-списка и `category→folder`, авто-title.
- `web/js/prompt_library.js:9` — DOM: плашка входящего, поиск+сортировка+вид, дерево полок, сетка/список, панель книги (копировать/редактировать), кнопка `💾 Сохранить` после `folder`, `prompt_height` через `computeSize`.
- База рантайма: `ComfyUI/user/prompt_library/library.json` + `previews/` (не в репозитории).
- Репозиторий: `https://github.com/vycheslav-iv/Prompt_Library.git` (ветка master, чисто).

## 3. Проблемы, которые встречались (и как решали)

- Провод IMAGE из даунстрима + выход в CLIP = цикл в графе. Решение: две копии ноды с общей базой (выдача до CLIP без IMAGE; сейвер после картинки, выход никуда). Зафиксировано в README.
- Нативное окно промпта раздувало ноду. Решение: `prompt_height` + переопределение `computeSize` (сериализация не страдает, только размер).
- Провод в виджет прятал окно. Решение: отдельный вход `source` (ANY), окно показывает входящий текст через `onExecuted`.
- Переименование виджета `category→folder`: старые workflow маппятся по индексу + `**kwargs` в `execute()`.

## 4. Что важно не сломать при продолжении работы

- Порядок `widgets_values` в патче = порядок INPUT_TYPES (`prompt_library_node.py:164`).
- `computeSize`-оверрайды виджетов только меняют размер, не видимость/сериализацию.
- Удаление папки НЕ должно терять книги (сейчас: переезд в корень) — поведение зафиксировано в спеке §4.2.
- Рабочий процесс: правим исходник `F:\AI_projects\Custom_node_ComfyUI\Prompt_Library\` → `python sync.py Prompt_Library` → перезапуск ComfyUI.
- Корень бандла — не репозиторий; память только здесь (где `.git`).

## 5. Следующие шаги (идеи, не сделано)

- Экспорт/импорт базы (JSON/TXT).
- Теги отдельно от папок (если полок станет мало).
- Виртуализация списка при >200 записей (сейчас UI-пакет режется на 200).
- Английская локализация `locales/en/nodeDefs.json` (сейчас только ru).

## 6. Связанные файлы

- `F:\AI_projects\Custom_node_ComfyUI\Prompt_Library\SPECIFICATION.md`
- `F:\AI_projects\Custom_node_ComfyUI\Prompt_Library\README.md`
- `F:\AI_projects\Custom_node_ComfyUI\AGENTS.md` (таблица репозиториев §6.1)
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
