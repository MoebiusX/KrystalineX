#!/usr/bin/env bash
# =============================================================================
# Anomaly Analyzer: Full Retrain Pipeline
# 
# Usage: bash scripts/retrain-model.sh [--skip-train] [--skip-upload]
#
# Steps:
#   1. Clean previous artifacts (lora-anomaly-analyzer/, last_run_prepared/)
#   2. Preprocess dataset (tokenize ahead of time to avoid VRAM instability)
#   3. Train LoRA adapter with Axolotl
#   4. Merge LoRA adapter into base model
#   5. Verify merged model exists
#   6. Import merged model into Ollama + smoke test
#   7. (Optional) Upload to Hugging Face
#
# Prerequisites:
#   - Docker with GPU support (nvidia-container-toolkit)
#   - Ollama running (docker or local)
#   - HF_TOKEN set in .env or environment
# =============================================================================

set -euo pipefail

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Load .env if present
if [ -f .env ]; then
    export $(grep -E '^HF_TOKEN=' .env | xargs)
fi

HF_TOKEN="${HF_TOKEN:?Set HF_TOKEN in .env or environment}"
AXOLOTL_IMAGE="axolotlai/axolotl:main-py3.11-cu124-2.6.0"
AXOLOTL_CONFIG="/data/axolotl-config.yaml"
OLLAMA_MODEL_NAME="anomaly-analyzer"
OLLAMA_CONTAINER="krystalinex-ollama-1"
HF_REPO="XavierThibaudon/anomaly-analyzer"

SKIP_TRAIN=false
SKIP_UPLOAD=false

for arg in "$@"; do
    case $arg in
        --skip-train) SKIP_TRAIN=true ;;
        --skip-upload) SKIP_UPLOAD=true ;;
    esac
done

echo ""
echo "========================================"
echo "  Anomaly Analyzer - Retrain Pipeline"
echo "========================================"
echo ""

# --- Step 1: Clean previous artifacts ---
if [ "$SKIP_TRAIN" = false ]; then
    echo "▶ Step 1/7: Cleaning previous artifacts..."

    if [ -d "lora-anomaly-analyzer" ]; then
        echo "  Removing lora-anomaly-analyzer/"
        rm -rf lora-anomaly-analyzer
    fi

    if [ -d "last_run_prepared" ]; then
        echo "  Removing last_run_prepared/"
        rm -rf last_run_prepared
    fi

    echo "  ✅ Clean slate"
else
    echo "▶ Step 1/7: Skipped cleanup (--skip-train, preserving existing artifacts)"
fi
echo ""

# --- Step 2: Preprocess dataset (tokenize ahead of time) ---
if [ "$SKIP_TRAIN" = false ]; then
    echo "▶ Step 2/7: Preprocessing dataset (tokenize ahead of time)..."
    echo "  This prevents VRAM instability from on-the-fly tokenization."
    echo ""

    MSYS_NO_PATHCONV=1 docker run --gpus all \
        -e HF_TOKEN="$HF_TOKEN" \
        -v "$(pwd)":/data \
        -w /data \
        "$AXOLOTL_IMAGE" \
        python -m axolotl.cli.preprocess "$AXOLOTL_CONFIG"

    echo ""
    echo "  ✅ Preprocessing complete"
else
    echo "▶ Step 2/7: Skipped preprocessing (--skip-train)"
fi
echo ""

# --- Step 3: Train LoRA adapter ---
if [ "$SKIP_TRAIN" = false ]; then
    echo "▶ Step 3/7: Training LoRA adapter..."
    echo "  Image: $AXOLOTL_IMAGE"
    echo "  Config: $AXOLOTL_CONFIG"
    echo ""

    MSYS_NO_PATHCONV=1 docker run --gpus all \
        -e HF_TOKEN="$HF_TOKEN" \
        -v "$(pwd)":/data \
        -w /data \
        "$AXOLOTL_IMAGE" \
        accelerate launch -m axolotl.cli.train "$AXOLOTL_CONFIG"

    echo ""
    echo "  ✅ Training complete"
else
    echo "▶ Step 3/7: Skipped training (--skip-train)"
fi
echo ""

# --- Step 4: Merge LoRA adapter ---
if [ "$SKIP_TRAIN" = false ]; then
    echo "▶ Step 4/7: Merging LoRA adapter into base model..."

    # Pre-flight: check disk space (need ~5GB for merged model)
    AVAIL_KB=$(df --output=avail "$(pwd)" 2>/dev/null | tail -1 || echo "0")
    AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
    if [ "$AVAIL_GB" -lt 5 ]; then
        echo "  ⚠️  WARNING: Only ${AVAIL_GB}GB free on host. Merge needs ~5GB."
        echo "     Free space with: du -sh ~/.cache/huggingface/ lora-anomaly-analyzer/"
        echo "     Continuing anyway (merge may fail)..."
    else
        echo "  ✅ Disk space OK (${AVAIL_GB}GB available)"
    fi

    # Merge inside container. Axolotl writes the merged model to
    # {output_dir}/merged/ (i.e. /data/lora-anomaly-analyzer/merged/).
    MSYS_NO_PATHCONV=1 docker run --gpus all \
        -e HF_TOKEN="$HF_TOKEN" \
        -v "$(pwd)":/data \
        -w /data \
        "$AXOLOTL_IMAGE" \
        python -m axolotl.cli.merge_lora "$AXOLOTL_CONFIG"

    echo ""
    echo "  ✅ Merge complete → lora-anomaly-analyzer/merged/"
