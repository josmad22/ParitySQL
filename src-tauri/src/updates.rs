use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Disabled,
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    phase: Phase,
    version: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Default)]
pub struct UpdateSession {
    phase: Phase,
    candidate: Option<Update>,
    package: Option<Arc<Vec<u8>>>,
}

pub type UpdateState = Mutex<UpdateSession>;

impl UpdateSession {
    fn status(&self) -> UpdateStatus {
        UpdateStatus {
            phase: self.phase,
            version: self.candidate.as_ref().map(|update| update.version.clone()),
        }
    }

    fn in_progress(&self) -> bool {
        matches!(
            self.phase,
            Phase::Checking | Phase::Downloading | Phase::Ready | Phase::Installing
        )
    }
}

/// La distribución consulta el feed público firmado de GitHub.
/// Se exige HTTPS incluso en desarrollo y no se aceptan modos inseguros de TLS.
fn configured(config: &tauri_plugin_updater::Config) -> bool {
    !config.pubkey.trim().is_empty()
        && !config.endpoints.is_empty()
        && config.endpoints.iter().all(|url| url.scheme() == "https")
        && !config.dangerous_insecure_transport_protocol
        && !config.dangerous_accept_invalid_certs
        && !config.dangerous_accept_invalid_hostnames
        && !config.allow_downgrades
}

/// Consulta la versión sin sustituir una descarga o paquete ya preparado.
pub async fn check(app: AppHandle, state: &UpdateState) -> Result<UpdateStatus, String> {
    {
        let mut session = state.lock().await;
        if session.in_progress() {
            return Ok(session.status());
        }
        let config: tauri_plugin_updater::Config = serde_json::from_value(
            app.config()
                .plugins
                .0
                .get("updater")
                .cloned()
                .unwrap_or_default(),
        )
        .map_err(|e| format!("La configuración de actualizaciones no es válida: {e}"))?;
        if !configured(&config) {
            session.phase = Phase::Disabled;
            session.candidate = None;
            session.package = None;
            return Ok(session.status());
        }
        session.phase = Phase::Checking;
    }
    let result = async {
        app.updater_builder()
            .timeout(Duration::from_secs(20))
            .build()?
            .check()
            .await
    }
    .await;
    let mut session = state.lock().await;
    match result {
        Ok(candidate) => {
            if candidate
                .as_ref()
                .is_some_and(|update| update.download_url.scheme() != "https")
            {
                session.phase = if session.candidate.is_some() {
                    Phase::Available
                } else {
                    Phase::Idle
                };
                return Err("El paquete de actualización debe descargarse mediante HTTPS.".into());
            }
            session.phase = if candidate.is_some() {
                Phase::Available
            } else {
                Phase::Idle
            };
            session.candidate = candidate;
            session.package = None;
            Ok(session.status())
        }
        Err(error) => {
            session.phase = if session.candidate.is_some() {
                Phase::Available
            } else {
                Phase::Idle
            };
            Err(format!("No se pudo comprobar la nueva versión: {error}"))
        }
    }
}

/// Descarga y verifica la firma antes de habilitar el reinicio. Los bytes no se
/// instalan ni se ejecutan mientras el usuario continúa trabajando.
pub async fn download(
    state: &UpdateState,
    progress: Channel<DownloadProgress>,
) -> Result<UpdateStatus, String> {
    let mut update = {
        let mut session = state.lock().await;
        if session.phase == Phase::Ready {
            return Ok(session.status());
        }
        if session.phase != Phase::Available {
            return Err("No hay una actualización disponible para descargar.".into());
        }
        let candidate = session
            .candidate
            .clone()
            .ok_or("No se encontró la actualización anunciada.")?;
        session.phase = Phase::Downloading;
        candidate
    };
    update.timeout = Some(Duration::from_secs(300));
    let mut downloaded = 0u64;
    let mut last_progress = Instant::now() - Duration::from_secs(1);
    let result = update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if last_progress.elapsed() >= Duration::from_millis(80) {
                    let _ = progress.send(DownloadProgress { downloaded, total });
                    last_progress = Instant::now();
                }
            },
            || {},
        )
        .await;
    let mut session = state.lock().await;
    match result {
        Ok(bytes) => {
            let size = bytes.len() as u64;
            let _ = progress.send(DownloadProgress {
                downloaded: size,
                total: Some(size),
            });
            session.package = Some(Arc::new(bytes));
            session.phase = Phase::Ready;
            Ok(session.status())
        }
        Err(error) => {
            session.package = None;
            session.phase = Phase::Available;
            Err(format!(
                "No se pudo descargar o verificar la actualización: {error}"
            ))
        }
    }
}

