# Libre CMMS - Copyright (C) 2026 CreativeMed LLC - AGPL-3.0-or-later
# Installs Libre as a startup service on Windows. Run in an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 [-Port 8080] [-NoService] [-NoFirewall] [-Uninstall]
param(
  [int]$Port = 0,
  [switch]$NoService,
  [switch]$NoFirewall,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Libre CMMS'
$Root = Split-Path -Parent $PSScriptRoot
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Please run this script in an Administrator PowerShell window.' -ForegroundColor Red; exit 1 }

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Get-NetFirewallRule -DisplayName 'Libre CMMS*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host 'Libre service and firewall rule removed. The data folder was left in place.'
  exit 0
}

# 1. Node.js
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org and run this again.' -ForegroundColor Red; exit 1 }
$ver = (& $node -v).TrimStart('v').Split('.')
if ([int]$ver[0] -lt 22 -or ([int]$ver[0] -eq 22 -and [int]$ver[1] -lt 13)) { Write-Host "Node.js $(& $node -v) is too old. Install Node.js 24 LTS." -ForegroundColor Red; exit 1 }
Write-Host "Node.js $(& $node -v) found at $node"

# 2. Configuration
$cfgFile = Join-Path $Root 'config\libre.config.json'
if (-not (Test-Path $cfgFile)) {
  Copy-Item (Join-Path $Root 'config\libre.config.example.json') $cfgFile
  Write-Host "Created $cfgFile"
}
$cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
if ($Port -gt 0) {
  $cfg.port = $Port
  $cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $cfgFile -Encoding UTF8
}
$Port = [int]$cfg.port

# 3. Firewall
if (-not $NoFirewall) {
  Get-NetFirewallRule -DisplayName 'Libre CMMS*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName "Libre CMMS (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain,Private | Out-Null
  Write-Host "Firewall rule added for TCP $Port (Domain and Private networks)."
}

# 4. Startup task (runs as SYSTEM at boot, restarts on failure)
if (-not $NoService) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  $logDir = Join-Path $Root 'data\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $cmd = "/c `"`"$node`" `"$Root\server\server.js`" >> `"$logDir\libre.log`" 2>&1`""
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Libre CMMS web server (Copyright CreativeMed LLC, AGPL-3.0)' | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  Write-Host "Libre is installed and running. Log file: $logDir\libre.log"
}

$scheme = if ($cfg.https.enabled) { 'https' } else { 'http' }
Write-Host ''
Write-Host "Open $scheme`://localhost:$Port on this computer, or $scheme`://$($env:COMPUTERNAME):$Port from other devices." -ForegroundColor Green
Write-Host 'Manage the service with:  Start-ScheduledTask / Stop-ScheduledTask -TaskName "Libre CMMS"'
