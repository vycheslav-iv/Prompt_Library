/* Диагностика залипшей раскладки ноды PromptLibrary — вставить в F12 → Console.
 *
 * v2: плюс блок overlay (w.width, живой ли w.node, lowQuality) и инлайн
 * обёртки .dom-widget — именно её ширина зажимает контент.
 * Ничего не меняет, только печатает JSON.
 */
(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: px(r.width), h: px(r.height), x: px(r.x), y: px(r.y) };
  };
  const css = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs[p];
    return out;
  };
  const chain = (el, depth) => {
    const out = [];
    for (let e = el, i = 0; e && e !== document.body && i < (depth || 8); e = e.parentElement, i++) {
      out.push({
        tag: e.tagName,
        cls: String(e.className || "").split(" ").slice(0, 3).join("."),
        testid: (e.dataset && e.dataset.testid) || null,
        node: (e.dataset && e.dataset.nodeId) || null,
        rect: rect(e),
        css: css(e, ["display", "flex", "width", "minWidth", "maxWidth", "overflowX", "gridTemplateColumns"]),
      });
    }
    return out;
  };
  const kids = (el, limit) => {
    if (!el) return null;
    const out = [];
    for (const c of Array.from(el.children).slice(0, limit || 8)) {
      out.push({
        tag: c.tagName,
        cls: String(c.className || "").split(" ").slice(0, 2).join("."),
        rect: rect(c),
        inline: (c.getAttribute("style") || "").slice(0, 120),
      });
    }
    return out;
  };

  const app = window.app;
  const report = {
    js: (window.app && window.app.ui && window.app.ui.lastVersion) || null,
    renderMode: window.LiteGraph && window.LiteGraph.vueNodesMode ? "vue" : "canvas",
    zoom: app && app.canvas && app.canvas.ds ? app.canvas.ds.scale : null,
    panelOpen: !!document.querySelector('[data-testid="properties-panel"]'),
    nodes: {},
  };

  const nodes = ((app && app.graph && app.graph._nodes) || []).filter(
    (n) => String((n && n.type) || "").toLowerCase() === "promptlibrary"
  );

  for (const n of nodes) {
    const info = { id: n.id, size: { w: px(n.size[0]), h: px(n.size[1]) }, pos: { x: n.pos[0], y: n.pos[1] } };
    const w = (n.widgets || []).find((x) => x.name === "pl_browser");
    info.widget = w ? { computedHeight: w.computedHeight, lastY: w.last_y, hidden: !!w.hidden } : null;
    if (w) {
      // v2: геометрия, которую DomWidgets.vue подставляет в оверлей:
      // size = [(w.width ?? node.width) - 2*margin, ...]. Если w.width застыло
      // или w.node — протухший клон, оверлей уже не догонит живую ноду.
      const live = app.graph.getNodeById(n.id);
      info.overlay = {
        wWidth: w.width ?? null,
        wY: w.y ?? null,
        wMargin: w.margin ?? null,
        wNodeIsLive: w.node === live,
        wNodeSize: w.node ? { w: px(w.node.size[0]), h: px(w.node.size[1]) } : null,
        wNodeWidth: w.node ? px(w.node.width) : null,
        lowQuality: !!(app.canvas && app.canvas.low_quality),
        hideOnZoom: !!(w.options && w.options.hideOnZoom),
      };
    }
    const el = w && w.element;
    // el — ЭТО и есть наш root (движок отдаёт виджету наш корневой элемент).
    // v2: обёртка .dom-widget (DomWidget.vue) — её инлайн-ширина и решает.
    const wrap = el && el.parentElement && /(^|\s)dom-widget(\s|$)/.test(el.parentElement.className || "")
      ? el.parentElement : null;
    info.root = el ? {
      rect: rect(el),
      inline: (el.getAttribute("style") || "").slice(0, 240),
      css: css(el, ["width", "minWidth", "maxWidth", "height", "display", "flex", "overflow"]),
      children: kids(el, 6),
    } : null;
    if (el) info.parents = chain(el.parentElement, 7);
    if (wrap) info.wrapper = { rect: rect(wrap), inline: (wrap.getAttribute("style") || "").slice(0, 300) };
    const nodeEl = document.querySelector(`[data-node-id="${n.id}"]`);
    if (nodeEl) {
      const cs = getComputedStyle(nodeEl);
      info.cssVars = {
        nodeWidth: cs.getPropertyValue("--node-width").trim(),
        nodeHeight: cs.getPropertyValue("--node-height").trim(),
        minNodeWidth: cs.getPropertyValue("--min-node-width").trim(),
        inlineMinWidth: nodeEl.style.minWidth,
      };
      info.nodeEl = { rect: rect(nodeEl) };
      info.nodeChain = chain(nodeEl.firstElementChild, 4);
    }
    report.nodes[n.id] = info;
  }

  console.log(JSON.stringify(report, null, 2));
  return "готово: JSON выше (скопировать целиком)";
})();
