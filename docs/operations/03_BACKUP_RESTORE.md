# KrystalineX Backup & Restore Procedures

**Version:** 1.0  
**Last Updated:** February 2, 2026  
**Owner:** Platform Operations

---

## Table of Contents

1. [Overview](#1-overview)
2. [Database Inventory](#2-database-inventory)
3. [Backup Procedures](#3-backup-procedures)
4. [Restore Procedures](#4-restore-procedures)
5. [Automated Backup Setup](#5-automated-backup-setup)
6. [Disaster Recovery](#6-disaster-recovery)
7. [Verification & Testing](#7-verification--testing)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview

### Backup Strategy

| Component | Method | Frequency | Retention |
|-----------|--------|-----------|-----------|
| App Database (crypto_exchange) | pg_dump | Every 6 hours | 30 days |
| Kong Database | pg_dump | Daily | 7 days |
| GoAlert Database | pg_dump | Daily | 7 days |
| Configuration Files | Git + tar | On change | Indefinite |
| Docker Volumes | Volume backup | Weekly | 4 weeks |

### Recovery Point Objective (RPO)
- **Critical data (wallets, orders):** 6 hours
- **Configuration:** 24 hours

### Recovery Time Objective (RTO)
- **Full restore:** < 2 hours
- **Single database restore:** < 30 minutes

---

## 2. Database Inventory

### Primary Databases

| Database | Service | Port | Purpose | Data Criticality |
|----------|---------|------|---------|------------------|
| `crypto_exchange` | app-database | 5433 | Users, wallets, orders, trades | **CRITICAL** |
| `kong` | kong-database | 5432 | API Gateway config, routes | HIGH |
| `goalert` | goalert-db | 5434 | Incident management | MEDIUM |

### Schema Overview (crypto_exchange)

```
├── users              # User accounts & authentication
├── sessions           # JWT refresh tokens
├── verification_codes # Email/SMS verification
├── wallets            # Asset balances (BTC, ETH, USDT, etc.)
├── transactions       # Deposit/withdrawal/trade history
├── orders             # Trading orders
├── trades             # Matched trade history
└── kyc_submissions    # KYC documents & status
```

---

## 3. Backup Procedures

### 3.1 Manual Backup (Docker Compose)

#### Full Database Backup

```powershell
# Set timestamp for backup file
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

# Backup app database (CRITICAL)
docker exec app-database pg_dump -U exchange -d crypto_exchange -F c -f /tmp/backup.dump
docker cp app-database:/tmp/backup.dump "./backups/crypto_exchange-$timestamp.dump"

# Backup Kong database
docker exec kong-database pg_dump -U kong -d kong -F c -f /tmp/backup.dump
docker cp kong-database:/tmp/backup.dump "./backups/kong-$timestamp.dump"

# Backup GoAlert database
docker compose exec -T goalert-db pg_dump -U goalert -d goalert -F c -f /tmp/backup.dump
docker compose cp goalert-db:/tmp/backup.dump "./backups/goalert-$timestamp.dump"

Write-Host "✅ Backups completed: ./backups/*-$timestamp.dump"
```

#### Schema-Only Backup (for migrations)

```powershell
docker exec app-database pg_dump -U exchange -d crypto_exchange --schema-only > "./backups/schema-only.sql"
```

#### Data-Only Backup (for seeding)

```powershell
docker exec app-database pg_dump -U exchange -d crypto_exchange --data-only --inserts > "./backups/data-only.sql"
```

### 3.2 Manual Backup (Kubernetes)

```bash
# Get pod name
POD=$(kubectl -n krystalinex get pods -l app=postgresql -o jsonpath='{.items[0].metadata.name}')

# Create backup
kubectl -n krystalinex exec $POD -- pg_dump -U exchange -d crypto_exchange -F c > ./backups/k8s-crypto_exchange-$(date +%Y%m%d).dump

# Verify backup size
ls -lh ./backups/
```

### 3.3 Selective Table Backup

For large databases, backup critical tables separately:

```powershell
# Backup only wallets and transactions (most critical)
docker exec app-database pg_dump -U exchange -d crypto_exchange `
  -t wallets -t transactions -t orders -t trades `
  -F c -f /tmp/critical.dump

docker cp app-database:/tmp/critical.dump "./backups/critical-tables-$(Get-Date -Format 'yyyyMMdd').dump"
```

### 3.4 Backup to Remote Storage

#### AWS S3

```powershell
# Backup and upload to S3
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
docker exec app-database pg_dump -U exchange -d crypto_exchange -F c | `
  aws s3 cp - "s3://your-backup-bucket/krystalinex/crypto_exchange-$timestamp.dump"
```

#### Azure Blob Storage

```powershell
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
docker exec app-database pg_dump -U exchange -d crypto_exchange -F c > backup.dump
az storage blob upload --account-name youraccount --container-name backups `
  --name "krystalinex/crypto_exchange-$timestamp.dump" --file backup.dump
```

---

## 4. Restore Procedures

### 4.1 Full Database Restore (Docker Compose)

> ⚠️ **WARNING:** This will overwrite all existing data!

```powershell
# Stop application services first
docker-compose stop server payment-processor

# Drop and recreate database
docker exec -it app-database psql -U exchange -c "DROP DATABASE IF EXISTS crypto_exchange;"
docker exec -it app-database psql -U exchange -c "CREATE DATABASE crypto_exchange;"

# Restore from backup
docker cp "./backups/crypto_exchange-YYYYMMDD-HHMMSS.dump" app-database:/tmp/backup.dump
docker exec app-database pg_restore -U exchange -d crypto_exchange -c /tmp/backup.dump

# Restart services
docker-compose start server payment-processor

# Verify restoration
docker exec app-database psql -U exchange -d crypto_exchange -c "SELECT COUNT(*) FROM users;"
```

### 4.2 Point-in-Time Restore (Kubernetes)

```bash
# Scale down application
kubectl -n krystalinex scale deployment kx-krystalinex-server --replicas=0

# Get PostgreSQL pod
POD=$(kubectl -n krystalinex get pods -l app=postgresql -o jsonpath='{.items[0].metadata.name}')

# Copy backup to pod
kubectl -n krystalinex cp ./backups/crypto_exchange-YYYYMMDD.dump $POD:/tmp/backup.dump

# Restore
kubectl -n krystalinex exec $POD -- pg_restore -U exchange -d crypto_exchange -c /tmp/backup.dump

# Scale up application
kubectl -n krystalinex scale deployment kx-krystalinex-server --replicas=2

# Verify
kubectl -n krystalinex exec $POD -- psql -U exchange -d crypto_exchange -c "SELECT COUNT(*) FROM users;"
```

### 4.3 Restore Specific Tables Only

```powershell
# Restore only wallets table (e.g., to fix balance corruption)
docker exec app-database pg_restore -U exchange -d crypto_exchange `
  -t wallets --data-only --disable-triggers `
  /tmp/backup.dump
```

### 4.4 Restore to Different Database (Migration/Testing)

```powershell
# Create test database
docker exec app-database psql -U exchange -c "CREATE DATABASE crypto_exchange_test;"

# Restore backup to test database
docker exec app-database pg_restore -U exchange -d crypto_exchange_test /tmp/backup.dump

# Verify data
docker exec app-database psql -U exchange -d crypto_exchange_test -c "\dt"
```

---

## 5. Automated Backup Setup

### 5.1 Docker Compose Backup Script

Create `scripts/backup-databases.ps1`:

```powershell
#!/usr/bin/env pwsh
# Automated database backup script for KrystalineX

param(
    [string]$BackupDir = "./backups",
    [int]$RetentionDays = 30,
    [switch]$UploadToS3,
    [string]$S3Bucket = "your-backup-bucket"
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

# Ensure backup directory exists
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

Write-Host "🔄 Starting database backups at $(Get-Date)"

# Backup configurations
$databases = @(
    @{ Service = "app-database"; User = "exchange"; Database = "crypto_exchange"; Priority = "critical" },
    @{ Service = "kong-database"; User = "kong"; Database = "kong"; Priority = "high" },
    @{ Service = "goalert-db"; User = "goalert"; Database = "goalert"; Priority = "medium" }
)

foreach ($db in $databases) {
    $backupFile = "$BackupDir/$($db.Database)-$timestamp.dump"
    
    Write-Host "  📦 Backing up $($db.Database)..."
    
    try {
        # Create backup inside container
        docker compose exec -T $db.Service pg_dump -U $db.User -d $db.Database -F c -f /tmp/backup.dump
        
        # Copy to host
        docker compose cp "$($db.Service):/tmp/backup.dump" $backupFile
        
        # Clean up container
        docker compose exec -T $db.Service rm /tmp/backup.dump
        
        $size = (Get-Item $backupFile).Length / 1MB
        Write-Host "    ✅ $($db.Database): $([math]::Round($size, 2)) MB"
        
        # Upload to S3 if requested
        if ($UploadToS3) {
            aws s3 cp $backupFile "s3://$S3Bucket/krystalinex/$($db.Database)-$timestamp.dump"
            Write-Host "    ☁️  Uploaded to S3"
        }
    }
    catch {
        Write-Host "    ❌ Failed to backup $($db.Database): $_" -ForegroundColor Red
    }
}

# Cleanup old backups
Write-Host "🧹 Cleaning up backups older than $RetentionDays days..."
Get-ChildItem -Path $BackupDir -Filter "*.dump" | 
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } | 
    ForEach-Object {
        Remove-Item $_.FullName
        Write-Host "  🗑️  Deleted: $($_.Name)"
    }

Write-Host "✅ Backup completed at $(Get-Date)"
```

### 5.2 Windows Task Scheduler (Automated)

```powershell
# Create scheduled task for automated backups every 6 hours
$action = New-ScheduledTaskAction -Execute "pwsh.exe" `
    -Argument "-File C:\Users\bizai\Documents\GitHub\KrystalineX\scripts\backup-databases.ps1"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount

Register-ScheduledTask -TaskName "KrystalineX-DatabaseBackup" `
    -Action $action -Trigger $trigger -Principal $principal `
    -Description "Automated PostgreSQL backup for KrystalineX"
```

### 5.3 Kubernetes CronJob

Create `k8s/backup-cronjob.yaml`:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgresql-backup
  namespace: krystalinex
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: postgres:15
            env:
            - name: PGHOST
              value: postgresql
            - name: PGUSER
              value: exchange
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: krystalinex-secrets
                  key: DB_PASSWORD
            - name: PGDATABASE
              value: crypto_exchange
            command:
            - /bin/bash
            - -c
            - |
              TIMESTAMP=$(date +%Y%m%d-%H%M%S)
              pg_dump -F c > /backups/crypto_exchange-$TIMESTAMP.dump
              echo "Backup completed: crypto_exchange-$TIMESTAMP.dump"
              # Cleanup old backups (keep last 30)
              ls -t /backups/*.dump | tail -n +31 | xargs -r rm
            volumeMounts:
            - name: backup-storage
              mountPath: /backups
          restartPolicy: OnFailure
          volumes:
          - name: backup-storage
            persistentVolumeClaim:
              claimName: backup-pvc
```

---

## 6. Disaster Recovery

### 6.1 Disaster Scenarios

| Scenario | RTO | RPO | Recovery Procedure |
|----------|-----|-----|-------------------|
| Single table corruption | 15 min | 6 hours | Restore table from backup |
| Full database corruption | 30 min | 6 hours | Full database restore |
| Pod/container failure | 5 min | 0 | Kubernetes auto-restart |
| Node failure | 10 min | 0 | Kubernetes rescheduling |
| Full cluster loss | 2 hours | 6 hours | Restore from off-site backup |
| Region failure | 4 hours | 6 hours | Failover to secondary region |

### 6.2 Full Disaster Recovery Runbook

#### Step 1: Assess Damage

```powershell
# Check database connectivity
docker exec app-database psql -U exchange -d crypto_exchange -c "SELECT 1;"

# Check data integrity
docker exec app-database psql -U exchange -d crypto_exchange -c "
  SELECT 'users' as table_name, COUNT(*) FROM users
  UNION ALL SELECT 'wallets', COUNT(*) FROM wallets
  UNION ALL SELECT 'orders', COUNT(*) FROM orders;
"
```

#### Step 2: Identify Latest Backup

```powershell
# List available backups
Get-ChildItem -Path "./backups" -Filter "crypto_exchange-*.dump" | 
    Sort-Object LastWriteTime -Descending | 
    Select-Object Name, LastWriteTime, @{Name="SizeMB";Expression={[math]::Round($_.Length/1MB, 2)}}
```

#### Step 3: Notify Stakeholders

```powershell
# Send notification via ntfy
curl -X POST "https://ntfy.sh/$env:NTFY_TOPIC" `
  -H "Title: 🔴 DR INITIATED: KrystalineX" `
  -H "Priority: urgent" `
  -H "Tags: rotating_light,disaster" `
  -d "Database recovery in progress. ETA: 30 minutes. Last backup: [TIMESTAMP]"
```

#### Step 4: Execute Recovery

See [Section 4.1](#41-full-database-restore-docker-compose) for detailed restore steps.

#### Step 5: Verify Recovery

```powershell
# Run integrity checks
docker exec app-database psql -U exchange -d crypto_exchange -c "
  -- Check wallet balance consistency
  SELECT 
    CASE WHEN SUM(CASE WHEN balance < 0 THEN 1 ELSE 0 END) = 0 
         THEN '✅ No negative balances' 
         ELSE '❌ Negative balances found' END AS check_result
  FROM wallets;
"

# Run application health check
Invoke-RestMethod -Uri "http://localhost:5000/health" | ConvertTo-Json
```

#### Step 6: Resume Operations

```powershell
# Scale up services
docker-compose up -d server payment-processor

# Or in Kubernetes
kubectl -n krystalinex scale deployment kx-krystalinex-server --replicas=2
kubectl -n krystalinex scale deployment kx-krystalinex-payment-processor --replicas=2
```

### 6.3 Off-Site Backup Strategy

```
                    ┌─────────────────┐
                    │  Primary Site   │
                    │   (Local/K8s)   │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
     ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
     │  Local Disk │  │   AWS S3    │  │ Azure Blob  │
     │  (Primary)  │  │  (Offsite)  │  │  (Offsite)  │
     └─────────────┘  └─────────────┘  └─────────────┘
           │                │                │
           │         Encrypted at rest       │
           │         Versioned               │
           └────────────────┴────────────────┘
                            │
                   30-day retention
```

---

## 7. Verification & Testing

### 7.1 Backup Verification Checklist

Run monthly:

- [ ] Backup files exist and are non-zero
- [ ] Backup files can be read (not corrupted)
- [ ] Restore to test database succeeds
- [ ] Row counts match production
- [ ] Application can connect to restored database

### 7.2 Automated Verification Script

```powershell
# scripts/verify-backup.ps1

param([string]$BackupFile)

Write-Host "🔍 Verifying backup: $BackupFile"

# Create temporary test database
docker exec app-database psql -U exchange -c "DROP DATABASE IF EXISTS backup_test;"
docker exec app-database psql -U exchange -c "CREATE DATABASE backup_test;"

# Copy and restore
docker cp $BackupFile app-database:/tmp/test-backup.dump
$result = docker exec app-database pg_restore -U exchange -d backup_test /tmp/test-backup.dump 2>&1

if ($LASTEXITCODE -eq 0) {
    # Get row counts
    $counts = docker exec app-database psql -U exchange -d backup_test -t -c "
        SELECT 'users: ' || COUNT(*) FROM users
        UNION ALL SELECT 'wallets: ' || COUNT(*) FROM wallets
        UNION ALL SELECT 'orders: ' || COUNT(*) FROM orders;
    "
    Write-Host "✅ Backup verified successfully"
    Write-Host $counts
} else {
    Write-Host "❌ Backup verification failed: $result" -ForegroundColor Red
    exit 1
}

# Cleanup
docker exec app-database psql -U exchange -c "DROP DATABASE backup_test;"
docker exec app-database rm /tmp/test-backup.dump
```

### 7.3 DR Drill Schedule

| Drill Type | Frequency | Duration | Participants |
|------------|-----------|----------|--------------|
| Backup verification | Monthly | 30 min | Ops |
| Single table restore | Quarterly | 1 hour | Ops + Dev |
| Full DR simulation | Annually | 4 hours | All teams |

---

## 8. Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| `pg_dump: connection refused` | Database not running | `docker-compose up -d app-database` |
| `permission denied` | Wrong user | Use `-U exchange` for app-database |
| `database does not exist` | Database dropped | Recreate with `CREATE DATABASE` |
| Restore hangs | Active connections | Terminate connections first |
| Backup file corrupted | Disk issue | Use `-F c` (custom format) with checksums |
| Out of disk space | Large database | Compress with `gzip` or stream to S3 |

### Terminate Active Connections Before Restore

```sql
-- Run before restore if connections are blocking
SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE datname = 'crypto_exchange' AND pid <> pg_backend_pid();
```

### Check Backup File Integrity

```powershell
# Verify backup file (custom format)
docker cp ./backups/crypto_exchange-latest.dump app-database:/tmp/check.dump
docker exec app-database pg_restore -l /tmp/check.dump | Select-Object -First 20

# If this fails, the backup is corrupted
```

### Large Database Optimization

```powershell
# Parallel backup (faster for large databases)
docker exec app-database pg_dump -U exchange -d crypto_exchange -F d -j 4 -f /tmp/parallel_backup

# Compressed backup
docker exec app-database pg_dump -U exchange -d crypto_exchange | gzip > ./backups/crypto_exchange-compressed.sql.gz
```

---

## Quick Reference Card

```
┌────────────────────────────────────────────────────────────────────┐
│                    BACKUP & RESTORE QUICK REFERENCE                │
├────────────────────────────────────────────────────────────────────┤
│ BACKUP (Docker):                                                   │
│   docker exec app-database pg_dump -U exchange -d crypto_exchange  │
│     -F c -f /tmp/backup.dump                                       │
│   docker cp app-database:/tmp/backup.dump ./backups/               │
│                                                                    │
│ RESTORE (Docker):                                                  │
│   docker-compose stop server payment-processor                     │
│   docker cp ./backups/backup.dump app-database:/tmp/               │
│   docker exec app-database pg_restore -U exchange                  │
│     -d crypto_exchange -c /tmp/backup.dump                         │
│   docker-compose start server payment-processor                    │
│                                                                    │
│ VERIFY:                                                            │
│   docker exec app-database psql -U exchange -d crypto_exchange     │
│     -c "SELECT COUNT(*) FROM users;"                               │
│                                                                    │
│ EMERGENCY CONTACTS:                                                │
│   GoAlert: http://localhost:8081                                   │
│   On-Call: See RUNBOOK.md Section 10                               │
└────────────────────────────────────────────────────────────────────┘
```

---

*This document should be tested quarterly. Last DR drill: ____________*
