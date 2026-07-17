$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $PSScriptRoot 'setup-local.ps1'
$content = Get-Content $setupScript -Raw

foreach ($required in @('Require-Command node', 'Require-Command npm', 'Require-Command docker', 'npm ci', 'docker compose -f docker-compose.dev.yml up -d --wait', 'npm run db:generate', 'npm run db:push', 'New-LocalJwtSecret')) {
    if (-not $content.Contains($required)) { throw "Missing onboarding behavior: $required" }
}

& $setupScript -WhatIf
if (-not $?) { throw 'The onboarding dry run failed.' }

if (-not (Test-Path (Join-Path $repoRoot 'docker-compose.dev.yml'))) { throw 'Missing local services compose file.' }
Write-Host 'Developer onboarding script checks passed.' -ForegroundColor Green
