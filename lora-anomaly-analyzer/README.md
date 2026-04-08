---
library_name: peft
license: llama3.2
base_model: meta-llama/Llama-3.2-1B-Instruct
tags:
- generated_from_trainer
datasets:
- /data/data/training-data-combined.jsonl
model-index:
- name: data/lora-anomaly-analyzer
  results: []
---

<!-- This model card has been generated automatically according to the information the Trainer had access to. You
should probably proofread and complete it, then remove this comment. -->

[<img src="https://raw.githubusercontent.com/axolotl-ai-cloud/axolotl/main/image/axolotl-badge-web.png" alt="Built with Axolotl" width="200" height="32"/>](https://github.com/axolotl-ai-cloud/axolotl)
<details><summary>See axolotl config</summary>

axolotl version: `0.11.0.dev0`
```yaml
# Axolotl LoRA Fine-tuning Config for Anomaly Analyzer
# 
# Train a specialized model for crypto exchange anomaly analysis.
# Based on Llama 3.2 1B - small enough for fast inference, trainable on consumer GPUs.

base_model: meta-llama/Llama-3.2-1B-Instruct
model_type: AutoModelForCausalLM
tokenizer_type: AutoTokenizer

# Use Llama 3 chat template — critical for instruction-following
chat_template: llama3

# Llama 3.2 lacks a pad token — use the built-in finetune pad token
special_tokens:
  pad_token: "<|finetune_right_pad_id|>"

# Use 8-bit quantization for memory efficiency
load_in_8bit: true

# LoRA Configuration
adapter: lora
lora_r: 16
lora_alpha: 32
lora_dropout: 0.05
lora_target_modules:
  - q_proj
  - v_proj
  - k_proj
  - o_proj
  - gate_proj
  - up_proj
  - down_proj

# Dataset
datasets:
  - path: /data/data/training-data-combined.jsonl
    type: alpaca

# Output
output_dir: /data/lora-anomaly-analyzer
dataset_prepared_path: /data/last_run_prepared

# Training Configuration
micro_batch_size: 2
gradient_accumulation_steps: 4
num_epochs: 5
learning_rate: 2e-4
lr_scheduler: cosine
warmup_ratio: 0.1
weight_decay: 0.01

# Optimizer
optimizer: adamw_torch
adam_beta1: 0.9
adam_beta2: 0.999

# Validation (5% held out for eval loss monitoring)
val_set_size: 0.05

# Logging
logging_steps: 10
save_steps: 100

# Mixed precision
bf16: auto
tf32: false

# Sequence length (our prompts can be long)
sequence_len: 2048
sample_packing: false

# Gradient checkpointing for memory
gradient_checkpointing: true

# Reproducibility
seed: 42

```

</details><br>

# data/lora-anomaly-analyzer

This model is a fine-tuned version of [meta-llama/Llama-3.2-1B-Instruct](https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct) on the /data/data/training-data-combined.jsonl dataset.

## Model description

More information needed

## Intended uses & limitations

More information needed

## Training and evaluation data

More information needed

## Training procedure

### Training hyperparameters

The following hyperparameters were used during training:
- learning_rate: 0.0002
- train_batch_size: 2
- eval_batch_size: 2
- seed: 42
- gradient_accumulation_steps: 4
- total_train_batch_size: 8
- optimizer: Use OptimizerNames.ADAMW_TORCH with betas=(0.9,0.999) and epsilon=1e-08 and optimizer_args=No additional optimizer arguments
- lr_scheduler_type: cosine
- lr_scheduler_warmup_steps: 6
- training_steps: 60

### Training results



### Framework versions

- PEFT 0.15.2
- Transformers 4.52.4
- Pytorch 2.6.0+cu124
- Datasets 3.6.0
- Tokenizers 0.21.1