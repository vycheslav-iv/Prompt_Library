# Память сессии — Prompt Library (2026-09-14, пауза)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md` (включая §17 — договорённый план).

---

## 1. Что делали в этой сессии (кратко)

- Долгая доводка размещения ноды по скринам. Итог: убраны ВСЕ подпорки
  (CSS-инъекции, таймеры, наблюдатели, скрытия, подгонки под ресайз).
  Осталось: голова текста в окне при проводе, фиксированные списки 320px,
  fitNode, мин. ширина 470, dropAutoSockets, сторож цикла.
- Зафиксировано в спеке (§17) + коммит `146f087` + пуш. Пауза по решению пользователя.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `PromptLibrary` (prompt/mode/selected/save_folder + optional source/image; `OUTPUT_NODE=True`; `VALIDATE_INPUTS` для `*`).
- `execute()`: incoming = source ?? prompt; выдача обновляет `last_used`; автосейв с дедупом; патч `[display, mode, selected, save_folder]`.
- Endpoints: `list/entry/preview/add/favorite/update/delete/folder_create/folder_rename/folder_delete`.
- База: `ComfyUI/user/prompt_library/library.json` (`{entries, folders}`) + `previews/` 512px/LANCZOS/q90.
- `web/js/prompt_library.js` — дерево категорий (список слева, дерево справа), виды 163/109/82, DnD, панель книги (копировать/переименовать/редактировать), `💾 Сохранить`, MODE, сторож цикла. Без костылей размещения.
- Репозиторий: `https://github.com/vycheslav-iv/Prompt_Library.git`, master чист (5 коммитов).

## 3. Проблемы, которые встречались (и как решали)

- Фронтенд 1.52.7 игнорирует `computeSize`/`hidden` у multiline; каждому виджету даёт автосокет (`getWidgetConfig` — проверено в бандле). Отсюда: `dropAutoSockets`, отказ от скрытий.
- Подгонка списков под ресайз + автофит фронтенда = бесконечное вытягивание вниз. Удалена.
- CSS-класс с условием `>=1` однажды лёг на общий корень и ужав все ноды. Правило: условия только строгие, глобального ничего.
- Процессный урок: «готово» только по скрину пользователя; Unverified claims подорвали доверие — восстанавливать делом.

## 4. Что важно не сломать при продолжении работы

- Порядок `widgets_values` = порядок INPUT_TYPES.
- Удаление категории НЕ теряет книги (переезд в корень).
- Внутреннее поле `folder` не переименовывать.
- `D:\ComfyUI_windows_portable_old\` — архив, не трогать.
- Исходник → `python sync.py Prompt_Library` → рестарт + Ctrl+F5 + пересоздать ноду.
- gh: `vycheslav-iv`; запрещено: PowerShell, `rm -rf .git`, `git init` в корне бандла.

## 5. Следующие шаги (договорено, §17 спеки)

1. Разбить на две ноды: **Prompt Library** (без IMAGE-входа) + **Prompt Saver** (prompt + image, дописывает превью).
2. Постраничность списка (~20 записей, дальше/назад).
3. Никаких подпираний размеров кодом.

## 6. Связанные файлы

- `F:\AI_projects\Custom_node_ComfyUI\Prompt_Library\SPECIFICATION.md`
- `F:\AI_projects\Custom_node_ComfyUI\Prompt_Library\README.md`
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
- Скил: `comfyui-cycle-guard` (автосокеты + живучесть)
