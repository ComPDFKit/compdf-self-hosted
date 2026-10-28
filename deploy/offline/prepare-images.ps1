[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [Parameter(Mandatory)] [string]$AppImage,
    [Parameter(Mandatory)] [string]$ServerImage
)

$ErrorActionPreference = 'Stop'
if ($AppImage -notmatch '@sha256:[0-9a-fA-F]{64}$' -or $ServerImage -notmatch '@sha256:[0-9a-fA-F]{64}$') {
    throw 'AppImage and ServerImage must be immutable tag@sha256 references.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker is required.' }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Work = [IO.Path]::GetFullPath($WorkingDirectory)
$Artifacts = Join-Path $Work 'artifacts'
New-Item -ItemType Directory -Force -Path $Artifacts | Out-Null

& docker pull $AppImage
if ($LASTEXITCODE -ne 0) { throw 'Failed to pull the App image.' }
& docker pull $ServerImage
if ($LASTEXITCODE -ne 0) { throw 'Failed to pull the Server image.' }
& docker image save --output (Join-Path $Artifacts 'compdf-app.docker.tar') $AppImage
if ($LASTEXITCODE -ne 0) { throw 'Failed to save the App image.' }
& docker image save --output (Join-Path $Artifacts 'compdf-server.docker.tar') $ServerImage
if ($LASTEXITCODE -ne 0) { throw 'Failed to save the Server image.' }

Copy-Item -LiteralPath (Join-Path $RepoRoot 'docker-compose.yml') -Destination (Join-Path $Artifacts 'compose.release.yml')
if (-not (Test-Path -LiteralPath (Join-Path $Work 'release-spec.json'))) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-spec.example.json') -Destination (Join-Path $Work 'release-spec.json')
}
Get-ChildItem -File -LiteralPath $Artifacts | Get-FileHash -Algorithm SHA256
Write-Host "Edit $Work\release-spec.json with the exact image tags, digests, dates, and release notes before signing."
