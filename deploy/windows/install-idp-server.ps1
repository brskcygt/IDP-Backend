#Requires -Version 5.1
<#
.SYNOPSIS
    IDP backend ve idp-agent-gateway'i bu Windows sunucusuna kurar, gunceller veya kaldirir.

.DESCRIPTION
    Idempotent: tekrar calistirmak guvenlidir. Her calistirmada
      - Node surumunu dogrular, backend ve idp-agent-gateway icin `npm ci --omit=dev` calistirir,
      - mevcut sirlari (SESSION_SECRET, IDP_SECRET_KEY, IDP_AGENT_API_TOKEN) KORUR, sadece eksikleri uretir,
      - IDP_AGENT_PUBLIC_URL ve Cloudflare Access ciftini parametre verilmedikce KORUR,
      - gateway kontrol dinleyicisini 127.0.0.1:7004'e baglar (firewall kurali acmaz),
      - servis hesabini, dosya izinlerini, firewall kurallarini ve zamanlanmis gorevleri yeniden uygular,
      - gorevleri yeniden baslatir ve saglik kontrolu yapar.
    `git pull` YAPMAZ: kodu guncellemek operatorun isidir.

    Bu dosya bilerek ASCII tutuldu: Windows PowerShell 5.1, BOM'suz .ps1 dosyalarini ANSI kod
    sayfasiyla okur; Turkce karakterler bozulurdu.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install-idp-server.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$RepoPath,

    [string]$DataDir = (Join-Path $env:ProgramData 'IDP\Server'),

    [ValidateRange(1, 65535)]
    [int]$Port = 3001,

    [string]$BindHost = '0.0.0.0',

    [ValidateRange(1, 65535)]
    [int]$GatewayPort = 7003,

    [string]$GatewayBindHost = '0.0.0.0',

    # Agent'larin baglanacagi adres -> backend .env IDP_AGENT_PUBLIC_URL (ws:// veya wss://, orn. wss://agent.ornek.com).
    # Verilmezse .env'deki mevcut deger korunur; o da yoksa ws://<ilk ic IP>:<GatewayPort> yazilir (ic ag davranisi).
    [string]$AgentPublicUrl,

    # Cloudflare Access service token -> backend .env IDP_AGENT_CF_ACCESS_CLIENT_ID / _SECRET (ikisi birlikte).
    # -CfAccessClientId verilip secret verilmezse secret gizli girisle sorulur. Verilmezse mevcut degerler korunur.
    [string]$CfAccessClientId,

    [System.Security.SecureString]$CfAccessClientSecret,

    [System.Security.SecureString]$AdminPassword,

    [switch]$SkipFirewall,

    [switch]$Uninstall,

    # Varsayilan (eski) yollardaki veriyi bilerek yok say ve DataDir'de sifirdan basla.
    [switch]$IgnoreLegacyData,

    # Verilirse portlar Public profilde de acilir ama SADECE bu uzak adreslere (orn. LocalSubnet, 192.168.0.7).
    # Verilmezse Public kurali kaldirilir. Any / * / bos kabul edilmez.
    [string[]]$FirewallPublicRemoteAddress
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ------------------------------------------------------------------ sabitler
$BackendTaskName     = 'IDP-Backend'
$GatewayTaskName     = 'IDP-Agent-Gateway'
$ServiceUserName     = 'idp-svc'
$ServiceAccount      = $env:COMPUTERNAME + '\' + $ServiceUserName
$FirewallBackendRule = 'IDP-Backend-Inbound'
$FirewallGatewayRule = 'IDP-Agent-Gateway-Inbound'
$FirewallBackendPublicRule = 'IDP-Backend-Inbound-PublicRestricted'
$FirewallGatewayPublicRule = 'IDP-Agent-Gateway-Inbound-PublicRestricted'
$FirewallGroup       = 'IDP Server'
# Gateway kontrol dinleyicisi (tum HTTP uclari + backend aboneligi): sadece yerel. Firewall kurali ACILMAZ, tunele eklenmez.
$GatewayControlHost  = '127.0.0.1'
$GatewayControlPort  = 7004
# .env'e tirnaksiz yazilabilecek degerler (IDP_AGENT_API_TOKEN kontroluyle ayni karakter kumesi).
$EnvSafeValuePattern = '^[A-Za-z0-9._~+/=-]+$'
$MinNodeVersion      = [version]'22.13.0'   # node:sqlite bayraksiz: 22.13+
$HealthTimeoutSec    = 120
$LogRotateBytes      = 20MB
$SidSystem           = 'S-1-5-18'
$SidAdministrators   = 'S-1-5-32-544'
$System32            = Join-Path $env:SystemRoot 'System32'
$CmdExe              = Join-Path $System32 'cmd.exe'
$IcaclsExe           = Join-Path $System32 'icacls.exe'
$SeceditExe          = Join-Path $System32 'secedit.exe'
$EnvLinePattern      = '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$'

$script:TasksDisabled = $false
$script:AdminPasswordInEnv = $false

# ------------------------------------------------------------------ yardimcilar
function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host ('==> ' + $Message) -ForegroundColor Cyan
}

function Write-Info([string]$Message) {
    Write-Host ('    ' + $Message)
}

function Write-Warn([string]$Message) {
    Write-Warning $Message
}

function Assert-LocalPath([string]$Path, [string]$Name) {
    if ($Path -notmatch '^[A-Za-z]:\\') {
        throw ($Name + ' yerel bir surucu yolu olmali (UNC veya goreli yol desteklenmez): ' + $Path)
    }
    # " ve % cmd.exe komut satirini, # ise .env'deki tirnaksiz degerleri bozar.
    if ($Path -match '["%#\r\n]') {
        throw ($Name + ' su karakterleri iceremez: " % # veya satir sonu. Yol: ' + $Path)
    }
    $drive = New-Object System.IO.DriveInfo -ArgumentList ($Path.Substring(0, 1))
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) {
        throw ($Name + ' sabit (Fixed) yerel bir surucude olmali; eslenmis ag suruculeri servis hesabinda gorunmez: ' + $Path)
    }
}

function New-RandomBytes([int]$Count) {
    $bytes = New-Object byte[] $Count
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ,$bytes
}

function New-HexSecret([int]$ByteCount) {
    $bytes = New-RandomBytes $ByteCount
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function New-Base64Secret([int]$ByteCount) {
    $bytes = New-RandomBytes $ByteCount
    return [System.Convert]::ToBase64String($bytes)
}

# Servis hesabi parolasi: hic duz metin string olusturmadan SecureString'e yazilir; hicbir yerde
# saklanmaz, sadece gorev kaydinda kullanilir (bkz. runner-cloud/windows/install-runner-task.ps1).
function New-ServicePassword {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    $secure = New-Object System.Security.SecureString
    foreach ($b in (New-RandomBytes 36)) { $secure.AppendChar($alphabet[$b % 64]) }
    $extra = New-RandomBytes 3
    $secure.AppendChar($alphabet[$extra[0] % 26])          # buyuk harf
    $secure.AppendChar($alphabet[26 + ($extra[1] % 26)])   # kucuk harf
    $secure.AppendChar($alphabet[52 + ($extra[2] % 10)])   # rakam
    $secure.AppendChar('-')                                # sembol
    $secure.MakeReadOnly()
    return $secure
}

function ConvertTo-PlainText([System.Security.SecureString]$Secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Icacls([string[]]$Arguments, [string]$What) {
    $ErrorActionPreference = 'Continue'   # yerel: icacls stderr'i PS 5.1'de istisnaya donmesin
    $output = & $IcaclsExe @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw ('icacls basarisiz (' + $What + '): ' + $output.Trim()) }
}

# Kalitimi keser; sadece SYSTEM + Administrators (tam) + servis hesabi ($ServiceRight) kalir.
# Baska acik (explicit) ACE varsa onlari da siler. Kalip: install-runner-task.ps1:101-106.
function Set-RestrictedAcl {
    param(
        [string]$Path,
        [string]$ServiceSid,
        [ValidateSet('R', 'RX', 'M')][string]$ServiceRight,
        [switch]$Container
    )
    $inherit = ''
    if ($Container) { $inherit = '(OI)(CI)' }
    Invoke-Icacls -What $Path -Arguments @(
        $Path, '/inheritance:r', '/grant:r',
        ('*' + $SidSystem + ':' + $inherit + 'F'),
        ('*' + $SidAdministrators + ':' + $inherit + 'F'),
        ('*' + $ServiceSid + ':' + $inherit + $ServiceRight)
    )
    $allowed = @($SidSystem, $SidAdministrators, $ServiceSid)
    $acl = Get-Acl -LiteralPath $Path
    $others = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
        ForEach-Object { $_.IdentityReference.Value } |
        Where-Object { $allowed -notcontains $_ } |
        Select-Object -Unique)
    foreach ($sid in $others) {
        Invoke-Icacls -What ('ACL temizligi ' + $Path) -Arguments @($Path, '/remove', ('*' + $sid))
    }
    # Sahip: dosyayi olusturan yonetici kullanicisi degil, Administrators grubu.
    try {
        Invoke-Icacls -What ('sahiplik ' + $Path) -Arguments @($Path, '/setowner', ('*' + $SidAdministrators), '/T', '/C', '/Q')
    }
    catch { Write-Warn ('Sahiplik Administrators yapilamadi (' + $Path + '): ' + $_.Exception.Message) }
}

# Dosyayi once bos olusturup ACL'yi kisitlar, SONRA icerigi yazar (sir, genis ACL ile diske dusmesin).
# UTF-8 BOM'suz ve LF: hem dotenv hem `node --env-file` sorunsuz okur.
function Write-ProtectedFile([string]$Path, [string]$Content, [string]$ServiceSid) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        [System.IO.File]::WriteAllText($Path, '')
    }
    Set-RestrictedAcl -Path $Path -ServiceSid $ServiceSid -ServiceRight 'R'
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

