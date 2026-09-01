#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$Once,
    [ValidateRange(5, 300)]
    [int]$DefaultPollSeconds = 15
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

$configPath = Join-Path $env:ProgramData 'IDP Runner\agent.json'
$jobSigningKeyPath = Join-Path $env:ProgramData 'IDP Runner\job-signing-public.jwk'
$logPath = Join-Path $env:ProgramData 'IDP Runner\runner.log'
if (-not (Test-Path $configPath)) {
    throw "Runner is not enrolled: $configPath was not found."
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$provider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
$lastEmptyLogAt = [DateTimeOffset]::MinValue

function Write-RunnerLog {
    param([Parameter(Mandatory)] [string]$Message)
    $line = "[$([DateTimeOffset]::Now.ToString('o'))] $Message"
    Write-Host $line
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function New-RequestNonce {
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 24
        $generator.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    finally {
        $generator.Dispose()
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)] [string]$Value)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))
        return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function ConvertFrom-Base64Url {
    param([Parameter(Mandatory)] [string]$Value)
    $base64 = $Value.Replace('-', '+').Replace('_', '/')
    switch ($base64.Length % 4) {
        2 { $base64 += '==' }
        3 { $base64 += '=' }
        1 { throw 'Invalid base64url value in signing key.' }
    }
    return [Convert]::FromBase64String($base64)
}

