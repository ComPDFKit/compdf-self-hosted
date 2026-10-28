[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$SpecPath,
    [Parameter(Mandatory)] [string]$PrivateKeyPath,
    [Parameter(Mandatory)] [string]$KeyId,
    [Parameter(Mandatory)] [string]$OutputDirectory,
    [Parameter(Mandatory)] [string]$OfflinePackage
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Spec = (Resolve-Path -LiteralPath $SpecPath).Path
$Key = (Resolve-Path -LiteralPath $PrivateKeyPath).Path
$Output = [IO.Path]::GetFullPath($OutputDirectory)
$Package = [IO.Path]::GetFullPath($OfflinePackage)
$Go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $Go -and (Test-Path -LiteralPath 'C:\Program Files\Go\bin\go.exe')) {
    $Go = 'C:\Program Files\Go\bin\go.exe'
}
if (-not $Go) { throw 'Go is required to build compdf-release.' }
if (Test-Path -LiteralPath $Output) { throw "Output directory already exists: $Output" }
if (Test-Path -LiteralPath $Package) { throw "Offline package already exists: $Package" }

Push-Location (Join-Path $RepoRoot 'updater')
try {
    & $Go run ./cmd/compdf-release --spec $Spec --private-key $Key --key-id $KeyId --output $Output --offline-package $Package --approve
    if ($LASTEXITCODE -ne 0) { throw "compdf-release failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
Get-FileHash -Algorithm SHA256 -LiteralPath $Package
