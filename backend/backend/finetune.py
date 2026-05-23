import os
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM, TrainingArguments
from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training
from trl import SFTTrainer
from datasets import Dataset

def prepare_dummy_linux_dataset():
    """Generates a small dummy dataset for Linux commands fine-tuning."""
    # Training data should follow the instruction/response format
    data = {
        "text": [
            "### Instruction: How do you list files in reverse time order? \n### Response: Use the command 'ls -ltr' to list all files sorted by modification time in reverse order (newest at the bottom) with details.",
            "### Instruction: What command shows real-time disk I/O statistics? \n### Response: You can monitor disk I/O using the 'iotop' or 'iostat -xz 1' commands to watch disk usage in real time.",
            "### Instruction: How do you search for text patterns inside files recursively? \n### Response: Use 'grep -rn \"pattern\" /path/to/search/' to recursively look for the pattern, displaying line numbers.",
            "### Instruction: How do you check memory buffers and cache size? \n### Response: Use 'free -m' or inspect '/proc/meminfo' to see detailed kernel memory buffers, cache, and active RAM allocation.",
            "### Instruction: How do you force terminate a frozen process by name? \n### Response: Use 'pkill -9 process_name' or 'killall -9 process_name' to send the SIGKILL signal to all processes matching that name."
        ]
    }
    return Dataset.from_dict(data)

def train_lora_adapter(
    model_id: str = "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
    output_dir: str = "../models/adapters/linux_assistant_lora",
    epochs: int = 3,
    batch_size: int = 1
):
    """
    Fine-tunes a base SLM using LoRA adapters on a domain-specific dataset.
    """
    print(f"Initializing LoRA fine-tuning for {model_id}...")
    
    # 1. Load tokenizer and base model
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading model on {device}...")
    
    # PEFT 4-bit / low RAM setups
    if device == "cuda":
        # Can utilize quantization for training locally on low-VRAM GPUs (QLoRA)
        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype=torch.float16,
            device_map="auto",
            trust_remote_code=True
        )
        model = prepare_model_for_kbit_training(model)
    else:
        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype=torch.float32,
            device_map={"": device},
            trust_remote_code=True
        )

    # 2. Configure PEFT / LoRA
    # r = Rank of adapter (8 or 16 is standard for SLMs)
    # target_modules target the Q/V matrices in Self-Attention layers
    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        target_modules=["q_proj", "v_proj", "k_proj", "o_proj"], 
        lora_dropout=0.05,
        bias="none",
        task_type=TaskType.CAUSAL_LM
    )
    
    model = get_peft_model(model, lora_config)
    print("PEFT LoRA parameters configured:")
    model.print_trainable_parameters()

    # 3. Load Dataset
    dataset = prepare_dummy_linux_dataset()
    print(f"Loaded training dataset with {len(dataset)} examples.")

    # 4. Set up Training Arguments
    training_args = TrainingArguments(
        output_dir=output_dir,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=4,
        learning_rate=2e-4,
        logging_steps=1,
        num_train_epochs=epochs,
        weight_decay=0.01,
        evaluation_strategy="no",
        save_strategy="no",
        fp16=(device == "cuda"),
        bf16=False,
        report_to="none"  # Prevents wandb logging prompts
    )

    # 5. Initialize SFTTrainer
    trainer = SFTTrainer(
        model=model,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=512,
        tokenizer=tokenizer,
        args=training_args
    )

    # 6. Run Training
    print("Starting SFT training loop...")
    trainer.train()
    
    # 7. Save Adapter weights
    print(f"Saving fine-tuned LoRA adapters to: {output_dir}")
    os.makedirs(output_dir, exist_ok=True)
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    print("Fine-tuning completed successfully!")

if __name__ == "__main__":
    # Ensure folder paths exist relative to backend
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    adapter_output_dir = os.path.join(base_dir, "models", "adapters", "linux_assistant_lora")
    
    train_lora_adapter(
        model_id="TinyLlama/TinyLlama-1.1B-Chat-v1.0",
        output_dir=adapter_output_dir,
        epochs=3,
        batch_size=1
    )
