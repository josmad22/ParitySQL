// El espacio de comparación consume la misma conexión y base activas que Extraer.
(function () {
  window.createCompareWorkspace = function ({ invoke, getContext, toast, openConnections }) {
    const $ = (id) => document.getElementById(id);
    const api = window.SqlCompare;
    const sources = [{ id: "pasted", name: "Contenido pegado", content: "" }];
    let analysis = { modules: [], issues: [] };
    let results = new Map();
    let selectedId = null;
    let sourceId = "pasted";
    let objectView = false;
    let editingSource = false;
    let visible = false;
    let revision = 0;
    let contextKey = "";
    let analysisTimer = null;
    let runTimer = null;
    let running = false;
    let rerun = false;
    let needsCompare = false;
    let importRevision = 0;
    let fileSequence = 0;
    let widthFrame = null;
    let parameterDetailsOpen = false;
    let currentChanges = [];
    let activeChange = -1;
    let objectQuery = "";
    let objectFilter = "all";
    let objectSort = "number";
    let objectSortDirection = 1;
    let hoveredRow = null;
    let hoveredElements = [];
    let hoverPointer = null;
    let hoverFrame = null;
    const objectCollator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

    const currentSource = () => sources.find((s) => s.id === sourceId) || sources[0];
    const currentObject = () => analysis.modules.find((m) => m.id === selectedId);
    const validModules = () => analysis.modules.filter((m) => !m.error);
    const statusText = { pending: "Pendiente", loading: "Consultando…", same: "Sin cambios", changed: "Con cambios", missing: "No encontrado", unavailable: "Sin definición", error: "Error", invalid: "Incompleto", duplicate: "Duplicado" };

    function textElement(tag, className, value) {
      const el = document.createElement(tag);
      el.className = className;
      el.textContent = value;
      return el;
    }

    function scheduleRun(delay = 650) {
      clearTimeout(runTimer);
      if (!visible || !needsCompare) return;
      runTimer = setTimeout(() => process(false), delay);
    }

    function invalidate() {
      revision++;
      needsCompare = true;
      rerun = false;
      results = new Map();
      clearTimeout(runTimer);
      $("compareSummary").textContent = "";
      $("compareHint").textContent = "Selecciona un objeto para revisar su definición y sus diferencias.";
    }

    function syncScroll() {
      const input = $("sourceSql");
      $("sourceHighlight").scrollTop = input.scrollTop;
      $("sourceHighlight").scrollLeft = input.scrollLeft;
      $("sourceLines").style.transform = "translateY(-" + input.scrollTop + "px)";
    }

    function highlight() {
      const text = $("sourceSql").value;
      $("sourceHighlight").innerHTML = window.highlightSql(text + "\n");
      $("sourceLines").textContent = Array.from({ length: text.split("\n").length }, (_, i) => i + 1).join("\n");
      syncScroll();
    }

    function updateSourceMode() {
      const item = currentObject();
      const comparison = item && results.get(item.id) && results.get(item.id).comparison;
      const showObject = Boolean(objectView && item);
      const aligned = Boolean(showObject && comparison);
      $("sourceInputEditor").hidden = aligned;
      $("sourceDiff").hidden = !aligned;
      $("sourceDiffWrap").hidden = !aligned;
      $("sourceSql").readOnly = showObject;
      $("showSourceBtn").hidden = !item || (!showObject && !comparison);
      $("showSourceBtn").textContent = showObject ? "Editar contenido completo" : "Ver comparación alineada";
    }

    function syncComparisonScroll(from) {
      if (!visible || $("sourceDiff").hidden || !objectView) return;
      const to = from === $("sourceDiff") ? $("compareResults") : $("sourceDiff");
      const top = Math.min(from.scrollTop, to.scrollHeight - to.clientHeight);
      const left = Math.min(from.scrollLeft, to.scrollWidth - to.clientWidth);
      // Comparar las posiciones evita que los eventos de scroll se realimenten.
      for (const panel of [from, to]) {
        if (Math.abs(panel.scrollTop - top) > 0.5) panel.scrollTop = top;
        if (Math.abs(panel.scrollLeft - left) > 0.5) panel.scrollLeft = left;
      }
    }

    function highlightHoveredRow(index) {
      if (index === hoveredRow) return;
      for (const row of hoveredElements) row.classList.remove("hover-row");
      hoveredElements = [];
      hoveredRow = index;
      if (index === null) return;
      for (const panel of [$("sourceDiff"), $("compareResults")]) {
        const row = panel.querySelector('[data-row="' + index + '"]');
        if (row) { row.classList.add("hover-row"); hoveredElements.push(row); }
      }
    }

    function refreshHoveredRow() {
      hoverFrame = null;
      if (!hoverPointer || !visible || !objectView || $("sourceDiff").hidden) {
        highlightHoveredRow(null);
        return;
      }
      const element = document.elementFromPoint(hoverPointer.x, hoverPointer.y);
      const row = element && element.closest(".diff-line[data-row]");
      highlightHoveredRow(row && hoverPointer.panel.contains(row) ? row.dataset.row : null);
    }

    function queueHoveredRow() {
      if (hoverFrame === null) hoverFrame = requestAnimationFrame(refreshHoveredRow);
    }

    function clearHoveredRow() {
      hoverPointer = null;
      highlightHoveredRow(null);
    }

    function sizeAlignedCode() {
      widthFrame = null;
      if (!visible || $("sourceDiff").hidden) { updateChangeOverview(); return; }
      const left = $("sourceDiff");
      const right = $("compareResults");
      const codes = [left.querySelector(".diff-code"), right.querySelector(".diff-code")];
      if (codes.some((code) => !code)) return;
      const top = left.scrollTop;
      const horizontal = left.scrollLeft;
      for (const code of codes) code.style.width = "";
      const width = Math.ceil(Math.max(...codes.map((code) => code.scrollWidth), left.clientWidth, right.clientWidth));
      // Un ancho común conserva los mismos límites de scroll en ambos lados,
      // incluso cuando solo una versión contiene una línea muy larga.
      for (const code of codes) code.style.width = width + "px";
      for (const panel of [left, right]) {
        panel.scrollTop = top;
        panel.scrollLeft = horizontal;
      }
      updateChangeOverview();
      queueHoveredRow();
    }

    function queueAlignedSize() {
      if (widthFrame === null) widthFrame = requestAnimationFrame(sizeAlignedCode);
    }

    function overviewMetrics(track, panel) {
      const height = track.clientHeight;
      const thumbHeight = Math.min(height, Math.max(24, height * panel.clientHeight / Math.max(1, panel.scrollHeight)));
      return { thumbHeight, travel: height - thumbHeight, maximum: Math.max(0, panel.scrollHeight - panel.clientHeight) };
    }

    function updateChangeOverview() {
      for (const [nav, panel] of [[$("sourceChanges"), $("sourceDiff")], [$("targetChanges"), $("compareResults")]]) {
        const track = nav.querySelector(".change-track");
        if (!track) continue;
        // Deja libre la altura que ocupa la barra horizontal del código.
        nav.style.paddingBottom = Math.max(0, panel.offsetHeight - panel.clientHeight) + "px";
        const { thumbHeight, travel, maximum } = overviewMetrics(track, panel);
        const viewport = track.querySelector(".change-viewport");
        viewport.style.top = (maximum ? panel.scrollTop / maximum * travel : 0) + "px";
        viewport.style.height = thumbHeight + "px";
        viewport.setAttribute("aria-valuemax", String(maximum));
        viewport.setAttribute("aria-valuenow", String(Math.round(panel.scrollTop)));
        viewport.setAttribute("aria-disabled", String(maximum === 0));
        track.setAttribute("aria-disabled", String(maximum === 0));
      }
    }

    function bindOverviewScroll(track, panel) {
      let drag = null;
      const viewport = track.querySelector(".change-viewport");
      const scrollTo = (top) => {
        panel.scrollTop = top;
        syncComparisonScroll(panel);
        updateChangeOverview();
        queueHoveredRow();
      };
      const dragTo = (y) => {
        const { travel, maximum } = overviewMetrics(track, panel);
        const offset = Math.max(0, Math.min(travel, y - track.getBoundingClientRect().top - drag.offset));
        scrollTo(travel ? offset / travel * maximum : 0);
      };
      track.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(".change-marker")) return;
        const { thumbHeight, travel, maximum } = overviewMetrics(track, panel);
        if (!maximum) return;
        event.preventDefault();
        viewport.focus({ preventScroll: true });
        const thumbTop = panel.scrollTop / maximum * travel;
        drag = { id: event.pointerId, offset: event.target.closest(".change-viewport") ? event.clientY - track.getBoundingClientRect().top - thumbTop : thumbHeight / 2 };
        track.setPointerCapture(event.pointerId);
        track.classList.add("dragging");
        dragTo(event.clientY);
      });
      track.addEventListener("pointermove", (event) => {
        if (drag && drag.id === event.pointerId) dragTo(event.clientY);
      });
      const endDrag = (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        drag = null;
        track.classList.remove("dragging");
        if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
      };
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) track.addEventListener(type, endDrag);
      track.addEventListener("wheel", (event) => {
        if (!event.deltaY || panel.scrollHeight <= panel.clientHeight) return;
        event.preventDefault();
        scrollTo(panel.scrollTop + event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? panel.clientHeight : 1));
      }, { passive: false });
      track.addEventListener("keydown", (event) => {
        if (event.target !== viewport) return;
        const positions = { ArrowUp: panel.scrollTop - 20, ArrowDown: panel.scrollTop + 20, PageUp: panel.scrollTop - panel.clientHeight * 0.9, PageDown: panel.scrollTop + panel.clientHeight * 0.9, Home: 0, End: panel.scrollHeight };
        if (!(event.key in positions)) return;
        event.preventDefault();
        scrollTo(positions[event.key]);
      });
    }

    function jumpToChange(index) {
      if (!currentChanges[index]) return;
      if ($("sourceDiff").hidden) {
        objectView = true;
        editingSource = false;
        sourceId = currentObject().sourceId;
        renderSources(); renderEditor(); renderTarget();
      }
      activeChange = index;
      const block = currentChanges[index];
      const panel = $("sourceDiff");
      const row = panel.querySelector('[data-row="' + block.start + '"]');
      const rowTop = row.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
      const top = Math.max(0, rowTop - panel.clientHeight * 0.25);
      for (const scroller of [panel, $("compareResults")]) {
        scroller.scrollTop = top;
        scroller.scrollLeft = 0;
        for (const line of scroller.querySelectorAll(".diff-line")) {
          const position = Number(line.dataset.row);
          line.classList.toggle("active-change", position >= block.start && position <= block.end);
        }
      }
      for (const marker of document.querySelectorAll(".change-marker")) {
        const selected = Number(marker.dataset.change) === index;
        marker.classList.toggle("active", selected);
        if (selected) marker.setAttribute("aria-current", "true");
        else marker.removeAttribute("aria-current");
      }
      $("changePosition").textContent = "Diferencia " + (index + 1) + " de " + currentChanges.length;
      updateChangeOverview();
    }

    function renderChangeNavigation(comparison, heading) {
      currentChanges = comparison.changes;
      if (currentChanges.length) {
        const navigation = textElement("div", "diff-navigation", "");
        const position = textElement("span", "", currentChanges.length + " diferencias");
        position.id = "changePosition";
        position.setAttribute("aria-live", "polite");
        navigation.appendChild(position);
        for (const [direction, text, label] of [[-1, "↑", "Diferencia anterior"], [1, "↓", "Diferencia siguiente"]]) {
          const button = textElement("button", "", text);
          button.type = "button";
          button.title = label;
          button.setAttribute("aria-label", label);
          button.onclick = () => jumpToChange(activeChange < 0 ? direction > 0 ? 0 : currentChanges.length - 1 : (activeChange + direction + currentChanges.length) % currentChanges.length);
          navigation.appendChild(button);
        }
        heading.appendChild(navigation);
      }
      const labels = { added: "Añadir al entorno", removed: "Quitar del entorno", modified: "Modificar en el entorno" };
      for (const [nav, panel, label] of [[$("sourceChanges"), $("sourceDiff"), "origen"], [$("targetChanges"), $("compareResults"), "entorno"]]) {
        nav.hidden = false;
        const track = textElement("div", "change-track", "");
        const viewport = textElement("span", "change-viewport", "");
        viewport.tabIndex = 0;
        viewport.setAttribute("role", "scrollbar");
        viewport.setAttribute("aria-label", "Desplazamiento vertical del " + label);
        viewport.setAttribute("aria-controls", panel.id);
        viewport.setAttribute("aria-orientation", "vertical");
        viewport.setAttribute("aria-valuemin", "0");
        track.appendChild(viewport);
        currentChanges.forEach((block, index) => {
          const marker = textElement("button", "change-marker " + block.type, "");
          marker.type = "button";
          marker.dataset.change = index;
          marker.style.top = (block.start + block.end + 1) / (2 * comparison.alignedRows.length) * 100 + "%";
          const location = [block.sourceLine && "origen línea " + block.sourceLine, block.targetLine && "entorno línea " + block.targetLine].filter(Boolean).join(" / ");
          marker.title = labels[block.type] + " · diferencia " + (index + 1) + " · " + location;
          marker.setAttribute("aria-label", marker.title);
          marker.onclick = () => jumpToChange(index);
          track.appendChild(marker);
        });
        nav.appendChild(track);
        bindOverviewScroll(track, panel);
      }
    }

    function renderEditor() {
      const item = currentObject();
      const showObject = objectView && item;
      const source = currentSource();
      updateSourceMode();
      $("sourceSql").value = showObject ? item.definition : source.content;
      $("sourceEditorLabel").textContent = showObject ? item.schema + "." + item.name + " · definición detectada" : source.name;
      $("sourceSql").scrollTop = 0;
      $("sourceSql").scrollLeft = 0;
      highlight();
    }

    function renderSources() {
      const select = $("sourceDocument");
      select.replaceChildren();
      for (const source of sources) {
        const option = document.createElement("option");
        option.value = source.id;
        option.textContent = source.name;
        select.appendChild(option);
      }
      select.value = sourceId;
      $("removeSourceBtn").hidden = sourceId === "pasted";
    }

    function renderIssues() {
      const container = $("sourceIssues");
      container.replaceChildren();
      container.hidden = analysis.issues.length === 0;
      for (const issue of analysis.issues) {
        container.appendChild(textElement("div", "source-issue", issue.source + ": " + issue.message));
      }
    }

    function selectObject(item) {
      selectedId = item.id;
      sourceId = item.sourceId;
      objectView = true;
      editingSource = false;
      renderSources(); renderList(); renderEditor(); renderTarget();
    }

    function renderList(resetScroll = false) {
      const list = $("detectedObjects");
      const body = $("detectedObjectRows");
      const scrollTop = resetScroll ? 0 : list.scrollTop;
      const focused = document.activeElement;
      const focusedId = focused.closest(".detected-object") && focused.closest(".detected-object").dataset.objectId;
      const focusedControl = focused.classList.contains("object-select") ? ".object-select" : focused.classList.contains("object-name-button") ? ".object-name-button" : null;
      body.replaceChildren();
      const entries = analysis.modules.map((item, index) => {
        const result = results.get(item.id);
        const status = item.error ? item.status : result ? result.status : "pending";
        return { item, index: index + 1, status };
      });
      const counts = {
        all: entries.length,
        changed: entries.filter((e) => e.status === "changed").length,
        same: entries.filter((e) => e.status === "same").length,
        procedure: entries.filter((e) => e.item.kind === "PROCEDURE").length,
        function: entries.filter((e) => e.item.kind === "FUNCTION").length,
      };
      $("detectedCount").textContent = counts.all + " objetos";
      $("changedCount").textContent = counts.changed + " con cambios";
      $("sameCount").textContent = counts.same + " sin cambios";
      $("selectedCount").textContent = currentObject() ? "1 seleccionado" : "0 seleccionados";
      const labels = { all: "Todos", changed: "Con cambios", same: "Sin cambios", procedure: "SP", function: "Funciones" };
      for (const button of $("objectFilters").querySelectorAll("button")) {
        const filter = button.dataset.objectFilter;
        button.textContent = labels[filter] + " (" + counts[filter] + ")";
        button.setAttribute("aria-pressed", String(filter === objectFilter));
      }
      const query = objectQuery.trim().toLowerCase();
      const filtered = entries.filter(({ item, status }) => {
        const matchesName = (item.schema + "." + item.name).toLowerCase().includes(query);
        const matchesFilter = objectFilter === "all" || objectFilter === status ||
          objectFilter === "procedure" && item.kind === "PROCEDURE" || objectFilter === "function" && item.kind === "FUNCTION";
        return matchesName && matchesFilter;
      });
      const value = (entry) => objectSort === "name" ? entry.item.schema + "." + entry.item.name
        : objectSort === "source" ? entry.item.source : objectSort === "kind" ? entry.item.kind : statusText[entry.status];
      filtered.sort((a, b) => (objectSort === "number" ? a.index - b.index : objectCollator.compare(value(a), value(b))) * objectSortDirection || a.index - b.index);
      for (const button of document.querySelectorAll("[data-object-sort]")) {
        const active = button.dataset.objectSort === objectSort;
        button.parentElement.setAttribute("aria-sort", active ? objectSortDirection === 1 ? "ascending" : "descending" : "none");
        button.querySelector("span").textContent = active ? objectSortDirection === 1 ? "↑" : "↓" : "↕";
      }
      for (const { item, index, status } of filtered) {
        const qualified = item.schema + "." + item.name;
        const row = document.createElement("tr");
        row.className = "detected-object" + (item.id === selectedId ? " selected" : "");
        row.dataset.objectId = item.id;
        if (item.id === selectedId) row.setAttribute("aria-current", "true");
        const selection = document.createElement("td");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "comparedObject";
        radio.className = "object-select";
        radio.checked = item.id === selectedId;
        radio.setAttribute("aria-label", "Ver comparación de " + qualified);
        radio.onchange = () => { if (radio.checked) selectObject(item); };
        selection.appendChild(radio);
        const name = document.createElement("td");
        const nameButton = textElement("button", "object-name-button", qualified);
        nameButton.type = "button";
        nameButton.title = qualified;
        name.appendChild(nameButton);
        const type = document.createElement("td");
        type.appendChild(textElement("span", "object-type-badge" + (item.kind === "FUNCTION" ? " function" : ""), item.kind === "FUNCTION" ? "Función" : "SP"));
        const file = textElement("td", "object-file", item.source);
        file.title = item.source;
        const state = document.createElement("td");
        state.appendChild(textElement("span", "object-status " + status, statusText[status]));
        row.append(selection, textElement("td", "object-number", index), name, type, file, state);
        row.onclick = (event) => { if (!event.target.closest("input")) selectObject(item); };
        body.appendChild(row);
      }
      if (!filtered.length) {
        const row = document.createElement("tr");
        const cell = textElement("td", "detected-empty", entries.length ? "No hay objetos que coincidan con la búsqueda y el filtro." : "Los SP y funciones aparecerán aquí al pegar o importar su contenido.");
        cell.colSpan = 6;
        row.appendChild(cell);
        body.appendChild(row);
      }
      $("visibleObjectCount").textContent = "Mostrando " + filtered.length + " de " + entries.length + " objetos";
      $("objectFilterNote").textContent = currentObject() && !filtered.some((e) => e.item.id === selectedId) ? "El objeto seleccionado está fuera del filtro." : "";
      if (focusedId && focusedControl) {
        const replacement = Array.from(body.children).find((row) => row.dataset.objectId === focusedId);
        if (replacement) replacement.querySelector(focusedControl).focus({ preventScroll: true });
      }
      list.scrollTop = scrollTop;
    }

    function emptyTarget(title, message) {
      const empty = textElement("div", "empty-state", "");
      empty.append(textElement("div", "empty-title", title), textElement("div", "empty-sub", message));
      $("compareResults").replaceChildren(empty);
    }

    function renderTarget() {
      highlightHoveredRow(null);
      currentChanges = [];
      activeChange = -1;
      for (const nav of [$("sourceChanges"), $("targetChanges")]) { nav.hidden = true; nav.replaceChildren(); }
      const item = currentObject();
      const metadata = $("comparisonDetails");
      metadata.replaceChildren();
      metadata.hidden = !item;
      $("sourceDiff").replaceChildren();
      updateSourceMode();
      $("compareResults").classList.remove("aligned");
      if (!item) {
        emptyTarget("Sin comparación todavía", "Pega código o importa archivos .sql para identificar los objetos y compararlos con el entorno seleccionado.");
        return;
      }
      const result = results.get(item.id);
      const container = $("compareResults");
      container.replaceChildren();
      const heading = textElement("div", "target-object-head", "");
      heading.appendChild(textElement("span", "compare-object-name", item.schema + "." + item.name));
      const status = item.error ? item.status : result ? result.status : "pending";
      heading.appendChild(textElement("span", "object-status " + status, statusText[status]));
      metadata.appendChild(heading);
      if (item.error || !result || !result.comparison) {
        const message = item.error || (result && result.error) || (status === "loading" ? "Recuperando la definición del entorno seleccionado…" : "El objeto está pendiente de consultar en el entorno seleccionado.");
        container.appendChild(textElement("div", "compare-error" + (item.error || (result && result.error) ? "" : " neutral"), message));
        return;
      }
      const comparison = result.comparison;
      heading.appendChild(textElement("div", "comparison-label" + (comparison.same ? " same" : ""), comparison.label));
      if (comparison.parameterChanges && comparison.parameterChanges.length) {
        const details = document.createElement("details");
        details.className = "parameter-details";
        details.open = parameterDetailsOpen;
        details.addEventListener("toggle", () => { parameterDetailsOpen = details.open; });
        details.appendChild(textElement("summary", "", "Cambios de parámetros (" + comparison.parameterChanges.length + ")"));
        for (const change of comparison.parameterChanges) {
          const row = textElement("div", "parameter-change", "");
          row.append(textElement("strong", "", change.name + " · " + change.change),
            textElement("div", "parameter-before", "Actual (entorno): " + change.target),
            textElement("div", "parameter-after", "Propuesta (origen): " + change.source));
          details.appendChild(row);
        }
        metadata.appendChild(details);
      }
      const renderSide = (side) => {
        const code = textElement("div", "diff-code", "");
        code.innerHTML = comparison.alignedRows.map((row, index) => {
          const line = row[side];
          if (!line) return '<div class="diff-line gap" data-row="' + index + '" aria-hidden="true"></div>';
          const sign = line.type === "added" ? "+" : line.type === "removed" ? "−" : "";
          return '<div class="diff-line ' + line.type + '" data-row="' + index + '" data-line="' + line.number + '"><span class="diff-number" aria-hidden="true">' + line.number +
            '</span><span class="diff-sign">' + sign + '</span><span class="diff-text">' + window.highlightSql(line.text) + "</span></div>";
        }).join("");
        return code;
      };
      $("sourceDiff").classList.add("aligned");
      container.classList.add("aligned");
      $("sourceDiff").appendChild(renderSide("left"));
      container.appendChild(renderSide("right"));
      renderChangeNavigation(comparison, heading);
      $("sourceDiff").scrollTop = container.scrollTop = 0;
      $("sourceDiff").scrollLeft = container.scrollLeft = 0;
      queueAlignedSize();
      updateChangeOverview();
    }

    function analyze() {
      clearTimeout(analysisTimer);
      analysisTimer = null;
      const previous = currentObject();
      analysis = api.analyzeSources(sources);
      const retained = previous && analysis.modules.find((m) => m.sourceId === previous.sourceId && m.schema === previous.schema && m.name === previous.name);
      if (!analysis.modules.some((m) => m.id === selectedId)) selectedId = retained ? retained.id : analysis.modules[0] ? analysis.modules[0].id : null;
      renderIssues(); renderList(); renderTarget();
      scheduleRun();
    }

    function onInput() {
      if (objectView) return;
      currentSource().content = $("sourceSql").value;
      currentSource().error = "";
      highlight();
      invalidate();
      renderTarget();
      clearTimeout(analysisTimer);
      analysisTimer = setTimeout(analyze, 250);
    }

    async function importFiles(files) {
      const ticket = importRevision;
      const selected = Array.from(files);
      if (!selected.length) return;
      $("importSqlBtn").disabled = true;
      $("importSqlBtn").textContent = "Leyendo…";
      const imported = [];
      try {
        for (const file of selected) {
          const source = { id: "file-" + ++fileSequence, name: file.name, content: "", error: "" };
          try {
            if (!/\.sql$/i.test(file.name)) throw new Error("Solo se admiten archivos .sql.");
            if (file.size > 10 * 1024 * 1024) throw new Error("El archivo supera el límite de 10 MB.");
            source.content = api.decodeSql(await file.arrayBuffer());
            if (!source.content.trim()) throw new Error("El archivo está vacío.");
          } catch (error) { source.error = error.message; }
          imported.push(source);
        }
        if (ticket !== importRevision) return;
        sources.push(...imported);
        sourceId = imported[0].id;
        objectView = false;
        editingSource = false;
        invalidate(); renderSources(); renderEditor(); analyze();
      } finally {
        $("importSqlBtn").disabled = false;
        $("importSqlBtn").textContent = "Importar .sql";
        $("sqlFiles").value = "";
      }
    }

    async function process(manual = true) {
      clearTimeout(runTimer);
      if (analysisTimer) analyze();
      // analyze puede haber programado una consulta; la llamada actual la sustituye.
      clearTimeout(runTimer);
      if (!visible) return;
      const modules = validModules();
      if (!modules.length) {
        if (manual) toast("No hay objetos válidos para comparar. Revisa el contenido y los errores del listado.", "err");
        return;
      }
      const context = getContext();
      if (context.modalOpen) return;
      if (!context.conn || !context.database) {
        $("compareSummary").textContent = !context.conn ? "Selecciona un entorno" : "Selecciona una base de datos";
        if (manual) {
          toast(!context.conn ? "Configura un entorno de conexión" : "Elige una base de datos", "err");
          if (!context.conn) openConnections();
        }
        return;
      }
      if (running) { if (needsCompare) rerun = true; return; }
      const ticket = revision;
      running = true;
      needsCompare = false;
      $("compareBtn").disabled = true;
      $("compareBtnText").textContent = "Comparando…";
      $("compareResults").setAttribute("aria-busy", "true");
      $("compareSummary").textContent = "Consultando " + modules.length + " objetos…";
      for (const item of modules) results.set(item.id, { status: "loading" });
      renderList(); renderTarget();
      try {
        const definitions = await invoke("fetch_definitions", { conn: context.conn, database: context.database,
          objects: modules.map(({ schema, name }) => ({ schema, name })) });
        if (ticket !== revision) return;
        let changed = 0;
        let same = 0;
        let errors = analysis.modules.length - modules.length;
        modules.forEach((item, i) => {
          const target = definitions[i];
          if (!target || target.error || !target.definition) {
            results.set(item.id, { status: target && target.status !== "ok" && target.status ? target.status : "error", error: target && target.error || "No se recibió la definición del objeto." });
            errors++;
          } else {
            const comparison = api.compareDefinitions(item.definition, target.definition);
            results.set(item.id, { comparison, status: comparison.same ? "same" : "changed" });
            if (comparison.same) same++; else changed++;
          }
        });
        $("compareSummary").textContent = changed + " con cambios · " + same + " sin cambios" + (errors ? " · " + errors + " con error" : "");
        $("compareHint").textContent = context.name + " · " + context.database + " · + añadir / − quitar del entorno";
      } catch (error) {
        if (ticket !== revision) return;
        for (const item of modules) results.set(item.id, { status: "error", error: String(error) });
        $("compareSummary").textContent = "Error al consultar el entorno";
        toast(String(error), "err");
      } finally {
        running = false;
        $("compareBtn").disabled = false;
        $("compareBtnText").textContent = "Procesar y comparar";
        $("compareResults").setAttribute("aria-busy", "false");
        if (ticket === revision && !editingSource && currentObject() && results.get(selectedId) && results.get(selectedId).comparison) {
          objectView = true;
          sourceId = currentObject().sourceId;
          renderSources(); renderEditor();
        }
        renderList(); renderTarget();
        if (rerun && needsCompare) { rerun = false; scheduleRun(200); }
      }
    }

    function refreshContext() {
      const context = getContext();
      $("compareEnv").textContent = context.name || "Sin entorno";
      const key = JSON.stringify([context.conn, context.database]);
      if (key === contextKey) return;
      contextKey = key;
      invalidate(); renderList(); renderTarget(); scheduleRun();
    }

    function setVisible(value) {
      visible = value;
      if (!value) { clearTimeout(runTimer); clearHoveredRow(); return; }
      refreshContext();
      scheduleRun();
    }

    function clear() {
      importRevision++;
      clearTimeout(analysisTimer);
      analysisTimer = null;
      sources.splice(1);
      sources[0].content = "";
      sourceId = "pasted";
      selectedId = null;
      objectView = false;
      editingSource = false;
      objectQuery = "";
      objectFilter = "all";
      objectSort = "number";
      objectSortDirection = 1;
      $("objectSearch").value = "";
      invalidate(); renderSources(); renderEditor(); analyze();
    }

    $("compareBtn").onclick = () => process(true);
    $("objectSearch").addEventListener("input", (event) => { objectQuery = event.target.value; renderList(true); });
    for (const button of $("objectFilters").querySelectorAll("button")) {
      button.onclick = () => { objectFilter = button.dataset.objectFilter; renderList(true); };
    }
    for (const button of document.querySelectorAll("[data-object-sort]")) {
      button.onclick = () => {
        objectSortDirection = objectSort === button.dataset.objectSort ? -objectSortDirection : 1;
        objectSort = button.dataset.objectSort;
        renderList(true);
      };
    }
    $("sourceSql").addEventListener("input", onInput);
    $("sourceSql").addEventListener("scroll", syncScroll);
    for (const panel of [$("sourceDiff"), $("compareResults")]) {
      panel.addEventListener("scroll", () => { syncComparisonScroll(panel); updateChangeOverview(); queueHoveredRow(); }, { passive: true });
      panel.addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch") return;
        hoverPointer = { panel, x: event.clientX, y: event.clientY };
        queueHoveredRow();
      }, { passive: true });
      panel.addEventListener("pointerleave", clearHoveredRow);
    }
    window.addEventListener("blur", clearHoveredRow);
    const resizeObserver = new ResizeObserver(queueAlignedSize);
    resizeObserver.observe($("sourceDiff"));
    resizeObserver.observe($("compareResults"));
    $("importSqlBtn").onclick = () => $("sqlFiles").click();
    $("sqlFiles").addEventListener("change", (event) => importFiles(event.target.files));
    $("clearSourcesBtn").onclick = clear;
    $("sourceDocument").onchange = (event) => {
      sourceId = event.target.value;
      const first = analysis.modules.find((m) => m.sourceId === sourceId);
      selectedId = first ? first.id : null;
      objectView = false;
      editingSource = true;
      renderSources(); renderList(); renderEditor(); renderTarget();
    };
    $("showSourceBtn").onclick = () => {
      objectView = !objectView;
      editingSource = !objectView;
      if (objectView && currentObject()) sourceId = currentObject().sourceId;
      renderSources(); renderEditor(); renderTarget();
      (objectView ? $("sourceDiff") : $("sourceSql")).focus();
    };
    $("removeSourceBtn").onclick = () => {
      const index = sources.findIndex((s) => s.id === sourceId);
      if (index <= 0) return;
      sources.splice(index, 1);
      sourceId = "pasted"; objectView = false;
      editingSource = false;
      invalidate(); renderSources(); renderEditor(); analyze();
    };
    // dragDropEnabled=false permite el drop HTML5 de archivos en WebView2/Windows.
    const pane = $("compareView");
    let dragDepth = 0;
    pane.addEventListener("dragenter", (event) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault(); dragDepth++; pane.classList.add("file-drag");
    });
    pane.addEventListener("dragover", (event) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
    pane.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; pane.classList.remove("file-drag"); } });
    pane.addEventListener("drop", (event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation(); dragDepth = 0; pane.classList.remove("file-drag");
      importFiles(event.dataTransfer.files);
    });
    // Evita que un archivo soltado fuera del panel navegue fuera de la aplicación.
    for (const name of ["dragover", "drop"]) document.addEventListener(name, (event) => {
      if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
    });
    renderSources(); renderEditor(); analyze();
    return { process: () => process(true), refreshContext, setVisible, resume: () => scheduleRun() };
  };
})();