# ------------------------------------------------------------------ .env yardimcilari
function Read-EnvLines([string]$Path) {
    $list = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $text = [System.IO.File]::ReadAllText($Path)
        foreach ($line in ($text -split "`r?`n")) { $list.Add($line) }
        while ($list.Count -gt 0 -and $list[$list.Count - 1] -eq '') { $list.RemoveAt($list.Count - 1) }
    }
    return ,$list
}

function ConvertFrom-EnvRawValue([string]$Raw) {
    $value = $Raw.Trim()
    if ($value.Length -ge 2) {
        $quote = [string]$value[0]
        if ($quote -eq '"' -or $quote -eq "'" -or $quote -eq '`') {
            $end = $value.LastIndexOf($quote)
            if ($end -gt 0) { return $value.Substring(1, $end - 1) }
        }
    }
    $hash = $value.IndexOf('#')
    if ($hash -ge 0) { $value = $value.Substring(0, $hash) }
    return $value.Trim()
}

function Get-EnvValue($Lines, [string]$Key) {
    $result = $null
    foreach ($line in $Lines) {
        if ($line -match $EnvLinePattern -and $Matches[1] -ceq $Key) {
            $result = ConvertFrom-EnvRawValue $Matches[2]   # dotenv gibi: son tanim kazanir
        }
    }
    return $result
}

function Set-EnvValue($Lines, [string]$Key, [string]$Value) {
    $newLine = $Key + '=' + $Value
    $found = $false
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $EnvLinePattern -and $Matches[1] -ceq $Key) {
            if (-not $found) { $Lines[$i] = $newLine; $found = $true }
            else { $Lines.RemoveAt($i); $i-- }
        }
    }
    if (-not $found) { $Lines.Add($newLine) }
}

function Remove-EnvKey($Lines, [string]$Key) {
    $removed = 0
    for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
        if ($Lines[$i] -match $EnvLinePattern -and $Matches[1] -ceq $Key) { $Lines.RemoveAt($i); $removed++ }
    }
    return $removed
}

function Join-EnvLines($Lines) {
    return (($Lines -join "`n") + "`n")
}

# backend/src/config.js ile ayni kural: ws:// veya wss://, host zorunlu, kullanici bilgisi yok.
# Ayrica bosluk, tirnak ve # yok: deger .env'e tirnaksiz yazilir.
function Test-AgentPublicUrl([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\s"''`#]') { return $false }
    $uri = $null
    if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri)) { return $false }
    return [bool](($uri.Scheme -eq 'ws' -or $uri.Scheme -eq 'wss') -and $uri.Host -and -not $uri.UserInfo)
}

# dotenv: tek tirnak ve ters tirnak icinde kacis islenmez; cift tirnak \n'i genisletir, kullanmiyoruz.
function ConvertTo-EnvQuoted([string]$Value) {
    if ($Value -match "[`r`n]") { throw 'Parola satir sonu iceremez.' }
    if ($Value.IndexOf("'") -lt 0) { return "'" + $Value + "'" }
    if ($Value.IndexOf('`') -lt 0) { return '`' + $Value + '`' }
    throw 'Parola ayni anda hem tek tirnak ('') hem ters tirnak (`) iceremez (.env icinde guvenle yazilamaz).'
}

function Test-AdminPasswordPlain([string]$Plain) {
    if ($Plain.Length -lt 8) { return 'Parola en az 8 karakter olmali.' }
    if ($Plain -match "[`r`n]") { return 'Parola satir sonu iceremez.' }
    if ($Plain.IndexOf("'") -ge 0 -and $Plain.IndexOf('`') -ge 0) { return 'Parola ayni anda hem tek tirnak hem ters tirnak iceremez.' }
    return $null
}

# Parola SecureString olarak tutulur; duz metne sadece .env'e yazilirken cevrilir.
function Get-AdminPasswordSecure([System.Security.SecureString]$Provided) {
    if ($Provided) {
        $problem = Test-AdminPasswordPlain (ConvertTo-PlainText $Provided)
        if ($problem) { throw ('-AdminPassword gecersiz: ' + $problem) }
        return $Provided
    }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $first = Read-Host 'IDP "admin" hesabi icin parola (en az 8 karakter)' -AsSecureString
        $second = Read-Host 'Parolayi tekrar girin' -AsSecureString
        $firstPlain = ConvertTo-PlainText $first
        $same = ($firstPlain -ceq (ConvertTo-PlainText $second))
        $problem = Test-AdminPasswordPlain $firstPlain
        $firstPlain = $null
        $second.Dispose()
        if (-not $same) { Write-Warn 'Parolalar eslesmiyor.'; $first.Dispose(); continue }
        if ($problem) { Write-Warn $problem; $first.Dispose(); continue }
        return $first
    }
    throw 'Gecerli bir admin parolasi alinamadi.'
}

# ------------------------------------------------------------------ surec / port / saglik
function Get-IdpNodeProcesses {
    $entries = @($BackendEntry, $GatewayEntry)
    foreach ($proc in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'")) {
        $commandLine = [string]$proc.CommandLine
        foreach ($entry in $entries) {
            if ($commandLine.IndexOf($entry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $proc; break }
        }
    }
}

function Wait-Until([int]$TimeoutSeconds, [scriptblock]$Condition) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (& $Condition) { return $true }
        Start-Sleep -Seconds 2
    }
    return [bool](& $Condition)
}

function Stop-IdpRuntime {
    foreach ($name in @($BackendTaskName, $GatewayTaskName)) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) {
            # Once devre disi: 5 dakikalik bekci tetikleyicisi npm ci sirasinda sureci yeniden baslatmasin.
            Disable-ScheduledTask -TaskName $name | Out-Null
            Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            $script:TasksDisabled = $true
            Write-Info ('Gorev durduruldu ve gecici olarak devre disi: ' + $name)
        }
    }
    # Stop-ScheduledTask cmd.exe'yi oldurur; alt node.exe hayatta kalabilir.
    foreach ($proc in @(Get-IdpNodeProcesses)) {
        Write-Info ('node.exe sonlandiriliyor (PID ' + $proc.ProcessId + ')')
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not (Wait-Until -TimeoutSeconds 20 -Condition { @(Get-IdpNodeProcesses).Count -eq 0 })) {
        throw 'IDP node.exe surecleri 20 sn icinde kapanmadi; Gorev Yoneticisi''nden kapatip tekrar deneyin.'
    }
}

function Get-PortListeners([int]$LocalPort) {
    foreach ($conn in @(Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue)) {
        $proc = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$conn.OwningProcess)
        $name = ''; $commandLine = ''
        if ($proc) { $name = [string]$proc.Name; $commandLine = [string]$proc.CommandLine }
        [pscustomobject]@{ ProcessId = [int]$conn.OwningProcess; Name = $name; CommandLine = $commandLine }
    }
}

function Assert-PortFree([int]$LocalPort, [string]$Label) {
    $free = Wait-Until -TimeoutSeconds 10 -Condition { @(Get-PortListeners $LocalPort).Count -eq 0 }
    if (-not $free) {
        $owner = @(Get-PortListeners $LocalPort) | Select-Object -First 1
        throw ($Label + ' portu (' + $LocalPort + ') baska bir surec tarafindan dinleniyor: PID ' + $owner.ProcessId +
            ' ' + $owner.Name + ' ' + $owner.CommandLine + '. Portu bosaltin veya farkli port parametresi verin.')
    }
}

function Test-ListenerIsOurs([int]$LocalPort, [string]$Entry) {
    foreach ($listener in @(Get-PortListeners $LocalPort)) {
        if ($listener.CommandLine.IndexOf($Entry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

function Get-HttpStatus([string]$Url) {
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = 'GET'
        $request.Timeout = 5000
        $request.ReadWriteTimeout = 5000
        $request.AllowAutoRedirect = $false
        $request.Proxy = $null
        $response = $request.GetResponse()
        try { return [int]$response.StatusCode } finally { $response.Close() }
    }
    catch {
        $ex = $_.Exception
        while ($ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
        if ($ex -and $ex.Response) {
            $code = [int]$ex.Response.StatusCode
            $ex.Response.Close()
            return $code
        }
        return 0
    }
}

function Get-LocalProbeHost([string]$Bind) {
    if ($Bind -eq '0.0.0.0' -or $Bind -eq '::') { return '127.0.0.1' }
    if ($Bind.Contains(':')) { return '[' + $Bind + ']' }
    return $Bind
}

function Get-ReachableHosts([string]$Bind) {
    if ($Bind -ne '0.0.0.0' -and $Bind -ne '::') { return $Bind }
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Sort-Object -Property InterfaceIndex |
        Select-Object -ExpandProperty IPAddress -Unique)
    if ($ips.Count -eq 0) { return $env:COMPUTERNAME }
    $ips
}

function Show-LogTail([string]$Path, [int]$Count = 40) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        Write-Host ('    ---- ' + $Path + ' (son ' + $Count + ' satir) ----')
        foreach ($line in @(Get-Content -LiteralPath $Path -Tail $Count)) { Write-Host ('    ' + $line) }
    }
    else { Write-Host ('    Log dosyasi yok: ' + $Path) }
}

function Show-TaskDiagnostics([string]$TaskName, [string]$LogPath) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $info) {
        Write-Host ('    Gorev {0}: durum={1}, son sonuc=0x{2:X8}, son calisma={3}' -f $TaskName, $task.State, $info.LastTaskResult, $info.LastRunTime)
    }
    Show-LogTail $LogPath 40
}

