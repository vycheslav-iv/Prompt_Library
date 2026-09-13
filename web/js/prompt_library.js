const { app } = window.comfyAPI.app;

function setWidgetDisabled(w, val) {
    if (!w) return;
    if (w.options) w.options.disabled = val;
    try { w.disabled = val; } catch (e) {}
}

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
    };
}

app.registerExtension({
    name: "PromptLibrary",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptLibrary") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = origOnNodeCreated?.apply(this, arguments);

            // Скрыть технический selected (он управляется кликами по списку)
            const selWidget = this.widgets?.find((w) => w.name === "selected");
            if (selWidget) {
                selWidget.hidden = true;
                selWidget.computeSize = () => [0, -4];
            }

            // --- DOM: библиотека ---
            const root = document.createElement("div");
            root.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:340px;";

            // Плашка входящего промпта
            const incomingWrap = document.createElement("div");
            incomingWrap.style.cssText = "display:none;flex-direction:column;gap:2px;border:1px solid #333;border-radius:4px;padding:4px 6px;background:#1a1a1a;";
            const incomingLabel = document.createElement("div");
            incomingLabel.style.cssText = "color:#888;font-size:10px;";
            incomingLabel.textContent = "Входящий промпт (будет записан):";
            const incomingText = document.createElement("div");
            incomingText.style.cssText = "color:#ddd;font-size:11px;max-height:72px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;resize:vertical;";
            incomingText.textContent = "—";
            incomingWrap.appendChild(incomingLabel);
            incomingWrap.appendChild(incomingText);

            // Тулбар: поиск + сортировка (как картотека)
            const toolbar = document.createElement("div");
            toolbar.style.cssText = "display:flex;gap:6px;";
            const search = document.createElement("input");
            search.placeholder = "Поиск по названию и тексту...";
            search.style.cssText = "flex:1;min-width:0;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 6px;";
            const sortSel = document.createElement("select");
            sortSel.title = "Порядок полки";
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
                <option value="large">🖼 Крупные</option>
                <option value="medium">🎞 Средние</option>
                <option value="list">📋 Список</option>`;
            try {
                const savedView = localStorage.getItem("promptLibrary.view");
                if (savedView) viewSel.value = savedView;
            } catch (e) { /* silent */ }
            if (!["large", "medium", "list"].includes(viewSel.value)) viewSel.value = "large";
            toolbar.appendChild(search);
            toolbar.appendChild(sortSel);
            toolbar.appendChild(viewSel);

            // Ряд: дерево папок | список книг
            const main = document.createElement("div");
            main.style.cssText = "display:flex;gap:6px;min-height:0;";

            const treeBox = document.createElement("div");
            treeBox.style.cssText = "width:38%;min-width:120px;display:flex;flex-direction:column;gap:4px;";
            const treeHead = document.createElement("div");
            treeHead.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
            const treeTitle = document.createElement("div");
            treeTitle.style.cssText = "color:#888;font-size:11px;font-weight:bold;";
            treeTitle.textContent = "📁 Полки";
            const newFolderBtn = document.createElement("button");
            newFolderBtn.textContent = "+ Полка";
            newFolderBtn.title = "Создать папку (в текущей — подпапку)";
            newFolderBtn.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;";
            treeHead.appendChild(treeTitle);
            treeHead.appendChild(newFolderBtn);
            const tree = document.createElement("div");
            tree.style.cssText = "display:flex;flex-direction:column;gap:2px;max-height:300px;overflow-y:auto;border:1px solid #333;border-radius:4px;padding:4px;background:#191919;";
            treeBox.appendChild(treeHead);
            treeBox.appendChild(tree);

            const list = document.createElement("div");
            list.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;max-height:336px;overflow-y:auto;";

            main.appendChild(treeBox);
            main.appendChild(list);

            const hint = document.createElement("div");
            hint.style.cssText = "color:#888;font-size:11px;";
            hint.textContent = "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.";

            // --- Панель книги: название, полка, полный текст ---
            const detail = document.createElement("div");
            detail.style.cssText = "display:none;flex-direction:column;gap:4px;border:1px solid #4a9eff;border-radius:4px;padding:6px;background:#16202f;";

            const dTitle = document.createElement("input");
            dTitle.placeholder = "Название";
            dTitle.readOnly = true;
            dTitle.style.cssText = "background:#111;color:#fff;border:1px solid #444;border-radius:4px;padding:4px 6px;font-size:12px;font-weight:bold;";
            const dFolder = document.createElement("input");
            dFolder.placeholder = "Полка: Фото/Портреты";
            dFolder.readOnly = true;
            dFolder.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 6px;font-size:11px;";
            const dText = document.createElement("textarea");
            dText.readOnly = true;
            dText.rows = 5;
            dText.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px;font-size:11px;resize:vertical;";
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
            const bEdit = mkBtn("✏️ Редактировать", "Изменить название, полку и текст");
            const bSave = mkBtn("💾 Сохранить", "Сохранить изменения");
            bSave.style.display = "none";
            dBtns.appendChild(bCopy);
            dBtns.appendChild(bEdit);
            dBtns.appendChild(bSave);

            detail.appendChild(dTitle);
            detail.appendChild(dFolder);
            detail.appendChild(dText);
            detail.appendChild(dMeta);
            detail.appendChild(dBtns);

            root.appendChild(incomingWrap);
            root.appendChild(toolbar);
            root.appendChild(main);
            root.appendChild(detail);
            root.appendChild(hint);

            const st = {
                root, search, sortSel, viewSel, tree, list, hint, detail,
                dTitle, dFolder, dText, dMeta, bSave,
                incomingWrap, incomingText,
                entries: [], folders: [], full: new Map(),
                detailId: null, selFolder: "__all",
            };
            this._pl = st;

            const reload = async () => {
                try {
                    const r = await fetch("/prompt_library/list");
                    if (!r.ok) return;
                    const data = await r.json();
                    st.entries = (data.entries || []).map(plMap);
                    st.folders = data.folders || [];
                    renderTree();
                    render();
                } catch (e) { /* silent */ }
            };
            st.reload = reload;

            // --- Дерево полок ---
            const folderRow = (key, label, depth, isFolder) => {
                const row = document.createElement("div");
                const active = st.selFolder === key;
                row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:4px;cursor:pointer;font-size:11px;color:${active ? "#fff" : "#ccc"};background:${active ? "#2c4a73" : "transparent"};padding-left:${4 + depth * 14}px;`;
                const name = document.createElement("span");
                name.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                name.textContent = label;
                name.title = isFolder ? key : label;
                row.appendChild(name);
                if (isFolder) {
                    const rn = document.createElement("button");
                    rn.textContent = "✏️"; rn.title = "Переименовать полку";
                    rn.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    rn.onclick = async (ev) => {
                        ev.stopPropagation();
                        const leaf = key.split("/").pop();
                        const next = prompt("Новое название полки:", leaf);
                        if (!next || !next.trim() || next.trim() === leaf) return;
                        const parent = key.split("/").slice(0, -1).join("/");
                        const newPath = parent ? `${parent}/${next.trim()}` : next.trim();
                        try {
                            const r = await fetch("/prompt_library/folder_rename", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ old: key, new: newPath }),
                            });
                            if (r.ok) {
                                if (st.selFolder === key) st.selFolder = newPath;
                                await reload();
                            } else alert("Не удалось переименовать.");
                        } catch (e) { alert("Не удалось переименовать."); }
                    };
                    const del = document.createElement("button");
                    del.textContent = "🗑"; del.title = "Удалить полку (книги переедут в корень)";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить полку «${key}» с подполками? Книги не пропадут — переедут в корень.`)) return;
                        try {
                            const r = await fetch("/prompt_library/folder_delete", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ path: key }),
                            });
                            if (r.ok) {
                                if (st.selFolder === key || st.selFolder.startsWith(key + "/")) st.selFolder = "__all";
                                await reload();
                            }
                        } catch (e) { /* silent */ }
                    };
                    row.appendChild(rn);
                    row.appendChild(del);
                }
                row.onclick = () => { st.selFolder = key; renderTree(); render(); };
                return row;
            };

            const renderTree = () => {
                st.tree.innerHTML = "";
                st.tree.appendChild(folderRow("__all", "📚 Всё", 0, false));
                st.tree.appendChild(folderRow("__fav", "★ Избранное", 0, false));
                st.tree.appendChild(folderRow("__root", "📥 Без полки", 0, false));
                const all = [...new Set([...st.folders, ...st.entries.map((e) => e.folder).filter(Boolean)])].sort();
                const kids = new Map(); // parent -> [childPath]
                for (const f of all) {
                    const parent = f.split("/").slice(0, -1).join("/");
                    if (!kids.has(parent)) kids.set(parent, []);
                    kids.get(parent).push(f);
                }
                const walk = (parent, depth) => {
                    for (const f of (kids.get(parent) || [])) {
                        st.tree.appendChild(folderRow(f, "📁 " + f.split("/").pop(), depth, true));
                        walk(f, depth + 1);
                    }
                };
                walk("", 0);
            };

            newFolderBtn.onclick = async () => {
                const parent = (st.selFolder && !st.selFolder.startsWith("__")) ? st.selFolder : "";
                const name = prompt(parent ? `Новая подполка в «${parent}»: ` : "Новая полка:");
                if (!name || !name.trim()) return;
                try {
                    const r = await fetch("/prompt_library/folder_create", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ parent, name: name.trim() }),
                    });
                    if (r.ok) {
                        const data = await r.json();
                        st.selFolder = data.path;
                        await reload();
                    }
                } catch (e) { /* silent */ }
            };

            // --- Список книг ---
            const sortedFiltered = () => {
                const q = (st.search.value || "").toLowerCase();
                let arr = st.entries.filter((e) => {
                    if (st.selFolder === "__fav" && !e.favorite) return false;
                    else if (st.selFolder === "__root" && e.folder) return false;
                    else if (st.selFolder && !st.selFolder.startsWith("__") && e.folder !== st.selFolder) return false;
                    if (q && !((e.title || "") + "\n" + (e.head || "") + "\n" + (e.folder || "")).toLowerCase().includes(q)) return false;
                    return true;
                });
                const by = st.sortSel.value;
                const ts = (s) => s || "";
                if (by === "title") arr = [...arr].sort((a, b) => (a.title || a.head).localeCompare(b.title || b.head, "ru"));
                else if (by === "old") arr = [...arr].sort((a, b) => ts(a.created_at) < ts(b.created_at) ? -1 : 1);
                else if (by === "used") arr = [...arr].sort((a, b) => ts(b.last_used || "") < ts(a.last_used || "") ? -1 : 1);
                else arr = [...arr].sort((a, b) => ts(b.created_at) < ts(a.created_at) ? -1 : 1);
                return arr;
            };

            const render = () => {
                const mode = st.viewSel.value || "large";
                const grid = mode !== "list";
                const imgSize = mode === "large" ? 192 : mode === "medium" ? 128 : 96;
                st.list.style.flexDirection = grid ? "row" : "column";
                st.list.style.flexWrap = grid ? "wrap" : "nowrap";
                st.list.style.alignContent = grid ? "flex-start" : "";
                st.list.innerHTML = "";
                const selVal = selWidget ? selWidget.value : "";
                let shown = 0;
                for (const e of sortedFiltered()) {
                    const card = document.createElement("div");
                    card.style.cssText = grid
                        ? `display:flex;flex-direction:column;gap:4px;width:${imgSize + 12}px;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${e.id === selVal ? "#4a9eff" : "#333"};background:${e.id === selVal ? "#1e2c44" : "#1e1e1e"};flex-shrink:0;`
                        : `display:flex;gap:6px;align-items:center;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${e.id === selVal ? "#4a9eff" : "#333"};background:${e.id === selVal ? "#1e2c44" : "#1e1e1e"};`;

                    const img = document.createElement("img");
                    img.style.cssText = `width:${imgSize}px;height:${imgSize}px;object-fit:cover;border-radius:3px;background:#222;flex-shrink:0;`;
                    if (e.has_preview) img.src = `/prompt_library/preview?id=${encodeURIComponent(e.id)}&t=${Date.now()}`;
                    else img.style.display = "none";

                    const body = document.createElement("div");
                    body.style.cssText = grid ? "min-width:0;text-align:center;" : "flex:1;min-width:0;";
                    const title = document.createElement("div");
                    title.style.cssText = "color:#fff;font-size:12px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    title.textContent = e.title || e.head || "(без названия)";
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
                        ? (e.folder || "Без полки")
                        : `${e.folder || "Без полки"} · ${e.created_at || ""}${e.last_used ? " · выдана " + e.last_used : ""}`;
                    body.appendChild(meta);

                    const fav = document.createElement("button");
                    fav.textContent = e.favorite ? "★" : "☆";
                    fav.title = "В избранное";
                    fav.style.cssText = "background:none;border:none;color:#e8c33a;cursor:pointer;font-size:14px;flex-shrink:0;";
                    fav.onclick = async (ev) => {
                        ev.stopPropagation();
                        try {
                            await fetch("/prompt_library/favorite", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: e.id, favorite: !e.favorite }),
                            });
                            e.favorite = !e.favorite;
                            render();
                        } catch (err) { /* silent */ }
                    };

                    const del = document.createElement("button");
                    del.textContent = "🗑";
                    del.title = "Удалить книгу";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить «${e.title || e.head}»?`)) return;
                        try {
                            await fetch("/prompt_library/delete", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: e.id }),
                            });
                            st.entries = st.entries.filter((x) => x.id !== e.id);
                            if (st.detailId === e.id) { st.detailId = null; st.detail.style.display = "none"; }
                            renderTree(); render();
                        } catch (err) { /* silent */ }
                    };

                    card.onclick = async () => {
                        if (selWidget) selWidget.value = e.id;
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
                                st.dMeta.textContent = `№ ${full.id} · создана ${full.created_at || "—"} · выдана ${full.last_used || "—"}`;
                                st.detail.style.display = "flex";
                                st.hint.textContent = "Включите «Выдавать выбранный» для подачи текста в CLIP.";
                            }
                        } catch (err) { /* silent */ }
                        const useSel = this.widgets?.find((w) => w.name === "use_selected");
                        if (useSel) { useSel.value = true; setWidgetDisabled(useSel, false); }
                        render();
                        this.graph?.setDirtyCanvas(true, true);
                    };

                    // В сетке кнопки — рядком под названием, в списке — сбоку (display:contents)
                    const actions = document.createElement("div");
                    actions.style.cssText = grid ? "display:flex;gap:2px;justify-content:center;" : "display:contents;";
                    actions.appendChild(fav);
                    actions.appendChild(del);
                    card.appendChild(img);
                    card.appendChild(body);
                    card.appendChild(actions);
                    st.list.appendChild(card);
                    shown++;
                }
                if (!st.detailId) st.hint.textContent = shown ? `Книг на полке: ${shown}` : "Пусто. Запустите Queue или нажмите «Сохранить промпт».";
            };
            st.render = render;
            search.oninput = render;
            sortSel.onchange = render;
            viewSel.onchange = () => {
                try { localStorage.setItem("promptLibrary.view", viewSel.value); } catch (e) { /* silent */ }
                render();
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
                    await fetch("/prompt_library/update", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: st.detailId, title: st.dTitle.value, prompt: st.dText.value, folder: st.dFolder.value }),
                    });
                    st.full.delete(st.detailId);
                    for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = true;
                    st.bSave.style.display = "none";
                    await reload();
                } catch (err) { /* silent */ }
            };

            // Окно промпта: регулируемая высота через виджет prompt_height
            const promptWidget = this.widgets?.find((w) => w.name === "prompt");
            const heightWidget = this.widgets?.find((w) => w.name === "prompt_height");
            const applyPromptHeight = () => {
                try {
                    const h = Math.max(40, Math.min(400, Number(heightWidget?.value) || 84));
                    if (promptWidget) promptWidget.computeSize = (w) => [w || 300, h];
                    this.setSize([this.size[0], this.computeSize()[1]]);
                    this.graph?.setDirtyCanvas(true, true);
                } catch (e) { /* silent */ }
            };
            if (heightWidget) heightWidget.callback = () => applyPromptHeight();
            st.applyPromptHeight = applyPromptHeight;
            requestAnimationFrame(() => applyPromptHeight());

            // Нативная кнопка «Сохранить» — ручное сохранение без запуска Queue
            try {
                const saveBtn = this.addWidget("button", "save_now", null, async () => {
                    const pw = this.widgets?.find((w) => w.name === "prompt");
                    const fw = this.widgets?.find((w) => w.name === "folder") || this.widgets?.find((w) => w.name === "category");
                    const text = (pw?.value || "").trim();
                    if (!text) {
                        saveBtn.label = "⚠️ Пусто — нечего сохранять";
                        setTimeout(() => { saveBtn.label = "💾 Сохранить промпт"; }, 1500);
                        return;
                    }
                    saveBtn.label = "⏳ Сохраняю...";
                    try {
                        const r = await fetch("/prompt_library/add", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ prompt: text, folder: (fw?.value || "").trim() }),
                        });
                        if (r.ok) { await reload(); saveBtn.label = "✅ Сохранено"; }
                        else saveBtn.label = "❌ Ошибка";
                    } catch (err) { saveBtn.label = "❌ Ошибка"; }
                    setTimeout(() => { saveBtn.label = "💾 Сохранить промпт"; }, 1500);
                }, { serialize: false, canvasOnly: true });
                saveBtn.label = "💾 Сохранить промпт";
                const arr = this.widgets;
                arr.splice(arr.indexOf(saveBtn), 1);
                const fIdx = arr.findIndex((w) => w.name === "folder" || w.name === "category");
                arr.splice(fIdx >= 0 ? fIdx + 1 : arr.length, 0, saveBtn);
            } catch (e) { /* silent */ }

            const syncPromptVisibility = () => {
                try {
                    const linked = this.inputs?.find((i) => i.name === "source")?.link != null;
                    st.incomingWrap.style.display = linked ? "flex" : "none";
                    if (linked && promptWidget?.value) st.incomingText.textContent = promptWidget.value;
                    this.setSize([this.size[0], this.computeSize()[1]]);
                    this.graph?.setDirtyCanvas(true, true);
                } catch (e) { /* silent */ }
            };
            st.syncPromptVisibility = syncPromptVisibility;
            requestAnimationFrame(() => syncPromptVisibility());

            this.addDOMWidget("pl_browser", "custom", root, {
                serialize: false,
                getValue: () => null,
                setValue: () => {},
            });

            reload();
            requestAnimationFrame(() => this.graph?.setDirtyCanvas(true, true));
            return ret;
        };

        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const ret = origOnConnectionsChange?.apply(this, arguments);
            try { this._pl?.syncPromptVisibility?.(); } catch (e) { /* silent */ }
            return ret;
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const ret = origOnExecuted?.apply(this, arguments);
            try {
                if (message?.text?.[0] !== undefined) {
                    const promptWidget = this.widgets?.find((w) => w.name === "prompt");
                    if (promptWidget && message.text[0] !== promptWidget.value) {
                        promptWidget.value = message.text[0];
                    }
                    if (this._pl?.incomingText) this._pl.incomingText.textContent = message.text[0] || "—";
                }
                if (message?.entries && this._pl) {
                    // Полное обновление списка и дерева (renderTree живёт в замыкании onNodeCreated)
                    this._pl.reload?.();
                }
                if (message?.selected !== undefined) {
                    const w = this.widgets?.find((w) => w.name === "selected");
                    if (w && message.selected) w.value = message.selected;
                }
            } catch (e) { /* silent */ }
            return ret;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const ret = origOnConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                try { this._pl?.applyPromptHeight?.(); } catch (e) { /* silent */ }
                try { this._pl?.reload?.(); } catch (e) { /* silent */ }
            });
            return ret;
        };
    },
});
