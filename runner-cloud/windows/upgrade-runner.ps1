#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$bundleRoot = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $bundleRoot 'release-manifest.json') -Raw | ConvertFrom-Json
$source = Join-Path $bundleRoot 'idp-runner.ps1'
$target = Join-Path $env:ProgramFiles 'IDP Runner\idp-runner.ps1'
$configPath = Join-Path $env:ProgramData 'IDP Runner\agent.json'
$rollbackRoot = Join-Path $env:ProgramData 'IDP Runner\Rollback'

if (-not (Get-ScheduledTask -TaskName 'IDP Runner' -ErrorAction SilentlyContinue)) { throw 'IDP Runner task is not installed.' }
if (-not (Test-Path -LiteralPath $target) -or -not (Test-Path -LiteralPath $configPath)) { throw 'Existing runner installation is incomplete.' }
$signature = Get-AuthenticodeSignature -LiteralPath $source
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne [string]$manifest.publisherThumbprint) {
    throw 'Upgrade runner signature is invalid.'
}

$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$backup = Join-Path $rollbackRoot $stamp
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'idp-runner.ps1')
Copy-Item -LiteralPath $configPath -Destination (Join-Path $backup 'agent.json')

try {
    Stop-ScheduledTask -TaskName 'IDP Runner' -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $source -Destination $target -Force
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $config | Add-Member -NotePropertyName installedReleaseId -NotePropertyValue ([string]$manifest.releaseId) -Force
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
    Start-ScheduledTask -TaskName 'IDP Runner'
    Start-Sleep -Seconds 5
    $task = Get-ScheduledTask -TaskName 'IDP Runner'
    if ($task.State -ne 'Running') { throw "Runner did not remain running after upgrade (state: $($task.State))." }
}
catch {
    Stop-ScheduledTask -TaskName 'IDP Runner' -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $backup 'idp-runner.ps1') -Destination $target -Force
    Copy-Item -LiteralPath (Join-Path $backup 'agent.json') -Destination $configPath -Force
    Start-ScheduledTask -TaskName 'IDP Runner' -ErrorAction SilentlyContinue
    throw "Upgrade failed and the previous runner was restored. $($_.Exception.Message)"
}

[pscustomobject]@{ Upgraded = $true; ReleaseId = [string]$manifest.releaseId; RollbackBackup = $backup }
