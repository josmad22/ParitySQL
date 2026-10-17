use std::path::Path;

/// Exporta el contenido sin modificarlo y realiza la escritura fuera del hilo de UI.
async fn write_script(path: &Path, content: &str) -> Result<(), String> {
    tokio::fs::write(path, content.as_bytes())
        .await
        .map_err(|e| format!("No se pudo guardar el script: {e}"))
}

/// Solicita el destino al usuario. Cancelar no crea ni modifica archivos.
pub async fn save_script(content: String, filename: String) -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&filename)
        .add_filter("Script SQL", &["sql"])
        .save_file()
        .await;

    match file {
        Some(handle) => {
            let path = handle.path();
            write_script(path, &content).await?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn exported_script_preserves_content_and_reports_write_errors() {
        let path = std::env::temp_dir().join(format!(
            "paritysql-export-{}-{}.sql",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let script = "-- Comparación: áéíóú\r\nSELECT N'✓';\r\nGO\r\n";
        super::write_script(&path, script).await.unwrap();
        let exported = tokio::fs::read_to_string(&path).await.unwrap();
        tokio::fs::remove_file(&path).await.unwrap();
        assert_eq!(exported, script);
        assert!(super::write_script(&path.join("invalid.sql"), script)
            .await
            .unwrap_err()
            .starts_with("No se pudo guardar el script:"));
    }
}
