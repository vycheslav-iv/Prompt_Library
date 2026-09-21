# Память сессии — Prompt Library (v1.44, 2026-09-22)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- **v1.44: мультивывод — 10 дополнительных STRING-выходов (слоты 2..11)** через
  виртуальную категорию **«🔌 Выходы»** в проводнике (после «★ Избранное»,
  `folderOrder: ["__all","__fav","__outs","__root"]`).
  - Python: `RETURN_TYPES=("STRING",)*12`, `RETURN_NAMES` (первые два `prompt_out`,
    `category_out`), скрытый виджет `slots_out` (JSON массив привязок),
    `_parse_slots`, эмит `slot_texts` (пустой → `""`, нет записи → `"(запись удалена)"`),
    PNG-патч 5-й элемент `widgets_values[4]` + `widgets_values_named.slots_out`.
  - JS: `slots_out` скрыт в `onNodeCreated`; `st.slotsOut` + хелперы
    (`readOutSlots`/`writeOutSlots`/`nextOutSlot`/`outSlotBy`/`outSlotOfEntry`/
    `outSlotOfFolder`/`applyOutSockets`/`folderActOf`/`bindOutSlot`/`unbindOutSlot`);
    `plDrop` → `__outs` создаёт слот (дубль игнорируется, 10 занято → toast);
    папка-слот наследует выделение как `active_id`, клик по карточке внутри папки
    перезаписывает `active_id` (cache-key меняется → перепрогон);
    рендер «🔌 Выходы»: строки слотов с 🔌, именем, ✖ отвязкой; битая привязка →
    «(запись удалена)».
    Карточка-слот в обычном списке — маркер 🔌 в title, фон `#1c3525`, рамка
    `#2e6b4f` (активная папка-слот — то же).
    PNG-гидрация в `onConfigure` из `named.slots_out` или позиционного
    `widgets_values[4]`; `applyOutSockets` показывает/прячет сокеты 2..11,
    задаёт имена проводов (обрезка 16).
  - Тесты: Python 330/330 (песочница), JS смоук 90/90 (6 фаз мультивывода:
    bind/drop/click/unbind/full-warn/hydration), аудит чист.
  - SPEC §40: статус ✅ реализовано, хроника 36 обновлена.
  - `check.py --strict`: зелёное, sync выполнен, push в origin/master.
- **v1.43: `category_out` сохраняет пробелы** — `_sanitize_folder_path` больше не
  заменяет пробел на `_` (`"Мои Пейзажи"` → `"Мои Пейзажи/"`). Спецсимволы `&`, `!`,
  служебные ветки `__*` по-прежнему чистятся/`""`. JS-экспорт не тронут.
  Тесты 316/316, check.py зелёный, sync выполнен.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `RETURN_TYPES=("STRING",)*12`, `RETURN_NAMES` (первые
  два `prompt_out`, `category_out`), `slots_out` в `INPUT_TYPES` required,
  `_parse_slots`, эмит `slot_texts`, PNG-патч 5-й элемент.
- `web/js/prompt_library.js` — категория «🔌 Выходы» в проводнике, `st.slotsOut`,
  хелперы слотов, `plDrop`→`__outs`, `applyOutSockets` (hide/show сокетов 2..11),
  `folderActOf` (активный вывод папки-слота), маркер 🔌/зелёная подсветка карточки,
  гидрация `slots_out` в `onConfigure`.
- Важное в JS: `st.plDrop` (подписка на дропы, смотрит `curFolder`/`__fav`),
  `st.exportFolder` виртуальные ветки, валидация `save_folder` с `__fav/__root/__all`,
  `st.syncSaveFolder`, `markEntries`/`markFolders`/цвета, виджеты
  `selected/save_folder/pickup`.

## 3. Проблемы, которые встречались (и как решали)

- **`ModuleNotFoundError: websockets`** на системном `python` — живые DOM-пробы гонять
  ТОЛЬКО под `D:/ComfyUI_windows_portable/python_embeded/python.exe` (SPEC §34.2).
