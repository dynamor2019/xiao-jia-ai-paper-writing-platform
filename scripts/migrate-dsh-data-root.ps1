param(
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "XiaoJiaAI Data")
)

$ErrorActionPreference = "Stop"

function Move-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source)) {
    return
  }

  $sourceItem = Get-Item -LiteralPath $Source -Force
  if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    return
  }

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    $target = Join-Path $Destination $_.Name
    if (Test-Path -LiteralPath $target) {
      if ($_.PSIsContainer) {
        Move-DirectoryContents -Source $_.FullName -Destination $target
        Remove-Item -LiteralPath $_.FullName -Force -Recurse
      } else {
        $stamp = Get-Date -Format "yyyyMMddHHmmss"
        $backupTarget = "$target.migrated-$stamp"
        Move-Item -LiteralPath $_.FullName -Destination $backupTarget
      }
    } else {
      Move-Item -LiteralPath $_.FullName -Destination $target
    }
  }
}

function Update-JsonPathValues {
  param([Parameter(Mandatory = $true)][string]$Root)

  if (-not (Test-Path -LiteralPath $Root)) {
    return
  }

  $oldRoot = ($ProjectDir.TrimEnd("\") + "\output").Replace("\", "\\")
  $newRoot = (Join-Path $DataRoot "output").TrimEnd("\").Replace("\", "\\")
  $oldState = ($ProjectDir.TrimEnd("\") + "\.dsh-state").Replace("\", "\\")
  $newState = (Join-Path $DataRoot ".dsh-state").TrimEnd("\").Replace("\", "\\")

  Get-ChildItem -LiteralPath $Root -Recurse -File -Include *.json,*.request.json | ForEach-Object {
    $content = Get-Content -LiteralPath $_.FullName -Raw
    if ($null -eq $content) {
      return
    }
    $updated = $content.Replace($oldRoot, $newRoot).Replace($oldState, $newState)
    $updated = $updated.Replace($oldRoot.Replace("\\", "/"), $newRoot.Replace("\\", "/"))
    $updated = $updated.Replace($oldState.Replace("\\", "/"), $newState.Replace("\\", "/"))
    if ($updated -ne $content) {
      Set-Content -LiteralPath $_.FullName -Value $updated -NoNewline -Encoding UTF8
    }
  }
}

$project = Resolve-Path -LiteralPath $ProjectDir
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null

Move-DirectoryContents -Source (Join-Path $project "output") -Destination (Join-Path $DataRoot "output")
Move-DirectoryContents -Source (Join-Path $project "papers\input") -Destination (Join-Path $DataRoot "papers\input")
Move-DirectoryContents -Source (Join-Path $project ".dsh-state") -Destination (Join-Path $DataRoot ".dsh-state")

Update-JsonPathValues -Root (Join-Path $DataRoot ".dsh-state")
Update-JsonPathValues -Root (Join-Path $DataRoot "output")

New-Item -ItemType Directory -Path (Join-Path $DataRoot "output") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DataRoot "papers\input") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DataRoot ".dsh-state") -Force | Out-Null

$env:PAPER_DATA_ROOT = $DataRoot
Push-Location $project
try {
  node scripts/link-dsh-data-root.mjs
} finally {
  Pop-Location
}

Write-Output "DSH data migrated to $DataRoot"
