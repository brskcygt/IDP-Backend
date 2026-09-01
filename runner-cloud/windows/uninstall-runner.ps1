#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'IDP Runner'
$serviceUser = 'idp-runner-svc'
$dataRoot = Join-Path $env:ProgramData 'IDP Runner'
$installRoot = Join-Path $env:ProgramFiles 'IDP Runner'
$configPath = Join-Path $dataRoot 'agent.json'
$receiptRoot = Join-Path $env:ProgramData 'IDP Runner Removal Records'

if (-not (Test-Path -LiteralPath $configPath)) { throw 'IDP Runner configuration was not found; refusing an ambiguous removal.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$expectedPrefix = "IDPRunner-$env:COMPUTERNAME-"
$keyNames = @([string]$config.signingKeyName, [string]$config.exchangeKeyName)
foreach ($keyName in $keyNames) {
    if ([string]::IsNullOrWhiteSpace($keyName) -or -not $keyName.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected runner key name; removal aborted: $keyName"
    }
}

function Remove-BatchLogonRight {
    param([Parameter(Mandatory)] [ValidatePattern('^S-1-5-21-[0-9-]+$')] [string]$Sid)
    $policyPath = Join-Path $env:TEMP "idp-runner-rights-remove-$PID.inf"
    $databasePath = Join-Path $env:TEMP "idp-runner-rights-remove-$PID.sdb"
    try {
        & "$env:SystemRoot\System32\secedit.exe" /export /cfg $policyPath /areas USER_RIGHTS /quiet | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not export user-rights policy (secedit $LASTEXITCODE)." }
        $policy = @(Get-Content -LiteralPath $policyPath)
        $index = -1
        for ($line = 0; $line -lt $policy.Count; $line++) {
            if ($policy[$line] -match '^SeBatchLogonRight\s*=') { $index = $line; break }
        }
        if ($index -lt 0) { return }
        $entries = @(($policy[$index] -split '=', 2)[1] -split ',') |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and $_ -ne "*$Sid" -and $_ -ne $Sid }
        $policy[$index] = 'SeBatchLogonRight = ' + ($entries -join ',')
        $policy | Set-Content -LiteralPath $policyPath -Encoding Unicode
        & "$env:SystemRoot\System32\secedit.exe" /configure /db $databasePath /cfg $policyPath /areas USER_RIGHTS /overwrite /quiet | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not remove batch-logon right (secedit $LASTEXITCODE)." }

        & "$env:SystemRoot\System32\secedit.exe" /export /cfg $policyPath /areas USER_RIGHTS /quiet | Out-Null
        if ((Get-Content -LiteralPath $policyPath -Raw) -match [regex]::Escape("*$Sid")) {
            throw 'Batch-logon SID remained after policy update.'
        }
    }
    finally {
        Remove-Item -LiteralPath $policyPath, $databasePath -Force -ErrorAction SilentlyContinue
    }
}

$serviceSid = if ($config.serviceAccountSid) { [string]$config.serviceAccountSid } elseif (Get-LocalUser -Name $serviceUser -ErrorAction SilentlyContinue) {
    (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, $serviceUser)).Translate([Security.Principal.SecurityIdentifier]).Value
} else { $null }
if ($serviceSid) {
    Remove-BatchLogonRight -Sid $serviceSid
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$provider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
$openOptions = [Security.Cryptography.CngKeyOpenOptions]::MachineKey
foreach ($keyName in $keyNames) {
    if ([Security.Cryptography.CngKey]::Exists($keyName, $provider, $openOptions)) {
        $key = [Security.Cryptography.CngKey]::Open($keyName, $provider, $openOptions)
        try { $key.Delete() } finally { $key.Dispose() }
    }
}

New-Item -ItemType Directory -Path $receiptRoot -Force | Out-Null
$receipt = [ordered]@{
    removedAt = [DateTimeOffset]::UtcNow.ToString('o')
    computerName = $env:COMPUTERNAME
    agentId = [string]$config.agentId
    agentName = [string]$config.agentName
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $receiptRoot "removed-$([DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')).json") -Encoding UTF8

Remove-Item -LiteralPath $dataRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
if (Get-LocalUser -Name $serviceUser -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $serviceUser }

[pscustomobject]@{
    Removed = $true
    AgentId = [string]$config.agentId
    SigningInfrastructurePreserved = Test-Path -LiteralPath (Join-Path $env:ProgramData 'IDP Signing')
}
