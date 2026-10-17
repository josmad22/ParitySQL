param(
    [string]$KeyDirectory = (Join-Path $env:USERPROFILE ".tauri/ParitySQL")
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$keyPath = Join-Path $KeyDirectory "updater.key"
$passwordPath = Join-Path $KeyDirectory "updater-password.dpapi"
$publicPath = Join-Path $KeyDirectory "updater.key.pub"
foreach ($path in @($keyPath, $passwordPath, $publicPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Falta un archivo de firma local. Usa GitHub Actions o recupera tu copia privada de firma."
    }
}
Add-Type -AssemblyName System.Security
$encrypted = [System.IO.File]::ReadAllBytes($passwordPath)
$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$previousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $keyPath
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Text.Encoding]::UTF8.GetString($decrypted)
    & (Join-Path $PSScriptRoot "prepare-release.ps1") -Repository "josmad22/ParitySQL" -PublicKey (Get-Content -LiteralPath $publicPath -Raw)
    Push-Location $projectRoot
    try {
        cargo tauri build --locked --config src-tauri/tauri.release.local.json
        if ($LASTEXITCODE -ne 0) { throw "La compilación firmada no se completó." }
    } finally { Pop-Location }
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $previousKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
    [Array]::Clear($decrypted, 0, $decrypted.Length)
}
