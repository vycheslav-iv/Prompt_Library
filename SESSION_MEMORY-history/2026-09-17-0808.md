# Память сессии — Prompt Library (2026-09-17, v1.15: Vue fixes + audit)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Закоммичили и запушили v1.15: Vue-фиксы §22.10 (пол 480px, смена режима без F5,
  «сжатая» новая нода) + аудит §25.2 (битый `library.json`, вечный repaint).
- Обновили SPECIFICATION.md до v1.15 (версия, хроника §17).
- Проверены: 66/66 Python, 45 фаз смоук, аудит чист.

## 2. Итоговое состояние кода

- `web/js/prompt_library.js:52` — `PL_JS_VERSION = "1.15-vue-floor480"`
- `web/js/prompt_library.js:27-50` — `plModeWatchers` + `plHookVueMode()` — перехват
  `window.LiteGraph.vueNodesMode` (обёртка accessor'ом один раз на страницу)
- `web/js/prompt_library.js:94` — `PANES_MIN_H = 480` — единый пол высоты для обоих режимов
- `web/js/prompt_library.js:374` — `st.isVueNodes()` — сначала `LiteGraph.vueNodesMode`,
  затем `extensionManager.setting.get`, затем `ui.settings.getSettingValue`
- `web/js/prompt_library.js:411` — `st.applyPaneLayout(forceVue)` — общая раскладка
- `web/js/prompt_library.js:483-501` — `st.onModeChange` + `settleLayout()` (2 кадра rAF)
- `web/js/prompt_library.js:889` — догоняющая сверка режима в `render()`
- `web/js/prompt_library.js:992` — `st.dropAutoSockets()`; `:273` — `scrollArea`
- `prompt_library_node.py:77-90` — `_load_db()` устойчив к битому `library.json`

## 3. Проблемы, которые встречались (и как решали)

- «В Vue ноду можно сжать в ноль» — `min-height:0` у панелей убирал пол;
  вернули `PANES_MIN_H=480` на `scrollArea` (§22.10)
- «Смена режима без F5 не применяет раскладку» — перехват `LiteGraph.vueNodesMode`
  через `Object.defineProperty` + `plModeWatchers` (§22.10)
- «Новая нода открывается сжатой в Vue» — `settleLayout()` с одним rAF
  после монтирования Vue-ноды (§22.11)
- Вечный repaint канваса — `checkCycle` из `onDrawForeground` безусловно
  метил canvas грязным; исправлено: `setDirtyCanvas` только при смене состояния (§25.2)
- Битый `library.json` ронял всё — `_load_db()` теперь отбрасывает не-словари
  и не-строки (§25.2)

## 4. Что важно не сломать при продолжении работы

- **Canvas-ветку `applyPaneLayout` и `computeLayoutSize`** — проверены живьём (§22.4)
- Порядок INPUT_TYPES `[mode, selected, save_folder]`; `widget.serialize = false` свойством
- Не возвращать `autoFitHeight`/`calibrateFloor`/`_vueFloor`
- Не перезаписывать `this.computeSize` на ноде
- Синк: `python sync.py Prompt_Library` → `D:\ComfyUI_windows_portable\...` → **Ctrl+F5**

## 5. Следующие шаги (идеи, не сделано)

1. **Вынести воркфлоу из `library.json`** (главный риск §25.3): `workflows/{id}.json`
   или SQLite; сейчас 2.9 МБ / 92 записи (6 воркфлоу = 1.72 МБ), лимит — 500 записей
2. Разбить на две ноды: **Prompt Library** + **Prompt Saver**
3. Постраничность списка (~20 записей)

## 6. Связанные файлы

- `web/js/prompt_library.js` — нода (JS-расширение, v1.15)
- `prompt_library_node.py` — Python-нода
- `SPECIFICATION.md` — §22.9 (Vue facts), §22.10 (PANES_MIN_H + live switch),
  §22.11 (narrow node fix), §25 (audit: broken JSON + repaint)
- `_smoke_prompt_library.mjs` — смоук-тест JS (45 фаз)
- `_test_prompt_library.py` — Python-тест (66 проверок)
- `_audit_prompt_library.mjs` — аудит связности
