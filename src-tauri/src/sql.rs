use serde::{Deserialize, Serialize};
use tiberius::{AuthMethod, Client, Config};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

/// Datos de conexión que llegan desde el frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnConfig {
    pub server: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// "sql" | "windows"
    pub auth: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub version: String,
    pub latency_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectResult {
    pub input: String,
    pub qualified: String,
    /// etiqueta legible: procedimiento, función, vista, trigger…
    pub kind: String,
    pub script: String,
    pub lines: usize,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenResult {
    pub objects: Vec<ObjectResult>,
    pub total_objects: usize,
    pub ok_objects: usize,
    pub total_lines: usize,
    /// Cabecera del script (USE [db]; GO) — se muestra y se incluye en el script.
    pub header: String,
    pub script: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectName {
    pub schema: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionResult {
    pub definition: Option<String>,
    pub error: Option<String>,
    pub status: String,
}

/// Recupera definiciones de SP/funciones mediante metadatos. Nunca ejecuta el
/// contenido origen; los nombres se envían como parámetros de la consulta.
pub async fn fetch_definitions(
    conn: &ConnConfig,
    database: &str,
    objects: Vec<ObjectName>,
) -> Result<Vec<DefinitionResult>, String> {
    let mut client = connect(conn, Some(database)).await?;
    let mut results = Vec::with_capacity(objects.len());
    for object in objects {
        let rows = match client
            .query(
                "SELECT OBJECT_DEFINITION(o.object_id) FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.name = @P2 \
             AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT')",
                &[&object.schema.as_str(), &object.name.as_str()],
            )
            .await
        {
            Ok(stream) => stream
                .into_first_result()
                .await
                .map_err(|e| format!("No se pudieron consultar los metadatos de SQL Server: {e}")),
            Err(e) => Err(format!(
                "No se pudieron consultar los metadatos de SQL Server: {e}"
            )),
        };
        let result = match rows {
            Err(error) => DefinitionResult { definition: None, error: Some(error), status: "error".into() },
            Ok(rows) => match rows.into_iter().next() {
                None => DefinitionResult {
                    definition: None,
                    error: Some("No encontrado en la base de datos o sin permisos para verlo.".into()),
                    status: "missing".into(),
                },
                Some(row) => match row.get::<&str, _>(0).filter(|s| !s.trim().is_empty()) {
                    Some(definition) => DefinitionResult { definition: Some(definition.to_string()), error: None, status: "ok".into() },
                    None => DefinitionResult {
                        definition: None,
                        error: Some("Definición no disponible (objeto encriptado o sin permiso VIEW DEFINITION).".into()),
                        status: "unavailable".into(),
                    },
                },
            },
        };
        results.push(result);
    }
    Ok(results)
}

/// Construye la Config de tiberius. Devuelve además el nombre de instancia si
/// el servidor usa `HOST\INSTANCIA` (requiere SQL Browser).
fn build_config(
    conn: &ConnConfig,
    database: Option<&str>,
) -> Result<(Config, Option<String>), String> {
    let mut config = Config::new();
    let server = conn.server.trim();
    if server.is_empty() {
        return Err("El servidor no puede estar vacío.".into());
    }

    let mut host = server.to_string();
    let mut instance: Option<String> = None;
    let mut inline_port = None;

    if let Some(idx) = server.find('\\') {
        // HOST\INSTANCIA -> se resuelve el puerto por el SQL Browser
        host = server[..idx].to_string();
        let inst = server[idx + 1..].trim().to_string();
        if !inst.is_empty() {
            instance = Some(inst);
        }
    } else if let Some(idx) = server.find(',') {
        // HOST,PUERTO
        host = server[..idx].to_string();
        inline_port = Some(
            server[idx + 1..]
                .trim()
                .parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or("El puerto del servidor debe estar entre 1 y 65535.")?,
        );
    }

    if host.trim().is_empty() {
        return Err("El servidor no puede estar vacío.".into());
    }
    config.host(host.trim());

    if instance.is_none() {
        let port = inline_port.or(conn.port).unwrap_or(1433);
        if port == 0 {
            return Err("El puerto del servidor debe estar entre 1 y 65535.".into());
        }
        config.port(port);
    } else if let Some(inst) = &instance {
        config.instance_name(inst);
    }

    match conn.auth.as_str() {
        "windows" => {
            config.authentication(AuthMethod::Integrated);
        }
        _ => {
            let user = conn.user.clone().unwrap_or_default();
            let pass = conn.password.clone().unwrap_or_default();
            config.authentication(AuthMethod::sql_server(user, pass));
        }
    }

    let db = database
        .map(|s| s.to_string())
        .or_else(|| conn.database.clone())
        .unwrap_or_default();
    if !db.is_empty() {
        config.database(db);
    }

    // La mayoría de servidores usan certificados autofirmados.
    config.trust_cert();

    Ok((config, instance))
}

/// Abre una conexión al servidor (opcionalmente contra una base concreta).
async fn connect(
    conn: &ConnConfig,
    database: Option<&str>,
) -> Result<Client<Compat<TcpStream>>, String> {
    let (config, instance) = build_config(conn, database)?;

    let tcp = if instance.is_some() {
        use tiberius::SqlBrowser;
        TcpStream::connect_named(&config)
            .await
            .map_err(|e| format!("No se pudo conectar (instancia): {e}"))?
    } else {
        TcpStream::connect(config.get_addr())
            .await
            .map_err(|e| format!("No se pudo conectar a {}: {e}", config.get_addr()))?
    };
    tcp.set_nodelay(true).ok();

    let client = Client::connect(config, tcp.compat_write())
        .await
        .map_err(|e| format!("Fallo de autenticación / conexión: {e}"))?;

    Ok(client)
}

pub async fn test_connection(conn: &ConnConfig) -> Result<TestResult, String> {
    let start = std::time::Instant::now();
    let mut client = connect(conn, None).await?;

    let rows = client
        .simple_query("SELECT @@VERSION")
        .await
        .map_err(|e| format!("No se pudieron consultar los metadatos de SQL Server: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("No se pudieron consultar los metadatos de SQL Server: {e}"))?;

    let latency_ms = start.elapsed().as_millis();

    let version = rows
        .into_iter()
        .next()
        .and_then(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
        .unwrap_or_else(|| "SQL Server".to_string());

    let short = version
        .lines()
        .next()
        .unwrap_or("SQL Server")
        .trim()
        .to_string();

    Ok(TestResult {
        ok: true,
        version: short,
        latency_ms,
    })
}

pub async fn list_databases(conn: &ConnConfig) -> Result<Vec<String>, String> {
    let mut client = connect(conn, None).await?;

    let rows = client
        .simple_query(
            "SELECT name FROM sys.databases \
             WHERE state = 0 AND name NOT IN ('master','tempdb','model','msdb') \
             ORDER BY name",
        )
        .await
        .map_err(|e| format!("No se pudieron consultar los metadatos de SQL Server: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("No se pudieron consultar los metadatos de SQL Server: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        if let Some(n) = r.get::<&str, _>(0) {
            out.push(n.to_string());
        }
    }
    Ok(out)
}

/// Separa `esquema.objeto`; sin esquema asume `dbo`. Quita corchetes.
fn parse_object(raw: &str) -> (String, String) {
    let clean = raw.replace(['[', ']'], "");
    match clean.split_once('.') {
        Some((schema, name)) => (schema.trim().to_string(), name.trim().to_string()),
        None => ("dbo".to_string(), clean.trim().to_string()),
    }
}

/// Mapea el `type` de sys.objects a (palabra DROP, etiqueta legible).
fn map_type(code: &str) -> (&'static str, &'static str) {
    match code {
        "P" | "PC" => ("PROCEDURE", "procedimiento"),
        "FN" | "IF" | "TF" | "FS" | "FT" | "AF" => ("FUNCTION", "función"),
        "V" => ("VIEW", "vista"),
        "TR" | "TA" => ("TRIGGER", "trigger"),
        "U" => ("TABLE", "tabla"),
        _ => ("OBJECT", "objeto"),
    }
}

/// level1type para sp_addextendedproperty según el tipo de objeto.
fn ext_level1_type(code: &str) -> &'static str {
    match code {
        "P" | "PC" => "PROCEDURE",
        "FN" | "IF" | "TF" | "FS" | "FT" | "AF" => "FUNCTION",
        "V" => "VIEW",
        "U" => "TABLE",
        "TR" | "TA" => "TRIGGER",
        _ => "OBJECT",
    }
}

/// Duplica comillas simples para literales SQL.
fn sql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Lee las propiedades extendidas a nivel objeto (minor_id = 0).
async fn fetch_ext_props(
    client: &mut Client<Compat<TcpStream>>,
    qualified: &str,
) -> Vec<(String, Option<String>)> {
    let sql = "SELECT ep.name, CAST(ep.value AS NVARCHAR(MAX)) \
               FROM sys.extended_properties ep \
               WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(@P1) AND ep.minor_id = 0 \
               ORDER BY ep.name";
    let rows = match client.query(sql, &[&qualified]).await {
        Ok(stream) => match stream.into_first_result().await {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for r in rows {
        let name = r.get::<&str, _>(0).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let val = r.get::<&str, _>(1).map(|s| s.to_string());
        out.push((name, val));
    }
    out
}

/// Genera el bloque sp_addextendedproperty. Si no hay propiedades, deja una
/// plantilla comentada con los niveles rellenados y la descripción pendiente.
fn build_ext_block(
    schema: &str,
    name: &str,
    type_code: &str,
    props: &[(String, Option<String>)],
) -> String {
    let l1 = ext_level1_type(type_code);
    let sch = sql_escape(schema);
    let nm = sql_escape(name);

    if props.is_empty() {
        let lines = [
            "-- Sin propiedad extendida. Completa la descripción y descomenta para registrarla:".to_string(),
            "-- EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'<DESCRIPCIÓN PENDIENTE>',".to_string(),
            format!("--     @level0type = N'SCHEMA',    @level0name = '{sch}',"),
            format!("--     @level1type = N'{l1}', @level1name = '{nm}';"),
            "-- GO".to_string(),
        ];
        lines.join("\n")
    } else {
        let mut lines: Vec<String> =
            vec!["-- Propiedades extendidas (se re-crean tras el DROP/CREATE):".to_string()];
        for (pname, pval) in props {
            let val = sql_escape(pval.as_deref().unwrap_or(""));
            lines.push(format!(
                "EXEC sys.sp_addextendedproperty @name = N'{}', @value = N'{}',",
                sql_escape(pname),
                val
            ));
            lines.push(format!(
                "    @level0type = N'SCHEMA',    @level0name = '{sch}',"
            ));
            lines.push(format!("    @level1type = N'{l1}', @level1name = '{nm}';"));
            lines.push("GO".to_string());
        }
        lines.join("\n")
    }
}

pub async fn generate(
    conn: &ConnConfig,
    database: &str,
    objects: Vec<String>,
) -> Result<GenResult, String> {
    let mut client = connect(conn, Some(database)).await?;

    let items: Vec<(String, String, String)> = objects
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let (schema, name) = parse_object(s);
            (s.to_string(), schema, name)
        })
        .collect();

    let n = items.len();
    let mut results: Vec<ObjectResult> = Vec::with_capacity(n);
    let mut blocks: Vec<String> = Vec::new();
    let mut ok = 0usize;

    for (i, (input, schema, name)) in items.iter().enumerate() {
        let qualified = format!("{schema}.{name}");
        let qn: &str = qualified.as_str();

        let rows = match client
            .query(
                "SELECT o.type, OBJECT_DEFINITION(o.object_id) \
                 FROM sys.objects o WHERE o.object_id = OBJECT_ID(@P1)",
                &[&qn],
            )
            .await
        {
            Ok(stream) => stream
                .into_first_result()
                .await
                .map_err(|e| format!("No se pudieron consultar los metadatos de SQL Server: {e}")),
            Err(e) => Err(format!(
                "No se pudieron consultar los metadatos de SQL Server: {e}"
            )),
        };

        match rows {
            Err(e) => results.push(err_result(input, &qualified, e)),
            Ok(rows) => match rows.into_iter().next() {
                None => results.push(err_result(
                    input,
                    &qualified,
                    "No encontrado en la base de datos.".to_string(),
                )),
                Some(row) => {
                    let type_code = row.get::<&str, _>(0).unwrap_or("").trim().to_string();
                    let def = row.get::<&str, _>(1).map(|s| s.to_string());

                    match def {
                        Some(d) if !d.trim().is_empty() => {
                            let (drop_kw, label) = map_type(&type_code);

                            // propiedades extendidas a nivel objeto (MS_Description, etc.)
                            let props = fetch_ext_props(&mut client, qn).await;

                            let base =
                                build_block(i + 1, n, &qualified, label, &type_code, drop_kw, &d);
                            let ext = build_ext_block(schema, name, &type_code, &props);
                            let block = format!("{base}\n{ext}");
                            let lines = block.lines().count();
                            ok += 1;
                            blocks.push(block.clone());
                            results.push(ObjectResult {
                                input: input.clone(),
                                qualified,
                                kind: label.to_string(),
                                script: block,
                                lines,
                                error: None,
                            });
                        }
                        _ => results.push(err_result(
                            input,
                            &qualified,
                            "Definición no disponible (objeto encriptado o del sistema)."
                                .to_string(),
                        )),
                    }
                }
            },
        }
    }

    let header = format!("USE [{database}];\nGO");
    let body = blocks.join("\n\n");
    let script = if body.is_empty() {
        String::new()
    } else {
        format!("{header}\n\n{body}")
    };
    let total_lines = if script.is_empty() {
        0
    } else {
        script.lines().count()
    };

    Ok(GenResult {
        objects: results,
        total_objects: n,
        ok_objects: ok,
        total_lines,
        header,
        script,
    })
}

fn err_result(input: &str, qualified: &str, error: String) -> ObjectResult {
    ObjectResult {
        input: input.to_string(),
        qualified: qualified.to_string(),
        kind: String::new(),
        script: String::new(),
        lines: 0,
        error: Some(error),
    }
}

fn build_block(
    idx: usize,
    total: usize,
    qualified: &str,
    label: &str,
    type_code: &str,
    drop_kw: &str,
    definition: &str,
) -> String {
    let bar = "═".repeat(51);
    let header =
        format!("/* {bar}\n   Objeto {idx} de {total}  ·  {qualified}  ({label})\n   {bar} */");
    let drop = format!(
        "IF OBJECT_ID('{qualified}', '{type_code}') IS NOT NULL\n    DROP {drop_kw} {qualified};\nGO"
    );
    let body = definition.trim_end();
    format!("{header}\n{drop}\n{body}\nGO")
}

#[cfg(test)]
mod tests {
    #[test]
    fn generated_script_keeps_server_definition_and_conditional_drop() {
        let (schema, name) = super::parse_object("[dbo].[demo]");
        assert_eq!((schema.as_str(), name.as_str()), ("dbo", "demo"));
        let definition = "CREATE PROCEDURE dbo.demo AS\nSELECT N'contenido original';";
        let block = super::build_block(
            1,
            1,
            "dbo.demo",
            "procedimiento",
            "P",
            "PROCEDURE",
            definition,
        );
        assert!(block.contains(
            "IF OBJECT_ID('dbo.demo', 'P') IS NOT NULL\n    DROP PROCEDURE dbo.demo;\nGO"
        ));
        assert!(block.ends_with(&format!("{definition}\nGO")));
        assert_eq!(super::map_type("IF"), ("FUNCTION", "función"));
    }

    #[test]
    fn extended_properties_keep_values_and_escape_sql_literals() {
        let block = super::build_ext_block(
            "dbo",
            "demo",
            "P",
            &[("MS_Description".into(), Some("Texto 'original'".into()))],
        );
        assert!(block.contains("@value = N'Texto ''original'''"));
        assert!(block.contains("@level1type = N'PROCEDURE', @level1name = 'demo'"));
    }

    fn connection(server: &str, port: Option<u16>) -> super::ConnConfig {
        super::ConnConfig {
            server: server.into(),
            port,
            auth: "sql".into(),
            user: None,
            password: None,
            database: None,
        }
    }

    #[test]
    fn connection_formats_keep_inline_ports_and_named_instances() {
        for (server, port, expected) in [
            ("sql-test", None, "sql-test:1433"),
            ("sql-test", Some(1544), "sql-test:1544"),
            (" sql-test,1545 ", None, "sql-test:1545"),
            ("sql-test,1545", Some(1433), "sql-test:1545"),
        ] {
            let (config, instance) = super::build_config(&connection(server, port), None).unwrap();
            assert_eq!(config.get_addr(), expected);
            assert!(instance.is_none());
        }
        let (_, instance) =
            super::build_config(&connection("sql-test\\INSTANCE", None), None).unwrap();
        assert_eq!(instance.as_deref(), Some("INSTANCE"));
    }

    #[test]
    fn invalid_connection_boundaries_fail_before_network_io() {
        for server in [
            "",
            " ",
            ",1545",
            "sql-test,0",
            "sql-test,65536",
            "sql-test,invalid",
        ] {
            assert!(super::build_config(&connection(server, None), None).is_err());
        }
        assert!(super::build_config(&connection("sql-test", Some(0)), None).is_err());
    }
}
