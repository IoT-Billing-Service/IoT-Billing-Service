[CmdletBinding()]
param(
    [switch]$SkipDependencies,
    [switch]$SkipServices,
    [switch]$SkipDatabase,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. Install it, then rerun this script."
    }
}

function Get-MajorVersion([string]$Command) {
    $version = (& $Command --version | Select-Object -First 1) -replace '^[^0-9]*', '' -replace '[^0-9.].*$', ''
    return [int]($version.Split('.')[0])
}

function New-LocalJwtSecret {
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Initialize-Environment([string]$Template, [string]$Destination, [bool]$GenerateJwtSecret) {
    if (Test-Path $Destination) {
        Write-Host "Keeping existing $Destination"
        return
    }

    if ($WhatIf) {
        Write-Host "Would create $Destination from $Template"
        return
    }

    $content = Get-Content $Template -Raw
    if ($GenerateJwtSecret) {
        $content = $content.Replace('JWT_SECRET=change-me-in-production', "JWT_SECRET=$(New-LocalJwtSecret)")
    }
    Set-Content -Path $Destination -Value $content -Encoding utf8 -NoNewline
    Write-Host "Created $Destination"
}

if ($WhatIf) {
    Write-Host 'Dry run: no files, containers, dependencies, or databases will be changed.' -ForegroundColor Yellow
} else {
    Write-Step 'Checking prerequisites'
    Require-Command git
    Require-Command node
    Require-Command npm
    if ((Get-MajorVersion node) -lt 20) { throw 'Node.js 20 or newer is required.' }
    if ((Get-MajorVersion npm) -lt 10) { throw 'npm 10 or newer is required.' }
    if (-not $SkipServices) {
        Require-Command docker
        & docker compose version | Out-Null
    }
}

Write-Step 'Preparing local environment files'
Initialize-Environment "$repoRoot/backend/.env.example" "$repoRoot/backend/.env" $true
Initialize-Environment "$repoRoot/frontend/.env.local.example" "$repoRoot/frontend/.env.local" $false

if (-not $SkipServices) {
    Write-Step 'Starting PostgreSQL/TimescaleDB and Redis'
    if ($WhatIf) {
        Write-Host 'Would run: docker compose -f docker-compose.dev.yml up -d --wait'
    } else {
        Push-Location $repoRoot
        try { & docker compose -f docker-compose.dev.yml up -d --wait } finally { Pop-Location }
    }
}

if (-not $SkipDependencies) {
    Write-Step 'Installing locked Node dependencies'
    foreach ($workspace in @('backend', 'frontend')) {
        if ($WhatIf) {
            Write-Host "Would run: npm ci ($workspace)"
        } else {
            Push-Location (Join-Path $repoRoot $workspace)
            try { & npm ci } finally { Pop-Location }
        }
    }
}

if (-not $SkipDatabase) {
    Write-Step 'Generating Prisma client and applying the local schema'
    if ($WhatIf) {
        Write-Host 'Would run: npm run db:generate and npm run db:push (backend)'
    } else {
        Push-Location (Join-Path $repoRoot 'backend')
        try {
            & npm run db:generate
            & npm run db:push
        } finally { Pop-Location }
    }
}

Write-Host "`nSetup complete. Start the services in separate terminals:" -ForegroundColor Green
Write-Host '  cd backend; npm run dev'
Write-Host '  cd frontend; npm run dev'
Write-Host "`nThe generated JWT secret is local-only. Never commit .env files or use local credentials in a deployed environment."
