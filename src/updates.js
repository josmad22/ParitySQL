// La UI solo coordina estados: Rust consulta, verifica e instala el paquete.
(function () {
  window.createUpdateNotifier = function ({ invoke, Channel, toast, beforeRestart = async () => true }) {
    const button = document.getElementById("updateButton");
    const label = document.getElementById("updateLabel");
    const progress = document.getElementById("updateProgress");
    const announcement = document.getElementById("updateAnnouncement");
    const interval = 6 * 60 * 60 * 1000;
    let phase = "idle";
    let version = "";
    let checking = false;
    let acting = false;
    let stopped = true;
    let configured = true;
    let lastCheck = 0;
    let timer = null;
    let recoveryTimer = null;
    let lastAnnouncedProgress = -1;

    function render(status) {
      const previous = phase;
      phase = status.phase;
      version = status.version || "";
      configured = phase !== "disabled";
      const visible = ["available", "downloading", "ready", "installing"].includes(phase);
      button.hidden = !visible;
      button.dataset.phase = phase;
      button.disabled = phase === "downloading" || phase === "installing";
      button.setAttribute("aria-busy", String(button.disabled));
      document.getElementById("updateDownloadIcon").hidden = phase === "ready" || phase === "installing";
      document.getElementById("updateRestartIcon").hidden = phase !== "ready" && phase !== "installing";
      progress.hidden = phase !== "downloading";
      const labels = { available: "Nueva versión disponible", downloading: "Descargando…", ready: "Reiniciar ahora", installing: "Reiniciando…" };
      label.textContent = labels[phase] || "";
      button.title = phase === "ready"
        ? "Instalar ParitySQL " + version + " y reiniciar. Guarda tus scripts antes de continuar."
        : "Actualizar ParitySQL a la versión " + version;
      button.setAttribute("aria-label", (labels[phase] || "Actualizaciones") + (version ? " · ParitySQL " + version : ""));
      if (previous !== phase) announcement.textContent = visible ? button.getAttribute("aria-label") : "";
    }

    function showProgress(event) {
      if (stopped || phase !== "downloading") return;
      const total = Number(event.total);
      const downloaded = Math.max(0, Number(event.downloaded) || 0);
      const percent = Number.isFinite(total) && total > 0 ? Math.min(100, Math.floor(downloaded / total * 100)) : null;
      progress.classList.toggle("indeterminate", percent === null);
      progress.style.setProperty("--download-progress", (percent === null ? 35 : percent) + "%");
      if (percent === null) progress.removeAttribute("aria-valuenow");
      else progress.setAttribute("aria-valuenow", String(percent));
      label.textContent = percent === 100 ? "Verificando descarga…" : "Descargando…" + (percent === null ? "" : " " + percent + "%");
      const bucket = percent === null ? -1 : Math.floor(percent / 25);
      if (bucket > lastAnnouncedProgress) {
        lastAnnouncedProgress = bucket;
        announcement.textContent = label.textContent;
      }
    }

    async function check() {
      if (stopped || !configured || checking || acting || ["ready", "installing"].includes(phase)) return;
      clearTimeout(recoveryTimer);
      checking = true;
      lastCheck = Date.now();
      if (phase === "available") {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
      }
      try {
        const status = await invoke("check_for_updates");
        if (!stopped && status && typeof status.phase === "string") {
          render(status);
          // Una recarga del WebView puede encontrar una operación que Rust
          // todavía está completando. Consultar su estado no inicia otra descarga.
          if (phase === "checking" || phase === "downloading") recoveryTimer = setTimeout(check, 1500);
        }
      } catch (_) {
        // Una comprobación automática sin red no interrumpe el trabajo ni
        // convierte un fallo de conexión en una actualización disponible.
      } finally {
        checking = false;
        if (phase === "available") {
          button.disabled = false;
          button.setAttribute("aria-busy", "false");
        }
      }
    }

    async function activate() {
      if (acting || stopped || checking) return;
      if (phase === "available") {
        acting = true;
        lastAnnouncedProgress = -1;
        render({ phase: "downloading", version });
        showProgress({ downloaded: 0, total: null });
        try {
          const channel = new Channel();
          channel.onmessage = showProgress;
          const status = await invoke("download_update", { progress: channel });
          if (!stopped) render(status);
        } catch (error) {
          if (!stopped) {
            render({ phase: "available", version });
            toast("No se pudo descargar la actualización: " + String(error), "err");
          }
        } finally { acting = false; }
      } else if (phase === "ready") {
        acting = true;
        try {
          if (!await beforeRestart()) return;
          render({ phase: "installing", version });
          await invoke("install_update");
        } catch (error) {
          if (!stopped) {
            render({ phase: "ready", version });
            toast("No se pudo instalar la actualización: " + String(error), "err");
          }
        } finally { acting = false; }
      }
    }

    function onFocus() { if (Date.now() - lastCheck >= interval) check(); }
    function onOnline() { if (Date.now() - lastCheck >= 60000) check(); }
    function start() {
      if (!stopped) return;
      stopped = false;
      button.addEventListener("click", activate);
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onOnline);
      timer = setInterval(check, interval);
      check();
    }
    function stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(recoveryTimer);
      button.removeEventListener("click", activate);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    }
    return { start, stop, check };
  };
})();
