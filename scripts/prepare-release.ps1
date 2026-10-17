param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$PublicKey,
    [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "Indica el repositorio como propietario/repositorio."
}
if ([string]::IsNullOrWhiteSpace($PublicKey)) {
    throw "Configura PARITYSQL_UPDATER_PUBLIC_KEY con el contenido de la clave pública."
}
try {
    $publicText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PublicKey.Trim()))
    $publicLines = @($publicText -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($publicLines.Count -ne 2 -or -not $publicLines[0].StartsWith("untrusted comment:")) {
        throw "Formato inesperado."
    }
    if ([Convert]::FromBase64String($publicLines[1]).Length -ne 42) {
        throw "La clave no es pública."
    }
} catch {
    throw "Usa el contenido del archivo .pub generado por Tauri. Nunca uses la clave privada .key como clave pública."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot "src-tauri/tauri.conf.json"
$cargoPath = Join-Path $projectRoot "src-tauri/Cargo.toml"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$cargo = Get-Content -LiteralPath $cargoPath -Raw
$packageVersion = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
if ($config.version -ne $packageVersion) {
    throw "Las versiones de Cargo.toml y tauri.conf.json deben coincidir."
}
if ($Tag -and $Tag -ne "v$($config.version)") {
    throw "La etiqueta debe coincidir con la versión de la aplicación: v$($config.version)."
}

$override = @{
    bundle = @{ createUpdaterArtifacts = $true; targets = @("nsis") }
    plugins = @{
        updater = @{
            pubkey = $PublicKey.Trim()
            endpoints = @("https://github.com/$Repository/releases/latest/download/latest.json")
            windows = @{ installMode = "passive" }
        }
    }
}
$destination = Join-Path $projectRoot "src-tauri/tauri.release.local.json"
$json = $override | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($destination, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output "Configuración pública de actualización preparada para ParitySQL $($config.version)."