function Test-JobSignature {
    param(
        [Parameter(Mandatory)] [string]$Payload,
        [Parameter(Mandatory)] [string]$Signature
    )
    if (-not (Test-Path $jobSigningKeyPath)) { throw 'Pinned job signing key is missing.' }
    $jwk = Get-Content -LiteralPath $jobSigningKeyPath -Raw | ConvertFrom-Json
    if ($jwk.kty -ne 'EC' -or $jwk.crv -ne 'P-256') { throw 'Pinned job signing key is invalid.' }
    $x = ConvertFrom-Base64Url ([string]$jwk.x)
    $y = ConvertFrom-Base64Url ([string]$jwk.y)
    if ($x.Length -ne 32 -or $y.Length -ne 32) { throw 'Pinned P-256 coordinates are invalid.' }

    $blob = New-Object byte[] 72
    [Text.Encoding]::ASCII.GetBytes('ECS1').CopyTo($blob, 0)
    [BitConverter]::GetBytes([int]32).CopyTo($blob, 4)
    $x.CopyTo($blob, 8)
    $y.CopyTo($blob, 40)
    $publicKey = [Security.Cryptography.CngKey]::Import(
        $blob,
        [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob
    )
    $verifier = [Security.Cryptography.ECDsaCng]::new($publicKey)
    try {
        return $verifier.VerifyData(
            [Text.Encoding]::UTF8.GetBytes($Payload),
            [Convert]::FromBase64String($Signature),
            [Security.Cryptography.HashAlgorithmName]::SHA256
        )
    }
    finally {
        $verifier.Dispose()
        $publicKey.Dispose()
    }
}

function Invoke-SignedAgentRequest {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [hashtable]$Payload
    )

    $protected = [Convert]::FromBase64String([string]$config.credentialDpapi)
    $credentialBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    $credential = [Text.Encoding]::UTF8.GetString($credentialBytes)
    $key = [Security.Cryptography.CngKey]::Open(
        [string]$config.signingKeyName,
        $provider,
        [Security.Cryptography.CngKeyOpenOptions]::MachineKey
    )
    $signer = [Security.Cryptography.ECDsaCng]::new($key)

    try {
        $body = $Payload | ConvertTo-Json -Compress
        $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
        $nonce = New-RequestNonce
        $canonical = "POST`n$Path`n$timestamp`n$nonce`n$(Get-Sha256Hex -Value $body)"
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
        return Invoke-RestMethod -Method Post `
            -Uri "$($config.apiBaseUrl)$Path" `
            -Headers $headers `
            -ContentType 'application/json; charset=utf-8' `
            -Body $body
    }
    finally {
        $credential = $null
        [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
        [Array]::Clear($protected, 0, $protected.Length)
        $signer.Dispose()
        $key.Dispose()
    }
}

function Send-JobText {
    param([string]$JobId, [string]$Stream, [string]$Text, [int]$Sequence)
    if ([string]::IsNullOrEmpty($Text)) { return $Sequence }
    for ($offset = 0; $offset -lt $Text.Length; $offset += 12000) {
        $length = [Math]::Min(12000, $Text.Length - $offset)
        $null = Invoke-SignedAgentRequest -Path "/v1/agents/jobs/$JobId/logs" -Payload @{
            sequence = $Sequence; stream = $Stream; content = $Text.Substring($offset, $length)
        }
        $Sequence++
    }
    return $Sequence
}

function Invoke-PowerShellJob {
    param([string]$JobId, [string]$Script, [int]$TimeoutSeconds)
    $jobRoot = Join-Path ([IO.Path]::GetTempPath()) "idp-job-$JobId"
    $scriptPath = Join-Path $jobRoot 'job.ps1'
    $process = $null
    New-Item -ItemType Directory -Path $jobRoot -Force | Out-Null
    try {
        [IO.File]::WriteAllText($scriptPath, $Script, [Text.UTF8Encoding]::new($false))
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = 'powershell.exe'
        $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'PowerShell child process did not start.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $cancelled = $false
        $timedOut = $false
        while (-not $process.WaitForExit(1000)) {
            if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                $timedOut = $true
                break
            }
            try {
                $state = Invoke-SignedAgentRequest -Path "/v1/agents/jobs/$JobId/status" -Payload @{}
                if ($state.cancelRequested -eq $true) {
                    $cancelled = $true
                    break
                }
            }
            catch {
                Write-RunnerLog "Job $JobId cancellation check failed; execution continues: $($_.Exception.Message)"
            }
        }
        if ($cancelled -or $timedOut) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
            $process.WaitForExit()
            $exitCode = if ($cancelled) { 130 } else { 124 }
        }
        else {
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        return [pscustomobject]@{
            ExitCode = $exitCode
            Stdout = $stdoutTask.GetAwaiter().GetResult()
            Stderr = $stderrTask.GetAwaiter().GetResult()
            Cancelled = $cancelled
        }
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
        Remove-Item -LiteralPath $jobRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

do {
    try {
        $response = Invoke-SignedAgentRequest -Path '/v1/agents/jobs/lease' -Payload @{
            version = '0.3.0'
            osVersion = [Environment]::OSVersion.VersionString
            releaseId = if ($config.installedReleaseId) { [string]$config.installedReleaseId } else { $null }
        }
        if ($null -eq $response.job) {
            if (([DateTimeOffset]::Now - $lastEmptyLogAt).TotalMinutes -ge 5) {
                Write-RunnerLog 'Connected; queue is empty.'
                $lastEmptyLogAt = [DateTimeOffset]::Now
            }
        }
        else {
            $job = $response.job
            $payload = [string]$job.payload | ConvertFrom-Json
            $diagnostic = $job.payloadSignature -eq 'allowlisted-diagnostic-v1' -and
                $payload.type -eq 'diagnostic' -and $payload.action -eq 'hostname' -and
                [int]$payload.version -eq 1
            $signedPowerShell = $payload.type -eq 'powershell' -and [int]$payload.version -eq 1 -and
                (Test-JobSignature -Payload ([string]$job.payload) -Signature ([string]$job.payloadSignature))
            if (-not $diagnostic -and -not $signedPowerShell) {
                throw "Refusing unsupported or unsigned job $($job.id)."
            }
            if ($signedPowerShell) {
                $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
                if ([long]$payload.expiresAt -lt $now -or [int]$payload.timeoutSeconds -ne [int]$job.timeoutSeconds -or
                    [int]$payload.timeoutSeconds -lt 1 -or [int]$payload.timeoutSeconds -gt 3600 -or
                    [Text.Encoding]::UTF8.GetByteCount([string]$payload.script) -gt 65536) {
                    throw "Signed PowerShell job $($job.id) violates execution policy."
                }
            }

            $null = Invoke-SignedAgentRequest -Path "/v1/agents/jobs/$($job.id)/start" -Payload @{}
            $exitCode = 0
            try {
                if ($diagnostic) {
                    $result = [pscustomobject]@{ ExitCode = 0; Stdout = [Environment]::MachineName; Stderr = '' }
                } else {
                    $result = Invoke-PowerShellJob -JobId ([string]$job.id) -Script ([string]$payload.script) `
                        -TimeoutSeconds ([int]$payload.timeoutSeconds)
                }
                $sequence = Send-JobText -JobId ([string]$job.id) -Stream 'stdout' -Text ([string]$result.Stdout) -Sequence 0
                $sequence = Send-JobText -JobId ([string]$job.id) -Stream 'stderr' -Text ([string]$result.Stderr) -Sequence $sequence
                $exitCode = [int]$result.ExitCode
                if ($result.Cancelled -eq $true) {
                    Write-RunnerLog "Job $($job.id) cancelled; process tree terminated with exit code $exitCode."
                }
                else {
                    Write-RunnerLog "Job $($job.id) completed with exit code $exitCode."
                }
            }
            catch {
                $exitCode = 1
                Write-RunnerLog "Job $($job.id) failed: $($_.Exception.Message)"
            }
            finally {
                $null = Invoke-SignedAgentRequest -Path "/v1/agents/jobs/$($job.id)/complete" -Payload @{
                    exitCode = $exitCode
                }
            }
        }
        $pollSeconds = if ($response.pollAfterSeconds) {
            [Math]::Max(5, [Math]::Min(300, [int]$response.pollAfterSeconds))
        }
        else { $DefaultPollSeconds }
    }
    catch {
        Write-RunnerLog "Polling failed: $($_.Exception.Message)"
        if ($Once) { throw }
        $pollSeconds = [Math]::Min(300, $DefaultPollSeconds * 2)
    }

    if (-not $Once) { Start-Sleep -Seconds $pollSeconds }
} while (-not $Once)
