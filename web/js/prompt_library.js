const { app } = window.comfyAPI.app;

// Лёгкая проекция серверной записи для списка
function plMap(e) {
    return {
        id: e.id,
        title: e.title || "",
        head: (e.prompt || "").slice(0, 120),
        folder: e.folder || "",
        favorite: !!e.favorite,
        created_at: e.created_at || "",
        last_used: e.last_used || null,
        has_preview: !!e.preview,
        has_workflow: !!e.has_workflow,
        media: e.media || null, // 'video' / 'image' / null (старые записи — неизвестно)
    };
}

// Бейдж типа записи: только текст, раскладку не трогает
function plBadge(e) {
    return e.media === "video" ? "🎬 " : e.media === "image" ? "📷 " : "";
}

// --- Синхронизация Library-нод одной страницы -------------------------------
// WS-сигнал (§26) ходит кругом через сервер и доходит до соседней ноды с
// задержкой; пока он идёт, второй экземпляр ноды показывает устаревший список —
// удалённые карточки и папки «остаются». Держим реестр живых нод и после любой
// мутации (POST) перечитываем базу у всех, кроме инициатора — он обновляет себя
// сам. Никаких таймеров и наблюдателей: только вызовы из хендлеров (st.apiPost).
const plLiveStates = new Set();

function plRefreshLocal(except) {
    for (const s of [...plLiveStates]) {
        if (s === except) continue;
        try { s.reload?.(); } catch (e) { /* silent */ }
    }
}

// --- Смена режима рендера (canvas ↔ Nodes 2.0) без перезагрузки страницы ------
// Настройка `Comfy.VueNodes.Enabled` превращается фронтендом в авторитетный флаг
// `LiteGraph.vueNodesMode` (useVueFeatureFlags: watch → LiteGraph.vueNodesMode),
// а сам LiteGraph виден расширению как `window.LiteGraph` (useGlobalLitegraph).
// Событие настроек — только второй путь (scripts/ui/settings.ts: dispatchChange
// шлёт CustomEvent `<id>.change` на app.ui.settings); он есть не везде.
// Оборачиваем свойство accessor'ом один раз на страницу и раздаём сигнал нодам.
// Если обёртка не удалась — код молча живёт на событии настроек и на сверке
// в render() (нода обязана работать без любых обходных путей).
const plModeWatchers = new Set();
let plModeHooked = false;
function plHookVueMode() {
    if (plModeHooked) return;
    try {
        const lg = window.LiteGraph;
        if (!lg || typeof lg.vueNodesMode !== "boolean") return;
        let current = lg.vueNodesMode;
        Object.defineProperty(lg, "vueNodesMode", {
            configurable: true,
            enumerable: true,
            get: () => current,
            set: (v) => {
                current = !!v;
                for (const fn of plModeWatchers) {
                    try { fn(current); } catch (e) { /* silent */ }
                }
            },
        });
        plModeHooked = true;
    } catch (e) { /* silent */ }
}

// Маркер сборки: виден в F12 → Console. Нужен, чтобы точно знать, какая версия JS
// реально загружена браузером (файл статичный: после правки исходника нужен Ctrl+F5).
const PL_JS_VERSION = "1.23-panes-fit";
console.log(`[PromptLibrary] JS ${PL_JS_VERSION} loaded`);

