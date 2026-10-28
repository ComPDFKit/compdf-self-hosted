[CmdletBinding()]
param(
    [ValidateSet('validate', 'install', 'status', 'logs', 'smoke', 'restart', 'stop', 'uninstall')]
    [string]$Action = 'install',
    [string]$EnvFile = '.env',
    [switch]$Build,
    [switch]$DryRun,
    [switch]$AllowInsecureDefaults
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ResolvedEnvFile = if ([IO.Path]::IsPathRooted($EnvFile)) {
    $EnvFile
} else {
    Join-Path $RepoRoot $EnvFile
}

if (-not (Test-Path -LiteralPath $ResolvedEnvFile -PathType Leaf)) {
    throw "Environment file does not exist: $ResolvedEnvFile"
}

function Format-Command([string[]]$Arguments) {
    return 'docker ' + (($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' ')
}

function Invoke-Docker([string[]]$Arguments) {
    if ($DryRun) {
        Write-Host ('[dry-run] ' + (Format-Command $Arguments))
        return
    }
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE"
    }
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command is not available: $Name"
    }
}

function Assert-SecureEnvironment {
    $content = Get-Content -Raw -LiteralPath $ResolvedEnvFile
    if (-not $AllowInsecureDefaults -and $content -match '(?m)^CORS_ORIGINS\s*=\s*\*\s*$') {
        throw 'CORS_ORIGINS=* is blocked. Set explicit HTTPS origins or pass -AllowInsecureDefaults for a non-production environment.'
    }
}

function Invoke-Smoke {
    if ($DryRun) {
        Write-Host '[dry-run] GET http://127.0.0.1:8080/api/v1/status'
        return
    }
    $uri = 'http://127.0.0.1:8080/api/v1/status'
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $uri
            if ($response.StatusCode -eq 200) {
                Write-Host "Smoke check passed: $uri"
                return
            }
        } catch {
            if ($attempt -eq 30) { throw }
        }
        Start-Sleep -Seconds 2
    }
    throw "Smoke check failed: $uri"
}

Assert-Command docker
Assert-Command node
Assert-SecureEnvironment

$ComposeArguments = @('compose', '--env-file', $ResolvedEnvFile, '-f', (Join-Path $RepoRoot 'docker-compose.yml'))
if ($Build) {
    $ComposeArguments += @('-f', (Join-Path $RepoRoot 'docker-compose.build.yml'))
}

Push-Location $RepoRoot
try {
    if (-not $DryRun) {
        & docker compose version | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required.' }
        & node (Join-Path $RepoRoot 'scripts\validate-compose.mjs') $ResolvedEnvFile
        if ($LASTEXITCODE -ne 0) { throw 'Compose contract validation failed.' }
    } else {
        Write-Host "[dry-run] node scripts/validate-compose.mjs $ResolvedEnvFile"
    }

    switch ($Action) {
        'validate' {
            Invoke-Docker ($ComposeArguments + @('config', '--quiet'))
        }
        'install' {
            Invoke-Docker ($ComposeArguments + @('pull', '--ignore-buildable'))
            $up = @('up', '-d', '--remove-orphans')
            if ($Build) { $up += '--build' }
            Invoke-Docker ($ComposeArguments + $up)
            Invoke-Smoke
        }
        'status' { Invoke-Docker ($ComposeArguments + @('ps')) }
        'logs' { Invoke-Docker ($ComposeArguments + @('logs', '--tail', '200')) }
        'smoke' { Invoke-Smoke }
        'restart' {
            Invoke-Docker ($ComposeArguments + @('restart'))
            Invoke-Smoke
        }
        'stop' { Invoke-Docker ($ComposeArguments + @('stop')) }
        'uninstall' { Invoke-Docker ($ComposeArguments + @('down', '--remove-orphans')) }
    }
} finally {
    Pop-Location
}
