#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^https://')]
    [string]$ApiBaseUrl = 'https://idp-runner-api.bariskoc-249.workers.dev',

    [Parameter()]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$')]
    [string]$AgentName = $env:COMPUTERNAME
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

# Fail before consuming an enrollment token if machine-scoped DPAPI is not
# available in this PowerShell/.NET installation.
$dpapiProbe = [Text.Encoding]::UTF8.GetBytes('idp-runner-dpapi-probe')
$dpapiProbeProtected = [System.Security.Cryptography.ProtectedData]::Protect(
    $dpapiProbe,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::LocalMachine
)
[Array]::Clear($dpapiProbe, 0, $dpapiProbe.Length)
[Array]::Clear($dpapiProbeProtected, 0, $dpapiProbeProtected.Length)

$programDataRoot = Join-Path $env:ProgramData 'IDP Runner'
$configPath = Join-Path $programDataRoot 'agent.json'
$provider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
$openOptions = [Security.Cryptography.CngKeyOpenOptions]::MachineKey
$signingKeyName = "IDPRunner-$AgentName-Signing"
$exchangeKeyName = "IDPRunner-$AgentName-Exchange"

function Open-OrCreateMachineKey {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [Security.Cryptography.CngAlgorithm]$Algorithm
    )

    if ([Security.Cryptography.CngKey]::Exists($Name, $provider, $openOptions)) {
        return [Security.Cryptography.CngKey]::Open($Name, $provider, $openOptions)
    }

    $creation = [Security.Cryptography.CngKeyCreationParameters]::new()
    $creation.Provider = $provider
    $creation.KeyCreationOptions = [Security.Cryptography.CngKeyCreationOptions]::MachineKey
    $creation.ExportPolicy = [Security.Cryptography.CngExportPolicies]::None
    return [Security.Cryptography.CngKey]::Create($Algorithm, $Name, $creation)
}

function ConvertFrom-SecureValue {
    param([Parameter(Mandatory)] [Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

if (Test-Path $configPath) {
    throw "Runner is already enrolled. Existing configuration: $configPath"
}

New-Item -ItemType Directory -Path $programDataRoot -Force | Out-Null
& "$env:SystemRoot\System32\icacls.exe" $programDataRoot /inheritance:r `
    /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Could not restrict the IDP Runner data directory ACL.'
}

$signingKey = Open-OrCreateMachineKey -Name $signingKeyName `
    -Algorithm ([Security.Cryptography.CngAlgorithm]::ECDsaP256)
$exchangeKey = Open-OrCreateMachineKey -Name $exchangeKeyName `
    -Algorithm ([Security.Cryptography.CngAlgorithm]::ECDiffieHellmanP256)

try {
    if ($env:IDP_ENROLLMENT_TOKEN) {
        $token = [string]$env:IDP_ENROLLMENT_TOKEN
        Remove-Item Env:\IDP_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue
        try {
            $body = @{
                token = $token
                agentName = $AgentName
                signingPublicKey = [Convert]::ToBase64String(
                    $signingKey.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
                )
                exchangePublicKey = [Convert]::ToBase64String(
                    $exchangeKey.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
                )
                version = '0.3.0'
                osVersion = [Environment]::OSVersion.VersionString
            } | ConvertTo-Json -Compress

            $response = Invoke-RestMethod -Method Post `
                -Uri "$($ApiBaseUrl.TrimEnd('/'))/v1/agents/enroll" `
                -ContentType 'application/json' `
                -Body $body
        }
        finally { $token = $null }
    }
    else {
        $session = Invoke-RestMethod -Method Post `
            -Uri "$($ApiBaseUrl.TrimEnd('/'))/v1/bootstrap/sessions" `
            -ContentType 'application/json' `
            -Body (@{ agentName = $AgentName } | ConvertTo-Json -Compress)
        Write-Host ''
        Write-Host "IDP APPROVAL CODE: $($session.userCode)" -ForegroundColor Cyan
        Write-Host 'Enter this code in IDP Runner enrollment. Waiting for approval...' -ForegroundColor Yellow
        do {
            Start-Sleep -Seconds ([Math]::Max(2, [int]$session.pollAfterSeconds))
            $status = Invoke-RestMethod -Method Post `
                -Uri "$($ApiBaseUrl.TrimEnd('/'))/v1/bootstrap/sessions/$($session.sessionId)/status" `
                -ContentType 'application/json' `
                -Body (@{ pollSecret = [string]$session.pollSecret } | ConvertTo-Json -Compress)
        } while (-not $status.approved)

        $body = @{
            pollSecret = [string]$session.pollSecret
            signingPublicKey = [Convert]::ToBase64String($signingKey.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))
            exchangePublicKey = [Convert]::ToBase64String($exchangeKey.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))
            version = '0.3.0'
            osVersion = [Environment]::OSVersion.VersionString
        } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -Method Post `
            -Uri "$($ApiBaseUrl.TrimEnd('/'))/v1/bootstrap/sessions/$($session.sessionId)/enroll" `
            -ContentType 'application/json' -Body $body
        $session.pollSecret = $null
    }

    if (-not $response.ok -or -not $response.agentId -or -not $response.credential) {
        throw 'The enrollment service returned an incomplete response.'
    }

    $credentialBytes = [Text.Encoding]::UTF8.GetBytes([string]$response.credential)
    try {
        $protectedCredential = [System.Security.Cryptography.ProtectedData]::Protect(
            $credentialBytes,
            $null,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
    }
    finally {
        [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
        $response.credential = $null
    }

    $config = [ordered]@{
        apiBaseUrl = $ApiBaseUrl.TrimEnd('/')
        agentId = [string]$response.agentId
        agentName = $AgentName
        signingKeyName = $signingKeyName
        exchangeKeyName = $exchangeKeyName
        credentialDpapi = [Convert]::ToBase64String($protectedCredential)
        enrolledAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
    & "$env:SystemRoot\System32\icacls.exe" $configPath /inheritance:r `
        /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Enrollment succeeded, but the runner configuration ACL could not be restricted.'
    }

    Write-Host "Enrollment succeeded: $AgentName ($($response.agentId))" -ForegroundColor Green
    Write-Host "Protected configuration: $configPath"
}
finally {
    $signingKey.Dispose()
    $exchangeKey.Dispose()
}
