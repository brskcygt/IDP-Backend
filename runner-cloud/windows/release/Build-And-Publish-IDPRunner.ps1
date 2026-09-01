#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter()] [ValidatePattern('^https://')] [string]$ApiBaseUrl = 'https://idp-runner-api.bariskoc-249.workers.dev',
    [Parameter()] [string]$PkiDirectory = (Join-Path $env:ProgramData 'IDP Signing\Public')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$toolRoot = Join-Path $env:TEMP "idp-build-publish-$PID"
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
try {
    $tools = @{
        'New-IDPSignedRunnerBundle.ps1' = 'CE3557AE575E7283107A0DEA8C1E989CC581A69BEFAB1F23650330D4CC9EED04'
        'New-IDPRunnerInstaller.ps1' = '586D88E0402AF6A86E16A736156591FEF434432FAFC32E167230C8647F14149B'
        'Publish-IDPRunnerInstaller.ps1' = '6D056E5BE424FF96BD8EA2C1AE3018EBAE8ED4E46CBE794580768E9B10907D3C'
    }
    foreach ($tool in $tools.Keys) {
        $toolPath = Join-Path $toolRoot $tool
        Invoke-WebRequest "$($ApiBaseUrl.TrimEnd('/'))/downloads/release/$tool" -OutFile $toolPath -UseBasicParsing
        if ((Get-FileHash -LiteralPath $toolPath -Algorithm SHA256).Hash -ne $tools[$tool]) { throw "Build tool integrity check failed: $tool" }
    }
    $bundle = & (Join-Path $toolRoot 'New-IDPSignedRunnerBundle.ps1') -ApiBaseUrl $ApiBaseUrl -PkiDirectory $PkiDirectory
    $installer = & (Join-Path $toolRoot 'New-IDPRunnerInstaller.ps1') -BundleDirectory $bundle.BundleDirectory -PkiDirectory $PkiDirectory
    $published = & (Join-Path $toolRoot 'Publish-IDPRunnerInstaller.ps1') -InstallerPath $installer.InstallerPath -PkiDirectory $PkiDirectory -ApiBaseUrl $ApiBaseUrl
    [pscustomobject]@{ Ok = $true; ReleaseId = $published.releaseId; InstallerPath = $installer.InstallerPath; Sha256 = $published.installerSha256 }
}
finally {
    Remove-Item -LiteralPath $toolRoot -Recurse -Force -ErrorAction SilentlyContinue
}