app.registerExtension({
    name: "PromptLibrary",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptLibrary") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = origOnNodeCreated?.apply(this, arguments);

            // Скрыть технические selected/save_folder (ими управляет дерево и список)
            const selWidget = this.widgets?.find((w) => w.name === "selected");
            if (selWidget) {
                selWidget.hidden = true;
                selWidget.computeSize = () => [0, -4];
            }
            const saveFolderW = this.widgets?.find((w) => w.name === "save_folder");
            if (saveFolderW) {
                saveFolderW.hidden = true;
                saveFolderW.computeSize = () => [0, -4];
            }


            // --- DOM: библиотека ---
            // Растяжение вниз: root заполняет высоту виджета (wrapper фронтенда —
            // flex column с *:flex-1, высота виджета = computedHeight из layout),
            // main забирает свободное место (flex:1), listContent/tree тянутся
            // внутри (flex:1 + min-height floor). Без ресайза вид как раньше.
            const root = document.createElement("div");
            root.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:400px;height:100%;";
            // Ноду нельзя сжать уже контента, иначе дерево вылезает за границу.
            // (Само присвоение — ниже, после this._pl = st, иначе TDZ-ошибка.)
            const MIN_W = 470;
            // Пол высоты панелей (список+дерево) — ОДИН для обоих режимов.
            //  • В Vue высоту ноды задаёт МИНИМАЛЬНАЯ высота контента
            //    (measureMinContentHeight), а пол внутри `overflow-y:auto` в этот
            //    замер не попадает (содержимое скролл-контейнера не расширяет
            //    родителя) — поэтому в Vue пол стоит на самом scrollArea,
            //    см. applyPaneLayout. Маленькое значение (280) позволяло сжать
            //    ноду почти в ноль — теперь как в канвасе (480).
            const PANES_MIN_H = 480;

            // Тулбар: вид → порядок → поиск (название + текст)
            const toolbar = document.createElement("div");
            toolbar.style.cssText = "display:flex;gap:6px;";
            const search = document.createElement("input");
            search.placeholder = "Поиск по названию и тексту...";
            search.style.cssText = "flex:1;min-width:0;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 6px;";
            const sortSel = document.createElement("select");
            sortSel.title = "Порядок категории";
            sortSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;max-width:150px;";
            sortSel.innerHTML = `
                <option value="new">Сначала новые</option>
                <option value="title">По названию А–Я</option>
                <option value="old">Сначала старые</option>
                <option value="used">Недавно выданные</option>`;
            // Режимы вида как в проводнике Windows
            const viewSel = document.createElement("select");
            viewSel.title = "Вид списка";
            viewSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;max-width:130px;";
            viewSel.innerHTML = `
                <option value="large">📷 Крупные</option>
                <option value="medium">🎞 Средние</option>
                <option value="list">📋 Список</option>`;
            try {
                const savedView = localStorage.getItem("promptLibrary.view");
                if (savedView) viewSel.value = savedView;
            } catch (e) { /* silent */ }
            if (!["large", "medium", "list"].includes(viewSel.value)) viewSel.value = "large";
            // Фильтр типа: все / только фото / только видео (записи без метки видны только во «Все»)
            const mediaSel = document.createElement("select");
            mediaSel.title = "Тип записей";
            mediaSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;max-width:110px;";
            mediaSel.innerHTML = `
                <option value="all">Всё</option>
                <option value="image">📷 Фото</option>
                <option value="video">🎬 Видео</option>`;
            try {
                const savedMedia = localStorage.getItem("promptLibrary.media");
                if (savedMedia) mediaSel.value = savedMedia;
            } catch (e) { /* silent */ }
            if (!["all", "image", "video"].includes(mediaSel.value)) mediaSel.value = "all";
            toolbar.appendChild(viewSel);
            toolbar.appendChild(sortSel);
            toolbar.appendChild(mediaSel);
            toolbar.appendChild(search);
            // Видимая версия сборки прямо в интерфейсе: по скриншоту всегда
            // понятно, какой JS исполняется (споры «у тебя старый файл» закрыты).
            const verTag = document.createElement("span");
            verTag.textContent = "v" + PL_JS_VERSION;
            verTag.title = "Версия JS-расширения (должна совпадать с консолью F12)";
            verTag.style.cssText = "color:#555;font-size:10px;flex-shrink:0;align-self:center;white-space:nowrap;";
            toolbar.appendChild(verTag);

            // Кнопка-тогл ручного ввода + область ввода
            const inputToggle = document.createElement("button");
            inputToggle.textContent = "➕ Добавить промпт";
            inputToggle.title = "Показать/скрыть окно ручного ввода промпта";
            inputToggle.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;flex-shrink:0;";

            const inputArea = document.createElement("div");
            inputArea.style.cssText = "display:none;flex-direction:column;gap:4px;border:1px solid #4a9eff;border-radius:4px;padding:6px;background:#16202f;";
            const inputText = document.createElement("textarea");
            inputText.rows = 4;
            inputText.placeholder = "Введите промпт...";
            inputText.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px;font-size:11px;resize:vertical;max-height:300px;overflow-y:auto;";
            const inputSaveBtn = document.createElement("button");
            inputSaveBtn.textContent = "💾 Сохранить промпт";
            inputSaveBtn.title = "Сохранить в текущую категорию";
            inputSaveBtn.style.cssText = "width:100%;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:5px;cursor:pointer;font-size:12px;";
            inputArea.appendChild(inputText);
            // Ручное превью с диска (без провода): файл → даунскейл до 512px
            // через canvas прямо в браузере → маленький PNG dataURL на сервер.
            const inputAttachRow = document.createElement("div");
            inputAttachRow.style.cssText = "display:flex;gap:4px;align-items:center;";
            const inputFile = document.createElement("input");
            inputFile.type = "file";
            inputFile.accept = "image/*";
            inputFile.style.display = "none";
            const attachBtn = document.createElement("button");
            attachBtn.type = "button";
            attachBtn.title = "Выбрать картинку с диска как превью записи";
            attachBtn.style.cssText = "flex:1;min-width:0;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:5px;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            const attachThumb = document.createElement("img");
            attachThumb.style.cssText = "width:40px;height:40px;object-fit:cover;border-radius:3px;background:#222;display:none;flex-shrink:0;";
            const attachClear = document.createElement("button");
            attachClear.type = "button";
            attachClear.textContent = "✖";
            attachClear.title = "Убрать прикреплённое превью";
            attachClear.style.cssText = "display:none;background:none;border:none;cursor:pointer;font-size:12px;flex-shrink:0;";
            let attachedFile = null;
            const renderAttach = () => {
                attachBtn.textContent = attachedFile ? `📷 ${attachedFile.name}` : "📷 Прикрепить превью";
                attachThumb.style.display = "none";
                attachClear.style.display = attachedFile ? "" : "none";
                if (attachedFile) {
                    try {
                        const url = URL.createObjectURL(attachedFile);
                        attachThumb.src = url;
                        attachThumb.style.display = "";
                        attachThumb.onload = () => { try { URL.revokeObjectURL(url); } catch (e) { /* silent */ } };
                    } catch (e) { /* silent */ }
                }
            };
            attachBtn.onclick = () => { try { inputFile.click(); } catch (e) { /* silent */ } };
            inputFile.onchange = () => {
                attachedFile = (inputFile.files && inputFile.files[0]) || null;
                renderAttach();
            };
            attachClear.onclick = () => {
                attachedFile = null;
                try { inputFile.value = ""; } catch (e) { /* silent */ }
                renderAttach();
            };
            inputAttachRow.appendChild(attachBtn);
            inputAttachRow.appendChild(attachThumb);
            inputAttachRow.appendChild(attachClear);
            inputArea.appendChild(inputAttachRow);
            inputArea.appendChild(inputSaveBtn);
            renderAttach();
            const readAttachedPreview = () => new Promise((resolve) => {
                if (!attachedFile) return resolve(null);
                try {
                    const url = URL.createObjectURL(attachedFile);
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                            const scale = Math.min(1, 512 / Math.max(w, h));
                            const cw = document.createElement("canvas");
                            cw.width = Math.max(1, Math.round(w * scale));
                            cw.height = Math.max(1, Math.round(h * scale));
                            cw.getContext("2d").drawImage(img, 0, 0, cw.width, cw.height);
                            resolve(cw.toDataURL("image/png"));
                        } catch (e) { resolve(null); }
                        try { URL.revokeObjectURL(url); } catch (err) { /* silent */ }
                    };
                    img.onerror = () => { try { URL.revokeObjectURL(url); } catch (err) { /* silent */ } resolve(null); };
                    img.src = url;
                } catch (e) { resolve(null); }
            });

            let inputVisible = false;
            inputToggle.onclick = () => {
                inputVisible = !inputVisible;
                inputArea.style.display = inputVisible ? "flex" : "none";
                inputToggle.style.background = inputVisible ? "#2c4a73" : "#2a2a2a";
                if (inputVisible) st.panelOpened?.();
                else st.shrinkBack?.();
                // Vue: высоту ноды владеет layout (computeLayoutSize + CSS-цепочка),
                // подгонять её из JS не нужно и вредно (SPEC §22.9).
                if (!st._vuePanes) st.syncNodeSize?.();
            };

            inputSaveBtn.onclick = async () => {
                const text = inputText.value.trim();
                const dest = (st.selFolder && !st.selFolder.startsWith("__")) ? st.selFolder : "";
                const base = "💾 Сохранить промпт";
                if (!text) {
                    inputSaveBtn.textContent = "⚠️ Пусто — нечего сохранять";
                    setTimeout(() => { inputSaveBtn.textContent = base; }, 1500);
                    return;
                }
                inputSaveBtn.textContent = "⏳ Сохраняю...";
                try {
                    const previewData = await readAttachedPreview();
                    const r = await st.apiPost("/prompt_library/add", { prompt: text, folder: dest,
                        ...(previewData ? { preview_data: previewData } : {}) });
                    if (r.ok) {
                        let dup = null;
                        try { dup = await r.json(); } catch (e) { /* silent */ }
                        await reload();
                        if (dup && dup.duplicate) {
                            const where = dup.folder || "корне";
                            inputSaveBtn.textContent = `⚠️ Уже есть в «${where}»`;
                            try {
                                st.toast("warn", "Prompt Library: дубликат",
                                    `Такой промпт уже есть в «${where}» — новая запись не создана.`);
                            } catch (e) { /* silent */ }
                        } else {
                            inputSaveBtn.textContent = "✅ Сохранено";
                            inputText.value = "";
                        }
                        attachedFile = null;
                        try { inputFile.value = ""; } catch (e) { /* silent */ }
                        renderAttach();
                    } else {
                        inputSaveBtn.textContent = "❌ Ошибка";
                    }
                } catch (err) { inputSaveBtn.textContent = "❌ Ошибка"; }
                setTimeout(() => { inputSaveBtn.textContent = base; }, 1500);
            };

            // Ряд: дерево папок | список книг
            // flex:1 — забирает всё свободное место root при ресайзе ноды вниз
            const main = document.createElement("div");
            main.style.cssText = "display:flex;gap:6px;min-height:0;flex:1 1 auto;";

            const treeBox = document.createElement("div");
            treeBox.style.cssText = "width:34%;min-width:110px;display:flex;flex-direction:column;gap:4px;flex-shrink:0;";
            const treeHead = document.createElement("div");
            treeHead.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
            const treeTitle = document.createElement("div");
            treeTitle.style.cssText = "color:#888;font-size:11px;font-weight:bold;";
            treeTitle.textContent = "📁 Категории";
            const newFolderBtn = document.createElement("button");
            newFolderBtn.textContent = "+ Категория";
            newFolderBtn.title = "Создать категорию (в текущей — подкатегорию)";
            newFolderBtn.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;";
            treeHead.appendChild(treeTitle);
            treeHead.appendChild(newFolderBtn);
            const tree = document.createElement("div");
            // Тянется с нодой и СЖИМАЕТСЯ до отведённого места (min-height:0):
            // пол даёт минимальная высота ноды (computeLayoutSize), а не CSS.
            // С полом на панелях контент вылезал за root и его перекрывал
            // следующий сосед (detail) — «область с кнопками стала перекрыта»
            // (номинальный DETAIL_H=280 < реальной высоты панели + разница шрифтов).
            tree.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:1 1 0;min-height:0;overflow-y:auto;border:1px solid #333;border-radius:4px;padding:4px;background:#191919;";
            treeBox.appendChild(treeHead);
            treeBox.appendChild(tree);

            const list = document.createElement("div");
            list.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;flex-shrink:0;";
            // Заголовок списка: пустой распорник — верх первой карточки совпадает
            // с верхом дерева (treeHead). Bulk-бар живёт в нижней строке (hintRow).
            const listHead = document.createElement("div");
            listHead.style.cssText = "height:22px;flex-shrink:0;";
            list.appendChild(listHead);
            // Контент списка (скроллируемый). Сжимается (min-height:0), см. tree.
            const listContent = document.createElement("div");
            listContent.style.cssText = "display:flex;flex-direction:column;gap:4px;flex:1 1 0;min-height:0;overflow-y:auto;";
            list.appendChild(listContent);

            // Слева список книг, справа проводник категорий
            main.appendChild(list);
            main.appendChild(treeBox);

            // Нижняя строка: ОДНА фиксированная (22px) — в ней либо подсказка,
            // либо bulk-бар с метками. Кнопки массовых действий — внизу, как
            // раньше, но рост строки исключён (height + flex-shrink:0), поэтому
            // появление кнопок не отжимает место у списка/дерева. Счётчик
            // сжимается с многоточием (flex:1 1 auto + min-width:0), кнопки
            // (flex-shrink:0) остаются видны всегда — в listHead их выдавливало
            // за правый край строки и резало overflow:hidden.
            const hintRow = document.createElement("div");
            hintRow.style.cssText = "display:flex;align-items:center;gap:4px;height:22px;flex-shrink:0;overflow:hidden;white-space:nowrap;";
            const hint = document.createElement("div");
            // Строго одна строка: рост подсказки отжимал бы место у списка.
            hint.style.cssText = "flex:1 1 auto;min-width:0;color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            hint.textContent = "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.";
            // Элементы bulk-бара создаются один раз (без пересоздания на каждый
            // рендер) и только переключают видимость.
            const bulkCount = document.createElement("span");
            bulkCount.style.cssText = "flex:1 1 auto;min-width:0;color:#e08a3c;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;";
            const bulkDel = document.createElement("button");
            bulkDel.textContent = "🗑 Удалить";
            bulkDel.title = "Удалить помеченные записи и категории";
            bulkDel.style.cssText = "display:none;background:#5a2b2b;color:#ffd9d9;border:1px solid #a33;border-radius:4px;padding:0 8px;cursor:pointer;font-size:11px;flex-shrink:0;";
            bulkDel.onclick = () => st.bulkDelete?.();
            const bulkClear = document.createElement("button");
            bulkClear.textContent = "✖";
            bulkClear.title = "Снять все метки (Esc)";
            bulkClear.style.cssText = "display:none;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:0 8px;cursor:pointer;font-size:11px;flex-shrink:0;";
            bulkClear.onclick = () => st.clearMarks?.();
            hintRow.appendChild(hint);
            hintRow.appendChild(bulkCount);
            hintRow.appendChild(bulkDel);
            hintRow.appendChild(bulkClear);

            // --- Панель книги: название, полка, полный текст ---
            const detail = document.createElement("div");
            detail.style.cssText = "display:none;flex-direction:column;gap:4px;border:1px solid #4a9eff;border-radius:4px;padding:6px;background:#16202f;flex-shrink:0;max-height:320px;overflow-y:auto;";

            const dTitle = document.createElement("input");
            dTitle.placeholder = "Название";
            dTitle.readOnly = true;
            dTitle.style.cssText = "background:#111;color:#fff;border:1px solid #444;border-radius:4px;padding:4px 6px;font-size:12px;font-weight:bold;";
            const dFolder = document.createElement("input");
            dFolder.placeholder = "Категория: Фото/Портреты";
            dFolder.readOnly = true;
            dFolder.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 6px;font-size:11px;";
            const dText = document.createElement("textarea");
            dText.readOnly = true;
            dText.rows = 10;
            dText.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px;font-size:11px;overflow-y:auto;resize:none;";
            const dMeta = document.createElement("div");
            dMeta.style.cssText = "color:#777;font-size:10px;";

            const dBtns = document.createElement("div");
            dBtns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
            const mkBtn = (label, title) => {
                const b = document.createElement("button");
                b.textContent = label; b.title = title;
                b.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;";
                return b;
            };
            const bCopy = mkBtn("📋 Копировать", "Скопировать полный текст в буфер обмена");
            const bEdit = mkBtn("✏️ Редактировать", "Изменить название, категорию и текст");
            const bSave = mkBtn("💾 Сохранить", "Сохранить изменения");
            bSave.style.display = "none";
            const bWorkflow = mkBtn("📥 Воркфлоу", "Открыть сохранённый воркфлоу на канвасе (текущий будет заменён)");
            bWorkflow.style.display = "none";
            dBtns.appendChild(bCopy);
            dBtns.appendChild(bEdit);
            dBtns.appendChild(bSave);
            dBtns.appendChild(bWorkflow);
            bWorkflow.onclick = () => { try { st.openWorkflow?.(st.detailId); } catch (e) { /* silent */ } };

            detail.appendChild(dTitle);
            detail.appendChild(dFolder);
            detail.appendChild(dText);
            detail.appendChild(dMeta);
            detail.appendChild(dBtns);

            // Vue (Nodes 2.0): main+detail переезжают внутрь scrollArea — так
            // переполнение уходит в скролл, а не за границу ноды. В канвасе
            // scrollArea не используется вовсе: main/detail остаются прямыми
            // детьми root, ровно как раньше (не трогаем рабочий путь §22.4).
            const scrollArea = document.createElement("div");
            scrollArea.style.cssText = "display:flex;flex-direction:column;gap:6px;";

            root.appendChild(inputToggle);
            root.appendChild(inputArea);
            root.appendChild(toolbar);
            root.appendChild(main);
            root.appendChild(detail);
            root.appendChild(hintRow);

            const st = {
                root, main, search, sortSel, viewSel, mediaSel, tree, list: listContent, listHead, hintRow, hint, detail,
                bulkCount, bulkDel, bulkClear,
                dTitle, dFolder, dText, dMeta, bSave, bWorkflow,
                entries: [], folders: [], full: new Map(),
                detailId: null, selFolder: "__all",
                // Мультивыделение на удаление (Ctrl — поштучно, Shift — диапазон).
                // Живёт только в сессии, в PNG не персистится; цель сохранения
                // (selFolder) метки не меняют — конфликта «куда сохранять» нет.
                markEntries: new Set(), markFolders: new Set(),
                anchorEntry: null, anchorFolder: null, folderOrder: [],
                hintMsg: "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.",
                // Стойкое сообщение (например, «дубликат не сохранён»): hintMsg виден
                // только при открытой панели книги, а этот — всегда, до действия
                // пользователя (клик по папке/карточке сбрасывает).
                hintSticky: null,
            };
            this._pl = st;
            plLiveStates.add(st);
            st.version = PL_JS_VERSION;

            st.toast = (severity, summary, detail) => {
                try {
                    app.extensionManager.toast.add({ severity, summary, detail, life: 6000 });
                } catch (e) { /* silent */ }
            };
            // Единая точка для всех POST, меняющих базу: ответ пришёл — сервер уже
            // записал (и разослал WS-сигнал), но соседняя нода этой страницы получит
            // его с задержкой — перечитываем её сразу. Забыть вызов в новом хендлере
            // невозможно: мутации идут только через st.apiPost (§26.9).
            st.apiPost = async (path, payload) => {
                const r = await fetch(path, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload || {}),
                });
                if (r && r.ok) { try { plRefreshLocal(st); } catch (e) { /* silent */ } }
                return r;
            };

            // Открыть воркфлоу записи на канвасе (как дроп PNG с workflow).
            // Деструктивно (заменяет текущий граф) — всегда через confirm.
            st.openWorkflow = async (id) => {
                if (!id) return;
                try {
                    let full = st.full.get(id);
                    if (!full || !full.workflow) {
                        const r = await fetch(`/prompt_library/entry?id=${encodeURIComponent(id)}`);
                        if (!r.ok) { st.toast("warn", "Prompt Library", "Не удалось прочитать запись."); return; }
                        full = await r.json();
                        st.full.set(id, full);
                    }
                    if (!full || !full.workflow) {
                        st.toast("warn", "Prompt Library: нет воркфлоу",
                            "У записи нет сохранённого воркфлоу (сохранена вручную или старой версией). Прогони Queue с этим промптом — воркфлоу прикрепится.");
                        return;
                    }
                    let ok = false;
                    try {
                        ok = await app.extensionManager.dialog.confirm({
                            title: "Открыть воркфлоу",
                            message: "Загрузить воркфлоу из записи? Текущий воркфлоу на канвасе будет заменён.",
                        });
                    } catch (e) {
                        ok = confirm("Загрузить воркфлоу из записи? Текущий воркфлоу будет заменён.");
                    }
                    if (!ok) return;
                    if (typeof app.loadGraphData !== "function") {
                        st.toast("error", "Prompt Library", "Фронтенд не даёт loadGraphData.");
                        return;
                    }
                    await app.loadGraphData(full.workflow);
                } catch (err) { st.toast("error", "Prompt Library", "Не удалось открыть воркфлоу."); }
            };

            // Drop карточки на канвас: кастомный MIME-тип (файлов нет, файловый
            // хендлер ComfyUI нас игнорирует). Слушатели — capture на canvas:
            // наш тип забираем себе (stopImmediatePropagation), чужое не трогаем.
            st.hookCanvasDrop = () => {
                try {
                    if (window.__plCanvasDropHooked) return;
                    const cv = app.canvas && app.canvas.canvas;
                    if (!cv || typeof cv.addEventListener !== "function") return;
                    cv.addEventListener("dragover", (ev) => {
                        try {
                            const t = (ev.dataTransfer && ev.dataTransfer.types) || [];
                            if (Array.prototype.includes.call(t, "application/x-pl-entry")) {
                                ev.preventDefault();
                                ev.dataTransfer.dropEffect = "copy";
                            }
                        } catch (e) { /* silent */ }
                    }, true);
                    cv.addEventListener("drop", async (ev) => {
                        let id = null;
                        try {
                            const t = (ev.dataTransfer && ev.dataTransfer.types) || [];
                            if (!Array.prototype.includes.call(t, "application/x-pl-entry")) return;
                            id = ev.dataTransfer.getData("application/x-pl-entry") || null;
                        } catch (e) { return; }
                        if (!id) return;
                        ev.preventDefault();
                        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                        await st.openWorkflow(id);
                    }, true);
                    window.__plCanvasDropHooked = true;
                } catch (e) { /* silent */ }
            };
            st.hookCanvasDrop();

            // Двухрежимный layout (SPEC §22.9): высоту виджету даёт и канвас, и
            // Vue-режим (Nodes 2.0), поэтому раскладка общая, разница — только в
            // способе увести переполнение (scrollArea). Прежнее утверждение, что
            // во Vue обёртка content-sized и flex-цепочку нечем ограничить, —
            // неверно: см. факты про hasLayoutSize/gridTemplateRows в §22.9.
            // Детект: авторитетный `window.LiteGraph.vueNodesMode`, затем Settings API
            // (docs: app.extensionManager.setting.get(id)), затем ui.settings.
            st.isVueNodes = () => {
                try {
                    const lg = window.LiteGraph;
                    if (lg && typeof lg.vueNodesMode === "boolean") return lg.vueNodesMode;
                } catch (e) { /* silent */ }
                try {
                    const em = app.extensionManager;
                    if (em && em.setting && typeof em.setting.get === "function") {
                        const v = em.setting.get("Comfy.VueNodes.Enabled");
                        if (v !== undefined && v !== null) return !!v;
                    }
                } catch (e) { /* silent */ }
                try {
                    const s = app.ui && app.ui.settings;
                    if (s && typeof s.getSettingValue === "function") {
                        const v = s.getSettingValue("Comfy.VueNodes.Enabled");
                        if (v !== undefined && v !== null) return !!v;
                    }
                } catch (e) { /* silent */ }
                return false;
            };
            // Min-width ноды в Vue-режиме: ядро берёт node.style.min-width
            // инлайн или 225 по дефолту (useNodeResize) — наш MIN_W через setSize
            // туда не доходит. Ставим напрямую на [data-node-id] (семантический
            // атрибут, не build-хэш). В канвасе такого элемента нет → no-op.
            st.applyNodeMinWidth = () => {
                try {
                    const nodeEl = root.closest && root.closest("[data-node-id]");
                    if (!nodeEl || !(nodeEl instanceof HTMLElement)) return;
                    nodeEl.style.minWidth = MIN_W + "px";
                } catch (e) { /* silent */ }
            };
            // Авто-подгонка высоты (chromeMin + setSize по прокси node.size) УДАЛЕНА
            // 2026-09-17: подход тупиковый — калибровка chrome самоблокируется
            // на высокой ноде (первая же выборка даёт target = nodeH → deadband,
            // см. SPEC §22.8). Растяжение теперь делают layout + CSS:
            // канвас — computeLayoutSize (§22.3), Vue — flex-цепочка (§22.9).
            st.applyPaneLayout = (forceVue) => {
                try {
                    st._vuePanes = (typeof forceVue === "boolean") ? forceVue : st.isVueNodes();
                    // Обрезка и отказ от собственного min-width — в ОБОИХ режимах.
                    // Vue-нода (`lg-node`) НЕ обрезает содержимое, а при живом
                    // переключении режима раскладка может остаться от прежнего
                    // режима — тогда root обрежет себя сам и не разъедется за ноду
                    // (грациозная деградация вместо развалившегося вида).
                    root.style.overflow = "hidden";
                    root.style.minWidth = "0";
                    if (st._vuePanes) {
                        // Vue (Nodes 2.0), факты из исходников фронтенда 1.52:
                        //  • NodeContent  = `flex flex-auto grow flex-col` → тело ноды
                        //    имеет реальную (не content-sized) высоту;
                        //  • NodeWidgets  получает `flex:1` и строку `auto` для нашего
                        //    виджета, т.к. hasLayoutSize = typeof computeLayoutSize
                        //    === "function" (useGraphNodeManager.ts);
                        //  • обёртка WidgetDOM (`flex flex-col *:flex-1`) отдаёт наш
                        //    root через flex:1 → root тоже реальной высоты.
                        // Значит растягивать контент можно тем же flex-приёмом, что и в
                        // канвасе (§22.3). Фиксированные 480px оставляли пустоту снизу.
                        // main+detail — в scrollArea: переполнение уходит в скролл.
                        if (scrollArea.parentNode !== root) {
                            root.insertBefore(scrollArea, hintRow);
                            scrollArea.appendChild(main);
                            scrollArea.appendChild(detail);
                        }
                        // Панели заселяют видимую область (их собственный скролл
                        // рассчитан на переполнение КАРТОЧКАМИ, а не на нехватку места).
                        for (const el of [tree, listContent]) {
                            el.style.flex = "1 1 0";
                            el.style.minHeight = "0";
                            el.style.height = "";
                        }
                        main.style.flex = "1 1 0";
                        main.style.minHeight = "0";
                        scrollArea.style.flex = "1 1 0";
                        // Пол — на scrollArea, а не на панелях: только он попадает
                        // в замер минимальной высоты контента, который в Vue задаёт
                        // высоту ноды. Иначе новая нода открывается «сжатой», а
                        // ноду можно сжать почти в ноль.
                        scrollArea.style.minHeight = PANES_MIN_H + "px";
                        scrollArea.style.overflowY = "auto";
                    } else {
                        // Канвас: раскладка ТА ЖЕ, что в Vue (высота виджета = его
                        // computedHeight, т.е. root всегда заполнен), но переполнение
                        // некуда уводить — поэтому панели ОБЯЗАНЫ сжиматься до
                        // отведённого места (flex 1 1 0 + min-height:0).
                        // Раньше здесь стоял пол min-height:480px на панелях: когда
                        // реального места было меньше пола (панель книги максимум
                        // 320px против номинальных DETAIL_H=280, другой шрифт/зум),
                        // контент вылезал за root и его перекрывал следующий сосед
                        // (detail рисуется позже) — низ списка с кнопками карточек
                        // оказывался «перекрыт». Минимальный РАЗМЕР ноды теперь задаёт
                        // только computeLayoutSize.minHeight (BASE_H) — он же в обоих
                        // режимах, поэтому панели получают ≈PANES_MIN_H при ноде
                        // минимального размера и растут вместе с ней.
                        if (scrollArea.parentNode === root) {
                            root.insertBefore(main, scrollArea);
                            root.insertBefore(detail, scrollArea);
                            root.removeChild(scrollArea);
                        }
                        for (const el of [tree, listContent]) {
                            el.style.flex = "1 1 0";
                            el.style.minHeight = "0";
                            el.style.height = "";
                        }
                        main.style.flex = "1 1 0";
                        main.style.minHeight = "0";
                    }
                    // Страховка: ничего внутри main не может нарисоваться поверх
                    // соседа (detail/hintRow) — панели скроллятся сами.
                    main.style.overflow = "hidden";
                } catch (e) { /* silent */ }
            };
            // Замер пола по root.offsetHeight (_vueFloor) УДАЛЁН по той же причине:
            // в Vue root растянут до высоты ноды, поэтому измеренный «контент» =
            // текущая высота → минимальная высота запиралась на текущей (нода не
            // сжималась никогда). Минимум в обоих режимах — константы st.minH().
            st.applyPaneLayout();
            // Смена режима БЕЗ перезагрузки страницы (canvas ↔ Nodes 2.0).
            // Сигнал №1 — перехват `LiteGraph.vueNodesMode` (его выставляет сам
            // фронтенд: это и есть момент включения Vue-рендера) — plHookVueMode().
            // Сигнал №2 — событие настроек (страховка для сборок без window.LiteGraph).
            st.onModeChange = (vue) => {
                try { st.applyPaneLayout(typeof vue === "boolean" ? vue : undefined); } catch (e) { /* silent */ }
                // Vue монтирует ноду АСИНХРОННО: в момент смены флага элемента
                // `[data-node-id]` в DOM ещё нет, поэтому min-width уходил в пустоту
                // и нода оставалась на дефолтных 350px (`min-w-(--min-node-width)` в
                // LGraphNode.vue = узкая, «сжатая»); в reload-пути то же делает rAF
                // в onNodeCreated уже после монтирования — отсюда разница «до/после F5».
                try { st.settleLayout(true); } catch (e) { /* silent */ }
                try { this.graph?.setDirtyCanvas(true, true); } catch (e) { /* silent */ }
            };
            // Применение ширины/раскладки с догоняющим кадром (без таймеров и цикла):
            // первый проход — сразу, второй (один) — на случай кадра между сменой
            // флага и монтированием Vue-ноды.
            st.settleLayout = (again) => {
                try { st.applyNodeMinWidth?.(); } catch (e) { /* silent */ }
                try { st.enforceMinWidth?.(); } catch (e) { /* silent */ }
                if (again) { try { requestAnimationFrame(() => st.settleLayout(false)); } catch (e) { /* silent */ } }
            };
            plModeWatchers.add(st.onModeChange);
            plHookVueMode();
            try {
                const s = app.ui && app.ui.settings;
                if (s && typeof s.addEventListener === "function") {
                    const onVueSetting = (ev) => {
                        // detail.value = новое значение (стор обновляется до события)
                        const v = ev && ev.detail ? ev.detail.value : undefined;
                        st.onModeChange(typeof v === "boolean" ? v : undefined);
                    };
                    s.addEventListener("Comfy.VueNodes.Enabled.change", onVueSetting);
                    st.settingsListener = onVueSetting;
                    st.settingsTarget = s;
                }
            } catch (e) { /* silent */ }

            st.enforceMinWidth = () => {
                try {
                    if (this.size[0] < MIN_W) this.setSize([MIN_W, this.size[1]]);
                } catch (e) { /* silent */ }
            };

            // Выбор дерева персистится через скрытый save_folder как есть:
            // "" = "Всё", "__fav"/"__root" = служебные ветки, иначе путь папки.
            // Python на входе режет "__*" в корень (см. execute), поэтому записи
            // в служебные имена не сохраняются — виджет безопасен для round-trip.
            st.syncSaveFolder = () => {
                try {
                    const sf = this.widgets?.find((w) => w.name === "save_folder") || saveFolderW;
                    const v = st.selFolder === "__all" ? "" : (st.selFolder || "");
                    if (sf && sf.value !== v) sf.value = v;
                } catch (e) { /* silent */ }
            };



            const reload = async () => {
                try {
                    const r = await fetch("/prompt_library/list");
                    if (!r.ok) return;
                    const data = await r.json();
                    st.entries = (data.entries || []).map(plMap);
                    st.folders = data.folders || [];
                    // Чистим протухшие метки (запись удалена в другой вкладке,
                    // папка переименована через ✏️): сервер мусор игнорирует,
                    // но bulk-бар не должен врать о числе помеченных.
                    if (st.markEntries.size) {
                        const alive = new Set(st.entries.map((e) => e.id));
                        for (const id of st.markEntries) if (!alive.has(id)) st.markEntries.delete(id);
                        if (!st.markEntries.has(st.anchorEntry)) st.anchorEntry = null;
                    }
                    if (st.markFolders.size) {
                        const alive = new Set([...st.folders, ...st.entries.map((e) => e.folder).filter(Boolean)]);
                        for (const p of st.markFolders) if (!alive.has(p)) st.markFolders.delete(p);
                        if (!st.markFolders.has(st.anchorFolder)) st.anchorFolder = null;
                    }
                    renderTree();
                    render();
                    // fitNode удалён: высоту отдаёт computeLayoutSize (минимум),
                    // свободное место distributeSpace даёт нам, размер — у фронтенда.
                } catch (e) { /* silent */ }
            };
            st.reload = reload;

            // Глобальный слушатель: при сохранении записи на любой ноде
            // (через _broadcast_refresh → send_sync) все Library-ноды
            // автоматически перечитывают library.json без запуска Queue.
            // app.api — ComfyApi (extends EventTarget). При неизвестном
            // типе сообщения ComfyApi рассылает CustomEvent(type, {detail}).
            // Слушатель храним в st и СНИМАЕМ в onRemoved: app.api живёт всю сессию,
            // иначе удалённые ноды не собираются GC и продолжают тянуть
            // /prompt_library/list на каждый broadcast.
            try {
                const plListener = (ev) => {
                    try { if (this._pl) this._pl.reload(); } catch (e) { /* silent */ }
                };
                app.api.addEventListener("prompt_library/refresh", plListener);
                st.apiListener = plListener;
                st.apiTarget = app.api;
            } catch (e) { /* silent */ }

            // --- Drag & Drop: книги → на категории, категории → в другие категории (или в корень) ---
            st.plDrop = async (d, target) => {
                if (!d) return;
                try {
                    if (d.kind === "entry") {
                        const dest = target && !target.startsWith("__") ? target : (target === "__root" ? "" : null);
                        if (dest === null) return;
                        const e = st.entries.find((x) => x.id === d.id);
                        if (!e || e.folder === dest) return;
                        await st.apiPost("/prompt_library/update", { id: d.id, folder: dest });
                        st.full.delete(d.id);
                        await reload();
                    } else if (d.kind === "folder") {
                        const src = d.path;
                        const dest = (!target || target === "__all" || target === "__root")
                            ? src.split("/").pop()
                            : target + "/" + src.split("/").pop();
                        if (dest === src || dest.startsWith(src + "/")) return;
                        const r = await st.apiPost("/prompt_library/folder_rename", { old: src, new: dest });
                        if (r.ok) {
                            if (st.selFolder === src || st.selFolder.startsWith(src + "/")) {
                                st.selFolder = dest + st.selFolder.slice(src.length);
                            }
                            st.syncSaveFolder();
                            await reload();
                        }
                    }
                } catch (e) { /* silent */ }
            };

            // Фон списка — тоже дроп-зона: книга переезжает в открытую полку
            list.ondragover = (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; };
            list.ondrop = async (ev) => {
                ev.preventDefault();
                let d = null;
                try { d = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { /* silent */ }
                if (d && d.kind === "entry" && st.selFolder && !st.selFolder.startsWith("__")) {
                    await st.plDrop(d, st.selFolder);
                }
            };

            // --- Дерево полок ---
            const folderRow = (key, label, depth, isFolder) => {
                const row = document.createElement("div");
                const active = st.selFolder === key;
                const marked = st.markFolders.has(key);
                row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:4px;cursor:pointer;font-size:11px;color:${active ? "#fff" : "#ccc"};background:${marked ? "rgba(224,138,60,.35)" : active ? "#2c4a73" : "transparent"};${marked ? "box-shadow:inset 3px 0 0 #e08a3c;" : ""}padding-left:${4 + depth * 14}px;`;
                if (isFolder) row.title = "Клик — открыть · Ctrl+клик — пометить · Shift+клик — диапазон";
                const name = document.createElement("span");
                name.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                name.textContent = (marked ? "☑ " : "") + label;
                name.title = isFolder ? key : label;
                row.appendChild(name);
                // Папки можно таскать; любая строка — дроп-зона
                row.draggable = isFolder;
                if (isFolder) {
                    row.ondragstart = (ev) => {
                        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "folder", path: key }));
                        ev.dataTransfer.effectAllowed = "move";
                        ev.stopPropagation();
                    };
                }
                row.ondragover = (ev) => {
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = "move";
                    row.style.outline = "1px dashed #4a9eff";
                };
                row.ondragleave = () => { row.style.outline = ""; };
                row.ondrop = async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    row.style.outline = "";
                    let d = null;
                    try { d = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { /* silent */ }
                    await st.plDrop(d, key);
                };
                if (isFolder) {
                    const rn = document.createElement("button");
                    rn.textContent = "✏️"; rn.title = "Переименовать категорию (правка прямо в строке)";
                    rn.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    rn.onclick = (ev) => {
                        ev.stopPropagation();
                        const leaf = key.split("/").pop();
                        row.draggable = false; // пока правим — строку нельзя утащить
                        st.inlineEdit(name, leaf, async (next) => {
                            // Та же защита служебного префикса, что и при создании:
                            // иначе переименование увело бы папку в призрак.
                            if (next.startsWith("__")) {
                                st.toast("warn", "Prompt Library: имя категории",
                                    "Имя не может начинаться с «__» — это служебный префикс дерева.");
                                renderTree();
                                return;
                            }
                            const parent = key.split("/").slice(0, -1).join("/");
                            const newPath = parent ? `${parent}/${next}` : next;
                            try {
                                const r = await st.apiPost("/prompt_library/folder_rename", { old: key, new: newPath });
                                if (r.ok) {
                                    if (st.selFolder === key) st.selFolder = newPath;
                                    // Метки/якорь переименованного пути едут следом
                                    if (st.markFolders.delete(key)) st.markFolders.add(newPath);
                                    if (st.anchorFolder === key) st.anchorFolder = newPath;
                                    st.syncSaveFolder();
                                    await reload();
                                } else st.toast("warn", "Prompt Library", "Не удалось переименовать.");
                            } catch (e) { st.toast("warn", "Prompt Library", "Не удалось переименовать."); }
                        });
                    };
                    const del = document.createElement("button");
                    del.textContent = "🗑"; del.title = "Удалить категорию (записи переедут в корень)";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить категорию «${key}» с подкатегориями? Записи не пропадут — переедут в корень.`)) return;
                        try {
                            const r = await st.apiPost("/prompt_library/folder_delete", { path: key });
                            if (r.ok) {
                                if (st.selFolder === key || st.selFolder.startsWith(key + "/")) st.selFolder = "__all";
                                st.syncSaveFolder();
                                await reload();
                            }
                        } catch (e) { /* silent */ }
                    };
                    row.appendChild(rn);
                    row.appendChild(del);
                }
                row.onclick = (ev) => {
                    // Ctrl/Shift — только метка на удаление (текущую папку и цель
                    // сохранения не трогаем). Служебные ветки не помечаем.
                    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
                        if (isFolder) st.markFolderToggle(key, !!(ev.shiftKey));
                        return;
                    }
                    // Обычный клик при наличии меток — снять весь выбор (как в проводнике)
                    if (st.markEntries.size || st.markFolders.size) st.clearMarks();
                    st.selFolder = key;
                    st.syncSaveFolder();
                    st.anchorFolder = key; // обычный клик ставит якорь для Shift-диапазона
                    st.detailId = null;
                    if (selWidget) selWidget.value = "";
                    st.detail.style.display = "none";
                    st.shrinkBack?.();
                    st.hintMsg = "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.";
                    st.hintSticky = null;
                    renderTree();
                    render();
                };
                return row;
            };

            const renderTree = () => {
                st.tree.innerHTML = "";
                // Порядок строк для Shift-диапазона (включая служебные — при
                // применении диапазона они пропускаются, метятся только папки).
                st.folderOrder = ["__all", "__fav", "__root"];
                st.tree.appendChild(folderRow("__all", "📚 Всё", 0, false));
                st.tree.appendChild(folderRow("__fav", "★ Избранное", 0, false));
                st.tree.appendChild(folderRow("__root", "📥 Без категории", 0, false));
                const all = [...new Set([...st.folders, ...st.entries.map((e) => e.folder).filter(Boolean)])].sort();
                const kids = new Map(); // parent -> [childPath]
                for (const f of all) {
                    const parent = f.split("/").slice(0, -1).join("/");
                    if (!kids.has(parent)) kids.set(parent, []);
                    kids.get(parent).push(f);
                }
                const walk = (parent, depth) => {
                    for (const f of (kids.get(parent) || [])) {
                        st.folderOrder.push(f);
                        st.tree.appendChild(folderRow(f, "📁 " + f.split("/").pop(), depth, true));
                        walk(f, depth + 1);
                    }
                };
                walk("", 0);
            };
            st.renderTree = renderTree;

            newFolderBtn.onclick = async () => {
                const parent = (st.selFolder && !st.selFolder.startsWith("__")) ? st.selFolder : "";
                const name = prompt(parent ? `Новая подкатегория в «${parent}»: ` : "Новая категория:");
                if (!name || !name.trim()) return;
                // Префикс "__" — служебные ветки дерева (__all/__fav/__root): такая
                // «категория» стала бы призраком (записи в неё не попадают, из UI
                // её не удалить). Сервер это тоже проверяет — здесь понятное сообщение.
                if (name.trim().startsWith("__")) {
                    st.toast("warn", "Prompt Library: имя категории",
                        "Имя не может начинаться с «__» — это служебный префикс дерева.");
                    return;
                }
                try {
                    const r = await st.apiPost("/prompt_library/folder_create", { parent, name: name.trim() });
                    if (r.ok) {
                        const data = await r.json();
                        st.selFolder = data.path;
                        st.syncSaveFolder();
                        await reload();
                    } else {
                        st.toast("warn", "Prompt Library", "Не удалось создать категорию.");
                    }
                } catch (e) { /* silent */ }
            };

            // --- Список книг ---
            const sortedFiltered = () => {
                const q = (st.search.value || "").toLowerCase();
                const mf = st.mediaSel.value || "all";
                let arr = st.entries.filter((e) => {
                    if (st.selFolder === "__fav" && !e.favorite) return false;
                    else if (st.selFolder === "__root" && e.folder) return false;
                    else if (st.selFolder && !st.selFolder.startsWith("__") && e.folder !== st.selFolder) return false;
                    if (mf !== "all" && e.media !== mf) return false;
                    if (q && !((e.title || "") + "\n" + (e.head || "") + "\n" + (e.folder || "")).toLowerCase().includes(q)) return false;
                    return true;
                });
                const by = st.sortSel.value;
                const ts = (s) => s || "";
                if (by === "title") arr = [...arr].sort((a, b) => (a.title || a.head).localeCompare(b.title || b.head, "ru"));
                else if (by === "old") arr = [...arr].sort((a, b) => ts(a.created_at) < ts(b.created_at) ? -1 : ts(a.created_at) > ts(b.created_at) ? 1 : 0);
                else if (by === "used") arr = [...arr].sort((a, b) => ts(b.last_used || "") < ts(a.last_used || "") ? -1 : ts(b.last_used || "") > ts(a.last_used || "") ? 1 : 0);
                else arr = [...arr].sort((a, b) => ts(b.created_at) < ts(a.created_at) ? -1 : ts(b.created_at) > ts(a.created_at) ? 1 : 0);
                return arr;
            };

            const render = () => {
                const mode = st.viewSel.value || "large";
                const grid = mode !== "list";
                const imgSize = mode === "large" ? 163 : mode === "medium" ? 109 : 82;
                st.list.style.flexDirection = grid ? "row" : "column";
                st.list.style.flexWrap = grid ? "wrap" : "nowrap";
                st.list.style.alignContent = grid ? "flex-start" : "";
                st.list.innerHTML = "";
                const selVal = selWidget ? selWidget.value : "";
                let shown = 0;
                for (const e of sortedFiltered()) {
                    const card = document.createElement("div");
                    card.draggable = true;
                    card.title = (e.has_workflow
                        ? "Тяни на канвас — открыть сохранённый воркфлоу"
                        : "Воркфлоу нет (ручная запись) — прогони Queue, и воркфлоу прикрепится")
                        + " · Ctrl+клик — пометить, Shift+клик — диапазон";
                    card.ondragstart = (ev) => {
                        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "entry", id: e.id }));
                        try { ev.dataTransfer.setData("application/x-pl-entry", e.id); } catch (err) { /* silent */ }
                        // copyMove: на папку — move, на канвас — copy (dropEffect обязан
                        // входить в effectAllowed, иначе браузер показывает запрет и блочит drop)
                        ev.dataTransfer.effectAllowed = "copyMove";
                    };
                    // Помеченные — левая акцент-полоса (inset box-shadow: на layout
                    // не влияет, в отличие от border) + тёплая подложка
                    const marked = st.markEntries.has(e.id);
                    const acct = marked ? "box-shadow:inset 4px 0 0 #e08a3c;" : "";
                    const bg = marked ? "#4a2f18" : e.id === selVal ? "#1e2c44" : "#1e1e1e";
                    const border = `1px solid ${e.id === selVal ? "#4a9eff" : "#333"}`;
                    card.style.cssText = grid
                        ? `display:flex;flex-direction:column;gap:4px;width:${imgSize + 12}px;padding:4px;border-radius:4px;cursor:pointer;border:${border};background:${bg};${acct}flex-shrink:0;`
                        : `display:flex;gap:6px;align-items:center;padding:4px;border-radius:4px;cursor:pointer;border:${border};background:${bg};${acct}`;

                    const img = document.createElement("img");
                    img.style.cssText = `width:${imgSize}px;height:${imgSize}px;object-fit:cover;border-radius:3px;background:#222;flex-shrink:0;`;
                    img.loading = "lazy";
                    // Стабильный t=: превью неизменно для записи (апгрейд jpg→png
                    // виден через Last-Modified → дешёвый 304, а не перезакачка).
                    // Date.now() тут был бы DDoS на 85 картинок при каждом рендере.
                    if (e.has_preview) img.src = `/prompt_library/preview?id=${encodeURIComponent(e.id)}&t=${encodeURIComponent(e.created_at || e.id)}`;
                    else img.style.display = "none";

                    const body = document.createElement("div");
                    body.style.cssText = grid ? "min-width:0;text-align:center;" : "flex:1;min-width:0;";
                    const title = document.createElement("div");
                    title.style.cssText = "color:#fff;font-size:12px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    title.textContent = plBadge(e) + (e.title || e.head || "(без названия)");
                    title.title = e.title || e.head || "";
                    body.appendChild(title);
                    if (!grid) {
                        const t = document.createElement("div");
                        t.style.cssText = "color:#bbb;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                        t.textContent = e.head || "";
                        body.appendChild(t);
                    }
                    const meta = document.createElement("div");
                    meta.style.cssText = "color:#888;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    meta.textContent = grid
                        ? (e.folder || "Без категории")
                        : `${e.folder || "Без категории"} · ${e.created_at || ""}${e.last_used ? " · выдана " + e.last_used : ""}`;
                    body.appendChild(meta);

                    const fav = document.createElement("button");
                    fav.textContent = e.favorite ? "★" : "☆";
                    fav.title = "В избранное";
                    fav.style.cssText = "background:none;border:none;color:#e8c33a;cursor:pointer;font-size:14px;flex-shrink:0;";
                    fav.onclick = async (ev) => {
                        ev.stopPropagation();
                        const prev = e.favorite;
                        e.favorite = !prev;
                        render();
                        try {
                            const r = await st.apiPost("/prompt_library/favorite", { id: e.id, favorite: e.favorite });
                            if (!r.ok) { e.favorite = prev; render(); }
                        } catch (err) { e.favorite = prev; render(); }
                    };

                    const rn = document.createElement("button");
                    rn.textContent = "✏️";
                    rn.title = "Переименовать (правка прямо в строке)";
                    rn.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;";
                    rn.onclick = (ev) => {
                        ev.stopPropagation();
                        card.draggable = false; // пока правим — карточку нельзя утащить
                        st.inlineEdit(title, e.title || e.head || "", async (next) => {
                            try {
                                await st.apiPost("/prompt_library/update", { id: e.id, title: next });
                                e.title = next;
                                st.full.delete(e.id);
                            } catch (err) { /* silent */ }
                            render();
                        });
                    };

                    const del = document.createElement("button");
                    del.textContent = "🗑";
                    del.title = "Удалить книгу";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить «${e.title || e.head}»?`)) return;
                        try {
                            await st.apiPost("/prompt_library/delete", { id: e.id });
                            st.entries = st.entries.filter((x) => x.id !== e.id);
                            st.full.delete(e.id);
                            if (st.detailId === e.id) { st.detailId = null; st.detail.style.display = "none"; st.shrinkBack?.(); }
                            renderTree(); render();
                            if (!st._vuePanes) st.syncNodeSize?.();
                        } catch (err) { /* silent */ }
                    };

                    card.onclick = async (ev) => {
                        // Ctrl/Shift — только метка на удаление (деталку не открываем,
                        // выбранную запись не меняем)
                        if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
                            st.markEntryToggle(e.id, !!(ev.shiftKey));
                            return;
                        }
                        // Обычный клик при наличии меток — снять весь выбор (как в проводнике)
                        if (st.markEntries.size || st.markFolders.size) st.clearMarks();
                        if (selWidget) selWidget.value = e.id;
                        st.anchorEntry = e.id; // обычный клик ставит якорь для Shift-диапазона
                        try {
                            if (!st.full.has(e.id)) {
                                const r = await fetch(`/prompt_library/entry?id=${encodeURIComponent(e.id)}`);
                                if (r.ok) st.full.set(e.id, await r.json());
                            }
                            const full = st.full.get(e.id);
                            if (full) {
                                st.detailId = e.id;
                                st.dTitle.value = full.title || "";
                                st.dFolder.value = full.folder || "";
                                st.dText.value = full.prompt || "";
                                for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = true;
                                st.bSave.style.display = "none";
                                st.bWorkflow.style.display = full.workflow ? "" : "none";
                                const mediaLabel = full.media === "video" ? " · 🎬 видео" : full.media === "image" ? " · 📷 фото" : "";
                                st.dMeta.textContent = `№ ${full.id} · создана ${full.created_at || "—"} · выдана ${full.last_used || "—"}${mediaLabel}`;
                                st.panelOpened?.();
                                st.detail.style.display = "flex";
                                st.hintMsg = "Запись выбрана. Для выдачи текста переключите режим на «📤 Выдача».";
                                st.hintSticky = null;
                            }
                        } catch (err) { /* silent */ }
                        render();
                        // Vue: размером ноды владеет layout, перерисовку канваса
                        // не запрашиваем (нода — DOM, canvas не участвует).
                        if (!st._vuePanes) {
                            st.syncNodeSize?.();
                            this.graph?.setDirtyCanvas(true, true);
                        }
                    };

                    // В сетке кнопки — рядком под названием, в списке — сбоку (display:contents)
                    const actions = document.createElement("div");
                    actions.style.cssText = grid ? "display:flex;gap:2px;justify-content:center;" : "display:contents;";
                    actions.appendChild(fav);
                    actions.appendChild(rn);
                    actions.appendChild(del);
                    card.appendChild(img);
                    card.appendChild(body);
                    card.appendChild(actions);
                    st.list.appendChild(card);
                    shown++;
                }
                st.renderHint(shown);
                // Страховка: если сигнал о смене режима не пришёл (сборка без
                // window.LiteGraph и без события настроек) — раскладка догонит при
                // первом же рендере. Одно чтение свойства, без таймеров и наблюдателей.
                try {
                    const vue = st.isVueNodes();
                    if (vue !== st._vuePanes) {
                        st.applyPaneLayout(vue);
                        // Догоняющий кадр: Vue мог ещё не смонтировать ноду
                        // ([data-node-id] появится только после рендера).
                        st.settleLayout?.(true);
                    }
                } catch (e) { /* silent */ }
            };
            // --- Мультивыделение на удаление (Ctrl — поштучно, Shift — диапазон) ---
            // Метки НЕ меняют текущую папку и выбранную запись → цель сохранения
            // (save_folder) всегда однозначна. Живут только в сессии.
            const rangeApply = (order, anchor, key, set) => {
                const a = order.indexOf(anchor), b = order.indexOf(key);
                if (a < 0 || b < 0) return false;
                const [lo, hi] = a < b ? [a, b] : [b, a];
                for (let i = lo; i <= hi; i++) {
                    const k = order[i];
                    if (k.startsWith("__")) continue; // служебные ветки не помечаем
                    set.add(k);
                }
                return true;
            };
            st.markEntryToggle = (id, range) => {
                // Эксклюзив: помечены папки — разметку карточек с зажатыми
                // модификаторами игнорируем (сброс чужих меток — только обычным
                // кликом, см. card.onclick / row.onclick).
                if (st.markFolders.size) return;
                if (range && st.anchorEntry && rangeApply(sortedFiltered().map((e) => e.id), st.anchorEntry, id, st.markEntries)) {
                    render();
                    return;
                }
                if (st.markEntries.has(id)) { st.markEntries.delete(id); st.anchorEntry = null; }
                else { st.markEntries.add(id); st.anchorEntry = id; }
                render();
            };
            st.markFolderToggle = (key, range) => {
                // Эксклюзив: помечены карточки — разметку папок с зажатыми
                // модификаторами игнорируем (сброс — только обычным кликом).
                if (st.markEntries.size) return;
                if (range && st.anchorFolder && rangeApply(st.folderOrder, st.anchorFolder, key, st.markFolders)) {
                    renderTree(); render();
                    return;
                }
                if (st.markFolders.has(key)) { st.markFolders.delete(key); st.anchorFolder = null; }
                else { st.markFolders.add(key); st.anchorFolder = key; }
                renderTree(); render();
            };
            st.clearMarks = () => {
                st.markEntries.clear(); st.markFolders.clear();
                st.anchorEntry = null; st.anchorFolder = null;
                renderTree(); render();
            };
            st.bulkDelete = async () => {
                const ids = [...st.markEntries], paths = [...st.markFolders];
                if (!ids.length && !paths.length) return;
                const parts = [];
                if (ids.length) parts.push(`записей: ${ids.length}`);
                if (paths.length) parts.push(`категорий: ${paths.length}`);
                const extra = paths.length ? " Записи из удалённых категорий не пропадут — переедут в корень." : "";
                if (!confirm(`Удалить ${parts.join(" и ")}?${extra}`)) return;
                try {
                    if (ids.length) {
                        await st.apiPost("/prompt_library/delete_many", { ids });
                    }
                    if (paths.length) {
                        await st.apiPost("/prompt_library/folder_delete_many", { paths });
                    }
                } catch (err) { /* silent */ }
                st.markEntries.clear(); st.markFolders.clear();
                st.anchorEntry = null; st.anchorFolder = null;
                if (st.detailId && ids.includes(st.detailId)) { st.detailId = null; st.detail.style.display = "none"; st.shrinkBack?.(); }
                if (selWidget && ids.includes(selWidget.value)) selWidget.value = "";
                if (paths.some((p) => st.selFolder === p || st.selFolder.startsWith(p + "/"))) {
                    st.selFolder = "__all";
                    st.syncSaveFolder();
                }
                await reload();
            };
            // Переименование на месте (без prompt() сверху браузера): текстовый
            // узел заменяется input'ом. Enter/уход фокуса — применить (пусто или
            // без изменений — отмена), Esc — отмена. keydown гасим на месте,
            // иначе Esc долетит до корневого слушателя меток.
            st.inlineEdit = (host, text, onCommit) => {
                const inp = document.createElement("input");
                inp.value = text;
                inp.style.cssText = "flex:1;min-width:0;width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #4a9eff;border-radius:3px;padding:1px 4px;font-size:inherit;";
                host.innerHTML = "";
                host.appendChild(inp);
                inp.focus();
                try { inp.select(); } catch (e) { /* silent */ }
                let done = false;
                const finish = (commit) => {
                    if (done) return; done = true;
                    const v = inp.value.trim();
                    if (commit && v && v !== text) onCommit(v);
                    else { renderTree(); render(); }
                };
                inp.onkeydown = (ev) => {
                    if (ev) ev.stopPropagation();
                    if (!ev) return;
                    if (ev.key === "Enter") finish(true);
                    else if (ev.key === "Escape") finish(false);
                };
                inp.onblur = () => finish(true);
                inp.onclick = (ev) => { if (ev) ev.stopPropagation(); };
            };
            // Строка-подсказка (внизу) — одна фиксированная строка 22px:
            // есть метки → показываем bulk-бар (счётчик + кнопки) ВМЕСТО
            // подсказки; меток нет → подсказка. Высота не меняется → список
            // не дёргается. Счётчик сжимается, кнопки не выдавливаются вон.
            st.renderHint = (shown) => {
                if (st.hintSticky) st.hint.textContent = st.hintSticky;
                else if (st.detailId) st.hint.textContent = st.hintMsg;
                else {
                    const base = shown ? `Записей в категории: ${shown}. ` : "Пусто. Запустите Queue или нажмите «Сохранить промпт». ";
                    st.hint.textContent = base + "Клик — открыть · Ctrl/Shift+клик — пометить · пустое место/Esc — снять.";
                }
                const nE = st.markEntries.size, nF = st.markFolders.size;
                const on = (nE + nF) > 0;
                st.hint.style.display = on ? "none" : "";
                st.bulkCount.style.display = on ? "" : "none";
                st.bulkDel.style.display = on ? "" : "none";
                st.bulkClear.style.display = on ? "" : "none";
                if (!on) return;
                const parts = [];
                if (nE) parts.push(`записей: ${nE}`);
                if (nF) parts.push(`категорий: ${nF}`);
                st.bulkCount.textContent = `Помечено — ${parts.join(", ")}.`;
                st.bulkCount.title = st.bulkCount.textContent;
            };
            // Esc снимает метки (слушатель на корне ноды — срабатывает при фокусе внутри неё).
            // outline:none — tabIndex делает div фокусируемым, без этого браузер
            // рисует контур фокуса (чисто косметика, на размер не влияет).
            root.tabIndex = 0;
            root.style.outline = "none";
            root.addEventListener("keydown", (ev) => {
                if (ev && ev.key === "Escape" && (st.markEntries.size || st.markFolders.size)) st.clearMarks?.();
            });
            // Клик по пустому месту списка/дерева снимает метки.
            // ev.target === zone отсекает всплывшие клики по карточкам/строкам
            // (у кнопок внутри — свой stopPropagation).
            for (const zone of [listContent, tree]) {
                zone.onclick = (ev) => {
                    if (ev && ev.target === zone && (st.markEntries.size || st.markFolders.size)) st.clearMarks?.();
                };
            }
            // Возврат высоты после закрытия панелей (деталка, ручной ввод).
            // Проблема: syncNodeSize только растит — открыл деталку (нода +280),
            // закрыл кликом по папке, а высота осталась → пустота внизу.
            // Решение детерминированное (не замер DOM): открытие запоминает
            // высоту, закрытие возвращает её. Только canvas — во Vue размером
            // владеет layout. Ручной ресайз пользователя шире панелей не трогаем
            // (возвращаем запомненное, а не минимум).
            st.panelOpened = () => {
                try { if (!st._vuePanes && st._prePanelH == null) st._prePanelH = this.size[1]; } catch (e) { /* silent */ }
            };
            st.shrinkBack = () => {
                try {
                    const detailHidden = !detail || detail.style.display === "none";
                    const inputHidden = !inputVisible;
                    if (!st._vuePanes && st._prePanelH != null && detailHidden && inputHidden
                        && this.size[1] > st._prePanelH) this.setSize([this.size[0], st._prePanelH]);
                    if (detailHidden && inputHidden) st._prePanelH = null;
                } catch (e) { /* silent */ }
            };
            st.render = render;
            search.oninput = render;
            sortSel.onchange = render;
            mediaSel.onchange = () => {
                try { localStorage.setItem("promptLibrary.media", mediaSel.value); } catch (e) { /* silent */ }
                render();
            };
            viewSel.onchange = () => {
                try { localStorage.setItem("promptLibrary.view", viewSel.value); } catch (e) { /* silent */ }
                render();
                // fitNode удалён.
                this.graph?.setDirtyCanvas(true, true);
            };

            bCopy.onclick = async () => {
                const txt = st.dText.value;
                try {
                    await navigator.clipboard.writeText(txt);
                    bCopy.textContent = "✅ Скопировано";
                } catch (e) {
                    st.dText.select();
                    try { document.execCommand("copy"); bCopy.textContent = "✅ Скопировано"; }
                    catch (err) { bCopy.textContent = "❌ Ошибка"; }
                }
                setTimeout(() => { bCopy.textContent = "📋 Копировать"; }, 1500);
            };
            bEdit.onclick = () => {
                for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = false;
                st.bSave.style.display = "";
                st.dTitle.focus();
            };
            bSave.onclick = async () => {
                if (!st.detailId) return;
                try {
                    await st.apiPost("/prompt_library/update", { id: st.detailId, title: st.dTitle.value,
                        prompt: st.dText.value, folder: st.dFolder.value });
                    st.full.delete(st.detailId);
                    for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = true;
                    st.bSave.style.display = "none";
                    await reload();
                } catch (err) { /* silent */ }
            };

            // --- Сторож цикла: IMAGE подключён + выход куда-то идёт = кольцо в графе ---
            const checkCycle = () => {
                try {
                    const imgLinked = (this.inputs?.find((i) => i.name === "image")?.link ?? null) != null;
                    const outLinked = (this.outputs?.[0]?.links?.length || 0) > 0;
                    const bad = imgLinked && outLinked;
                    let changed = false;
                    if (bad && !st.cycleWarned) {
                        st.cycleWarned = true;
                        changed = true;
                        if (st.origBg === undefined) st.origBg = this.bgcolor || null;
                        this.bgcolor = "#5a2323";
                        try {
                            app.extensionManager.toast.add({
                                severity: "warn",
                                summary: "Prompt Library: кольцо в графе!",
                                detail: "IMAGE подключён и выход идёт вверх по потоку — Queue упадёт. Отключи IMAGE-провод.",
                                life: 6000,
                            });
                        } catch (e) { /* silent */ }
                    } else if (!bad && st.cycleWarned) {
                        st.cycleWarned = false;
                        this.bgcolor = st.origBg || null;
                        changed = true;
                    }
                    // Перерисовку просим ТОЛЬКО при смене состояния: checkCycle
                    // вызывается и из onDrawForeground, а безусловный
                    // setDirtyCanvas там превращается в вечный цикл repaint
                    // (draw → dirty → draw) на видимой ноде.
                    if (changed) this.graph?.setDirtyCanvas(true, true);
                } catch (e) { /* silent */ }
            };
            st.checkCycle = checkCycle;

            // computeLayoutSize отдаёт минимальную высоту — фронтенд сам управляет
            // размером ноды и растягивает виджет (никаких offsetHeight/scrollHeight/plScale).
            // Минимальная ширина: ноду нельзя сжать уже контента.
            try {
                const prevOnResize = this.onResize ? this.onResize.bind(this) : null;
                this.onResize = (size) => {
                    try { if (prevOnResize) prevOnResize(size); } catch (e) { /* silent */ }
                    try {
                        if (this.size[0] < MIN_W) this.setSize([MIN_W, this.size[1]]);
                    } catch (e) { /* silent */ }
                };
            } catch (e) { /* silent */ }

            // Автосокеты виджетов: фронтенд 1.52 создаёт сокет каждому виджету
            // (getWidgetConfig, тип `*` по умолчанию). Вход `source` у нас
            // подписанный, а вторая точка рядом путает.
            // Удаляем автосокеты технических виджетов (только неподключённые).
            st.dropAutoSockets = () => {
                try {
                    if (typeof this.removeInput !== "function" || !this.inputs) return;
                    for (const n of ["selected", "save_folder"]) {
                        const idx = this.inputs.findIndex((i) => i.widget && i.widget.name === n);
                        if (idx >= 0 && this.inputs[idx].link == null) this.removeInput(idx);
                    }
                } catch (e) { /* silent */ }
                try { st.checkCycle?.(); } catch (e) { /* silent */ }
            };
            st.dropAutoSockets();
            requestAnimationFrame(() => { st.dropAutoSockets(); });

            // Безопасный переход в выдачу: предложить отключить IMAGE-провод
            // Возвращает true если переход разрешён, false если отменён
            st.ensureIssueSafe = async () => {
                try {
                    const idx = this.inputs?.findIndex((i) => i.name === "image");
                    if (idx !== undefined && idx >= 0 && this.inputs[idx].link != null) {
                        let ok = false;
                        try {
                            ok = await app.extensionManager.dialog.confirm({
                                title: "Режим «📤 Выдача»",
                                message: "IMAGE-провод вместе с выходом в CLIP создаст цикл и Queue упадёт. Отключить IMAGE-провод?",
                            });
                        } catch (e) {
                            ok = confirm("IMAGE-провод вместе с выходом в CLIP создаст цикл. Отключить IMAGE-провод?");
                        }
                        if (ok) {
                            this.disconnectInput(idx);
                        } else {
                            return false;
                        }
                    }
                } catch (e) { /* silent */ }
                checkCycle();
                return true;
            };

            const modeW = this.widgets?.find((w) => w.name === "mode");
            if (modeW) {
                modeW.callback = async (val) => {
                    if (val === "📤 Выдача") {
                        const ok = await st.ensureIssueSafe();
                        if (!ok) {
                            modeW.value = "📥 Запись";
                        }
                    } else {
                        checkCycle();
                    }
                };
            }

            requestAnimationFrame(() => { st.checkCycle?.(); });

            const browserWidget = this.addDOMWidget("pl_browser", "custom", root, {
                serialize: false,
                getValue: () => null,
                setValue: () => {},
            });
            // options.serialize сюда не пробрасывается (в файле лишний 4-й value
            // pl_browser:"") — ставим свойство явно, иначе позиционный маппинг
            // widgets_values хрупок при добавлении виджетов.
            try { browserWidget.serialize = false; } catch (e) { /* silent */ }
            // Высота DOM-контента: новый layout API (computeLayoutSize) вместо
            // legacy computeSize. Разница: computeSize = ТОЧНАЯ высота виджета
            // (лишний рост ноды → пустота снизу), computeLayoutSize = МИНИМУМ
            // (minHeight), а всё свободное место distributeSpace отдаёт нам —
            // нода тянется вниз вместе с контентом. Читаем только boolean-стейт
            // (display-флаги), НЕ размеры DOM — feedback loop из SPEC §21
            // здесь невозможен по построению. Никакого offsetHeight/scrollHeight.
            const DETAIL_H = 280;
            const BASE_H = 596;
            const INPUT_H = 170; // textarea + кнопка сохранения + ряд прикрепления превью
            // Единый минимум для обоих режимов (single source of truth).
            st.minH = () => {
                const showDetail = detail && detail.style.display !== "none";
                return BASE_H + (showDetail ? DETAIL_H : 0) + (inputVisible ? INPUT_H : 0);
            };
            st.syncNodeSize = () => {
                try {
                    const need = this.computeSize(this.size[0]);
                    this.setSize([Math.max(this.size[0], need[0]), Math.max(this.size[1], need[1])]);
                } catch (e) { /* silent */ }
            };
            try {
                // ВАЖНО: legacy computeSize НЕ задаём — иначе фронтенд возьмёт
                // точную высоту и stretch не сработает (_arrangeWidgets).
                browserWidget.computeLayoutSize = () => {
                    try {
                        // Единый минимум для обоих режимов (§22.3): только boolean-стейт
                        // (display-флаги), никаких замеров DOM → петель нет по построению.
                        // maxHeight не задаём: в _arrangeWidgets он уходит в prefHeight,
                        // а maxSize по умолчанию Infinity → distributeSpace отдаёт
                        // виджету всё свободное место ноды (растяжение в обоих режимах).
                        return { minHeight: st.minH(), minWidth: MIN_W };
                    } catch (e) { return { minHeight: BASE_H, minWidth: MIN_W }; }
                };
            } catch (e) { /* silent */ }
            // NB (Vue): программного ресайза ноды нет — setSize в Vue-режиме не
            // исполняется (доказано живьём: min-clamp и схлопывания не держатся),
            // размером владеют layout + пользователь. Поэтому здесь только
            // grow-only syncNodeSize (безвреден, если игнорируется) и никаких
            // схлопываний: борьба с layout выглядит как колхоз (дёргание).

            reload();
            requestAnimationFrame(() => { st.hookCanvasDrop?.(); st.enforceMinWidth?.(); st.applyNodeMinWidth?.(); this.graph?.setDirtyCanvas(true, true); });
            return ret;
        };

        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const ret = origOnConnectionsChange?.apply(this, arguments);
            try { this._pl?.dropAutoSockets?.(); } catch (e) { /* silent */ }
            try { this._pl?.checkCycle?.(); } catch (e) { /* silent */ }
            return ret;
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const ret = origOnExecuted?.apply(this, arguments);
            try {
                if (message?.entries && this._pl) {
                    this._pl.reload?.();
                }
                // Дубликат после Queue: такой текст уже есть — предупреждаем где лежит.
                // Пустой объект {} (нет дубля) — truthy, поэтому проверяем id.
                const sd = message?.skipped_duplicate;
                if (sd && sd.id && this._pl) {
                    const st = this._pl;
                    const where = sd.folder || "корне";
                    // Стойкое сообщение: hintMsg показывается только при открытой
                    // панели книги, поэтому пишем в отдельное поле — иначе
                    // предупреждение о дубле после Queue вообще не видно.
                    st.hintSticky = `Дубликат не сохранён — такой промпт уже есть в «${where}».`;
                    try {
                        st.toast("warn", "Prompt Library: дубликат",
                            `Такой промпт уже есть в «${where}» — новая запись не создана.`);
                    } catch (e) { /* silent */ }
                    st.renderHint?.();
                }
            } catch (e) { /* silent */ }
            return ret;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const ret = origOnConfigure?.apply(this, arguments);
            // Синхронный restore папки из данных воркфлоу: info несёт
            // widgets_values_named + widgets_values как в файле, ждать
            // hydration виджетов не нужно. Первый рендер после fetch —
            // уже правильная папка, кадра «Всё» нет.
            try {
                const st = this._pl;
                if (st && info) {
                    let v = null;
                    const named = info.widgets_values_named;
                    if (named && typeof named.save_folder === "string") v = named.save_folder;
                    if (v == null && Array.isArray(info.widgets_values)) {
                        // Позиционный фолбэк: порядок INPUT_TYPES required =
                        // [mode, selected, save_folder] (SPEC §10). Совпадает
                        // и со старыми 4-элементными массивами (prompt был 4-м).
                        const pv = info.widgets_values[2];
                        if (typeof pv === "string") v = pv;
                    }
                    if (v) st.selFolder = v;
                }
            } catch (e) { /* silent */ }
            requestAnimationFrame(() => {
                try { this._pl?.applyPaneLayout?.(); } catch (e) { /* silent */ }
                try { this._pl?.applyNodeMinWidth?.(); } catch (e) { /* silent */ }
                try { this._pl?.dropAutoSockets?.(); } catch (e) { /* silent */ }
                try { this._pl?.checkCycle?.(); } catch (e) { /* silent */ }
                try {
                    // Одноразовая сверка после загрузки базы (без таймеров):
                    // виджет (если гидрация донесла) — свежий источник;
                    // иначе держим sync-значение; мусор → корень.
                    // Клики всегда синхронизируют виджет и selFolder, поэтому
                    // эта сверка никогда не спорит с пользователем.
                    this._pl?.reload?.().then(() => {
                        try {
                            const st = this._pl;
                            if (!st) return;
                            const sf = this.widgets?.find((w) => w.name === "save_folder");
                            const wv = ((sf && sf.value) || "").trim();
                            // Валидны: служебные ветки + реальные папки из базы.
                            // Виджет теперь тоже несёт __fav/__root (см. syncSaveFolder).
                            const valid = (f) => !!f && (f === "__all" || f === "__fav" || f === "__root" || st.folders.includes(f));
                            let want = null;
                            if (valid(wv)) want = wv;
                            else if (st.selFolder !== "__all" && !valid(st.selFolder)) want = "__all";
                            if (want !== null && want !== st.selFolder) {
                                st.selFolder = want;
                                st.syncSaveFolder?.();
                                st.renderTree?.();
                                st.render?.();
                            }
                        } catch (e) { /* silent */ }
                    }).catch(() => {});
                } catch (e) { /* silent */ }
            });
            return ret;
        };

        const origOnDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            try { this._pl?.checkCycle?.(); } catch (e) { /* silent */ }
            return origOnDrawForeground?.apply(this, arguments);
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const st = this._pl;
            try { st?.full?.clear?.(); } catch (e) { /* silent */ }
            try { plLiveStates.delete(st); } catch (e) { /* silent */ }
            try { plModeWatchers.delete(st?.onModeChange); } catch (e) { /* silent */ }
            // Снимаем слушатели с ДОЛГОЖИВУЩИХ объектов (app.api / настройки).
            // Без этого удалённая нода не собирается GC и продолжает отвечать
            // reload() на каждый broadcast — запрос /prompt_library/list на каждую
            // выгрузку воркфлоу за сессию.
            try {
                if (st?.apiListener && st.apiTarget?.removeEventListener) {
                    st.apiTarget.removeEventListener("prompt_library/refresh", st.apiListener);
                }
            } catch (e) { /* silent */ }
            try {
                if (st?.settingsListener && st.settingsTarget?.removeEventListener) {
                    st.settingsTarget.removeEventListener("Comfy.VueNodes.Enabled.change", st.settingsListener);
                }
            } catch (e) { /* silent */ }
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
