#!/bin/bash
#
# Train LoRA Adapter for Anomaly Analyzer
#
# Prerequisites:
# - Python 3.10+
# - CUDA toolkit (for GPU training)
# - pip install axolotl
#
# Usage: ./scripts/train-lora.sh

set -e

echo "=== Anomaly Analyzer LoRA Training ==="
echo ""

# Check for training data
if [ ! -f "data/ttraining-data-axolotljsonl" ] && [ ! -f "data/training-data-axolotl.json" ]; then
    echo "❌ No training data found!"
    echo ""
    echo "Export training data first:"
    echo "  curl http://localhost:5000/api/v1/monitor/training/export > data/training-data.jsonl"
    exit 1
fi

# Convert training data
echo "📦 Converting training data to Axolotl format..."
npx tsx scripts/convert-training-data.cjs

# Check example count
EXAMPLES=$(wc -l < data/training-data-axolotl.jsonl)
echo "   Found $EXAMPLES training examples"

if [ "$EXAMPLES" -lt 50 ]; then
    echo "⚠️  Warning: Less than 50 examples. Consider collecting more for better results."
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check for GPU
if command -v nvidia-smi &> /dev/null; then
    echo "🖥️  GPU detected:"
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
    echo "⚠️  No GPU detected. Training will be slow on CPU."
fi

echo ""
echo "🚀 Starting LoRA training..."
echo "   This may take 30-60 minutes on a consumer GPU."
echo ""

# Run training
if command -v accelerate &> /dev/null; then
    accelerate launch -m axolotl.cli.train axolotl-config.yaml
else
    python -m axolotl.cli.train axolotl-config.yaml
fi

echo ""
echo "✅ Training complete!"
echo ""
echo "Next steps:"
echo "1. Merge LoRA: python -m axolotl.cli.merge_lora axolotl-config.yaml"
echo "2. Convert to GGUF for Ollama"
echo "3. See docs/FINE-TUNING.md for full instructions"
