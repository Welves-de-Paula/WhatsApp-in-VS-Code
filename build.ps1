# Build script: incrementa versão patch, remove .vsix antigo e empacota novo

$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json

# Incrementa versão patch (ex: 0.1.1 -> 0.1.2)
$version = [System.Version]$packageJson.version
$newVersion = "{0}.{1}.{2}" -f $version.Major, $version.Minor, ($version.Build + 1)

$packageJson.version = $newVersion

# Salva package.json atualizado (sem BOM para o vsce aceitar)
$json = $packageJson | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText((Resolve-Path "package.json").Path, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "Versão atualizada: $($version.ToString(3)) -> $newVersion"

# Remove .vsix antigos
$vsixFiles = Get-ChildItem -Filter "*.vsix"
if ($vsixFiles) {
    $vsixFiles | ForEach-Object {
        Remove-Item $_.FullName -Force
        Write-Host "Removido: $($_.Name)"
    }
}
else {
    Write-Host "Nenhum .vsix encontrado para remover."
}

# Compila o TypeScript
Write-Host "Compilando TypeScript..."
npm run compile
if ($LASTEXITCODE -ne 0) {
    Write-Error "Falha na compilação. Abortando."
    exit 1
}

# Empacota a extensão
Write-Host "Empacotando extensão..."
npx vsce package
if ($LASTEXITCODE -ne 0) {
    Write-Error "Falha ao empacotar. Abortando."
    exit 1
}

$newVsix = Get-ChildItem -Filter "*.vsix" | Select-Object -First 1
Write-Host "Pacote gerado: $($newVsix.Name)"
