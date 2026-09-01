#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$InstallerPath,
    [Parameter()] [string]$PkiDirectory = (Join-Path $env:ProgramData 'IDP Signing\Public'),
    [Parameter()] [ValidatePattern('^https://')] [string]$ApiBaseUrl = 'https://idp-runner-api.bariskoc-249.workers.dev'
)

$ErrorActionPreference = 'Stop'
$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.Name -notmatch '^MDP-Runner-Setup-([0-9]{8}-[0-9]{6})\.exe$') { throw 'Installer filename does not contain a valid release ID.' }
$releaseId = $Matches[1]
$rootPath = Join-Path $PkiDirectory 'idp-private-root.cer'
$publisherPath = Join-Path $PkiDirectory 'idp-runner-publisher.cer'
$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne 'F995D43C136CD3DA167E6FBA56057069B35A72EA') {
    throw 'Installer Authenticode signature is invalid or has an unexpected publisher.'
}
$uploadTokenSecure = Read-Host 'Paste the one-time release upload token' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($uploadTokenSecure)
try {
    $uploadToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $body = @{
        token = $uploadToken
        releaseId = $releaseId
        installerBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($installer.FullName))
        rootCertBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($rootPath))
        publisherCertBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($publisherPath))
    } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod -Method Post -Uri "$($ApiBaseUrl.TrimEnd('/'))/v1/releases/upload" `
        -ContentType 'application/json' -Body $body
    $result
}
finally {
    $uploadToken = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $uploadTokenSecure.Dispose()
}
