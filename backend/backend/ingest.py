import os
import json
import numpy as np
from pypdf import PdfReader
from sentence_transformers import SentenceTransformer
import faiss

class LocalDocumentIngestor:
    """
    Ingests text, markdown, and PDF documents, chunks them, 
    creates embeddings, and stores them in a local FAISS index.
    """
    def __init__(self, embedding_model_name: str = "sentence-transformers/all-MiniLM-L6-v2", device: str = "cpu"):
        """
        Args:
            embedding_model_name (str): Local HuggingFace embedding model name.
            device (str): Device to run embeddings on ('cpu' or 'cuda').
        """
        print(f"Loading embedding model '{embedding_model_name}' on {device}...")
        self.embed_model = SentenceTransformer(embedding_model_name, device=device)
        self.dimension = self.embed_model.get_sentence_embedding_dimension()
        print(f"Embedding model loaded. Embedding dimension: {self.dimension}")

    def load_pdf(self, file_path: str) -> list:
        """Parses a PDF file and returns list of dicts containing page content and page number."""
        chunks = []
        try:
            reader = PdfReader(file_path)
            source_name = os.path.basename(file_path)
            for page_idx, page in enumerate(reader.pages):
                text = page.extract_text()
                if text and text.strip():
                    chunks.append({
                        "text": text.strip(),
                        "metadata": {
                            "source": source_name,
                            "page": page_idx + 1
                        }
                    })
        except Exception as e:
            print(f"Error reading PDF {file_path}: {e}")
        return chunks

    def load_text_or_md(self, file_path: str) -> list:
        """Parses a text or Markdown file and returns list containing page content."""
        chunks = []
        try:
            source_name = os.path.basename(file_path)
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            if content.strip():
                chunks.append({
                    "text": content.strip(),
                    "metadata": {
                        "source": source_name,
                        "page": 1
                    }
                })
        except Exception as e:
            print(f"Error reading file {file_path}: {e}")
        return chunks

    def split_into_chunks(self, documents: list, chunk_size: int = 600, overlap: int = 100) -> list:
        """
        Splits loaded document pages into smaller chunks with overlap.
        
        Args:
            documents (list): List of dicts with 'text' and 'metadata'.
            chunk_size (int): Max character length of each chunk.
            overlap (int): Number of characters to overlap between adjacent chunks.
        """
        final_chunks = []
        for doc in documents:
            text = doc["text"]
            meta = doc["metadata"]
            
            # Simple recursive-character split approximation using sliding window
            start = 0
            while start < len(text):
                end = start + chunk_size
                chunk_text = text[start:end].strip()
                
                if chunk_text:
                    final_chunks.append({
                        "text": chunk_text,
                        "metadata": {
                            "source": meta["source"],
                            "page": meta["page"],
                            "char_range": (start, min(end, len(text)))
                        }
                    })
                
                start += (chunk_size - overlap)
        return final_chunks

    def build_and_save_index(self, chunks: list, output_dir: str = "data/faiss_index"):
        """
        Generates embeddings for chunks, builds FAISS index, and saves to disk.
        """
        if not chunks:
            print("No chunks to index.")
            return

        os.makedirs(output_dir, exist_ok=True)
        texts = [c["text"] for c in chunks]
        
        print(f"Generating embeddings for {len(texts)} chunks...")
        embeddings = self.embed_model.encode(texts, show_progress_bar=True, convert_to_numpy=True)
        
        # Build IndexFlatIP (Inner Product/Cosine Similarity) with normalized embeddings
        faiss.normalize_L2(embeddings)
        index = faiss.IndexFlatIP(self.dimension)
        index.add(embeddings)
        
        # Save FAISS index binary
        index_path = os.path.join(output_dir, "index.faiss")
        faiss.write_index(index, index_path)
        
        # Save metadata mapping file
        metadata_path = os.path.join(output_dir, "metadata.json")
        metadata_store = [
            {"text": c["text"], "metadata": c["metadata"]} for c in chunks
        ]
        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata_store, f, indent=4, ensure_ascii=False)
            
        print(f"FAISS index and metadata successfully saved to: {output_dir}")

def run_ingest(docs_dir: str, index_dir: str, embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"):
    """Orchestrates document ingestion process."""
    ingestor = LocalDocumentIngestor(embedding_model_name=embedding_model, device="cpu")
    
    if not os.path.exists(docs_dir):
        os.makedirs(docs_dir, exist_ok=True)
        print(f"Created empty directory: {docs_dir}. Please place your PDFs, TXT, or MD files inside.")
        return []
        
    all_raw_docs = []
    for file_name in os.listdir(docs_dir):
        file_path = os.path.join(docs_dir, file_name)
        if file_name.endswith(".pdf"):
            print(f"Parsing PDF: {file_name}")
            all_raw_docs.extend(ingestor.load_pdf(file_path))
        elif file_name.endswith((".txt", ".md")):
            print(f"Parsing text/markdown file: {file_name}")
            all_raw_docs.extend(ingestor.load_text_or_md(file_path))
            
    print(f"Loaded {len(all_raw_docs)} document pages.")
    chunks = ingestor.split_into_chunks(all_raw_docs)
    print(f"Generated {len(chunks)} chunks.")
    
    if chunks:
        ingestor.build_and_save_index(chunks, index_dir)
    return chunks

if __name__ == "__main__":
    # Local CLI execution test
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    docs_folder = os.path.join(base_dir, "docs")
    data_folder = os.path.join(base_dir, "data", "faiss_index")
    
    # Create sample Linux troubleshooting file if docs folder is empty
    os.makedirs(docs_folder, exist_ok=True)
    sample_file = os.path.join(docs_folder, "linux_troubleshooting.txt")
    if not os.path.exists(sample_file):
        with open(sample_file, "w", encoding="utf-8") as sf:
            sf.write(
                "Linux Memory Troubleshooting Guide:\n"
                "When your Linux system runs out of memory, the Out-Of-Memory (OOM) killer kicks in to terminate processes to save the kernel.\n"
                "Use the 'free -m' command to check current RAM usage, buffer, and cache.\n"
                "Use 'top' or 'htop' to sort processes by CPU and memory consumption.\n"
                "If swap usage is high, it indicates that RAM is exhausted, and the OS is paging memory chunks to disk, leading to high system load.\n"
                "To check OOM occurrences, inspect system logs with command: dmesg -T | grep -i oom\n"
                "Alternatively, search /var/log/syslog or /var/log/messages for OOM killer logs.\n"
            )
        print(f"Created a sample troubleshooting file at: {sample_file}")
        
    run_ingest(docs_folder, data_folder)
