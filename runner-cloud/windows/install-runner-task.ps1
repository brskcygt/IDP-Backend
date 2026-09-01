#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter()]
    [string]$RunnerSourcePath,

    [Parameter()]
    [ValidatePattern('^[A-Fa-f0-9]{40}$')]
    [string]$PublisherThumbprint
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$taskName = 'IDP Runner'
$installRoot = Join-Path $env:ProgramFiles 'IDP Runner'
$dataRoot = Join-Path $env:ProgramData 'IDP Runner'
$runnerPath = Join-Path $installRoot 'idp-runner.ps1'
$downloadPath = Join-Path $env:TEMP 'idp-runner-install.ps1'
$runnerUrl = 'https://idp-runner-api.bariskoc-249.workers.dev/downloads/idp-runner.ps1?version=task-v1'
$expectedHash = '9c9680cb6213b335ee271033e8a20466d4febac67031073fa7d8310dd10c4371'
$serviceUserName = 'idp-runner-svc'
$serviceAccount = "$env:COMPUTERNAME\$serviceUserName"
$signingKeyPath = Join-Path $dataRoot 'job-signing-public.jwk'

if (-not (Test-Path (Join-Path $dataRoot 'agent.json'))) {
    throw 'Runner must be enrolled before installing the background task.'
}

if ($RunnerSourcePath) {
    $resolvedRunnerSource = (Resolve-Path -LiteralPath $RunnerSourcePath).Path
    $runnerSignature = Get-AuthenticodeSignature -LiteralPath $resolvedRunnerSource
    if ($runnerSignature.Status -ne 'Valid' -or
        -not $PublisherThumbprint -or
        $runnerSignature.SignerCertificate.Thumbprint -ne $PublisherThumbprint) {
        throw 'Bundled runner has an invalid or unexpected Authenticode signature.'
    }
    $downloadPath = $resolvedRunnerSource
}
else {
    Invoke-WebRequest -Uri $runnerUrl -OutFile $downloadPath -UseBasicParsing
    $actualHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Runner SHA-256 mismatch. Expected $expectedHash, received $actualHash."
    }
}

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -LiteralPath $downloadPath -Destination $runnerPath -Force
if (-not $RunnerSourcePath) { Remove-Item -LiteralPath $downloadPath -Force }

$signingPolicy = Invoke-RestMethod -Method Get `
    -Uri 'https://idp-runner-api.bariskoc-249.workers.dev/v1/policy/job-signing-key'
if (-not $signingPolicy.ok -or $signingPolicy.key.kty -ne 'EC' -or $signingPolicy.key.crv -ne 'P-256') {
    throw 'Runner API returned an invalid job-signing public key.'
}
if ($signingPolicy.key.x -ne 'IF-Sy815eM6NWq-NDGwyaz8FGLoLbVVVvhqtChzZd94' -or
    $signingPolicy.key.y -ne 'xn6bFICjvyafyVxVh7o1eMHEL097RAUGiLBpVzrCLb4') {
    throw 'Runner API job-signing public key does not match the pinned key.'
}
$signingPolicy.key | ConvertTo-Json -Compress | Set-Content -LiteralPath $signingKeyPath -Encoding UTF8

$servicePassword = Read-Host "Password for local service account $serviceAccount" -AsSecureString
if (-not (Get-LocalUser -Name $serviceUserName -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $serviceUserName -Password $servicePassword `
        -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword `
        -Description 'IDP Windows Runner service account' | Out-Null
}

$serviceSid = ([Security.Principal.NTAccount]$serviceAccount).Translate(
    [Security.Principal.SecurityIdentifier]
).Value
$persistedConfig = Get-Content -LiteralPath (Join-Path $dataRoot 'agent.json') -Raw | ConvertFrom-Json
$persistedConfig | Add-Member -NotePropertyName serviceAccountSid -NotePropertyValue $serviceSid -Force
$persistedConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $dataRoot 'agent.json') -Encoding UTF8
$rightsExport = Join-Path $env:TEMP "idp-runner-rights-$PID.inf"
$rightsDb = Join-Path $env:TEMP "idp-runner-rights-$PID.sdb"
try {
    & "$env:SystemRoot\System32\secedit.exe" /export /cfg $rightsExport /areas USER_RIGHTS | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not export local user-rights policy.' }
    $rights = Get-Content -LiteralPath $rightsExport
    $batchIndex = -1
    for ($index = 0; $index -lt $rights.Count; $index++) {
        if ($rights[$index] -match '^SeBatchLogonRight\s*=') { $batchIndex = $index; break }
    }
    if ($batchIndex -lt 0) { throw 'SeBatchLogonRight was not found in the exported policy.' }
    if ($rights[$batchIndex] -notmatch [regex]::Escape("*$serviceSid")) {
        $rights[$batchIndex] = $rights[$batchIndex].TrimEnd() + ",*$serviceSid"
        $rights | Set-Content -LiteralPath $rightsExport -Encoding Unicode
        & "$env:SystemRoot\System32\secedit.exe" /configure /db $rightsDb /cfg $rightsExport /areas USER_RIGHTS | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not grant Log on as a batch job to the runner service account.' }
    }
}
finally {
    Remove-Item -LiteralPath $rightsExport, $rightsDb -Force -ErrorAction SilentlyContinue
}

& "$env:SystemRoot\System32\icacls.exe" $installRoot /inheritance:r `
    /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$serviceAccount`:(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the runner installation ACL.' }
& "$env:SystemRoot\System32\icacls.exe" $dataRoot /inheritance:r `
    /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$serviceAccount`:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the runner data ACL.' }

# Enrollment deliberately protects agent.json with a non-inheriting ACL, so
# the directory grant above cannot make it readable by the service account.
$agentConfigPath = Join-Path $dataRoot 'agent.json'
foreach ($readOnlyPath in @($agentConfigPath, $signingKeyPath)) {
    & "$env:SystemRoot\System32\icacls.exe" $readOnlyPath /grant:r "$serviceAccount`:R" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not grant the service account read access to $readOnlyPath." }
}

$agentConfig = Get-Content -LiteralPath $agentConfigPath -Raw | ConvertFrom-Json
$cngProvider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
$cngOpen = [Security.Cryptography.CngKeyOpenOptions]::MachineKey
foreach ($keyName in @([string]$agentConfig.signingKeyName, [string]$agentConfig.exchangeKeyName)) {
    $key = [Security.Cryptography.CngKey]::Open($keyName, $cngProvider, $cngOpen)
    try {
        $keyFile = Join-Path "$env:ProgramData\Microsoft\Crypto\Keys" $key.UniqueName
        & "$env:SystemRoot\System32\icacls.exe" $keyFile /grant "$serviceAccount`:R" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not grant the service account access to CNG key $keyName." }
    }
    finally { $key.Dispose() }
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runnerPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($servicePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -User $serviceAccount -Password $plainPassword -RunLevel Limited `
        -Settings $settings -Description 'IDP Windows deployment runner' -Force | Out-Null
}
finally {
    $plainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
    $servicePassword.Dispose()
}
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    TaskName = $task.TaskName
    State = $task.State
    RunAs = $serviceAccount
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    RunnerPath = $runnerPath
    LogPath = (Join-Path $dataRoot 'runner.log')
}
