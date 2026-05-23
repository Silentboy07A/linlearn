import os
from .ingest import run_ingest
from .rag_pipeline import LocalRAGPipeline
from .memory import ConversationMemory
from .evaluate import RAGEvaluator

class LocalLinuxAssistantAPI:
    """
    Unified API for the Local Linux Learning Assistant.
    Orchestrates ingestion, retrieval, generation, evaluation, and memory.
    """
    def __init__(self, 
                 model_id: str = "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
                 embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2",
                 index_dir: str = "data/faiss_index",
                 docs_dir: str = "docs"):
        """Initializes the backend configuration and local resources."""
        self.model_id = model_id
        self.embedding_model = embedding_model
        
        # Absolute path resolution
        self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.index_dir = os.path.join(self.base_dir, index_dir)
        self.docs_dir = os.path.join(self.base_dir, docs_dir)
        
        # Initialize sub-modules
        self.pipeline = None
        self.evaluator = None
        
        # Create directories
        os.makedirs(self.index_dir, exist_ok=True)
        os.makedirs(self.docs_dir, exist_ok=True)

    def load_pipeline(self) -> bool:
        """Loads or reloads the RAG pipeline resources."""
        try:
            self.pipeline = LocalRAGPipeline(
                model_id=self.model_id,
                embedding_model_name=self.embedding_model,
                index_dir=self.index_dir
            )
            self.evaluator = RAGEvaluator(embedding_model=self.pipeline.embedding_model)
            return True
        except Exception as e:
            print(f"Error loading RAG pipeline: {e}")
            return False

    def ingest_new_documents(self) -> int:
        """Runs the ingestion pipeline over files currently in the docs folder."""
        print(f"Ingesting documents from {self.docs_dir} to {self.index_dir}...")
        chunks = run_ingest(
            docs_dir=self.docs_dir,
            index_dir=self.index_dir,
            embedding_model=self.embedding_model
        )
        # Reload vector store inside pipeline if active
        if self.pipeline:
            self.pipeline.load_vector_db()
        return len(chunks)

    def query(self, 
              user_query: str, 
              history_list: list = None,
              top_k: int = 3, 
              temperature: float = 0.3,
              use_lora: bool = False,
              adapter_path: str = None) -> dict:
        """
        Processes a user query by retrieving context, generating an answer,
        and running quality evaluation.
        
        Args:
            user_query (str): The question asked.
            history_list (list): Existing conversation history array of dicts.
            top_k (int): Number of context chunks to fetch.
            temperature (float): SLM sampling temperature.
            use_lora (bool): Toggle PEFT/LoRA adapter logic.
            adapter_path (str): Filepath to LoRA adapter weights.
            
        Returns:
            dict: { 'response': str, 'citations': list, 'evaluation': dict }
        """
        if self.pipeline is None:
            loaded = self.load_pipeline()
            if not loaded:
                return {
                    "response": "Error: Base model failed to initialize. Please check hardware resource allocation.",
                    "citations": [],
                    "evaluation": {}
                }

        # Generate response using pipeline
        response, citations, retrieved_chunks = self.pipeline.generate_response(
            query=user_query,
            conversation_history=history_list,
            top_k=top_k,
            temperature=temperature,
            use_lora=use_lora,
            adapter_path=adapter_path
        )
        
        # Evaluate response quality
        eval_results = self.evaluator.run_eval(
            query=user_query,
            response=response,
            retrieved_chunks=retrieved_chunks
        )
        
        return {
            "response": response,
            "citations": citations,
            "evaluation": eval_results
        }