# Kurallar Public profile herkese bilerek ACILMAZ. Arayuz Public ise ve kisitli Public kurali yoksa
# istemciler (VPN dahil) baglanamaz; sessizce gecmek yerine iki secenegi acikca goster.
# Donus: "erisilemeyen" Public arayuz sayisi (ozet uyarisi icin).
function Show-PublicProfileWarning([bool]$PublicRuleActive) {
    $publicProfiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { [string]$_.NetworkCategory -eq 'Public' })
    foreach ($profileInfo in $publicProfiles) {
        $alias = [string]$profileInfo.InterfaceAlias
        if ($PublicRuleActive) {
            Write-Info ('Ag arayuzu "' + $alias + '" Public profilde; IDP portlari Public''te SADECE su kaynaklara acik: ' +
                ($FirewallPublicRemoteAddress -join ', '))
        }
        elseif ($SkipFirewall) {
            Write-Warn ('Ag arayuzu "' + $alias + '" PUBLIC profilde; -SkipFirewall verildigi icin firewall kurallarina dokunulmadi.')
        }
        else {
            Write-Warn ('Ag arayuzu "' + $alias + '" PUBLIC profilde. IDP kurallari Domain+Private''ta; bu arayuzden (VPN istemcileri dahil) ' +
                $Port + '/' + $GatewayPort + ' portlarina erisilemez. Kurallar Public''e herkese bilerek acilmadi. Secenekler:' + [Environment]::NewLine +
                '  (a) ONERILEN: betigi -FirewallPublicRemoteAddress LocalSubnet ile (ya da VPN NAT adresiyle, orn. 192.168.0.7) tekrar ' +
                'calistirin. Makinenin ag profili degismez; portlar Public''te sadece o kaynaklara acilir.' + [Environment]::NewLine +
                '  (b) Set-NetConnectionProfile -InterfaceAlias "' + $alias + '" -NetworkCategory Private  (MAKINE GENELI etki: bu arayuzde ' +
                'tum Private profil kurallari devreye girer).')
        }
    }
    if ($PublicRuleActive) { return 0 }
    return $publicProfiles.Count
}

