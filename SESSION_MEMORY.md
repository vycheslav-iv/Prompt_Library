# Память сессии — Prompt Library (2026-09-17, v1.10: воркфлоу в карточке)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.10: карточка несёт воркфлоу (PNG-превью с чанком + снапшот в записи, compact-JSON, кап 2МБ); drag на канвас и кнопка 📥 через confirm → `loadGraphData`; lazy-превью (без базы, стабильный кэш, 304). Всё проверено живьём, запушено.
- Полный аудит проекта: пойманы 3 своих же огреха (отступ `dirty`, флаг хука, stale `st.full`), вычищены устаревшие места в скиллах.

## 2. Итоговое состояние кода

- `prompt_library_node.py:216-254` — `_snapshot_workflow` (compact, кап), `_add_entry(..., workflow)`, PNG-превью 512px с workflow.
- `prompt_library_node.py:167-197,204-213` — `_upgrade_preview_to_png` (one-time JPG→PNG), `_preview_path` (без базы, png→jpg).
- `prompt_library_node.py:314-341` — `execute()`: захват + backfill + `dirty` всегда при `added`; guard `__*` → корень.
- `web/js/prompt_library.js:247-312` — `openWorkflow` (confirm → loadGraphData), `hookCanvasDrop` (capture, custom MIME, once-флаг после подписок).
- `web/js/prompt_library.js:774-790,822-875` — `computeLayoutSize` (минимумы); `onConfigure(info)` sync-restore + reconcile, ноль polling.
- `SPECIFICATION.md` v1.10 (§22 stretch, §23 restore, §24 workflow; §21.5 — архив).

## 3. Проблемы, которые встречались (и как решали)

- Пустота снизу — legacy `computeSize` = точная высота → `computeLayoutSize` (§22).
- Мёртвый патч (`prompt` + `except`) → `[mode, selected, save_folder]` (§22.5).
- Папка опаздывала → sync из `info`, retry удалён (§23); `__fav`/`__root` не персистились → round-trip + guard (§23.4).
- 🚫 при drag на канвас — `dropEffect=copy` вне `effectAllowed=move` → `copyMove`.
- Headless-тесты врали дважды (мутация эталона патчем; поддельный hash) — эталон копировать, hash считать.

## 4. Что важно не сломать при продолжении работы

- Не задавать `browserWidget.computeSize`; sizing — только boolean-стейт, никаких `offsetHeight`/`scrollHeight`.
- Порядок INPUT_TYPES `[mode, selected, save_folder]` — позиционный фолбэк `[2]`, `widgets_values`.
- `widget.serialize = false` свойством; ноль `setTimeout` в restore; префикс `__` зарезервирован.
- Тяжёлое (`workflow`) — никогда в `/list` (только флаг `has_workflow`); превью отдавать без базы.
- При удалении виджетов grep'ать имя везде (голый `except` прячет регрессии).

## 5. Следующие шаги (идеи, не сделано)

1. **SPLIT на две ноды**: Prompt Library + Prompt Saver.
2. **Постраничность** (~20 записей) + разгрузка хранения перед поднятием лимита 500 (с workflow вес вырос).
3. Предложен новый скилл «PNG с workflow внутри» — ждёт решения пользователя.

## 6. Связанные файлы

- `prompt_library.js` / `prompt_library_node.py` — код ноды (v1.10).
- `SPECIFICATION.md` v1.10, `README.md` — доки.
- `comfyui-dom-widget-sizing`, `comfyui-js-extension` (+ `.kilo`, `.agents` копии) — скиллы.
- `SESSION_MEMORY-history/2026-09-17*.md` — снапшоты памяти.
