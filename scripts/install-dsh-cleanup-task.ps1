param(
  [string]$Time = "03:30",
  [string]$TaskName = "DSH Weekly Cleanup"
)

$ErrorActionPreference = "Stop"

$projectDir = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $projectDir "scripts\cleanup-dsh-data.mjs"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --apply" -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Clean low-risk DSH temp/cache/log files without touching paper milestones, final outputs, or raw data." -Force | Out-Null
Write-Host "Installed scheduled cleanup task: $TaskName daily at $Time" -ForegroundColor Green
