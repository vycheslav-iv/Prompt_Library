# Память сессии — Prompt Library (2026-09-17, Vue-растяжение контента)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Починили ноду: в незакоммиченных Vue-правках были **потеряны два блока** — `const st = {…}`
  и определение `dropAutoSockets` → `TypeError`/`ReferenceError` при добавлении ноды.
- По решению пользователя **откатились до `aa98777`** (копия отброшенных правок —
  `Custom_node_ComfyUI/Prompt_Library_js_workingtree_2026-09-17.bak`, вне репозитория).
- Заново сделали **растяжение контента в Nodes 2.0**, но уже **только для Vue-ветки**,
  не трогая canvas. Пользователь проверил живьём: работает в обоих режимах.
- Попутно удалена тупиковая авто-подгонка высоты (`autoFitHeight`, `calibrateFloor`, `_vueFloor`).

## 2. Итоговое состояние кода

- `web/js/prompt_library.js:363` — `st.applyPaneLayout()` — **ключевое место**. Vue-ветка:
  `main` `flex:1 1 0`+`min-height:0`, `tree`/`listContent` `flex:1 1 0`+`min-height:0`+`height:""`,
  `main`+`detail` переезжают в `scrollArea` (`flex:1 1 0`, `min-height:0`, `overflow-y:auto`),
  `root` — `overflow:hidden`. Canvas-ветка — ровно как было (main/detail прямые дети root, пол 480px).
- `web/js/prompt_library.js:230` — `scrollArea` создаётся сразу, но подключается только в Vue.
- `web/js/prompt_library.js:1000` — `browserWidget.computeLayoutSize()` — единый
  `{minHeight: st.minH(), minWidth: MIN_W}` для обоих режимов; `maxHeight` НЕ задаётся.
- `web/js/prompt_library.js:987` — `st.minH()` = `BASE_H + DETAIL_H + INPUT_H` по boolean-стейту.
- `web/js/prompt_library.js:330` — `st.isVueNodes()` — детект только через
  `app.extensionManager.setting.get("Comfy.VueNodes.Enabled")`.
- `web/js/prompt_library.js:912` — `st.dropAutoSockets()` — снимает автосокеты `selected`/`save_folder`.
- `_smoke_prompt_library.mjs` (в корне бандла, вне репозитория) — смоук-тест: 42 фазы,
  canvas + Vue, проверка flex-цепочки. **Гонять перед каждым синком.**

## 3. Проблемы, которые встречались (и как решали)

- `st.dropAutoSockets is not a function` + `st is not defined` — в незакоммиченной правке
  потеряны определение функции и объявление `const st` — восстановили (они были целы в `aa98777`).
- «В Vue контент не тянется за нодой» — **причина найдена в исходниках фронтенда**:
  `applyPaneLayout` пинил `main flex:none` и панели на 480px. Цепочка высоты в Vue
  на самом деле есть (см. §22.9 SPEC): `hasLayoutSize = typeof widget.computeLayoutSize
  === "function"` → `gridTemplateRows: auto` → контейнер виджетов `flex:1` → `WidgetDOM`
  (`flex flex-col *:flex-1`) отдаёт `root` через `flex:1`.
- Ломало канвас в прежней попытке: `computeLayoutSize` возвращал `Math.max(this.size[1], …)`
  и `minH()` был сведён к BASE_H. Вывод: **не менять canvas-ветку**.

## 4. Что важно не сломать при продолжении работы

- **Canvas-ветка `applyPaneLayout` и `computeLayoutSize`** — проверены живьём (§22.4), не трогать.
- Порядок INPUT_TYPES `[mode, selected, save_folder]` (от него зависят позиционный фолбэк и
  `widgets_values`); `widget.serialize = false` свойством; ноль `setTimeout` в restore.
- Не возвращать `autoFitHeight`/`calibrateFloor`/`_vueFloor`: first-measurement self-lock
  (SPEC §22.8/§22.9). В Vue `root` растянут → `offsetHeight` = высота ноды, а не контент.
- Синк: `python sync.py Prompt_Library` → `D:\ComfyUI_windows_portable\...` → **Ctrl+F5**
  (JS-правки не требуют рестарта сервера) → при странностях пересоздать ноду.

## 5. Следующие шаги (идеи, не сделано)

1. **Vue: нода сжимается «в ноль»** (SPEC §22.10 п.1) — `min-height:0`+`flex:1 1 0` нет пола,
   панели исчезают. Нужен пол, совместимый со скроллом.
2. **Переключение canvas ↔ Vue на лету** (SPEC §22.10 п.2) — раскладка не переприменяется,
   контент вылезает за ноду; подписка висит на `app.ui.settings` вместо `extensionManager.setting`.
3. SPLIT на две ноды (Prompt Library + Prompt Saver); постраничность (~20 записей).

## 6. Связанные файлы

- `web/js/prompt_library.js` — нода (JS-расширение).
- `SPECIFICATION.md` — **§22.9** (факты из фронтенда + решение), **§22.10** (открытые проблемы),
  §22.4/§22.6 (canvas-путь и упразднённое решение про 480px).
- `.bak` в корне бандла — отброшенные Vue-правки (можно удалить после закрытия §22.10).
- Исходники фронтенда: `D:\ComfyUI_windows_portable\python_embeded\Lib\site-packages\comfyui_frontend_package\static\assets\settingStore-*.js` + `.js.map` (в `.map` лежит `sourcesContent` — читать код как есть).
