param(
    [string]$TaskName = 'DSH Paper Workbench'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe).Source
$launcherPath = Join-Path $PSScriptRoot 'start-dsh-web.mjs'
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument ('"{0}"' -f $launcherPath) `
    -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
    -UserId $userId `
    -LogonType Interactive `
    -RunLevel Limited

try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Keeps the local DSH scientific paper workbench available after sign-in.' `
        -Force | Out-Null
    Write-Output "Scheduled task installed: $TaskName"
} catch [Microsoft.Management.Infrastructure.CimException] {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $launcherFile = Join-Path $startupDir 'DSH-Paper-Workbench.vbs'
    $command = '"{0}" "{1}"' -f $nodePath, $launcherPath
    $content = "Set shell = CreateObject(`"WScript.Shell`")`r`nshell.Run `"$($command.Replace('`"', '`"`"'))`", 0, False`r`n"
    Set-Content -LiteralPath $launcherFile -Value $content -Encoding ASCII
    Write-Output "Startup launcher installed: $launcherFile"
}
