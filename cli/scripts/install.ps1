# Harness CLI installer for Windows, served from https://cdn.autonomous.ai/harness/cli/install.ps1.
# Source of truth: THIS file, cli/scripts/install.ps1. It is published by cli/scripts/upload-install-ps1.sh (staging
# by default; production is the owner's step) and tested by cli/src/scripts/installPs1.spec.ts. It is the Windows
# counterpart of install.sh, step for step.
#
#   irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex
#   iex "& { $(irm https://cdn.autonomous.ai/harness/cli/install.ps1) } -Desktop"
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Manifest C:\build\install-manifest.json -NoService
#
# It installs per user, with no administrator rights. Everything goes under %USERPROFILE%\.harness, and PATH is the
# user's own (HKCU\Environment), never the machine's. The file is pure ASCII on purpose: Windows PowerShell 5.1
# reads a script file without a BOM in the ANSI code page, so one non-ASCII character would garble it.
param(
  [switch]$Desktop,
  [string]$Manifest = $env:HARNESS_INSTALL_MANIFEST,
  [switch]$NoService
)

# The base under which the three published manifests live: cli/metadata.json, runtime/metadata.json and
# pty/metadata.json. upload-install-ps1.sh rewrites this one line for the staging copy.
$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'
# Set when this runs as a file (-File, or a saved copy). It is empty under `irm | iex`.
$HarnessScriptPath = $MyInvocation.MyCommand.Path

$HarnessCliVersionPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$'
$HarnessPtyVersionPattern = '^\d+(\.\d+)*$'
$HarnessPtyFiles = @('harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe')

function Get-HarnessPlatform {
  # The platform from the NATIVE architecture, read where Windows keeps it for the whole system. An x64
  # PowerShell emulated on an ARM64 computer reports AMD64 in its own environment, and would install the
  # emulated build.
  param([string]$Architecture)
  if (-not $Architecture) {
    $item = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction SilentlyContinue
    if ($item) { $Architecture = [string]$item.PROCESSOR_ARCHITECTURE }
    if (-not $Architecture) { $Architecture = [string]$env:PROCESSOR_ARCHITECTURE }
  }
  switch ($Architecture.ToUpperInvariant()) {
    'AMD64' { return 'win32-x64' }
    'ARM64' { return 'win32-arm64' }
    default { throw "This computer's processor ($Architecture) is not supported: Harness runs on 64-bit Windows, x64 or ARM64." }
  }
}

function Test-HarnessHost {
  # ConPTY, which the terminal host needs, arrived in Windows 10 1809 (build 17763). tar.exe, which unpacks the
  # downloads, has shipped in System32 since 1803. The path is fixed so a GNU tar on PATH is never used: it
  # cannot read a zip.
  param([int]$Build = [Environment]::OSVersion.Version.Build, [string]$SystemRoot = $env:SystemRoot)
  if ($Build -lt 17763) { throw "Harness needs Windows 10 version 1809 or later, and this computer runs build $Build. Update Windows, then run the installer again." }
  $tar = Join-Path $SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw "Windows' own tar.exe is missing ($tar). It is part of Windows 10 1803 and later." }
  return $tar
}

function Test-HarnessUrl([string]$Value) { return $Value -match '^https://' }
function Test-HarnessScheme([string]$Value) { return $Value -match '^[A-Za-z][A-Za-z0-9+.-]*://' }

function Invoke-HarnessRetry {
  # Three tries for a network step, as install.sh's download() makes. A connection that drops in the middle
  # of a 30 MB runtime is common on Wi-Fi.
  param([scriptblock]$Action, [int]$Attempts = 3)
  for ($i = 1; ; $i++) {
    try { return & $Action } catch {
      if ($i -ge $Attempts) { throw }
      Write-Host "  Connection interrupted; retrying ($($i + 1)/$Attempts)..."
      Start-Sleep -Seconds 2
    }
  }
}

function Get-HarnessJson {
  param([string]$Source)
  if (Test-HarnessUrl $Source) {
    $response = Invoke-HarnessRetry { Invoke-WebRequest -Uri $Source -UseBasicParsing -TimeoutSec 60 -Headers @{ 'Cache-Control' = 'no-cache' } }
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
    return $content | ConvertFrom-Json
  }
  if (Test-HarnessScheme $Source) { throw "Only https:// addresses are trusted, and $Source is not one." }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "The manifest $Source does not exist." }
  return (Get-Content -LiteralPath $Source -Raw -Encoding UTF8) | ConvertFrom-Json
}

