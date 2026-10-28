$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  $composeArgs = @('-f', 'docker-compose.yml', '-f', 'docker-compose.build.yml')
  $updaterOverlay = 'tmp/local-update/host-updater/docker-compose.local.yml'
  $services = @('compdf-server')
  if (Test-Path -LiteralPath $updaterOverlay) {
    $composeArgs += @('-f', $updaterOverlay)
    # The updater shares the server's network namespace and must follow recreation.
    $services += 'compdf-updater'
  }
  $composeArgs += @('-f', 'docker-compose.watch.yml')
  & docker compose @composeArgs up -d --no-deps --no-build --pull never @services
  if ($LASTEXITCODE -ne 0) { throw 'Could not start the backend watch service.' }
  Write-Host 'Backend watch mode started. Follow startup with: docker compose logs -f --tail 80 compdf-server'
} finally {
  Pop-Location
}
