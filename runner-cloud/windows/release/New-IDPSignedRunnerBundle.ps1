#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^https://')]
    [string]$ApiBaseUrl = 'https://idp-runner-api.bariskoc-249.workers.dev',

    [Parameter()]
    [string]$PkiDirectory = (Join-Path $env:ProgramData 'IDP Signing\Public'),

    [Parameter()]
    [string]$OutputDirectory = (Join-Path $env:ProgramData 'IDP Signing\Releases')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$pkiManifestPath = Join-Path $PkiDirectory 'pki-manifest.json'
if (-not (Test-Path -LiteralPath $pkiManifestPath)) {
    throw "PKI manifest was not found: $pkiManifestPath"
}
$pki = Get-Content -LiteralPath $pkiManifestPath -Raw | ConvertFrom-Json
$publisher = Get-Item -LiteralPath "Cert:\LocalMachine\My\$($pki.publisherThumbprint)" -ErrorAction Stop
if (-not $publisher.HasPrivateKey) { throw 'The publisher certificate private key is unavailable.' }

$releaseId = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$releaseRoot = Join-Path $OutputDirectory "idp-runner-$releaseId"
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

$artifacts = @(
    @{ Name = 'enroll-runner.ps1'; Url = "$ApiBaseUrl/downloads/enroll-runner.ps1" },
    @{ Name = 'install-runner-task.ps1'; Url = "$ApiBaseUrl/downloads/install-runner-task.ps1" },
    @{ Name = 'idp-runner.ps1'; Url = "$ApiBaseUrl/downloads/idp-runner.ps1" },
    @{ Name = 'install-runner-bundle.ps1'; Url = "$ApiBaseUrl/downloads/install-runner-bundle.ps1" },
    @{ Name = 'uninstall-runner.ps1'; Url = "$ApiBaseUrl/downloads/uninstall-runner.ps1" }
    @{ Name = 'upgrade-runner.ps1'; Url = "$ApiBaseUrl/downloads/upgrade-runner.ps1" }
)

foreach ($artifact in $artifacts) {
    $path = Join-Path $releaseRoot $artifact.Name
    Invoke-WebRequest -Uri $artifact.Url -OutFile $path -UseBasicParsing
    $signature = Set-AuthenticodeSignature -FilePath $path -Certificate $publisher -HashAlgorithm SHA256
    if ($signature.Status -ne 'Valid') {
        throw "Signing failed for $($artifact.Name): $($signature.StatusMessage)"
    }
}

Copy-Item -LiteralPath (Join-Path $PkiDirectory 'idp-private-root.cer') -Destination $releaseRoot
Copy-Item -LiteralPath (Join-Path $PkiDirectory 'idp-runner-publisher.cer') -Destination $releaseRoot

$files = foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -File | Sort-Object Name) {
    [ordered]@{
        name = $file.Name
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        size = $file.Length
    }
}
$releaseManifest = [ordered]@{
    version = 1
    releaseId = $releaseId
    createdAt = [DateTimeOffset]::UtcNow.ToString('o')
    apiBaseUrl = $ApiBaseUrl.TrimEnd('/')
    rootThumbprint = [string]$pki.rootThumbprint
    publisherThumbprint = [string]$pki.publisherThumbprint
    files = @($files)
}
$releaseManifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $releaseRoot 'release-manifest.json') -Encoding UTF8

$zipPath = "$releaseRoot.zip"
Compress-Archive -Path (Join-Path $releaseRoot '*') -DestinationPath $zipPath -Force

[pscustomobject]@{
    ReleaseId = $releaseId
    BundleDirectory = $releaseRoot
    ZipPath = $zipPath
    PublisherThumbprint = $pki.publisherThumbprint
}