function Resolve-HarnessRef {
  # Where an entry's file is. A published manifest names https:// addresses only. A local manifest (a test, or a
  # build of this tree) may also name files beside it.
  param([string]$Ref, [string]$ManifestSource)
  if (Test-HarnessUrl $Ref) { return $Ref }
  if (Test-HarnessScheme $Ref) { throw "Only https:// addresses are trusted, and $Ref is not one." }
  if (Test-HarnessUrl $ManifestSource) { throw "The manifest $ManifestSource names $Ref, which is not an https:// address." }
  if ([IO.Path]::IsPathRooted($Ref)) { return $Ref }
  return Join-Path (Split-Path -Parent $ManifestSource) $Ref
}

function Get-HarnessProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Get-HarnessManifests {
  # The three entries this computer needs, each with the document it came from: relative names in a local
  # manifest are resolved against that document. With -Manifest it is one document holding the cli, node and pty
  # keys. Otherwise it is the three published documents under $Base.
  param([string]$Manifest, [string]$Platform, [string]$Base = $HarnessManifestBase)
  if ($Manifest) {
    if (-not (Test-HarnessUrl $Manifest) -and -not (Test-HarnessScheme $Manifest)) {
      if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { throw "The manifest $Manifest does not exist." }
      $Manifest = (Resolve-Path -LiteralPath $Manifest).ProviderPath
    }
    $document = Get-HarnessJson $Manifest
    $sources = @{ cli = $Manifest; node = $Manifest; pty = $Manifest }
    $documents = @{ cli = $document; node = $document; pty = $document }
  } else {
    $sources = @{ cli = "${Base}cli/metadata.json"; node = "${Base}runtime/metadata.json"; pty = "${Base}pty/metadata.json" }
    $documents = @{}
    foreach ($name in 'cli', 'node', 'pty') { $documents[$name] = Get-HarnessJson $sources[$name] }
  }
  $cli = Get-HarnessProperty $documents.cli 'cli'
  $node = Get-HarnessProperty (Get-HarnessProperty $documents.node 'node') $Platform
  $pty = Get-HarnessProperty (Get-HarnessProperty $documents.pty 'pty') $Platform
  if (-not $cli) { throw "The CLI manifest ($($sources.cli)) has no 'cli' entry." }
  if (-not $node) { throw "The Node runtime manifest ($($sources.node)) has no '$Platform' entry: Harness is not published for this computer yet." }
  if (-not $pty) { throw "The terminal host manifest ($($sources.pty)) has no '$Platform' entry: Harness is not published for this computer yet." }
  return @{
    cli = @{ entry = $cli; source = $sources.cli }
    node = @{ entry = $node; source = $sources.node }
    pty = @{ entry = $pty; source = $sources.pty }
  }
}

