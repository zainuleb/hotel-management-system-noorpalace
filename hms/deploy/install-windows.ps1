<#
  Hotel Management System — Windows installer

  Run this once on the PC that will host the system (usually the front desk PC).
  Right-click this file and choose "Run with PowerShell".

  It will:
    1. check Node.js is present and new enough
    2. install dependencies and build the app
    3. open the Windows Firewall so other PCs and tablets on the hotel wifi
       can reach it (needs administrator rights — it will ask)
    4. make the system start automatically whenever this PC is switched on
    5. put a shortcut on the desktop
    6. print the addresses staff should use

  Nothing here touches the hotel's data. Re-running it is safe.
#>

param(
  [int]$Port = 8080,
  [string]$DataDir = '',
  [switch]$NoAutoStart,
  [switch]$NoFirewall
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
$AppName = 'Hotel Management System'

function Say($text, $colour = 'Gray') { Write-Host "  $text" -ForegroundColor $colour }
function Step($text) { Write-Host ""; Write-Host "  $text" -ForegroundColor Cyan }
function Ok($text)   { Say "OK  $text" 'Green' }
function Warn($text) { Say "!   $text" 'Yellow' }
function Die($text)  { Say "X   $text" 'Red'; Write-Host ""; Read-Host 'Press Enter to close'; exit 1 }

Write-Host ""
Write-Host "  $AppName — setup" -ForegroundColor White
Write-Host "  ============================================================"

# --------------------------------------------------------------- 1. Node.js
Step '1. Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn 'Node.js is not installed.'
  Say  'Download the LTS installer from https://nodejs.org, run it with the'
  Say  'default options, then run this script again.'
  Die  'Cannot continue without Node.js.'
}
$version = (& node --version).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt 24) {
  Warn "Node.js $version is installed, but this system needs version 24 or newer."
  Say  'Install the current LTS from https://nodejs.org and run this script again.'
  Die  'Node.js is too old.'
}
Ok "Node.js $version"

# --------------------------------------------- 2. dependencies and build
Step '2. Installing and building (this can take a minute)'
Push-Location $AppRoot
try {
  if (Test-Path (Join-Path $AppRoot 'package-lock.json')) {
    & npm ci --no-audit --no-fund 2>&1 | Out-Null
  } else {
    & npm install --no-audit --no-fund 2>&1 | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Die 'npm could not install the dependencies. Is this PC online?' }

  & npm run build 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $AppRoot 'dist\server.js'))) {
    Die 'The build failed. Send the contents of this window to your supplier.'
  }
  Ok 'Application built'
} finally {
  Pop-Location
}

# ------------------------------------------------------------- 3. firewall
Step '3. Opening the firewall for the hotel network'
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($NoFirewall) {
  Warn 'Skipped (-NoFirewall). Only this PC will be able to open the system.'
} elseif (-not $isAdmin) {
  Warn 'This window is not running as administrator, so the firewall rule was not added.'
  Say  'Other PCs and tablets will not be able to connect until it is. To add it,'
  Say  'open PowerShell as administrator and run:'
  Say  "  New-NetFirewallRule -DisplayName '$AppName' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private" 'White'
} else {
  $existing = Get-NetFirewallRule -DisplayName $AppName -ErrorAction SilentlyContinue
  if ($existing) { $existing | Remove-NetFirewallRule }
  New-NetFirewallRule -DisplayName $AppName -Direction Inbound -Protocol TCP `
    -LocalPort $Port -Action Allow -Profile Private | Out-Null
  Ok "Port $Port allowed on private (home/work) networks"
}

# ------------------------------------------------------------ 4. autostart
$startScript = Join-Path $PSScriptRoot 'Start Hotel System.bat'

Step '4. Starting automatically when this PC is switched on'
if ($NoAutoStart) {
  Warn 'Skipped (-NoAutoStart).'
} else {
  $startupDir = [Environment]::GetFolderPath('Startup')
  $shortcut = Join-Path $startupDir "$AppName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = $startScript
  $link.WorkingDirectory = $AppRoot
  $link.Description = "Starts the $AppName"
  $link.Save()
  Ok "Added to Startup for the current Windows user"
  Say 'To stop it starting automatically, delete this file:'
  Say "  $shortcut" 'White'
}

# ------------------------------------------------------- 5. desktop shortcut
Step '5. Desktop shortcut'
$desktop = [Environment]::GetFolderPath('Desktop')
$deskLink = Join-Path $desktop "$AppName.lnk"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($deskLink)
$link.TargetPath = $startScript
$link.WorkingDirectory = $AppRoot
$link.Save()
Ok 'Shortcut placed on the desktop'

# ------------------------------------------------------------- 6. addresses
Step '6. Addresses for your staff'
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress -Unique

Say "On this PC          http://localhost:$Port" 'White'
foreach ($ip in $ips) { Say "On the hotel wifi   http://${ip}:$Port" 'White' }
Write-Host ""
Say 'Bookmark the wifi address on every reception PC, kitchen screen and'
Say 'waiter tablet. The first person to open it will be asked to create the'
Say 'hotel details and the administrator login.'

if ($DataDir) {
  Write-Host ""
  Warn "To keep the database in $DataDir, add this line near the top of"
  Warn 'deploy\Start Hotel System.bat:'
  Say  "  set HMS_DATA_DIR=$DataDir" 'White'
}

Write-Host ""
Write-Host "  Setup finished. Start the system from the desktop shortcut." -ForegroundColor Green
Write-Host ""
Read-Host 'Press Enter to close'
