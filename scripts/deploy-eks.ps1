# KrystalineX EKS Deployment Script
# Usage: .\scripts\deploy-eks.ps1 [-Create] [-Deploy] [-Destroy] [-Status]
param(
    [switch]$Create,    # Create EKS cluster
    [switch]$Deploy,    # Deploy Helm chart
    [switch]$Destroy,   # Tear down cluster
    [switch]$Status,    # Show cluster status
    [switch]$Nginx,     # Install nginx-ingress controller
    [switch]$Secrets,   # Create secrets only
    [string]$Region = "eu-west-1",
    [string]$Cluster = "krystalinex",
    [string]$Namespace = "krystalinex"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $RepoRoot) { $RepoRoot = (Get-Location).Path }
$ChartDir = Join-Path $RepoRoot "k8s\charts\krystalinex"
$EksDir = Join-Path $RepoRoot "k8s\eks"

function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# CREATE: Provision EKS cluster + add-ons
# ---------------------------------------------------------------------------
if ($Create) {
    Write-Step "Creating EKS cluster '$Cluster' in $Region..."
    Write-Host "  This takes 15-20 minutes." -ForegroundColor Yellow

    eksctl create cluster -f (Join-Path $EksDir "cluster.yaml")
    if ($LASTEXITCODE -ne 0) { throw "eksctl create cluster failed" }
    Write-Ok "Cluster created"

    # Verify connectivity
    Write-Step "Verifying cluster connectivity..."
    kubectl get nodes
    Write-Ok "Cluster is reachable"

    # Create gp3 StorageClass as default
    Write-Step "Creating gp3 StorageClass..."
    @"
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  fsType: ext4
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
"@ | kubectl apply -f -
    Write-Ok "gp3 StorageClass created"

    # Remove gp2 as default (EKS ships with gp2 as default)
    kubectl annotate storageclass gp2 storageclass.kubernetes.io/is-default-class=false --overwrite 2>$null
    Write-Ok "gp2 demoted from default"

    # Create namespace
    Write-Step "Creating namespace '$Namespace'..."
    kubectl create namespace $Namespace --dry-run=client -o yaml | kubectl apply -f -
    Write-Ok "Namespace ready"

    Write-Host "`nCluster is ready! Next steps:" -ForegroundColor Green
    Write-Host "  1. .\scripts\deploy-eks.ps1 -Nginx" -ForegroundColor White
    Write-Host "  2. .\scripts\deploy-eks.ps1 -Deploy" -ForegroundColor White
}

# ---------------------------------------------------------------------------
# NGINX: Install nginx-ingress controller with AWS NLB
# ---------------------------------------------------------------------------
if ($Nginx) {
    Write-Step "Installing nginx-ingress controller..."

    helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>$null
    helm repo update ingress-nginx

    helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx `
        --namespace ingress-nginx --create-namespace `
        --set controller.service.type=LoadBalancer `
        --set controller.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-type"=nlb `
        --set controller.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-scheme"=internet-facing `
        --set controller.config.proxy-read-timeout=300 `
        --set controller.config.proxy-send-timeout=300 `
        --set controller.config.proxy-body-size=10m `
        --wait --timeout 120s

    Write-Ok "nginx-ingress installed"

    # Get the NLB DNS name
    Write-Step "Waiting for LoadBalancer external IP..."
    $attempts = 0
    do {
        $lb = kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>$null
        if ($lb) { break }
        Start-Sleep -Seconds 10
        $attempts++
    } while ($attempts -lt 12)

    if ($lb) {
        Write-Ok "NLB DNS: $lb"
        Write-Host "`n  Point www.krystaline.io CNAME to:" -ForegroundColor Yellow
        Write-Host "  $lb" -ForegroundColor White
    } else {
        Write-Warn "NLB not ready yet. Check with: kubectl get svc -n ingress-nginx"
    }
}

