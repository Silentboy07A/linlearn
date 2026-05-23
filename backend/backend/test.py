import os
import sys

# Ensure backend package can be imported
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api import LocalLinuxAssistantAPI

def main():
    print("=== Start Local Linux Assistant Verification ===")
    
    # 1. Initialize API wrapper
    # Using Qwen 0.5B-Instruct for quick execution/low RAM footprint in testing
    api = LocalLinuxAssistantAPI(
        model_id="TinyLlama/TinyLlama-1.1B-Chat-v1.0",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        index_dir="data/faiss_index",
        docs_dir="docs"
    )
    
    # Create sample document for RAG verification
    os.makedirs(api.docs_dir, exist_ok=True)
    sample_file = os.path.join(api.docs_dir, "linux_permissions.md")
    
    with open(sample_file, "w", encoding="utf-8") as f:
        f.write(
            "# Linux Permissions Guide\n\n"
            "File permissions in Linux are managed using user (u), group (g), and others (o).\n"
            "The command 'chmod' (change mode) is used to modify file permissions.\n"
            "Numeric modes use octal values: 4 for read (r), 2 for write (w), and 1 for execute (x).\n"
            "For example, 'chmod 755 script.sh' gives the owner read, write, and execute permissions (7 = 4+2+1),\n"
            "while group and others get read and execute permissions (5 = 4+1).\n"
            "Use 'chown' to modify file ownership, and 'chgrp' to modify group ownership.\n"
        )
    print(f"Created test guide at {sample_file}")

    # 2. Ingest document
    print("\nStarting Ingestion...")
    num_chunks = api.ingest_new_documents()
    print(f"Ingested {num_chunks} chunks into FAISS index.")

    # 3. Load pipeline (downloading model if needed, otherwise loaded from cache)
    print("\nLoading local SLM model...")
    success = api.load_pipeline()
    if not success:
        print("Failed to load RAG pipeline!")
        return

    # 4. Query RAG
    test_query = "How does chmod 755 work and what do the numbers represent?"
    print(f"\nSending Query: '{test_query}'")
    
    result = api.query(
        user_query=test_query,
        history_list=[],
        top_k=2,
        temperature=0.2
    )

    # 5. Output results
    print("\n=== Pipeline Output ===")
    print(f"Response:\n{result['response']}\n")
    
    print("Citations:")
    for cit in result["citations"]:
        print(f"- {cit['label']}")
        
    print("\nEvaluation Metrics:")
    for metric, value in result["evaluation"].items():
        print(f"- {metric}: {value}")
        
    print("\n=== Verification Successful! ===")

if __name__ == "__main__":
    main()
