use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub server: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// "sql" | "windows"
    pub auth: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub database: String,
    #[serde(default = "default_dot")]
    pub dot: String,
}

fn default_dot() -> String {
    "#16a34a".into()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub active_env: usize,
    #[serde(default)]
    pub current_db: String,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No se pudo localizar el directorio de configuración: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear el directorio de configuración: {e}"))?;
    Ok(dir.join("environments.json"))
}

/// Recupera la configuración local; una instalación nueva no precarga conexiones.
pub fn load(app: &tauri::AppHandle) -> Result<Store, String> {
    read_store(&store_path(app)?)
}

/// Solo la ausencia del archivo equivale a una instalación nueva. Un JSON
/// inválido o sin permisos se informa como error, sin sobrescribirlo ni borrarlo.
fn read_store(path: &Path) -> Result<Store, String> {
    match std::fs::read_to_string(path) {
        Ok(json) => serde_json::from_str(&json)
            .map_err(|e| format!("La configuración guardada no es válida: {e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_store()),
        Err(error) => Err(format!("No se pudo leer la configuración: {error}")),
    }
}

pub fn save(app: &tauri::AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    write_store(&path, store)
}

/// Escribe en un temporal del mismo directorio y reemplaza el JSON únicamente
/// al completar la escritura. Un fallo conserva la configuración anterior.
fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let json = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("No se pudo serializar la configuración: {e}"))?;
    let temporary = path.with_file_name(format!(
        ".environments-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| format!("No se pudo crear el archivo temporal de configuración: {e}"))?;
    let result = (|| {
        let mut file = file;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|e| format!("No se pudo guardar la configuración: {e}"))
}

fn default_store() -> Store {
    Store {
        environments: vec![],
        active_env: 0,
        current_db: String::new(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn configuration_is_replaced_completely_and_failed_replace_cleans_temporary() {
        let directory = std::env::temp_dir().join(format!(
            "paritysql-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("environments.json");
        let mut store = super::default_store();
        store.current_db = "base_de_prueba".into();
        super::write_store(&path, &store).unwrap();
        super::write_store(&path, &super::default_store()).unwrap();
        let loaded: super::Store = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(loaded.current_db.is_empty());
        assert!(loaded.environments.is_empty());
        assert!(super::write_store(&directory, &store).is_err());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let missing = super::read_store(&directory.join("missing.json")).unwrap();
        assert!(missing.environments.is_empty());
        std::fs::write(&path, "invalid json").unwrap();
        assert!(
            matches!(super::read_store(&path), Err(error) if error.starts_with("La configuración guardada no es válida:"))
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid json");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn default_configuration_contains_no_connections() {
        let store = super::default_store();
        assert!(store.environments.is_empty());
        assert!(store.current_db.is_empty());
        assert_eq!(
            serde_json::to_value(store).unwrap(),
            serde_json::json!({ "environments": [], "activeEnv": 0, "currentDb": "" })
        );
    }
}
