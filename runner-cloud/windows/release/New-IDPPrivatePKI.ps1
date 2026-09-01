#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^[A-Za-z0-9 ._-]{3,80}$')]
    [string]$OrganizationName = 'IDP',

    [Parameter()]
    [string]$OutputDirectory = (Join-Path $env:ProgramData 'IDP Signing\Public'),

    [Parameter()]
    [string]$BackupDirectory = (Join-Path $env:ProgramData 'IDP Signing\PRIVATE-BACKUP')
)

$ErrorActionPreference = 'Stop'
$rootSubject = "CN=$OrganizationName Private Root CA"
$publisherSubject = "CN=$OrganizationName Runner Publisher"

$existingRoot = Get-ChildItem Cert:\LocalMachine\My |
    Where-Object Subject -eq $rootSubject |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
$existingPublisher = Get-ChildItem Cert:\LocalMachine\My |
    Where-Object { $_.Subject -eq $publisherSubject -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

if ($existingRoot -or $existingPublisher) {
    throw 'An IDP private PKI already exists on this machine. Refusing to create ambiguous duplicate signing identities.'
}

$root = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $rootSubject `
    -FriendlyName "$OrganizationName Private Root CA" `
    -CertStoreLocation 'Cert:\LocalMachine\My' `
    -KeyAlgorithm RSA `
    -KeyLength 4096 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -KeyUsageProperty Sign `
    -NotAfter (Get-Date).AddYears(10)

try {
    $publisher = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $publisherSubject `
        -FriendlyName "$OrganizationName Runner Code Signing" `
        -CertStoreLocation 'Cert:\LocalMachine\My' `
        -Signer $root `
        -KeyAlgorithm RSA `
        -KeyLength 3072 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears(3)

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
    $rootPath = Join-Path $OutputDirectory 'idp-private-root.cer'
    $publisherPath = Join-Path $OutputDirectory 'idp-runner-publisher.cer'
    Export-Certificate -Cert $root -FilePath $rootPath -Force | Out-Null
    Export-Certificate -Cert $publisher -FilePath $publisherPath -Force | Out-Null

    # Trust is installed only on the controlled signing workstation here.
    Import-Certificate -FilePath $rootPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
    Import-Certificate -FilePath $publisherPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null

    $backupPassword = Read-Host 'Create a strong password for the offline PKI recovery files' -AsSecureString
    try {
        Export-PfxCertificate -Cert $root `
            -FilePath (Join-Path $BackupDirectory 'idp-private-root-KEEP-OFFLINE.pfx') `
            -Password $backupPassword -CryptoAlgorithmOption AES256_SHA256 -Force | Out-Null
        Export-PfxCertificate -Cert $publisher `
            -FilePath (Join-Path $BackupDirectory 'idp-runner-publisher-RECOVERY.pfx') `
            -Password $backupPassword -CryptoAlgorithmOption AES256_SHA256 -Force | Out-Null
    }
    finally {
        $backupPassword.Dispose()
    }

    $manifest = [ordered]@{
        version = 1
        organization = $OrganizationName
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        rootSubject = $root.Subject
        rootThumbprint = $root.Thumbprint
        rootNotAfter = $root.NotAfter.ToUniversalTime().ToString('o')
        publisherSubject = $publisher.Subject
        publisherThumbprint = $publisher.Thumbprint
        publisherNotAfter = $publisher.NotAfter.ToUniversalTime().ToString('o')
        privateKeysBackedUp = $true
    }
    $manifest | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'pki-manifest.json') -Encoding UTF8

    # Keep only the public root in the trust store; root signing requires restoring
    # its encrypted PFX during a controlled certificate-renewal ceremony.
    Remove-Item -LiteralPath "Cert:\LocalMachine\My\$($root.Thumbprint)" -Force

    Write-Warning "Move $BackupDirectory to encrypted offline storage, verify the copy, then delete that directory from this machine."
    Write-Warning 'This machine now holds the active publisher key. Restrict administrator access and do not use it as a customer runner.'
    [pscustomobject]@{
        RootThumbprint = $root.Thumbprint
        PublisherThumbprint = $publisher.Thumbprint
        PublicFiles = $OutputDirectory
        PrivateBackup = $BackupDirectory
        PublisherExpires = $publisher.NotAfter
    }
}
catch {
    Remove-Item -LiteralPath "Cert:\LocalMachine\My\$($root.Thumbprint)" -Force -ErrorAction SilentlyContinue
    throw
}