/// En Windows el instalador cierra la app y la vuelve a abrir; se invoca
/// únicamente cuando el usuario pulsa «Reiniciar ahora».
pub async fn install(app: AppHandle, state: &UpdateState) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(
            "La instalación de actualizaciones requiere una versión empaquetada de ParitySQL."
                .into(),
        );
    }
    let (update, package) = {
        let mut session = state.lock().await;
        if session.phase != Phase::Ready {
            return Err("La actualización todavía no está lista para instalar.".into());
        }
        let update = session
            .candidate
            .clone()
            .ok_or("No se encontró la actualización preparada.")?;
        let package = session
            .package
            .clone()
            .ok_or("Primero descarga la actualización.")?;
        session.phase = Phase::Installing;
        (update.restart_after_install(true), package)
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || update.install(package.as_slice())).await;
    match result {
        Ok(Ok(())) => {
            app.restart();
        }
        result => {
            state.lock().await.phase = Phase::Ready;
            let message = match result {
                Ok(Err(error)) => error.to_string(),
                Err(error) => error.to_string(),
                _ => unreachable!(),
            };
            Err(format!("No se pudo instalar la actualización: {message}"))
        }
    }
}

#[cfg(test)]
mod tests {
    fn config() -> tauri_plugin_updater::Config {
        serde_json::from_value(serde_json::json!({
            "pubkey": "public-key-for-config-test",
            "endpoints": ["https://example.com/latest.json"]
        }))
        .unwrap()
    }

    #[test]
    fn empty_or_insecure_configuration_never_checks_for_updates() {
        assert!(!super::configured(&tauri_plugin_updater::Config::default()));
        assert!(super::configured(&config()));
        let mut unsafe_config = config();
        unsafe_config.dangerous_accept_invalid_certs = true;
        assert!(!super::configured(&unsafe_config));
        let mut downgrade = config();
        downgrade.allow_downgrades = true;
        assert!(!super::configured(&downgrade));
        let mut insecure_endpoint = config();
        insecure_endpoint.endpoints[0].set_scheme("http").unwrap();
        assert!(!super::configured(&insecure_endpoint));
    }

    #[test]
    fn public_distribution_uses_the_signed_github_feed() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(super::configured(&updater));
        assert_eq!(updater.endpoints.len(), 1);
        assert_eq!(
            updater.endpoints[0].as_str(),
            "https://github.com/josmad22/ParitySQL/releases/latest/download/latest.json"
        );
        assert_eq!(config["bundle"]["targets"], serde_json::json!(["nsis"]));
        // Los artefactos firmados se habilitan solo al compilar una release.
        assert_eq!(config["bundle"]["createUpdaterArtifacts"], false);
    }

    #[tokio::test]
    async fn a_session_without_a_release_cannot_download_or_prepare_restart() {
        let state = super::UpdateState::default();
        assert!(
            super::download(&state, tauri::ipc::Channel::new(|_| Ok(())))
                .await
                .is_err()
        );
        let session = state.lock().await;
        assert!(session.package.is_none());
        assert!(!session.in_progress());
    }
}

#[cfg(test)]
mod published {
    use std::time::Duration;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::App;
    use tauri_plugin_updater::UpdaterExt;

    fn app_at(version: &str) -> App<MockRuntime> {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = mock_context(noop_assets());
        context.package_info_mut().version = version.parse().unwrap();
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), config["plugins"]["updater"].clone());
        mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "descarga el instalador público de GitHub; ejecutar tras publicar una release"]
    async fn published_update_is_signed_and_only_offered_to_older_versions() {
        let older = app_at("0.0.0");
        let mut update = older
            .updater_builder()
            .target("windows-x86_64")
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .expect("El feed debe ofrecer la release a una instalación anterior");
        assert_eq!(update.download_url.scheme(), "https");
        assert_eq!(update.download_url.host_str(), Some("github.com"));
        assert!(update
            .download_url
            .path()
            .starts_with("/josmad22/ParitySQL/releases/download/"));
        assert!(update.download_url.path().ends_with(".exe"));
        update.timeout = Some(Duration::from_secs(300));
        let mut received = 0usize;
        let bytes = update
            .download(|size, _| received += size, || {})
            .await
            .unwrap();
        assert_eq!(received, bytes.len());
        assert!(bytes.starts_with(b"MZ"));
        update.verify(&bytes).unwrap();
        let mut tampered = bytes.clone();
        tampered[0] ^= 1;
        assert!(update.verify(&tampered).is_err());

        let current = app_at(&update.version);
        assert!(current
            .updater_builder()
            .target("windows-x86_64")
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .is_none());
        println!(
            "Release {}: {} bytes verificados; paquete alterado rechazado; versión actual sin aviso.",
            update.version,
            bytes.len()
        );
    }
}
