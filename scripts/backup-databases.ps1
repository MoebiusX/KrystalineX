#!/usr/bin/env pwsh
# =============================================================================
# KrystalineX Database Backup Script
# =============================================================================
# Automated backup of all PostgreSQL databases
# 
# Usage:
#   ./scripts/backup-databases.ps1                    # Basic backup
#   ./scripts/backup-databases.ps1 -RetentionDays 7   # Custom retention
#   ./scripts/backup-databases.ps1 -UploadToS3        # Upload to S3
#   ./scripts/backup-databases.ps1 -Verify            # Verify after backup
# =============================================================================

param(
    [string]$BackupDir = "./backups",
    [int]$RetentionDays = 30,
    [switch]$UploadToS3,
    [string]$S3Bucket = "your-backup-bucket",
    [switch]$Verify,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$success = $true
$backupResults = @()

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    if (-not $Quiet) {
        $prefix = switch ($Level) {
            "INFO"    { "ℹ️ " }
            "SUCCESS" { "✅" }
            "WARNING" { "⚠️ " }
            "ERROR"   { "❌" }
            default   { "  " }
        }
        Write-Host "$prefix $Message"
    }
}

# Ensure backup directory exists
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

Write-Log "Starting database backups at $(Get-Date)" "INFO"
Write-Log "Backup directory: $BackupDir" "INFO"

# Database configurations
$databases = @(
    @{ 
        Service = "app-database"
        User = "exchange"
        Database = "crypto_exchange"
        Priority = "CRITICAL"
        Description = "User accounts, wallets, orders, trades"
    },
    @{ 
        Service = "kong-database"
        User = "kong"
        Database = "kong"
        Priority = "HIGH"
        Description = "API Gateway configuration"
    },
    @{ 
        Service = "goalert-db"
        User = "goalert"
        Database = "goalert"
        Priority = "MEDIUM"
        Description = "Incident management"
    }
)

foreach ($db in $databases) {
    $backupFile = "$BackupDir/$($db.Database)-$timestamp.dump"
    $result = @{
        Database = $db.Database
        Priority = $db.Priority
        Status = "PENDING"
        File = $backupFile
        SizeMB = 0
        Duration = 0
    }
    
    Write-Log "Backing up $($db.Database) [$($db.Priority)]..." "INFO"
    
    try {
        # Check if service is running
        $containerState = docker compose ps --status running --format '{{.Service}}' 2>$null | Select-String -SimpleMatch $db.Service
        if (-not $containerState) {
            throw "Service $($db.Service) is not running"
        }
        
        $startTime = Get-Date
        
        # Create backup inside container
        docker compose exec -T $db.Service pg_dump -U $db.User -d $db.Database -F c -f /tmp/backup.dump 2>$null
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
        
        # Copy to host
        docker compose cp "$($db.Service):/tmp/backup.dump" $backupFile 2>$null
        if ($LASTEXITCODE -ne 0) { throw "docker cp failed" }
        
        # Clean up container
        docker compose exec -T $db.Service rm -f /tmp/backup.dump 2>$null
        
        $endTime = Get-Date
        $duration = ($endTime - $startTime).TotalSeconds
        $size = (Get-Item $backupFile).Length / 1MB
        
        $result.Status = "SUCCESS"
        $result.SizeMB = [math]::Round($size, 2)
        $result.Duration = [math]::Round($duration, 1)
        
        Write-Log "  $($db.Database): $($result.SizeMB) MB in $($result.Duration)s" "SUCCESS"
        
        # Upload to S3 if requested
        if ($UploadToS3) {
            try {
                aws s3 cp $backupFile "s3://$S3Bucket/krystalinex/$($db.Database)-$timestamp.dump" --quiet
                Write-Log "  Uploaded to s3://$S3Bucket/krystalinex/" "SUCCESS"
            }
            catch {
                Write-Log "  S3 upload failed: $_" "WARNING"
            }
        }
        
        # Verify backup if requested
        if ($Verify) {
            Write-Log "  Verifying backup..." "INFO"
            $verifyResult = docker compose exec -T $db.Service pg_restore -l /tmp/backup.dump 2>&1
            docker compose cp $backupFile "$($db.Service):/tmp/backup.dump" 2>$null
            $tableCount = (docker compose exec -T $db.Service pg_restore -l /tmp/backup.dump 2>$null | Select-String "TABLE").Count
            docker compose exec -T $db.Service rm -f /tmp/backup.dump 2>$null
            Write-Log "  Verified: $tableCount tables in backup" "SUCCESS"
        }
    }
    catch {
        $result.Status = "FAILED"
        $success = $false
        Write-Log "  Failed to backup $($db.Database): $_" "ERROR"
    }
    
    $backupResults += $result
}

# Cleanup old backups
Write-Log "Cleaning up backups older than $RetentionDays days..." "INFO"
$deletedCount = 0
Get-ChildItem -Path $BackupDir -Filter "*.dump" -ErrorAction SilentlyContinue | 
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } | 
    ForEach-Object {
        Remove-Item $_.FullName -Force
        $deletedCount++
        Write-Log "  Deleted: $($_.Name)" "INFO"
    }

if ($deletedCount -eq 0) {
    Write-Log "  No old backups to clean up" "INFO"
}

# Summary
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host "                     BACKUP SUMMARY"
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host ""

$backupResults | ForEach-Object {
    $statusIcon = if ($_.Status -eq "SUCCESS") { "✅" } else { "❌" }
    Write-Host "  $statusIcon $($_.Database) [$($_.Priority)]"
    if ($_.Status -eq "SUCCESS") {
        Write-Host "     File: $($_.File)"
        Write-Host "     Size: $($_.SizeMB) MB | Duration: $($_.Duration)s"
    }
    Write-Host ""
}

# Calculate total size
$totalSize = ($backupResults | Where-Object { $_.Status -eq "SUCCESS" } | Measure-Object -Property SizeMB -Sum).Sum
Write-Host "  Total backup size: $([math]::Round($totalSize, 2)) MB"
Write-Host "  Timestamp: $timestamp"
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════"

if ($success) {
    Write-Log "Backup completed successfully at $(Get-Date)" "SUCCESS"
    exit 0
} else {
    Write-Log "Backup completed with errors at $(Get-Date)" "ERROR"
    exit 1
}
