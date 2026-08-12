<#
  Removes the Windows integration (autostart, firewall rule, shortcuts).

  It does NOT delete the hotel's data. The database and every backup stay in
  the data folder, so the system can be reinstalled later with everything
  intact, or the folder can be copied to a different PC.
#>

$ErrorActionPreference = 'SilentlyContinue'
$AppName = 'Hotel Management System'

Write-Host ""
Write-Host "  Removing $AppName from Windows" -ForegroundColor White
Write-Host "  ============================================================"

$startup = Join-Path ([Environment]::GetFolderPath('Startup')) "$AppName.lnk"
if (Test-Path $startup) { Remove-Item $startup -Force; Write-Host "  Removed autostart entry" -ForegroundColor Green }

$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
if (Test-Path $desktop) { Remove-Item $desktop -Force; Write-Host "  Removed desktop shortcut" -ForegroundColor Green }

$rule = Get-NetFirewallRule -DisplayName $AppName -ErrorAction SilentlyContinue
if ($rule) {
  $rule | Remove-NetFirewallRule
  Write-Host "  Removed firewall rule" -ForegroundColor Green
} else {
  Write-Host "  No firewall rule found (or not running as administrator)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Done. Your data has NOT been deleted. It is still in the data folder." -ForegroundColor Cyan
Write-Host ""
Read-Host 'Press Enter to close'