- **«Пустая категория = мусор» — ложная находка**: «Пейзажи» ветвится подпапкой
  «Аляска». Перед выводом «мусор» смотреть подпапки дерева.
- **python_embeded крашит консоль при деплое ws** — не трогать запуск probe-скриптов
  поверх системного python.
- Консоль cp1251 искажает кириллицу в выводе — вывод проверок читать внимательно.
- **JS bug: папка-слот `active_id` не обновлялся** — `writeOutSlots` перечитывал
  виджет, теряя мутацию. Лечение: читать массив один раз, мутировать его, писать тот
  же массив (`st.readOutSlots()` → `arr.find` → `arr[i].active_id = ...` →
  `st.writeOutSlots(arr)`).
- **JS bug: гидрация `onConfigure` — rAF не успевал** — проверки в смоуке шли до
  `flushRaf`. Лечение: после `onConfigure` вызывать `st.applyOutSockets()`
  синхронно в тесте (в проде rAF работает корректно).

## 4. Что важно не сломать при продолжении работы

- Слоты 0–1 (`prompt_out`, `category_out`) и вся логика `execute()`/
  `_sanitize_folder_path` НЕ трогаются.
- НЕ возвращать проверку `mode` в `IS_CHANGED` (§33.3).
- Замена превью обязана переносить граф; `_trim_entries`/удаление убирают и граф,
  и превью.
- Тесты только в `tests/`, в рабочую копию не копируются (AGENTS.md §1.1).
- Скил comfyui-expandable-inputs — паттерн добавления/скрытия сокетов, но выходы
  (в отличие от входов) требуют фиксированной длины `RETURN_TYPES` — только
  hide/show.
- Иконка категории выходов — **🔌** (не 📤, не 📥), `folderOrder` после «★
  Избранное».
- `IS_CHANGED` не смотрит на `slots_out` (смена содержимого слота = смена
  cache-key через виджет → перепрогон).

## 5. Следующие шаги (идеи, не сделано)

1. Живьём: самолечение дубля — подхват текста, уже существующего карточкой без графа.
2. Посмотреть кандидатов на скил после реализации (слоты выхода — паттерн для
   других нод); спросить пользователя перед созданием.
3. Масштабирование базы при 500+ записях — SQLite (обсуждено, не делали).

## 6. Связанные файлы

- `prompt_library_node.py` — `_sanitize_folder_path` (`:186`, v1.43),
  `RETURN_TYPES`/`RETURN_NAMES` (~`:805`), `execute` (`:1071` — `result`),
  `IS_CHANGED` (`:800`), `_parse_slots`, `slot_texts`.
- `web/js/prompt_library.js` — `plDrop` (`:1440-1463`), `exportFolder`
  (`:2374-2394`), валидация `save_folder` (`:2795-2834`), `syncSaveFolder`
  (`:1042`), `markEntries`, мультивывод helpers (`:1060-1145`),
  `renderTree`/`render` «🔌 Выходы» (`:1731-1870`), `card.onclick` (`:2008-2036`).
- `SPECIFICATION.md` — v1.44 (шапка, хроника 36), **§40 мультивывод** (реализован).
- `tests/_test_prompt_library.py` — 330/330; `tests/_smoke_prompt_library.mjs` — 90/90;
  `tests/_audit_prompt_library.mjs`.
- `tests/_probe_live_cache.py`, `tests/_probe_live_library.py`,
  `tests/_probe_live_dom.py`.
- `check.json` — `python _process/check.py Prompt_Library [--strict]`
- `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library` — рабочая копия
- Воркфлоу «Krea2_MY2» (в библиотеке ComfyUI): нода 1619 `OllamaGenerateV2`
  (system/prompt), 1618 System Prompt, 1919 Prompt, 1677 сабграф MASTER STYLE +
  1676 DeggSwitch
- `SESSION_MEMORY-history/2026-09-22-0144-v1.43.md` — снапшот этого файла (до v1.44)