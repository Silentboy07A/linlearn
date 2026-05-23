import os
import json
import torch
import faiss
import numpy as np
from sentence_transformers import SentenceTransformer
from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline

class LocalRAGPipeline:
    """
    Combines FAISS semantic search retrieval and local Small Language Model (SLM)
    generation to answer user queries with citations and rolling conversation history.
    """
    def __init__(self, 
                 model_id: str = "TinyLlama/TinyLlama-1.1B-Chat-v1.0", 
                 embedding_model_name: str = "sentence-transformers/all-MiniLM-L6-v2",
                 index_dir: str = "data/faiss_index",
                 device: str = None):
        """
        Args:
            model_id (str): Hugging Face model identifier for the SLM.
            embedding_model_name (str): SentenceTransformers model name.
            index_dir (str): Directory containing FAISS index.
            device (str): Device to use ('cpu', 'cuda', 'mps'). If None, auto-detected.
        """
        # Determine device
        if device is None:
            if torch.cuda.is_available():
                self.device = "cuda"
            elif torch.backends.mps.is_available():
                self.device = "mps"
            else:
                self.device = "cpu"
        else:
            self.device = device
            
        print(f"RAG Pipeline running on device: {self.device}")
        
        # Load Embedding Model
        self.embedding_model = SentenceTransformer(embedding_model_name, device=self.device)
        self.dimension = self.embedding_model.get_sentence_embedding_dimension()
        
        # Load FAISS vector store
        self.index_dir = index_dir
        self.index = None
        self.metadata = []
        self.load_vector_db()

        # Load tokenizer and base SLM
        print(f"Loading SLM: {model_id}...")
        self.tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        
        # Setup precision according to device constraints
        # FP16/BF16 is perfect for GPU, but CPU works best with Float32 or dynamic int8 quantization
        if self.device == "cuda":
            self.base_model = AutoModelForCausalLM.from_pretrained(
                model_id, 
                torch_dtype=torch.float16, 
                device_map="auto",
                trust_remote_code=True
            )
        else:
            self.base_model = AutoModelForCausalLM.from_pretrained(
                model_id, 
                torch_dtype=torch.float32, 
                device_map=self.device,
                trust_remote_code=True
            )
            
        # PEFT model wrapper reference (initially None, wrapped if LoRA is loaded)
        self.model = self.base_model
        self.current_adapter_path = None
        print("SLM Model loaded successfully.")

    def load_vector_db(self):
        """Loads FAISS index binary and metadata mapping JSON from disk."""
        index_path = os.path.join(self.index_dir, "index.faiss")
        metadata_path = os.path.join(self.index_dir, "metadata.json")
        
        if os.path.exists(index_path) and os.path.exists(metadata_path):
            try:
                self.index = faiss.read_index(index_path)
                with open(metadata_path, "r", encoding="utf-8") as f:
                    self.metadata = json.load(f)
                print(f"Successfully loaded vector DB index with {self.index.ntotal} chunks.")
            except Exception as e:
                print(f"Error loading vector DB index: {e}")
                self.index = None
                self.metadata = []
        else:
            print("No vector DB found. Ingestion will be required before context retrieval.")
            self.index = None
            self.metadata = []

    def retrieve(self, query: str, top_k: int = 3) -> list:
        """
        Retrieves top_k context chunks from FAISS index that match the query.
        
        Returns:
            list: List of dicts containing 'text' and 'metadata' (source, page).
        """
        if self.index is None or len(self.metadata) == 0:
            print("Vector DB is empty or not loaded. Returning empty retrieval.")
            return []
            
        # Encode user query
        query_vector = self.embedding_model.encode([query], convert_to_numpy=True)
        faiss.normalize_L2(query_vector)
        
        # Search index
        scores, indices = self.index.search(query_vector, top_k)
        
        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx != -1 and idx < len(self.metadata):
                chunk = self.metadata[idx]
                results.append({
                    "text": chunk["text"],
                    "metadata": chunk["metadata"],
                    "score": float(score)
                })
        return results

    def load_lora_adapters(self, adapter_path: str):
        """
        Loads PEFT/LoRA adapters and wraps the base model.
        
        Args:
            adapter_path (str): Local path containing adapter weights.
        """
        if not adapter_path:
            # Revert to base model
            self.model = self.base_model
            self.current_adapter_path = None
            print("Unloaded adapter. Restored base model.")
            return
            
        from peft import PeftModel
        try:
            print(f"Loading LoRA adapter from {adapter_path}...")
            self.model = PeftModel.from_pretrained(
                self.base_model,
                adapter_path,
                device_map="auto" if self.device == "cuda" else { "": self.device }
            )
            self.current_adapter_path = adapter_path
            print("LoRA adapter loaded and integrated.")
        except Exception as e:
            print(f"Failed to load LoRA adapter: {e}")
            self.model = self.base_model
            self.current_adapter_path = None

    def generate_response(self, 
                          query: str, 
                          conversation_history: list = None,
                          top_k: int = 3, 
                          temperature: float = 0.3,
                          max_new_tokens: int = 512,
                          use_lora: bool = False,
                          adapter_path: str = None) -> tuple:
        """
        Performs full RAG flow: retrieval, prompt crafting, and text generation.
        
        Returns:
            tuple: (generated_text, citations_list, retrieved_chunks)
        """
        # Toggle LoRA state
        if use_lora and adapter_path:
            if self.current_adapter_path != adapter_path:
                self.load_lora_adapters(adapter_path)
        else:
            if self.current_adapter_path is not None:
                self.load_lora_adapters(None)

        # 1. Retrieval
        retrieved_chunks = self.retrieve(query, top_k=top_k)
        
        # 2. Extract citations
        citations = []
        context_str = ""
        for i, chunk in enumerate(retrieved_chunks):
            src = chunk["metadata"].get("source", "Unknown")
            pg = chunk["metadata"].get("page", 1)
            citation_label = f"Source {i+1}: {src} (Page {pg})"
            citations.append({
                "label": citation_label,
                "text": chunk["text"]
            })
            context_str += f"--- {citation_label} ---\n{chunk['text']}\n\n"

        if not context_str:
            context_str = "No specific documentation context was found in the database."

        # 3. Construct System Prompt & Messages
        system_instruction = (
            "You are a helpful, local Linux learning and troubleshooting assistant.\n"
            "Use the provided context sections and conversation history to answer the user's question accurately.\n"
            "If the context doesn't contain enough information to answer, explain that but offer general Linux knowledge while making it clear it is not from the uploaded docs.\n"
            "Format your answer cleanly with code blocks, terminal commands, and clear explanations."
        )

        messages = [{"role": "system", "content": system_instruction}]

        # Add conversation history
        if conversation_history:
            messages.extend(conversation_history)

        # Add current query with context
        user_prompt = (
            f"Here is the context retrieved from local Linux documents:\n"
            f"{context_str}\n"
            f"User Question: {query}\n"
            f"Provide a clear answer with citations (e.g. referencing [Source 1] when using information from that chunk):"
        )
        messages.append({"role": "user", "content": user_prompt})

        # 4. Generate
        try:
            # Use tokenizer chat template if available, else format manually
            prompt_str = self.tokenizer.apply_chat_template(
                messages, 
                tokenize=False, 
                add_generation_prompt=True
            )
        except Exception:
            # Fallback formatting if chat template fails
            prompt_str = f"System: {system_instruction}\n"
            if conversation_history:
                for msg in conversation_history:
                    prompt_str += f"{msg['role'].capitalize()}: {msg['content']}\n"
            prompt_str += f"User: {user_prompt}\nAssistant:"

        inputs = self.tokenizer(prompt_str, return_tensors="pt").to(self.device)
        
        with torch.no_grad():
            output_ids = self.model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=temperature if temperature > 0.05 else 0.05,
                do_sample=True if temperature > 0.05 else False,
                pad_token_id=self.tokenizer.eos_token_id,
                eos_token_id=self.tokenizer.eos_token_id
            )
            
        # Decode only the newly generated tokens
        input_len = inputs["input_ids"].shape[1]
        generated_tokens = output_ids[0][input_len:]
        response_text = self.tokenizer.decode(generated_tokens, skip_special_tokens=True).strip()

        return response_text, citations, retrieved_chunks