# ---------------------------------------------------------------------------
# DEPLOY: Deploy KrystalineX via Helm
# ---------------------------------------------------------------------------
if ($Deploy) {
    $SecretsFile = Join-Path $ChartDir "values-secrets.yaml"
    $EksValues = Join-Path $ChartDir "values-eks.yaml"
    $BaseValues = Join-Path $ChartDir "values.yaml"

    if (-not (Test-Path $SecretsFile)) {
        Write-Step "Generating values-secrets.yaml with random passwords..."
        $dbPass = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
        $rmqPass = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
        $jwtSecret = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
        $kongPass = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
        $grafanaPass = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
        $goalertDbPass = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
        $goalertEnc = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object { [char]$_ })

        @"
# Auto-generated secrets for EKS deployment — DO NOT COMMIT
secrets:
  create: true
  dbPassword: "$dbPass"
  rabbitmqPassword: "$rmqPass"
  jwtSecret: "$jwtSecret"
  kongDbPassword: "$kongPass"
  grafanaAdminPassword: "$grafanaPass"
  goalertDbPassword: "$goalertDbPass"
  goalertEncryptionKey: "$goalertEnc"

goalert:
  provision:
    adminPassword: "$grafanaPass"
    carlosPassword: "$grafanaPass"
"@ | Set-Content $SecretsFile -Encoding utf8
        Write-Ok "Secrets generated at $SecretsFile"
    }

    Write-Step "Deploying KrystalineX to EKS namespace '$Namespace'..."

    # Template and apply (same pattern as local K8s deployment)
    Push-Location (Join-Path $RepoRoot "k8s\charts")
    try {
        helm template kx krystalinex `
            -f krystalinex/values.yaml `
            -f krystalinex/values-eks.yaml `
            -f krystalinex/values-secrets.yaml `
            --namespace $Namespace |
            kubectl apply -f - --namespace $Namespace

        if ($LASTEXITCODE -ne 0) { throw "Helm template | kubectl apply failed" }
        Write-Ok "Manifests applied"
    } finally {
        Pop-Location
    }

    Write-Step "Waiting for core pods to be ready..."
    $components = @("postgresql", "rabbitmq", "redis", "server", "frontend")
    foreach ($comp in $components) {
        Write-Host "  Waiting for $comp..." -NoNewline
        kubectl wait --for=condition=ready pod -l "app.kubernetes.io/component=$comp" `
            -n $Namespace --timeout=300s 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host " Ready" -ForegroundColor Green
        } else {
            Write-Host " Timeout (check logs)" -ForegroundColor Yellow
        }
    }

    Write-Step "Deployment summary:"
    kubectl get pods -n $Namespace -o wide
    Write-Host ""
    kubectl get svc -n $Namespace
}

# ---------------------------------------------------------------------------
# STATUS: Show cluster and pod status
# ---------------------------------------------------------------------------
if ($Status) {
    Write-Step "Cluster info"
    kubectl cluster-info 2>$null

    Write-Step "Nodes"
    kubectl get nodes -o wide

    Write-Step "Pods in '$Namespace'"
    kubectl get pods -n $Namespace -o wide

    Write-Step "Services in '$Namespace'"
    kubectl get svc -n $Namespace

    Write-Step "Ingress"
    kubectl get ingress -n $Namespace

    Write-Step "PVCs in '$Namespace'"
    kubectl get pvc -n $Namespace

    # NLB
    $lb = kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>$null
    if ($lb) {
        Write-Step "Load Balancer: $lb"
    }
}

# ---------------------------------------------------------------------------
# DESTROY: Tear down everything
# ---------------------------------------------------------------------------
if ($Destroy) {
    Write-Warn "This will DESTROY the EKS cluster '$Cluster' and all data!"
    $confirm = Read-Host "Type 'yes' to confirm"
    if ($confirm -ne "yes") {
        Write-Host "Aborted." -ForegroundColor Yellow
        return
    }

    Write-Step "Deleting namespace '$Namespace'..."
    kubectl delete namespace $Namespace --ignore-not-found

    Write-Step "Removing nginx-ingress..."
    helm uninstall ingress-nginx -n ingress-nginx 2>$null
    kubectl delete namespace ingress-nginx --ignore-not-found 2>$null

    Write-Step "Deleting EKS cluster '$Cluster'..."
    eksctl delete cluster --name $Cluster --region $Region --wait
    Write-Ok "Cluster destroyed"
}

# Show help if no flags
if (-not ($Create -or $Deploy -or $Destroy -or $Status -or $Nginx -or $Secrets)) {
    Write-Host @"

KrystalineX EKS Deployment
===========================
Usage: .\scripts\deploy-eks.ps1 <action>

Actions:
  -Create     Create EKS cluster (15-20 min)
  -Nginx      Install nginx-ingress controller with AWS NLB
  -Deploy     Deploy KrystalineX Helm chart
  -Status     Show cluster and pod status
  -Destroy    Tear down cluster and all resources

Workflow:
  1. .\scripts\deploy-eks.ps1 -Create
  2. .\scripts\deploy-eks.ps1 -Nginx
  3. .\scripts\deploy-eks.ps1 -Deploy
  4. .\scripts\deploy-eks.ps1 -Status

Options:
  -Region     AWS region (default: eu-west-1)
  -Cluster    Cluster name (default: krystalinex)
  -Namespace  K8s namespace (default: krystalinex)
"@
}