else
    echo "▶ Step 4/7: Skipped merge (--skip-train)"
fi
echo ""

# --- Step 5: Verify merged model exists ---
echo "▶ Step 5/7: Verifying merged model..."
if [ ! -f "lora-anomaly-analyzer/merged/model.safetensors" ] && \
   [ ! -f "lora-anomaly-analyzer/merged/model-00001-of-00002.safetensors" ]; then
    echo "  ❌ ERROR: No merged model found in lora-anomaly-analyzer/merged/"
    echo "     Expected model.safetensors or sharded model files"
    exit 1
fi
echo "  ✅ Merged model found"
echo ""

# --- Step 6: Import into Ollama (via docker cp + docker exec) ---
echo "▶ Step 6/7: Creating Ollama model '$OLLAMA_MODEL_NAME'..."

# Ensure Ollama container is running
if ! docker ps --format '{{.Names}}' | grep -q "$OLLAMA_CONTAINER"; then
    echo "  Starting Ollama container via docker compose..."
    docker compose up -d ollama
    echo "  Waiting for Ollama to be ready..."
    sleep 15
fi

# Clean previous model files inside container
echo "  Cleaning previous model files in container..."
MSYS_NO_PATHCONV=1 docker exec "$OLLAMA_CONTAINER" rm -rf /tmp/merged /tmp/Modelfile 2>/dev/null || true

# Create a container-ready Modelfile (sed runs locally to avoid MSYS path mangling)
echo "  Preparing Modelfile for container..."
sed 's|./lora-anomaly-analyzer/merged|/tmp/merged|' Modelfile > Modelfile.docker

# Copy into the container
echo "  Copying Modelfile into container..."
docker cp Modelfile.docker "$OLLAMA_CONTAINER":/tmp/Modelfile
rm -f Modelfile.docker

echo "  Copying merged model into container (~2.3GB)..."
docker cp lora-anomaly-analyzer/merged "$OLLAMA_CONTAINER":/tmp/merged

# Remove old model if exists
echo "  Removing old Ollama model (if exists)..."
MSYS_NO_PATHCONV=1 docker exec "$OLLAMA_CONTAINER" ollama rm "$OLLAMA_MODEL_NAME" 2>/dev/null || true

# Create the new model
echo "  Creating Ollama model..."
MSYS_NO_PATHCONV=1 docker exec "$OLLAMA_CONTAINER" ollama create "$OLLAMA_MODEL_NAME" -f /tmp/Modelfile

# Clean up temp files in container
MSYS_NO_PATHCONV=1 docker exec "$OLLAMA_CONTAINER" rm -rf /tmp/merged /tmp/Modelfile

echo "  ✅ Ollama model created"
echo ""

# --- Step 6b: Smoke test ---
echo "  🔍 Smoke testing model..."
SMOKE_RESULT=$(MSYS_NO_PATHCONV=1 docker exec "$OLLAMA_CONTAINER" ollama run "$OLLAMA_MODEL_NAME" \
    "Analyze anomaly: pg-pool.connect took 200ms instead of expected 12ms. Deviation: 7σ. Provide SUMMARY, CAUSES, RECOMMENDATIONS, CONFIDENCE." 2>&1 | head -20)

if [ -z "$SMOKE_RESULT" ]; then
    echo "  ⚠️  WARNING: Model returned empty response!"
    echo "     The model may have training issues. Check training data format."
    echo ""
else
    echo "  ✅ Model responded (${#SMOKE_RESULT} chars):"
    echo "     ${SMOKE_RESULT:0:200}..."
    echo ""
fi

# --- Step 7: Upload to Hugging Face ---
if [ "$SKIP_UPLOAD" = false ]; then
    echo "▶ Step 7/7: Uploading to Hugging Face ($HF_REPO)..."

    HF_HUB_ENABLE_HF_TRANSFER=1 huggingface-cli upload \
        "$HF_REPO" \
        ./lora-anomaly-analyzer/merged .

    echo "  ✅ Uploaded to https://huggingface.co/$HF_REPO"
else
    echo "▶ Step 7/7: Skipped upload (--skip-upload)"
fi

echo ""
echo "========================================"
echo "  ✅ Pipeline complete!"
echo "========================================"
echo "  Model: $OLLAMA_MODEL_NAME"
echo "  Test:  docker exec $OLLAMA_CONTAINER ollama run $OLLAMA_MODEL_NAME \"your prompt\""
echo ""
