#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BundleDirectory,

    [Parameter()]
    [string]$PkiDirectory = (Join-Path $env:ProgramData 'IDP Signing\Public')
)

$ErrorActionPreference = 'Stop'
$bundleDirectory = (Resolve-Path -LiteralPath $BundleDirectory).Path
$manifest = Get-Content -LiteralPath (Join-Path $bundleDirectory 'release-manifest.json') -Raw | ConvertFrom-Json
$publisher = Get-Item -LiteralPath "Cert:\LocalMachine\My\$($manifest.publisherThumbprint)" -ErrorAction Stop
if (-not $publisher.HasPrivateKey) { throw 'Publisher private key is unavailable.' }

$zipPath = "$bundleDirectory.zip"
if (-not (Test-Path -LiteralPath $zipPath)) {
    Compress-Archive -Path (Join-Path $bundleDirectory '*') -DestinationPath $zipPath -Force
}
$bundleBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($zipPath))
$escapedBundle = $bundleBase64.Replace('"', '""')
$source = @"
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Security.Principal;

internal static class Program
{
    private const string BundleBase64 = @"$escapedBundle";

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int Main(string[] args)
    {
        string agentName = null;
        bool uninstall = false;
        bool upgrade = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--agent-name" && i + 1 < args.Length) agentName = args[++i];
            else if (args[i] == "--uninstall") uninstall = true;
            else if (args[i] == "--upgrade") upgrade = true;
        }
        if (!uninstall && !upgrade && String.IsNullOrWhiteSpace(agentName))
        {
            Console.Error.WriteLine("Usage: MDP-Runner-Setup.exe --agent-name NAME");
            return 2;
        }

        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        if (identity == null)
        {
            Console.Error.WriteLine("Windows identity could not be determined.");
            return 5;
        }
        bool elevated;
        using (identity)
        {
            elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        if (!elevated)
        {
            Console.Error.WriteLine("Administrator privileges are required. Open PowerShell with Run as administrator and run this installer again.");
            return 5;
        }

        string root = Path.Combine(Path.GetTempPath(), "idp-runner-setup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string zip = Path.Combine(root, "bundle.zip");
            File.WriteAllBytes(zip, Convert.FromBase64String(BundleBase64));
            string payload = Path.Combine(root, "payload");
            ZipFile.ExtractToDirectory(zip, payload);
            string installer = Path.Combine(payload, uninstall ? "uninstall-runner.ps1" : upgrade ? "upgrade-runner.ps1" : "install-runner-bundle.ps1");
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = "powershell.exe";
            string installerArguments = (!uninstall && !upgrade) ? " -AgentName " + Quote(agentName) : "";
            start.Arguments = "-NoLogo -NoProfile -ExecutionPolicy AllSigned -File " + Quote(installer) + installerArguments;
            start.UseShellExecute = false;
            Process process = Process.Start(start);
            if (process == null) { Console.Error.WriteLine("PowerShell installer process did not start."); return 6; }
            process.WaitForExit();
            return process.ExitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }
}
"@

$outputPath = Join-Path (Split-Path $bundleDirectory -Parent) "MDP-Runner-Setup-$($manifest.releaseId).exe"
$compilerRoot = Join-Path $env:TEMP "idp-installer-build-$PID"
New-Item -ItemType Directory -Path $compilerRoot -Force | Out-Null
$sourcePath = Join-Path $compilerRoot 'Program.cs'
try {
    Set-Content -LiteralPath $sourcePath -Value $source -Encoding UTF8
    Add-Type -Path $sourcePath -OutputAssembly $outputPath -OutputType ConsoleApplication `
        -ReferencedAssemblies 'System.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll'
    $signature = Set-AuthenticodeSignature -FilePath $outputPath -Certificate $publisher -HashAlgorithm SHA256
    if ($signature.Status -ne 'Valid') { throw "Installer signing failed: $($signature.StatusMessage)" }
}
finally {
    Remove-Item -LiteralPath $compilerRoot -Recurse -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    InstallerPath = $outputPath
    Sha256 = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
    PublisherThumbprint = $signature.SignerCertificate.Thumbprint
    SizeBytes = (Get-Item -LiteralPath $outputPath).Length
}
