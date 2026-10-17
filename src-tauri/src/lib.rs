mod files;
pub mod sql;
pub mod store;
mod updates;

use sql::{ConnConfig, GenResult, TestResult};
use store::Store;

#[tauri::command]
async fn test_connection(conn: ConnConfig) -> Result<TestResult, String> {
    sql::test_connection(&conn).await
}

#[tauri::command]
async fn list_databases(conn: ConnConfig) -> Result<Vec<String>, String> {
    sql::list_databases(&conn).await
}

#[tauri::command]
async fn generate_scripts(
    conn: ConnConfig,
    database: String,
    objects: Vec<String>,
) -> Result<GenResult, String> {
    sql::generate(&conn, &database, objects).await
}

#[tauri::command]
async fn fetch_definitions(
    conn: ConnConfig,
    database: String,
    objects: Vec<sql::ObjectName>,
) -> Result<Vec<sql::DefinitionResult>, String> {
    sql::fetch_definitions(&conn, &database, objects).await
}

#[tauri::command]
async fn load_environments(app: tauri::AppHandle) -> Result<Store, String> {
    tauri::async_runtime::spawn_blocking(move || store::load(&app))
        .await
        .map_err(|e| format!("No se pudo cargar la configuración: {e}"))?
}

#[tauri::command]
async fn save_environments(app: tauri::AppHandle, store: Store) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store::save(&app, &store))
        .await
        .map_err(|e| format!("No se pudo guardar la configuración: {e}"))?
}

#[tauri::command]
async fn save_script(content: String, filename: String) -> Result<Option<String>, String> {
    files::save_script(content, filename).await
}

#[tauri::command]
async fn check_for_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, updates::UpdateState>,
) -> Result<updates::UpdateStatus, String> {
    updates::check(app, &state).await
}

#[tauri::command]
async fn download_update(
    state: tauri::State<'_, updates::UpdateState>,
    progress: tauri::ipc::Channel<updates::DownloadProgress>,
) -> Result<updates::UpdateStatus, String> {
    updates::download(&state, progress).await
}

#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, updates::UpdateState>,
) -> Result<(), String> {
    updates::install(app, &state).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            test_connection,
            list_databases,
            generate_scripts,
            fetch_definitions,
            load_environments,
            save_environments,
            save_script,
            check_for_updates,
            download_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar ParitySQL");
}

#[cfg(test)]
mod tests {
    #[test]
    fn ipc_results_preserve_frontend_camel_case_contract() {
        let result = super::GenResult {
            objects: vec![],
            total_objects: 0,
            ok_objects: 0,
            total_lines: 0,
            header: String::new(),
            script: String::new(),
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({
                "objects": [], "totalObjects": 0, "okObjects": 0,
                "totalLines": 0, "header": "", "script": ""
            })
        );
        assert_eq!(
            serde_json::to_value(super::TestResult {
                ok: true,
                version: String::new(),
                latency_ms: 1,
            })
            .unwrap(),
            serde_json::json!({ "ok": true, "version": "", "latencyMs": 1 })
        );
    }
}