# node.exe icin etkin gelen Block kurali Allow kurallarimizi ezer (Windows'un "erisime izin ver"
# penceresinde "iptal" secilince olusur). Silmeyiz, sadece adlariyla uyaririz.
function Show-NodeBlockRuleWarning {
    try {
        $filters = @(Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object {
                $program = [string]$_.Program
                $program -and ([System.Environment]::ExpandEnvironmentVariables($program) -ieq $NodeExe)
            })
        foreach ($rule in @($filters | Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
            if ([string]$rule.Enabled -eq 'True' -and [string]$rule.Direction -eq 'Inbound' -and [string]$rule.Action -eq 'Block') {
                Write-Warn ('node.exe icin etkin gelen BLOCK kurali var: "' + $rule.DisplayName + '" (Name: ' + $rule.Name +
                    ', profil: ' + [string]$rule.Profile + '). Block, Allow kurallarindan onceliklidir; IDP portlari engellenebilir. ' +
                    'Betik silmez: kontrol edip gerekirse Remove-NetFirewallRule -Name "' + $rule.Name + '" ile kaldirin.')
            }
        }
    }
    catch { Write-Info ('node.exe firewall kurali kontrolu yapilamadi: ' + $_.Exception.Message) }
}

# SeBatchLogonRight bir GPO ile tanimliysa secedit ile verdigimiz hak ilke yenilenince ezilir.
# Sadece domain uyesi makinede anlamli; degilse sessizce gecilir. Sorgu hatasi kurulumu durdurmaz.
function Show-BatchRightGpoWarning([string]$Sid) {
    $partOfDomain = $true
    try { $partOfDomain = [bool](Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).PartOfDomain } catch { $partOfDomain = $true }
    if (-not $partOfDomain) { return }
    try {
        $entries = @(Get-CimInstance -Namespace 'root\rsop\computer' -ClassName 'RSOP_UserPrivilegeRight' `
                -Filter "UserRight = 'SeBatchLogonRight' AND precedence = 1" -ErrorAction Stop)
    }
    catch { Write-Info ('GPO (RSOP) sorgusu yapilamadi, atlandi: ' + $_.Exception.Message); return }
    foreach ($entry in $entries) {
        $listed = $false
        foreach ($account in @($entry.AccountList)) {
            $a = [string]$account
            if ($a -ieq ('*' + $Sid) -or $a -ieq $Sid -or $a -ieq $ServiceAccount -or $a -ieq $ServiceUserName) { $listed = $true }
        }
        if (-not $listed) {
            Write-Warn ('"Log on as a batch job" (SeBatchLogonRight) Grup Ilkesi ile yonetiliyor (GPO: ' + [string]$entry.GPOID + '). ' +
                $ServiceAccount + ' bu GPO''ya eklenmeli; yoksa ilke yenilenince / reboot sonrasi gorevler 0x80070569 ile acilmaz.')
        }
    }
}

# Repo'da genis gruplara yazma izni varsa servis hesabinin calistirdigi kod baskalarinca degistirilebilir.
# Repo ACL'sini bilerek degistirmiyoruz (operatorun git pull'unu bozabilir); nasil daraltilacagini gosteriyoruz.
function Show-RepoWriteAceWarning([string]$Path) {
    try {
        $broad = @{ 'S-1-1-0' = 'Everyone'; 'S-1-5-11' = 'Authenticated Users'; 'S-1-5-32-545' = 'Users' }
        # WriteData, AppendData, DeleteSubdirectoriesAndFiles, Delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE
        $writeMask = [int64](0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000)
        $hits = @()
        $acl = Get-Acl -LiteralPath $Path
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            $sid = $rule.IdentityReference.Value
            if ($broad.ContainsKey($sid) -and [string]$rule.AccessControlType -eq 'Allow' -and ((([int64]$rule.FileSystemRights) -band $writeMask) -ne 0)) {
                $hits += $broad[$sid]
            }
        }
        $hits = @($hits | Select-Object -Unique)
        if ($hits.Count -gt 0) {
            Write-Warn ('Repo dizininde genis yazma izni var (' + ($hits -join ', ') + '): bu gruplardaki herkes servis hesabinin ' +
                'calistirdigi kodu degistirebilir. Betik repo ACL''sini degistirmez. Daraltmak icin (yonetici PowerShell): ' +
                'icacls "' + $Path + '" /inheritance:d ; icacls "' + $Path + '" /remove:g *S-1-1-0 *S-1-5-11 *S-1-5-32-545 ; ' +
                'icacls "' + $Path + '" /grant "' + $env:USERDOMAIN + '\' + $env:USERNAME + ':(OI)(CI)M"  (sonra betigi tekrar calistirin; idp-svc okuma izni yeniden eklenir)')
        }
    }
    catch { Write-Info ('Repo ACL kontrolu yapilamadi: ' + $_.Exception.Message) }
}

# Bilinen yer tutucular: "change_me", "your_..._here" ya da .env.example'daki ornek degerle birebir ayni.
# Degerler konsola yazilmaz, sadece anahtar adlari.
function Show-PlaceholderWarning($Lines, [string]$ExamplePath, [string]$Label) {
    $benign = @('PORT', 'NODE_ENV', 'SSH_PORT', 'PMP_TIMEOUT_MS', 'LOG_LEVEL', 'IDP_AGENT_API_URL')
    $examples = @{}
    if ($ExamplePath -and (Test-Path -LiteralPath $ExamplePath -PathType Leaf)) {
        foreach ($exampleLine in (Read-EnvLines $ExamplePath)) {
            if ($exampleLine -match $EnvLinePattern) {
                $exampleKey = $Matches[1]
                $exampleValue = ConvertFrom-EnvRawValue $Matches[2]
                if ($exampleValue -and ($benign -notcontains $exampleKey)) { $examples[$exampleKey] = $exampleValue }
            }
        }
    }
    foreach ($line in $Lines) {
        if ($line -notmatch $EnvLinePattern) { continue }
        $key = $Matches[1]
        $value = ConvertFrom-EnvRawValue $Matches[2]
        if (-not $value) { continue }
        if ($value -match '(?i)change_?me' -or $value -match '(?i)^your_.*_here$' -or
            ($examples.ContainsKey($key) -and $examples[$key] -ceq $value)) {
            Write-Warn ($Label + ': ' + $key + ' yer tutucu / .env.example ornek degeri gibi gorunuyor; gercek degerle degistirin ya da satiri silin.')
        }
    }
}

function Test-UsersFile {
    return ((Test-Path -LiteralPath $UsersPath -PathType Leaf) -and ((Get-Item -LiteralPath $UsersPath).Length -gt 2))
}

# ------------------------------------------------------------------ servis hesabi / haklar
# Kalip: install-runner-task.ps1:79-99 (secedit export -> SeBatchLogonRight satirina SID ekle -> configure).
function Set-BatchLogonRight([string]$Sid, [switch]$Remove) {
    $export = Join-Path $env:TEMP ('idp-server-rights-' + $PID + '.inf')
    $database = Join-Path $env:TEMP ('idp-server-rights-' + $PID + '.sdb')
    try {
        & $SeceditExe /export /cfg $export /areas USER_RIGHTS | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Yerel kullanici haklari politikasi disa aktarilamadi (secedit /export).' }
        $rights = @(Get-Content -LiteralPath $export)
        $token = '*' + $Sid
        $index = -1
        for ($i = 0; $i -lt $rights.Count; $i++) {
            if ($rights[$i] -match '^SeBatchLogonRight\s*=') { $index = $i; break }
        }
        $current = @()
        if ($index -ge 0) {
            $current = @(($rights[$index] -replace '^SeBatchLogonRight\s*=\s*', '').Split(',') |
                ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        $changed = $false
        if ($Remove) {
            if ($index -ge 0 -and ($current -contains $token)) {
                $remaining = @($current | Where-Object { $_ -ne $token })
                if ($remaining.Count -gt 0) {
                    $rights[$index] = 'SeBatchLogonRight = ' + ($remaining -join ',')
                    $changed = $true
                }
            }
        }
        elseif ($index -lt 0) {
            $section = -1
            for ($i = 0; $i -lt $rights.Count; $i++) { if ($rights[$i] -match '^\[Privilege Rights\]') { $section = $i; break } }
            if ($section -lt 0) { throw 'Disa aktarilan politikada [Privilege Rights] bolumu yok.' }
            $list = New-Object System.Collections.Generic.List[string]
            foreach ($r in $rights) { $list.Add([string]$r) }
            $list.Insert($section + 1, 'SeBatchLogonRight = ' + $token)
            $rights = $list.ToArray()
            $changed = $true
        }
        elseif (-not ($current -contains $token)) {
            $rights[$index] = $rights[$index].TrimEnd() + ',' + $token
            $changed = $true
        }
        if ($changed) {
            $rights | Set-Content -LiteralPath $export -Encoding Unicode
            & $SeceditExe /configure /db $database /cfg $export /areas USER_RIGHTS | Out-Null
            if ($LASTEXITCODE -ne 0) { throw '"Toplu is olarak oturum ac" (SeBatchLogonRight) hakki guncellenemedi (secedit /configure).' }
        }
    }
    finally {
        Remove-Item -LiteralPath $export, $database -Force -ErrorAction SilentlyContinue
    }
}

# Mevcut hesabin parolasina burada DOKUNULMAZ: parola ancak gorev kaydindan hemen once yenilenir.
# Boylece npm ci / .env adiminda bir hata olursa mevcut gorevler eski (gecerli) parolayla kalir.
function Get-OrCreateServiceAccount {
    $existing = Get-LocalUser -Name $ServiceUserName -ErrorAction SilentlyContinue
    if ($existing) {
        if (-not $existing.Enabled) { Enable-LocalUser -Name $ServiceUserName }
        Write-Info ('Servis hesabi mevcut: ' + $ServiceAccount + ' (parola, gorev kaydindan hemen once yenilenecek)')
    }
    else {
        $initialPassword = New-ServicePassword
        try {
            New-LocalUser -Name $ServiceUserName -Password $initialPassword -AccountNeverExpires -PasswordNeverExpires `
                -UserMayNotChangePassword -Description 'IDP backend ve agent gateway servis hesabi' | Out-Null
        }
        finally { $initialPassword.Dispose() }
        Write-Info ('Servis hesabi olusturuldu: ' + $ServiceAccount)
    }
    return (Get-LocalUser -Name $ServiceUserName).SID.Value
}

# ------------------------------------------------------------------ gorevler
# Tetikleyiciler: AtStartup + 5 dakikada bir "bekci". Task Scheduler'in RestartCount ayari surecin
# sifir-disi cikisinda guvenilir sekilde devreye girmeyebilir; MultipleInstances=IgnoreNew oldugundan
# bekci, gorev zaten calisiyorsa hicbir sey yapmaz, sure cokmusse yeniden baslatir.
function Register-IdpTask([string]$Name, [string]$Arguments, [string]$WorkingDirectory, [string]$Description, [string]$PlainPassword) {
    $action = New-ScheduledTaskAction -Execute $CmdExe -Argument $Arguments -WorkingDirectory $WorkingDirectory
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew -Priority 5 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $startup = New-ScheduledTaskTrigger -AtStartup
    $watchdog = $null
    try {
        $watchdog = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) `
            -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    }
    catch { Write-Warn ('Bekci tetikleyicisi olusturulamadi, sadece AtStartup kullanilacak: ' + $_.Exception.Message) }

    $triggers = @($startup)
    if ($watchdog) { $triggers += $watchdog }
    try {
        Register-ScheduledTask -TaskName $Name -Action $action -Trigger $triggers -Settings $settings `
            -User $ServiceAccount -Password $PlainPassword -RunLevel Limited -Description $Description -Force | Out-Null
    }
    catch {
        # Sadece tekrarlama/XML format hatasinda (0x80041318) bekcisiz dene; digerleri (parola, hak...) oldugu gibi gorunsun.
        $failure = [string]$_.Exception.Message + ' ' + [string]$_.FullyQualifiedErrorId
        if (-not $watchdog -or $failure -notmatch '(?i)repetition|out of range|incorrectly formatted|0x80041318') { throw }
        Write-Warn ('Gorev bekci tetikleyicisiyle kaydedilemedi (' + $_.Exception.Message + '); sadece AtStartup ile tekrar deneniyor.')
        Register-ScheduledTask -TaskName $Name -Action $action -Trigger @($startup) -Settings $settings `
            -User $ServiceAccount -Password $PlainPassword -RunLevel Limited -Description $Description -Force | Out-Null
    }
    Write-Info ('Gorev kaydedildi: ' + $Name + ' (' + $ServiceAccount + ', RunLevel Limited)')
}

function Invoke-NpmCi([string]$Directory, [string]$Label) {
    Write-Step ('npm ci --omit=dev: ' + $Label)
    $ErrorActionPreference = 'Continue'   # yerel: npm'in stderr uyarilari PS 5.1'de istisna olmasin
    Push-Location -LiteralPath $Directory
    try {
        & $NpmCmd ci --omit=dev --no-audit --no-fund | Out-Host
        $code = $LASTEXITCODE
    }
    finally { Pop-Location }
    if ($code -ne 0) {
        throw ('npm ci basarisiz (' + $Label + ', cikis kodu ' + $code + '). Yukarida "npm error" / "npm ERR!" ile ' +
            'baslayan satirlara bakin. node-gyp / "optional binding" / cpu-features mesajlari tek basina bu hataya yol acmaz.')
    }
    Write-Info ($Label + ': bagimliliklar kuruldu. "Failed to build optional crypto binding" ve cpu-features node-gyp mesajlari zararsizdir (opsiyonel hizlandirici).')
}

# ------------------------------------------------------------------ on kontroller
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Yonetici yetkisi gerekli: PowerShell''i "Yonetici olarak calistir" ile acip betigi tekrar calistirin.'
}
if (-not [Environment]::Is64BitProcess) {
    throw '64-bit Windows PowerShell gerekli (LocalAccounts modulu 32-bit oturumda yuklenmez): C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
}
if ($Port -eq $GatewayPort) { throw '-Port ve -GatewayPort ayni olamaz.' }
if ($Port -eq $GatewayControlPort -or $GatewayPort -eq $GatewayControlPort) {
    throw ('-Port ve -GatewayPort ' + $GatewayControlPort + ' olamaz (gateway kontrol dinleyicisinin portu).')
}
if ($PSBoundParameters.ContainsKey('AgentPublicUrl')) {
    $AgentPublicUrl = ([string]$AgentPublicUrl).Trim()
    if (-not (Test-AgentPublicUrl $AgentPublicUrl)) {
        throw ('-AgentPublicUrl gecersiz: "' + $AgentPublicUrl + '". ws:// veya wss:// ile baslayan bir adres verin ' +
            '(orn. wss://agent.ornek.com ya da ws://10.0.0.5:7003); bosluk, tirnak ve # iceremez.')
    }
}
if ($CfAccessClientSecret -and -not $PSBoundParameters.ContainsKey('CfAccessClientId')) {
    throw '-CfAccessClientSecret tek basina verilemez: -CfAccessClientId ile birlikte verin.'
}
if ($PSBoundParameters.ContainsKey('CfAccessClientId')) {
    $CfAccessClientId = ([string]$CfAccessClientId).Trim()
    if ($CfAccessClientId -notmatch $EnvSafeValuePattern) {
        throw '-CfAccessClientId bos olamaz ve sadece harf, rakam ve . _ ~ + / = - icerebilir.'
    }
}
foreach ($pair in @(@('-BindHost', $BindHost), @('-GatewayBindHost', $GatewayBindHost))) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse([string]$pair[1], [ref]$parsed)) {
        throw ($pair[0] + ' bir IP adresi olmali (orn. 0.0.0.0 veya 10.0.0.5): ' + $pair[1])
    }
}

if ($PSBoundParameters.ContainsKey('FirewallPublicRemoteAddress')) {
    if ($SkipFirewall) { throw '-FirewallPublicRemoteAddress ile -SkipFirewall birlikte kullanilamaz.' }
    # powershell.exe -File ile dizi "a,b" tek string gelir; virgulden de bol.
    $FirewallPublicRemoteAddress = @($FirewallPublicRemoteAddress | ForEach-Object { ([string]$_).Split(',') } | ForEach-Object { $_.Trim() })
    if ($FirewallPublicRemoteAddress.Count -eq 0) { $FirewallPublicRemoteAddress = @('') }
    foreach ($address in $FirewallPublicRemoteAddress) {
        if ([string]::IsNullOrWhiteSpace($address) -or $address -eq '*' -or $address -ieq 'Any' -or
            @('0.0.0.0/0', '0.0.0.0/0.0.0.0', '0.0.0.0-255.255.255.255', '::/0') -contains $address) {
            throw ('-FirewallPublicRemoteAddress gecersiz: "' + $address + '". Public profilde herkese acmak yok; ' +
                'LocalSubnet ya da belirli IP / alt ag verin (orn. 192.168.0.7 veya 192.168.0.0/24).')
        }
    }
}
else { $FirewallPublicRemoteAddress = $null }

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { throw '-RepoPath verilmeli (betik bir dosyadan calistirilmiyor).' }
    $RepoPath = Join-Path $PSScriptRoot '..\..'
}
$resolvedRepo = Resolve-Path -LiteralPath $RepoPath -ErrorAction SilentlyContinue
if ($resolvedRepo) { $RepoPath = $resolvedRepo.ProviderPath.TrimEnd('\') }
elseif (-not $Uninstall) { throw ('Repo dizini bulunamadi: ' + $RepoPath) }
$DataDir = [System.IO.Path]::GetFullPath($DataDir).TrimEnd('\')

$BackendDir     = Join-Path $RepoPath 'backend'
$GatewayDir     = Join-Path $RepoPath 'idp-agent-gateway'
$BackendEntry   = Join-Path $BackendDir 'src\server.js'
$GatewayEntry   = Join-Path $GatewayDir 'src\server.js'
$BackendEnvPath = Join-Path $BackendDir '.env'
$GatewayEnvPath = Join-Path $DataDir 'gateway.env'
$LogDir         = Join-Path $DataDir 'logs'
$BackendLog     = Join-Path $LogDir 'backend.log'
$GatewayLog     = Join-Path $LogDir 'gateway.log'
$UsersPath      = Join-Path $DataDir 'users.json'
$DbPath         = Join-Path $DataDir 'idp.db'
$SessionsPath   = Join-Path $DataDir 'sessions.json'
$SecretsPath    = Join-Path $DataDir 'secrets.enc.json'
$RegistryPath   = Join-Path $DataDir 'agents.json'
$LegacySecretsPath = Join-Path $BackendDir 'src\secrets.enc.json'   # FileSecretStore.js varsayilani
# Env yol degiskenleri yokken kullanilan varsayilan yollar (db.js, userStore.js, FileSecretStore.js, gateway server.js).
$LegacyData = @(
    @{ Legacy = (Join-Path $BackendDir 'src\idp.db');         Target = $DbPath },
    @{ Legacy = (Join-Path $BackendDir 'src\users.json');     Target = $UsersPath },
    @{ Legacy = $LegacySecretsPath;                           Target = $SecretsPath },
    @{ Legacy = (Join-Path $GatewayDir 'data\agents.json');   Target = $RegistryPath }
)

# ------------------------------------------------------------------ kaldirma
if ($Uninstall) {
    Write-Step 'IDP sunucu bilesenleri kaldiriliyor'
    Stop-IdpRuntime
    foreach ($name in @($BackendTaskName, $GatewayTaskName)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Info ('Gorev silindi: ' + $name)
        }
        else { Write-Info ('Gorev zaten yok: ' + $name) }
    }
    foreach ($rule in @($FirewallBackendRule, $FirewallGatewayRule, $FirewallBackendPublicRule, $FirewallGatewayPublicRule)) {
        $existingRule = Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue
        if ($existingRule) { $existingRule | Remove-NetFirewallRule; Write-Info ('Firewall kurali silindi: ' + $rule) }
    }
    $user = Get-LocalUser -Name $ServiceUserName -ErrorAction SilentlyContinue
    if ($user) {
        $sid = $user.SID.Value
        Set-BatchLogonRight -Sid $sid -Remove
        if (Test-Path -LiteralPath $RepoPath -PathType Container) {
            Invoke-Icacls -What 'repo ACL' -Arguments @($RepoPath, '/remove', ('*' + $sid))
        }
        try {
            Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID = '" + $sid + "'") | Remove-CimInstance
        }
        catch { Write-Warn ('Servis hesabinin profil klasoru silinemedi (elle silebilirsiniz): ' + $_.Exception.Message) }
        Remove-LocalUser -Name $ServiceUserName
        Write-Info ('Servis hesabi silindi: ' + $ServiceAccount)
    }
    else { Write-Info ('Servis hesabi zaten yok: ' + $ServiceAccount) }

    Write-Host ''
    Write-Host 'DOKUNULMADI (bilerek):' -ForegroundColor Yellow
    Write-Info ('Veri dizini : ' + $DataDir + '  (idp.db, users.json, secrets.enc.json, agents.json, gateway.env, logs)')
    Write-Info ('Backend env : ' + $BackendEnvPath + '  (IDP_SECRET_KEY burada)')
    Write-Info 'Bu dosyalarin ACL''lerinde silinen servis hesabinin SID''i yetim kalir; zararsizdir.'
    Write-Info 'Tamamen silmek icin once IDP_SECRET_KEY ve veri dizinini yedekleyin, sonra elle silin.'
    return
}

# ------------------------------------------------------------------ kurulum / guncelleme
$servicePassword = $null
$adminPasswordSecure = $null
$cfSecretSecure = $null
$agentPublicUrlSummary = ''
$script:PasswordRotated = $false
try {
    Write-Step 'On kontroller'
    Assert-LocalPath $RepoPath '-RepoPath'
    Assert-LocalPath $DataDir '-DataDir'
    foreach ($required in @($BackendEntry, (Join-Path $BackendDir 'package-lock.json'), $GatewayEntry, (Join-Path $GatewayDir 'package-lock.json'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw ('Beklenen dosya yok: ' + $required + ' (-RepoPath dogru mu?)') }
    }
    $usersRoot = Split-Path -Parent $env:PUBLIC
    if ($RepoPath.StartsWith($usersRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Warn ('Repo bir kullanici profili altinda (' + $RepoPath + '). Calisir (servis hesabina acik izin verilir), ' +
            'ama C:\IDP\ gibi profil disi bir dizin onerilir.')
    }
    Write-Info ('Repo    : ' + $RepoPath)
    Write-Info ('Veri    : ' + $DataDir)

    # --- Node: tam yol. Zamanlanmis gorev altinda PATH surec baslangicinda donar; gorevlerde tam yol kullanilir.
    $nodeCandidates = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
    $nodeOnPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeOnPath) { $nodeCandidates += $nodeOnPath.Path }
    $NodeExe = $null
    foreach ($candidate in $nodeCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $NodeExe = (Resolve-Path -LiteralPath $candidate).ProviderPath; break }
    }
    if (-not $NodeExe) { throw 'node.exe bulunamadi. Node.js 24 LTS''i makine geneline (C:\Program Files\nodejs) kurun.' }
    if ($NodeExe.StartsWith($usersRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ('node.exe bir kullanici profilinde (' + $NodeExe + ', nvm?). Servis hesabi buna erisemez; Node''u makine geneline kurun.')
    }
    $nodeVersionOutput = @(& $NodeExe -p 'process.versions.node')
    $nodeExitCode = $LASTEXITCODE
    $nodeVersionText = ''
    if ($nodeVersionOutput.Count -gt 0) { $nodeVersionText = [string]$nodeVersionOutput[0] }
    if ($nodeExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersionText)) { throw ('Node surumu okunamadi: ' + $NodeExe) }
    $nodeVersion = [version]$nodeVersionText.Trim()
    if ($nodeVersion -lt $MinNodeVersion) {
        throw ('Node ' + $nodeVersion + ' bulundu (' + $NodeExe + '). Backend node:sqlite kullaniyor; bayraksiz calismasi icin en az ' +
            $MinNodeVersion + ' gerekli (tercihen 24 LTS). Node''u guncelleyip tekrar calistirin.')
    }
    if ($nodeVersion.Major -lt 24) { Write-Warn ('Node ' + $nodeVersion + ' yeterli ama 24 LTS onerilir.') }
    $NpmCmd = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'   # npm.ps1 execution policy'ye takilabilir
    if (-not (Test-Path -LiteralPath $NpmCmd -PathType Leaf)) { throw ('npm.cmd bulunamadi: ' + $NpmCmd) }
    Write-Info ('Node    : ' + $NodeExe + ' (v' + $nodeVersion + ')')

    # --- git "dubious ownership" (betik git calistirmaz; operatorun git pull'u icin uyari)
    $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($gitCommand -and (Test-Path -LiteralPath (Join-Path $RepoPath '.git'))) {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $gitExe = $gitCommand.Path
        try { $gitOutput = & $gitExe -C $RepoPath rev-parse --is-inside-work-tree 2>&1 | Out-String }
        finally { $ErrorActionPreference = $previousPreference }
        if ($gitOutput -match 'dubious ownership') {
            Write-Warn ('Git bu repoyu "dubious ownership" ile reddediyor (sahip: ' + (Get-Acl -LiteralPath $RepoPath).Owner +
                '). git pull oncesi: git config --global --add safe.directory "' + ($RepoPath -replace '\\', '/') + '"')
        }
    }
    elseif (-not $gitCommand) { Write-Info 'git bulunamadi; dubious ownership kontrolu atlandi.' }

    Show-RepoWriteAceWarning $RepoPath

    # --- eski varsayilan yollardaki veri: sessizce yeni bos veriyle baslamayalim
    $legacyFound = @($LegacyData | Where-Object {
            (Test-Path -LiteralPath $_.Legacy -PathType Leaf) -and -not (Test-Path -LiteralPath $_.Target -PathType Leaf)
        })
    if ($legacyFound.Count -gt 0) {
        $legacyList = ($legacyFound | ForEach-Object { '      ' + $_.Legacy + '  ->  ' + $_.Target }) -join [Environment]::NewLine
        if (-not $IgnoreLegacyData) {
            throw ('Eski (varsayilan) yollarda veri bulundu ve veri dizininde karsiligi yok:' + [Environment]::NewLine + $legacyList +
                [Environment]::NewLine + '    Backend artik veriyi ' + $DataDir + ' altindan okur; bu dosyalar kullanilmaz. Secenekler:' +
                [Environment]::NewLine + '    (1) Tasima: dosyalari hedeflere kopyalayin (idp.db ile idp.db-wal/idp.db-shm birlikte; ' +
                'secrets.enc.json ayni IDP_SECRET_KEY ile acilir), sonra betigi tekrar calistirin.' +
                [Environment]::NewLine + '    (2) Bilerek sifirdan baslamak: -IgnoreLegacyData ile tekrar calistirin (eski dosyalar silinmez).')
        }
        Write-Warn ('-IgnoreLegacyData: eski yollardaki veri yok sayiliyor (silinmedi):' + [Environment]::NewLine + $legacyList)
    }

    # --- admin parolasi: uzun adimlardan (npm ci) ONCE sorulur
    $adminPasswordNeeded = -not (Test-UsersFile)
    if ($adminPasswordNeeded) {
        Write-Info ('Kullanici dosyasi yok (' + $UsersPath + '): ilk acilis icin admin parolasi gerekli.')
        $adminPasswordSecure = Get-AdminPasswordSecure $AdminPassword
    }
    elseif ($AdminPassword) {
        Write-Warn '-AdminPassword yok sayildi: kullanici dosyasi zaten var, parola degistirilmedi (uygulamadan degistirin).'
    }

    # --- Cloudflare Access secret'i: -File ile SecureString gecmez; -CfAccessClientId verilip secret verilmediyse
    # uzun adimlardan ONCE burada sorulur. Deger konsola yazilmaz.
    if ($PSBoundParameters.ContainsKey('CfAccessClientId')) {
        if ($CfAccessClientSecret) { $cfSecretSecure = $CfAccessClientSecret }
        else { $cfSecretSecure = Read-Host 'Cloudflare Access Client Secret (-CfAccessClientId icin)' -AsSecureString }
        $cfSecretCheck = ConvertTo-PlainText $cfSecretSecure
        $cfSecretValid = ($cfSecretCheck -match $EnvSafeValuePattern)
        $cfSecretCheck = $null
        if (-not $cfSecretValid) {
            throw 'Cloudflare Access Client Secret bos olamaz ve sadece harf, rakam ve . _ ~ + / = - icerebilir.'
        }
    }

    $isUpdate = [bool](Get-ScheduledTask -TaskName $BackendTaskName -ErrorAction SilentlyContinue)
    if ($isUpdate) { Write-Info 'Mevcut kurulum bulundu: GUNCELLEME modu (git pull yapilmaz).' }

    # --- 1) calisan surecleri durdur
    Write-Step 'Calisan IDP surecleri durduruluyor'
    Stop-IdpRuntime
    Assert-PortFree $Port 'Backend'
    Assert-PortFree $GatewayPort 'Gateway'
    Assert-PortFree $GatewayControlPort 'Gateway kontrol'

    # --- 2) servis hesabi + "toplu is olarak oturum ac" hakki (kalip: install-runner-task.ps1:66-99)
    Write-Step 'Servis hesabi'
    $ServiceSid = Get-OrCreateServiceAccount
    Set-BatchLogonRight -Sid $ServiceSid
    Write-Info 'SeBatchLogonRight (toplu is olarak oturum ac) verildi.'
    Show-BatchRightGpoWarning $ServiceSid

    # --- 3) dizinler ve izinler (kalip: install-runner-task.ps1:101-106)
    Write-Step 'Dizinler ve dosya izinleri'
    # Gorevlerden ONCE: backend/src/store/db.js IDP_DB_PATH klasorunu kendisi olusturmaz
    # (users/sessions/secrets yollari olusturur). DB dosyasi veri dizininde durur.
    [System.IO.Directory]::CreateDirectory($DataDir) | Out-Null
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $DbPath)) | Out-Null
    Set-RestrictedAcl -Path $DataDir -ServiceSid $ServiceSid -ServiceRight 'M' -Container
    [System.IO.Directory]::CreateDirectory($LogDir) | Out-Null
    foreach ($log in @($BackendLog, $GatewayLog)) {
        if ((Test-Path -LiteralPath $log -PathType Leaf) -and ((Get-Item -LiteralPath $log).Length -gt $LogRotateBytes)) {
            Move-Item -LiteralPath $log -Destination ($log + '.1') -Force
            Write-Info ('Log dondu: ' + $log + ' -> ' + $log + '.1')
        }
    }
    # Repo: servis hesabi okuyup calistirabilsin (npm ci'dan once; yeni dosyalar izni kalitimla alir).
    Invoke-Icacls -What 'repo ACL' -Arguments @($RepoPath, '/grant', ('*' + $ServiceSid + ':(OI)(CI)RX'))
    Write-Info ('Veri dizini: sadece SYSTEM, Administrators, ' + $ServiceAccount + ' (degistirme)')
    Write-Info ('Repo       : ' + $ServiceAccount + ' icin okuma/calistirma eklendi')

    # --- 4) bagimliliklar (Playwright tarayicisi indirilmez; PMP/SAML kapsam disi)
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    $env:npm_config_update_notifier = 'false'
    Invoke-NpmCi $BackendDir 'backend'
    Invoke-NpmCi $GatewayDir 'idp-agent-gateway'

    # --- 5) sirlar ve env dosyalari
    Write-Step 'Ortam dosyalari ve sirlar'
    $backendLines = Read-EnvLines $BackendEnvPath
    $gatewayLines = Read-EnvLines $GatewayEnvPath
    Show-PlaceholderWarning $backendLines (Join-Path $BackendDir '.env.example') 'backend\.env'
    Show-PlaceholderWarning $gatewayLines $null 'gateway.env'

    $sessionSecret = Get-EnvValue $backendLines 'SESSION_SECRET'
    if ([string]::IsNullOrWhiteSpace($sessionSecret)) {
        Set-EnvValue $backendLines 'SESSION_SECRET' (New-HexSecret 48)
        Write-Info 'SESSION_SECRET: yeni uretildi.'
    }
    else { Write-Info 'SESSION_SECRET: mevcut deger korundu.' }

    $secretKey = Get-EnvValue $backendLines 'IDP_SECRET_KEY'
    if ([string]::IsNullOrWhiteSpace($secretKey)) {
        if (Test-Path -LiteralPath $SecretsPath -PathType Leaf) {
            throw ('IDP_SECRET_KEY ' + $BackendEnvPath + ' icinde yok ama sifreli sir dosyasi var (' + $SecretsPath +
                '). Yeni anahtar uretmek mevcut sirlari cozulemez yapar. Yedekten IDP_SECRET_KEY''i .env''e geri yazin ve tekrar calistirin.')
        }
        if (Test-Path -LiteralPath $LegacySecretsPath -PathType Leaf) {
            if (-not $IgnoreLegacyData) {
                throw ('IDP_SECRET_KEY yok ama eski yolda sifreli sir dosyasi var (' + $LegacySecretsPath + '). Yedekten ' +
                    'IDP_SECRET_KEY''i .env''e geri yazin ya da bu dosyayi bilerek yok saymak icin -IgnoreLegacyData verin.')
            }
            Write-Warn ('Eski sir dosyasi (' + $LegacySecretsPath + ') yeni uretilen anahtarla cozulemeyecek (-IgnoreLegacyData).')
        }
        Set-EnvValue $backendLines 'IDP_SECRET_KEY' (New-Base64Secret 32)   # keyManager.js: base64, tam 32 bayt
        Write-Info 'IDP_SECRET_KEY: yeni uretildi (base64, 32 bayt).'
    }
    else {
        # Gecersiz anahtarda backend acilista exit 1 verir; o yuzden burada durup operatore birakiyoruz.
        $decoded = $null
        try { $decoded = [System.Convert]::FromBase64String($secretKey.Trim()) } catch { $decoded = $null }
        if ($null -eq $decoded -or $decoded.Length -ne 32) {
            $got = 'base64 degil'
            if ($null -ne $decoded) { $got = [string]$decoded.Length + ' bayt' }
            throw ('Mevcut IDP_SECRET_KEY gecersiz (' + $got + '; beklenen: base64, tam 32 bayt, 44 karakter). Betik anahtari ' +
                'yeniden uretmez (sirlar cozulemez hale gelir). ' + $BackendEnvPath + ' icindeki degeri yedekten duzeltin.')
        }
        Write-Info 'IDP_SECRET_KEY: mevcut deger korundu (format dogrulandi).'
    }

    $tokenBackend = Get-EnvValue $backendLines 'IDP_AGENT_API_TOKEN'
    $tokenGateway = Get-EnvValue $gatewayLines 'IDP_AGENT_API_TOKEN'
    if ((-not [string]::IsNullOrWhiteSpace($tokenBackend)) -and (-not [string]::IsNullOrWhiteSpace($tokenGateway)) -and ($tokenBackend -cne $tokenGateway)) {
        throw ('IDP_AGENT_API_TOKEN ' + $BackendEnvPath + ' ile ' + $GatewayEnvPath + ' arasinda farkli. Betik sirlari yeniden uretmez: ' +
            'dagitilmis agent''larin kullandigi degeri secip iki dosyada elle esitleyin.')
    }
    if (-not [string]::IsNullOrWhiteSpace($tokenBackend)) { $agentToken = $tokenBackend; Write-Info 'IDP_AGENT_API_TOKEN: mevcut deger korundu.' }
    elseif (-not [string]::IsNullOrWhiteSpace($tokenGateway)) { $agentToken = $tokenGateway; Write-Info 'IDP_AGENT_API_TOKEN: gateway.env degeri korundu.' }
    else {
        $agentToken = New-HexSecret 32
        Write-Info 'IDP_AGENT_API_TOKEN: yeni uretildi.'
        if (Test-Path -LiteralPath $RegistryPath -PathType Leaf) {
            Write-Warn 'Mevcut agents.json var ama token yoktu: daha once dagitilmis agent ZIP''leri yeni token ile yeniden uretilmeli.'
        }
    }
    if ($agentToken -notmatch '^[A-Za-z0-9._~+/=-]+$') {
        throw 'IDP_AGENT_API_TOKEN tirnaksiz yazilamayacak karakterler iceriyor; degeri elle sadelestirin (betik degistirmez).'
    }
    if ([string]::IsNullOrWhiteSpace($tokenBackend)) { Set-EnvValue $backendLines 'IDP_AGENT_API_TOKEN' $agentToken }

    $gatewayProbeHost = Get-LocalProbeHost $GatewayBindHost
    $backendProbeHost = Get-LocalProbeHost $BindHost
    Set-EnvValue $backendLines 'NODE_ENV' 'production'
    Set-EnvValue $backendLines 'PORT' ([string]$Port)
    Set-EnvValue $backendLines 'IDP_HOST' $BindHost
    Set-EnvValue $backendLines 'IDP_COOKIE_SECURE' 'false'
    Set-EnvValue $backendLines 'IDP_SECRETS_PATH' $SecretsPath
    Set-EnvValue $backendLines 'IDP_DB_PATH' $DbPath
    Set-EnvValue $backendLines 'IDP_USERS_PATH' $UsersPath
    Set-EnvValue $backendLines 'IDP_SESSIONS_PATH' $SessionsPath
    # Backend gateway'e yalnizca kontrol dinleyicisinden (127.0.0.1) konusur; 7003 artik sadece agent WebSocket'i.
    Set-EnvValue $backendLines 'IDP_AGENT_API_URL' ('http://' + $GatewayControlHost + ':' + $GatewayControlPort)

    # Agent paketlerine yazilan adres: parametre > .env'deki mevcut deger > ws://<ilk ic IP>:<GatewayPort> (ic ag).
    $existingPublicUrl = Get-EnvValue $backendLines 'IDP_AGENT_PUBLIC_URL'
    if ($PSBoundParameters.ContainsKey('AgentPublicUrl')) {
        Set-EnvValue $backendLines 'IDP_AGENT_PUBLIC_URL' $AgentPublicUrl
        $agentPublicUrlSummary = $AgentPublicUrl
        Write-Info ('IDP_AGENT_PUBLIC_URL: ' + $AgentPublicUrl + ' (parametreden)')
    }
    elseif (-not [string]::IsNullOrWhiteSpace($existingPublicUrl)) {
        $agentPublicUrlSummary = $existingPublicUrl.Trim()
        if (-not (Test-AgentPublicUrl $agentPublicUrlSummary)) {
            Write-Warn 'Mevcut IDP_AGENT_PUBLIC_URL gecersiz (ws:// veya wss:// olmali); agent kimligi uretimi 503 doner. -AgentPublicUrl ile duzeltin.'
        }
        Write-Info ('IDP_AGENT_PUBLIC_URL: mevcut deger korundu (' + $agentPublicUrlSummary + ')')
    }
    else {
        $publicHost = [string](@(Get-ReachableHosts $GatewayBindHost) | Select-Object -First 1)
        if ($publicHost.Contains(':')) { $publicHost = '[' + $publicHost + ']' }
        $agentPublicUrlSummary = 'ws://' + $publicHost + ':' + $GatewayPort
        Set-EnvValue $backendLines 'IDP_AGENT_PUBLIC_URL' $agentPublicUrlSummary
        Write-Info ('IDP_AGENT_PUBLIC_URL: ' + $agentPublicUrlSummary + ' (varsayilan, ic ag). Internetten erisim icin -AgentPublicUrl wss://... verin.')
    }

    # Cloudflare Access cifti: parametre verildiyse ikisi birlikte yazilir; verilmediyse mevcut degerler korunur.
    if ($cfSecretSecure) {
        Set-EnvValue $backendLines 'IDP_AGENT_CF_ACCESS_CLIENT_ID' $CfAccessClientId
        $cfSecretPlain = ConvertTo-PlainText $cfSecretSecure
        Set-EnvValue $backendLines 'IDP_AGENT_CF_ACCESS_CLIENT_SECRET' $cfSecretPlain
        $cfSecretPlain = $null
        Write-Info 'IDP_AGENT_CF_ACCESS_CLIENT_ID / _SECRET: parametreden yazildi (secret konsola yazdirilmadi).'
    }
    $cfIdSet = -not [string]::IsNullOrWhiteSpace((Get-EnvValue $backendLines 'IDP_AGENT_CF_ACCESS_CLIENT_ID'))
    $cfSecretSet = -not [string]::IsNullOrWhiteSpace((Get-EnvValue $backendLines 'IDP_AGENT_CF_ACCESS_CLIENT_SECRET'))
    if ($cfIdSet -ne $cfSecretSet) {
        throw ('IDP_AGENT_CF_ACCESS_CLIENT_ID ve IDP_AGENT_CF_ACCESS_CLIENT_SECRET ' + $BackendEnvPath + ' icinde birlikte olmali ' +
            '(yalnizca biri dolu; backend bu durumda acilmaz). -CfAccessClientId ile ikisini birlikte verin ya da iki satiri da silin.')
    }
    if ($cfIdSet -and -not $cfSecretSecure) { Write-Info 'Cloudflare Access cifti: mevcut degerler korundu.' }

    if ($adminPasswordNeeded) {
        $adminPlain = ConvertTo-PlainText $adminPasswordSecure   # on kontrollerde alindi
        Set-EnvValue $backendLines 'IDP_ADMIN_PASSWORD' (ConvertTo-EnvQuoted $adminPlain)
        $adminPlain = $null
        $script:AdminPasswordInEnv = $true
    }
    elseif ((Remove-EnvKey $backendLines 'IDP_ADMIN_PASSWORD') -gt 0) {
        Write-Info 'Artik gereksiz IDP_ADMIN_PASSWORD satiri .env''den silindi.'
    }

    foreach ($line in $backendLines) {
        if ($line -match $EnvLinePattern -and $Matches[1] -like '*_PATH' -and (ConvertFrom-EnvRawValue $Matches[2]).StartsWith('~')) {
            Write-Warn ($Matches[1] + ' "~" ile basliyor. Servis hesabinda HOME tanimsiz: backend "~" yerine "/root" koyar. Mutlak Windows yolu yazin.')
        }
    }

    Write-ProtectedFile -Path $BackendEnvPath -Content (Join-EnvLines $backendLines) -ServiceSid $ServiceSid
    Write-Info ('Backend env : ' + $BackendEnvPath + ' (sadece SYSTEM, Administrators, ' + $ServiceAccount + ' okuyabilir)')

    Set-EnvValue $gatewayLines 'NODE_ENV' 'production'
    Set-EnvValue $gatewayLines 'IDP_AGENT_GATEWAY_HOST' $GatewayBindHost
    Set-EnvValue $gatewayLines 'IDP_AGENT_GATEWAY_PORT' ([string]$GatewayPort)
    Set-EnvValue $gatewayLines 'IDP_AGENT_GATEWAY_CONTROL_HOST' $GatewayControlHost
    Set-EnvValue $gatewayLines 'IDP_AGENT_GATEWAY_CONTROL_PORT' ([string]$GatewayControlPort)
    if ([string]::IsNullOrWhiteSpace($tokenGateway)) { Set-EnvValue $gatewayLines 'IDP_AGENT_API_TOKEN' $agentToken }
    Set-EnvValue $gatewayLines 'IDP_AGENT_REGISTRY_PATH' $RegistryPath
    Write-ProtectedFile -Path $GatewayEnvPath -Content (Join-EnvLines $gatewayLines) -ServiceSid $ServiceSid
    Write-Info ('Gateway env : ' + $GatewayEnvPath)
    $agentToken = $null

    # --- 6) firewall: Domain + Private her zaman; Public sadece -FirewallPublicRemoteAddress ile ve uzak adres kisitli
    $publicRuleActive = $false
    if ($SkipFirewall) {
        Write-Step 'Firewall atlandi (-SkipFirewall; mevcut kurallara dokunulmadi)'
    }
    else {
        Write-Step 'Firewall kurallari'
        $rules = @(
            @{ Name = $FirewallBackendRule; PublicName = $FirewallBackendPublicRule; Display = ('IDP Backend (TCP ' + $Port + ')'); LocalPort = $Port },
            @{ Name = $FirewallGatewayRule; PublicName = $FirewallGatewayPublicRule; Display = ('IDP Agent Gateway (TCP ' + $GatewayPort + ')'); LocalPort = $GatewayPort }
        )
        foreach ($rule in $rules) {
            Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            New-NetFirewallRule -Name $rule.Name -DisplayName $rule.Display -Group $FirewallGroup `
                -Description 'install-idp-server.ps1 tarafindan yonetilir' -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $rule.LocalPort -Profile Domain, Private | Out-Null
            Write-Info ('Kural: ' + $rule.Display + ' [Domain, Private]')

            # Public kurali her calistirmada silinir; parametre verildiyse kisitli olarak yeniden olusturulur
            # (kurulu durum her zaman son parametreyi yansitir).
            Get-NetFirewallRule -Name $rule.PublicName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            if ($FirewallPublicRemoteAddress) {
                New-NetFirewallRule -Name $rule.PublicName -DisplayName ($rule.Display + ' [Public, kisitli]') -Group $FirewallGroup `
                    -Description 'install-idp-server.ps1 -FirewallPublicRemoteAddress ile yonetilir' -Direction Inbound -Action Allow `
                    -Protocol TCP -LocalPort $rule.LocalPort -Profile Public -RemoteAddress $FirewallPublicRemoteAddress | Out-Null
                Write-Info ('Kural: ' + $rule.Display + ' [Public, sadece: ' + ($FirewallPublicRemoteAddress -join ', ') + ']')
                $publicRuleActive = $true
            }
        }
    }
    $publicProfileCount = Show-PublicProfileWarning $publicRuleActive
    Show-NodeBlockRuleWarning

    # --- 7) zamanlanmis gorevler (kalip: install-runner-task.ps1:129-147, agentBuilder.js createWindowsInstaller)
    Write-Step 'Zamanlanmis gorevler'
    $backendArgs = '/d /v:off /s /c ""' + $NodeExe + '" "' + $BackendEntry + '" >> "' + $BackendLog + '" 2>&1"'
    $gatewayArgs = '/d /v:off /s /c ""' + $NodeExe + '" --env-file="' + $GatewayEnvPath + '" "' + $GatewayEntry + '" >> "' + $GatewayLog + '" 2>&1"'
    # Parola SADECE burada yenilenir ve hemen iki gorev kaydinda kullanilir; hicbir yerde saklanmaz.
    $servicePassword = New-ServicePassword
    Set-LocalUser -Name $ServiceUserName -Password $servicePassword -PasswordNeverExpires $true
    $script:PasswordRotated = $true
    Write-Info 'Servis hesabi parolasi yenilendi (rastgele, saklanmaz).'
    $plainServicePassword = $null
    $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($servicePassword)
    try {
        $plainServicePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
        Register-IdpTask -Name $GatewayTaskName -Arguments $gatewayArgs -WorkingDirectory $GatewayDir `
            -Description 'IDP agent gateway (WebSocket + REST)' -PlainPassword $plainServicePassword
        Register-IdpTask -Name $BackendTaskName -Arguments $backendArgs -WorkingDirectory $BackendDir `
            -Description 'IDP backend API' -PlainPassword $plainServicePassword
    }
    finally {
        $plainServicePassword = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
    }
    $script:TasksDisabled = $false

    Write-Step 'Gorevler baslatiliyor ve saglik kontrolu'
    Start-ScheduledTask -TaskName $GatewayTaskName
    Start-ScheduledTask -TaskName $BackendTaskName

    $gatewayLocalUrl = 'http://' + $gatewayProbeHost + ':' + $GatewayPort
    $backendLocalUrl = 'http://' + $backendProbeHost + ':' + $Port
    $gatewayOk = Wait-Until -TimeoutSeconds $HealthTimeoutSec -Condition { (Get-HttpStatus ($gatewayLocalUrl + '/health')) -eq 200 }
    Write-Info ('Gateway ' + $gatewayLocalUrl + '/health : ' + $(if ($gatewayOk) { 'OK' } else { 'YANIT YOK' }))
    # Backend gateway'e yalnizca buradan konusur; yoksa ajan listesi/deploy calismaz (gateway kodu eski olabilir).
    $gatewayControlUrl = 'http://' + $GatewayControlHost + ':' + $GatewayControlPort
    $controlOk = Wait-Until -TimeoutSeconds 30 -Condition { (Get-HttpStatus ($gatewayControlUrl + '/health')) -eq 200 }
    Write-Info ('Gateway kontrol ' + $gatewayControlUrl + '/health : ' + $(if ($controlOk) { 'OK' } else { 'YANIT YOK (gateway kodu kontrol dinleyicisini desteklemiyor olabilir)' }))
    if ($controlOk -and -not (Test-ListenerIsOurs $GatewayControlPort $GatewayEntry)) { Write-Warn ('Port ' + $GatewayControlPort + ' IDP gateway surecine ait gorunmuyor.') }
    $backendOk = Wait-Until -TimeoutSeconds $HealthTimeoutSec -Condition {
        if ((Get-HttpStatus ($backendLocalUrl + '/api/health')) -eq 200) { return $true }
        $me = Get-HttpStatus ($backendLocalUrl + '/api/auth/me')
        return ($me -eq 401 -or $me -eq 200)
    }
    Write-Info ('Backend ' + $backendLocalUrl + ' : ' + $(if ($backendOk) { 'OK' } else { 'YANIT YOK' }))
    if ($gatewayOk -and -not (Test-ListenerIsOurs $GatewayPort $GatewayEntry)) { Write-Warn ('Port ' + $GatewayPort + ' IDP gateway surecine ait gorunmuyor.') }
    if ($backendOk -and -not (Test-ListenerIsOurs $Port $BackendEntry)) { Write-Warn ('Port ' + $Port + ' IDP backend surecine ait gorunmuyor.') }

    # --- 8) ilk acilis parolasini .env'den sil (users dosyasi olustuysa)
    if ($adminPasswordNeeded) {
        if (Wait-Until -TimeoutSeconds 30 -Condition { Test-UsersFile }) {
            $backendLines = Read-EnvLines $BackendEnvPath
            [void](Remove-EnvKey $backendLines 'IDP_ADMIN_PASSWORD')
            Write-ProtectedFile -Path $BackendEnvPath -Content (Join-EnvLines $backendLines) -ServiceSid $ServiceSid
            $script:AdminPasswordInEnv = $false
            Write-Info 'Admin hesabi olustu; IDP_ADMIN_PASSWORD .env''den silindi. Kullanici adi: admin'
        }
        else {
            Write-Warn ('Kullanici dosyasi olusmadi (' + $UsersPath + '). IDP_ADMIN_PASSWORD hala ' + $BackendEnvPath +
                ' icinde; sorun giderilince betigi tekrar calistirin ya da satiri elle silin.')
        }
    }

    if (-not ($gatewayOk -and $controlOk -and $backendOk)) {
        Write-Host ''
        Write-Host 'Saglik kontrolu basarisiz. Tani:' -ForegroundColor Red
        if (-not ($gatewayOk -and $controlOk)) { Show-TaskDiagnostics $GatewayTaskName $GatewayLog }
        if (-not $backendOk) { Show-TaskDiagnostics $BackendTaskName $BackendLog }
        throw 'IDP servisleri saglik kontrolunu gecemedi (ayrintilar yukarida).'
    }

    # --- 9) ozet
    Write-Step 'Kurulum tamam'
    $backendHosts = @(Get-ReachableHosts $BindHost)
    $gatewayHosts = @(Get-ReachableHosts $GatewayBindHost)
    Write-Host '  Arayuz yalnizca Electron''da (backend tarayiciya arayuz sunmaz).'
    Write-Host '  Electron idp.env satiri (Araclar > Ayar dosyasini ac):'
    foreach ($h in $backendHosts) { Write-Host ('    IDP_SERVER_URL=http://' + $h + ':' + $Port) }
    Write-Host '  Agent gateway WebSocket (ic ag adresleri):'
    foreach ($h in $gatewayHosts) { Write-Host ('    ws://' + $h + ':' + $GatewayPort) }
    Write-Host ('    (bu makinedeki agent icin: ws://127.0.0.1:' + $GatewayPort + ')')
    Write-Host ('  Agent paketlerine yazilan adres (IDP_AGENT_PUBLIC_URL): ' + $agentPublicUrlSummary)
    Write-Host '  Agent kimligi: her agent icin IDP arayuzunden uretilir. IDP_AGENT_API_TOKEN artik sadece backend-gateway kontrol token''i, agent''a verilmez.'
    Write-Host '  Eski agent ZIP''leri (paylasimli token) artik baglanamaz; yeniden uretin.'
    Write-Host ('  Gateway kontrol API: ' + $GatewayControlHost + ':' + $GatewayControlPort + ' (sadece bu makine; firewall kurali yok, disari ACMAYIN)')
    Write-Host '  Loglar:'
    Write-Host ('    ' + $BackendLog)
    Write-Host ('    ' + $GatewayLog)
    Write-Host ('  Gorevler: ' + $BackendTaskName + ', ' + $GatewayTaskName + ' (hesap: ' + $ServiceAccount + ')')
    Write-Host '  Yedeklenecekler:'
    Write-Host ('    ' + $BackendEnvPath + '  (IDP_SECRET_KEY, SESSION_SECRET, IDP_AGENT_API_TOKEN)')
    Write-Host ('    ' + $GatewayEnvPath)
    Write-Host ('    ' + $DataDir + '  (idp.db*, users.json, secrets.enc.json, agents.json)')
    if ($publicProfileCount -gt 0) {
        Write-Host ''
        Write-Host '  UYARI: En az bir ag arayuzu Public profilde; o arayuzden gelen istemciler baglanamaz (yukaridaki uyariya bakin).' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '  UYARI: IDP_SECRET_KEY''i kasaya yedekleyin. Kaybolursa kayitli tum sirlar cozulemez hale gelir.' -ForegroundColor Yellow
}
catch {
    Write-Host ''
    Write-Host 'KURULUM TAMAMLANAMADI.' -ForegroundColor Red
    if ($script:TasksDisabled) {
        if ($script:PasswordRotated) {
            Write-Host ('  Servis parolasi yenilendi ama gorevler yeniden kaydedilemedi (' + $BackendTaskName + ', ' + $GatewayTaskName +
                '). Sorunu giderip betigi tekrar calistirin.')
        }
        else {
            Write-Host ('  IDP gorevleri eski (gecerli) parolayla kayitli ama devre disi (' + $BackendTaskName + ', ' + $GatewayTaskName +
                '). Sorunu giderip betigi tekrar calistirin. Acil geri donus: Enable-ScheduledTask + Start-ScheduledTask ' +
                '(npm ci yarida kaldiysa node_modules eksik olabilir).')
        }
    }
    if ($script:AdminPasswordInEnv) {
        Write-Host ('  IDP_ADMIN_PASSWORD su an ' + $BackendEnvPath + ' icinde. Betigi tekrar calistirin ya da satiri elle silin.')
    }
    throw
}
finally {
    if ($servicePassword) { $servicePassword.Dispose() }
    if ($adminPasswordSecure -and -not $AdminPassword) { $adminPasswordSecure.Dispose() }
    if ($cfSecretSecure -and -not $CfAccessClientSecret) { $cfSecretSecure.Dispose() }
}
