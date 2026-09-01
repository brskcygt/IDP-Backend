#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$')]
    [string]$AgentName = $env:COMPUTERNAME
)

$ErrorActionPreference = 'Stop'
$bundleRoot = $PSScriptRoot
$manifestPath = Join-Path $bundleRoot 'release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Release manifest is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$rootPath = Join-Path $bundleRoot 'idp-private-root.cer'
$publisherPath = Join-Path $bundleRoot 'idp-runner-publisher.cer'
$root = [Security.Cryptography.X509Certificates.X509Certificate2]::new($rootPath)
$publisher = [Security.Cryptography.X509Certificates.X509Certificate2]::new($publisherPath)
if ($root.Thumbprint -ne [string]$manifest.rootThumbprint -or
    $publisher.Thumbprint -ne [string]$manifest.publisherThumbprint) {
    throw 'Bundle certificate thumbprints do not match the release manifest.'
}

Import-Certificate -FilePath $rootPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
Import-Certificate -FilePath $publisherPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null

foreach ($entry in $manifest.files) {
    $path = Join-Path $bundleRoot ([string]$entry.name)
    if (-not (Test-Path -LiteralPath $path)) { throw "Bundle file is missing: $($entry.name)" }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne [string]$entry.sha256) {
        throw "Bundle hash verification failed: $($entry.name)"
    }
    if ([IO.Path]::GetExtension($path) -eq '.ps1') {
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $publisher.Thumbprint) {
            throw "Bundle signature verification failed: $($entry.name)"
        }
    }
}

Set-ExecutionPolicy -Scope Process -ExecutionPolicy AllSigned -Force
& (Join-Path $bundleRoot 'enroll-runner.ps1') -ApiBaseUrl ([string]$manifest.apiBaseUrl) -AgentName $AgentName
$agentConfigPath = Join-Path $env:ProgramData 'IDP Runner\agent.json'
$agentConfig = Get-Content -LiteralPath $agentConfigPath -Raw | ConvertFrom-Json
$agentConfig | Add-Member -NotePropertyName installedReleaseId -NotePropertyValue ([string]$manifest.releaseId) -Force
$agentConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $agentConfigPath -Encoding UTF8
& (Join-Path $bundleRoot 'install-runner-task.ps1') `
    -RunnerSourcePath (Join-Path $bundleRoot 'idp-runner.ps1') `
    -PublisherThumbprint $publisher.Thumbprint
