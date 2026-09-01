#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

$configPath = Join-Path $env:ProgramData 'IDP Runner\agent.json'
if (-not (Test-Path $configPath)) {
    throw "Runner is not enrolled: $configPath was not found."
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

$protectedCredential = [Convert]::FromBase64String([string]$config.credentialDpapi)
$credentialBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedCredential,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::LocalMachine
)
$credential = [Text.Encoding]::UTF8.GetString($credentialBytes)

$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$nonceBytes = New-Object byte[] 24
$random.GetBytes($nonceBytes)
$nonce = [Convert]::ToBase64String($nonceBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$path = '/v1/agents/heartbeat'
$body = @{
    version = '0.1.0'
    osVersion = [Environment]::OSVersion.VersionString
} | ConvertTo-Json -Compress

$sha256 = [Security.Cryptography.SHA256]::Create()
$bodyHashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))
$bodyHash = ([BitConverter]::ToString($bodyHashBytes)).Replace('-', '').ToLowerInvariant()
$canonical = "POST`n$path`n$timestamp`n$nonce`n$bodyHash"

$provider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
$key = [Security.Cryptography.CngKey]::Open(
    [string]$config.signingKeyName,
    $provider,
    [Security.Cryptography.CngKeyOpenOptions]::MachineKey
)
$signer = [Security.Cryptography.ECDsaCng]::new($key)

try {
    $signature = $signer.SignData(
        [Text.Encoding]::UTF8.GetBytes($canonical),
        [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $headers = @{
        Authorization = "Bearer $credential"
        'X-IDP-Agent-ID' = [string]$config.agentId
        'X-IDP-Timestamp' = $timestamp
        'X-IDP-Nonce' = $nonce
        'X-IDP-Signature' = [Convert]::ToBase64String($signature)
    }
    $response = Invoke-RestMethod -Method Post `
        -Uri "$($config.apiBaseUrl)$path" `
        -Headers $headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $body
    $response | Select-Object ok, agentId, serverTime, pollAfterSeconds
}
finally {
    $credential = $null
    [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
    [Array]::Clear($protectedCredential, 0, $protectedCredential.Length)
    $signer.Dispose()
    $key.Dispose()
    $sha256.Dispose()
    $random.Dispose()
}