function Save-HarnessVerified {
  # Download (or copy, for a local manifest), then keep the file only if its size and SHA-256 are the manifest's.
  # The manifest is the trust: the downloaded bytes are not, until they match it.
  param([string]$Source, [string]$Destination, [string]$Sha256, $Size)
  if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "The manifest gives no valid SHA-256 for $Source." }
  try {
    if (Test-HarnessUrl $Source) {
      Invoke-HarnessRetry { Invoke-WebRequest -Uri $Source -OutFile $Destination -UseBasicParsing -TimeoutSec 600 } | Out-Null
    } elseif (Test-HarnessScheme $Source) {
      throw "Only https:// addresses are trusted, and $Source is not one."
    } else {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
    $length = (Get-Item -LiteralPath $Destination).Length
    if ($null -ne $Size -and "$Size" -ne '' -and [int64]$Size -ne $length) {
      throw "$Source is $length bytes, but the manifest says ${Size}: the download is incomplete, or is not the published file."
    }
    $got = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($got -ne $Sha256.ToLowerInvariant()) { throw "$Source failed its checksum (expected $Sha256, got $got): it is not the published file." }
  } catch {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Expand-HarnessZip {
  param([string]$Tar, [string]$Archive, [string]$Destination)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & $Tar -xf $Archive -C $Destination
  if ($LASTEXITCODE -ne 0) { throw "Could not unpack $Archive (tar.exe exit code $LASTEXITCODE)." }
}

function New-HarnessStaging {
  # The name the CLI's own sweep recognizes (.<name>-staging-<pid>-<time>, runtimeInstall.ts sweepStaging).
  # A folder left by an installer that was stopped is removed by the next daemon start.
  param([string]$Parent, [string]$Name)
  $dir = Join-Path $Parent ".$Name-staging-$PID-$([DateTime]::UtcNow.Ticks)"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Move-HarnessFile {
  # Rename over the destination, retried. An antivirus scan or the search indexer can hold a new file for a
  # moment, and a harness-launch.exe that is still exiting holds its own. The backup name is [NullString]::Value:
  # Windows PowerShell 5.1 passes a plain $null to a .NET string as "", which Replace rejects ("The path is not
  # of a legal form"), so every pointer that already existed failed to update (seen on the VM, 2026-10-16).
  param([string]$Source, [string]$Destination)
  for ($i = 1; ; $i++) {
    try {
      if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($Source, $Destination, [NullString]::Value) } else { [IO.File]::Move($Source, $Destination) }
      return
    } catch {
      if ($i -ge 5) { Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue; throw }
      Start-Sleep -Milliseconds (50 * $i)
    }
  }
}

function Copy-HarnessFile {
  param([string]$Source, [string]$Destination)
  $temp = "$Destination.tmp-$PID"
  Copy-Item -LiteralPath $Source -Destination $temp -Force
  Move-HarnessFile -Source $temp -Destination $Destination
}

function Write-HarnessPointer {
  # One line and CRLF, UTF-8 with no BOM, through a rename (installLayout.ts writePointer). harness.cmd reads it
  # with `set /p`, which would keep a BOM as part of the value.
  param([string]$Path, [string]$Value)
  $temp = "$Path.tmp-$PID"
  [IO.File]::WriteAllText($temp, "$Value`r`n", (New-Object Text.UTF8Encoding $false))
  Move-HarnessFile -Source $temp -Destination $Path
}

function Add-HarnessUserPath {
  # Add the folder to the user's PATH in HKCU\Environment once. The value keeps its kind (REG_EXPAND_SZ, normally)
  # and every entry already in it. An entry is compared expanded, case-insensitively and without a trailing
  # backslash, so %USERPROFILE%\.harness\bin counts as the same folder.
  param([string]$Directory, [string]$SubKey = 'Environment')
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
  try {
    $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($current -ne '') { try { $kind = $key.GetValueKind('Path') } catch { } }
    $entries = @($current -split ';' | Where-Object { $_ -ne '' })
    $wanted = $Directory.TrimEnd('\')
    foreach ($entry in $entries) {
      if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $wanted) { return $false }
    }
    $key.SetValue('Path', ((@($entries) + $wanted) -join ';'), $kind)
    return $true
  } finally { $key.Close() }
}

function Send-HarnessEnvironmentChange {
  # Tell Explorer, and through it every terminal started from now on, that the user's PATH changed. Add-Type
  # compiles a little C#, which Constrained Language Mode (some managed computers) forbids. That only means a
  # new terminal must be opened from a fresh Explorer, so it is a note and not a failure.
  try {
    if (-not ('Harness.NativeMethods' -as [type])) {
      Add-Type -Namespace Harness -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][Harness.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    Write-Host '  (Could not announce the PATH change; terminals opened after you sign in again will see it.)'
  }
}

# --- Install (Task B1.8) ---

# --- Run ---
if ($env:HARNESS_INSTALL_LIBRARY -ne '1') {
  if (-not $Manifest) { $Manifest = $env:HARNESS_INSTALL_MANIFEST }
  $harnessExit = @(Install-Harness -Desktop:([bool]$Desktop) -Manifest $Manifest -NoService:([bool]$NoService))[-1]
  # Run as a file, the exit code is the result. Run by `irm | iex`, it never calls `exit`: that would close the
  # person's PowerShell window with the message still in it.
  if ($HarnessScriptPath) { exit $harnessExit }
  $global:LASTEXITCODE = $harnessExit
}
