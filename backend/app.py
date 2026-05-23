import os
import shutil
import gradio as gr
from backend.api import LocalLinuxAssistantAPI
from backend.memory import ConversationMemory

# Define global configuration
DEFAULT_MODEL = "TinyLlama/TinyLlama-1.1B-Chat-v1.0"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

print("Initializing Local Linux Assistant API...")
assistant_api = LocalLinuxAssistantAPI(
    model_id=DEFAULT_MODEL,
    embedding_model=EMBEDDING_MODEL
)

# Global conversation memory store, keyed by session ID or just single session for simplicity
session_memory = ConversationMemory(max_turns=5)

def chatbot_respond(message, chat_history, top_k, temperature, use_lora, adapter_path):
    """
    Handles queries from the Gradio chatbot interface.
    """
    if not message.strip():
        return "", chat_history, "", "No query entered."

    # Format Gradio history for our backend API
    # Gradio history is list of lists: [[user_msg1, assistant_msg1], [user_msg2, assistant_msg2]]
    formatted_history = []
    for user_msg, assist_msg in chat_history:
        if user_msg:
            formatted_history.append({"role": "user", "content": user_msg})
        if assist_msg:
            formatted_history.append({"role": "assistant", "content": assist_msg})

    # Display a processing message
    try:
        # Run query
        result = assistant_api.query(
            user_query=message,
            history_list=formatted_history,
            top_k=int(top_k),
            temperature=float(temperature),
            use_lora=use_lora,
            adapter_path=adapter_path if use_lora else None
        )
        
        response = result["response"]
        citations = result["citations"]
        eval_metrics = result["evaluation"]
        
        # Format citations markdown
        citations_markdown = "### 📚 Retrieved Context & Sources\n\n"
        if not citations:
            citations_markdown += "*No local documents were retrieved for this query. Generative response is based on model's internal training weights.*"
        else:
            for cit in citations:
                citations_markdown += f"**{cit['label']}**\n> {cit['text']}\n\n"

        # Format evaluation stats
        eval_markdown = f"### 📊 RAG Quality metrics (Local Embeddings)\n"
        eval_markdown += f"- **Context Relevance:** `{eval_metrics.get('context_relevance', 0.0)}` (Cosine similarity of query to docs)\n"
        eval_markdown += f"- **Faithfulness/Groundedness:** `{eval_metrics.get('faithfulness', 0.0)}` (Response claims matching context)\n"
        eval_markdown += f"- **Status:** *{eval_metrics.get('status', 'Unrated')}*\n"
        
        # Add to Gradio history
        chat_history.append((message, response))
        
        return "", chat_history, citations_markdown, eval_markdown
        
    except Exception as e:
        import traceback
        error_msg = f"An error occurred: {str(e)}\n\n{traceback.format_exc()}"
        chat_history.append((message, "I encountered an error trying to process your request. Please ensure the model is downloaded and check server logs."))
        return "", chat_history, "Error retrieving context.", error_msg

def clear_chat():
    """Clears chatbot history."""
    session_memory.clear()
    return [], "Citations cleared.", "Evaluation metrics cleared."

def upload_and_ingest(files):
    """
    Receives files from Gradio, saves them to the local docs directory,
    and runs the ingestion pipeline to build/update the FAISS index.
    """
    if not files:
        return "No files selected."
        
    docs_dir = assistant_api.docs_dir
    os.makedirs(docs_dir, exist_ok=True)
    
    saved_files = []
    for file_temp in files:
        # Gradio temp file path
        temp_path = file_temp.name
        filename = os.path.basename(temp_path)
        dest_path = os.path.join(docs_dir, filename)
        
        # Copy to local docs directory
        shutil.copy(temp_path, dest_path)
        saved_files.append(filename)
        
    print(f"Copied {len(saved_files)} files to {docs_dir}")
    
    # Run ingestion
    try:
        num_chunks = assistant_api.ingest_new_documents()
        return f"Successfully ingested {len(saved_files)} files!\nFiles loaded: {', '.join(saved_files)}\nSplit into {num_chunks} vector chunks inside FAISS."
    except Exception as e:
        return f"Ingestion failed: {str(e)}"

# Custom CSS for modern visual design
custom_css = """
body {
    background-color: #0b0f19;
    color: #f3f4f6;
    font-family: 'Outfit', 'Inter', -apple-system, sans-serif;
}
.gradio-container {
    max-width: 1200px !important;
    margin: 0 auto !important;
}
.sidebar-panel {
    background: rgba(17, 24, 39, 0.7) !important;
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 12px !important;
}
.main-header {
    text-align: center;
    margin-bottom: 2rem;
    padding: 1.5rem;
    background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
    border-radius: 16px;
    border: 1px solid rgba(99, 102, 241, 0.2);
}
.main-header h1 {
    color: #818cf8 !important;
    font-size: 2.2rem !important;
    font-weight: 800 !important;
    margin: 0;
}
.main-header p {
    color: #9ca3af !important;
    margin-top: 0.5rem;
}
.footer-text {
    text-align: center;
    font-size: 0.85rem;
    color: #6b7280;
    margin-top: 2rem;
}
"""

# Build Gradio UI with tabs
with gr.Blocks(theme=gr.themes.Soft(primary_hue="indigo", secondary_hue="slate"), css=custom_css, title="Linux Learning Assistant") as demo:
    
    # Header
    gr.HTML(
        "<div class='main-header'>"
        "<h1>🐧 Local Linux Learning & Troubleshooting Assistant</h1>"
        "<p>Fully offline domain-specific RAG system utilizing FAISS and Small Language Models (SLMs).</p>"
        "</div>"
    )
    
    with gr.Tabs() as tabs:
        # Tab 1: Chat Assistant
        with gr.Tab("💬 Chat Assistant"):
            with gr.Row():
                # Left Column: Configuration Sidebar
                with gr.Column(scale=3, elem_classes="sidebar-panel"):
                    gr.Markdown("### ⚙️ Generation Controls")
                    top_k = gr.Slider(minimum=1, maximum=7, value=3, step=1, label="Retrieve Top-K Chunks")
                    temperature = gr.Slider(minimum=0.0, maximum=1.0, value=0.2, step=0.1, label="Sampling Temperature")
                    
                    gr.Markdown("---")
                    gr.Markdown("### 🧠 PEFT/LoRA Adapters")
                    use_lora = gr.Checkbox(label="Enable LoRA Adapter", value=False)
                    adapter_path_input = gr.Textbox(
                        label="Adapter Weights Directory Path", 
                        placeholder="e.g., models/adapters/linux_assistant_lora",
                        value="models/adapters/linux_assistant_lora"
                    )
                    
                    gr.Markdown("---")
                    gr.Markdown("### 📂 Ingested System Info")
                    info_box = gr.Markdown("No vector store loaded yet. Add documents via the Ingestion tab.")
                    
                    def check_db_status():
                        if os.path.exists(assistant_api.index_dir) and os.listdir(assistant_api.index_dir):
                            # Try to query number of chunks
                            if assistant_api.pipeline is None:
                                assistant_api.load_pipeline()
                            if assistant_api.pipeline and assistant_api.pipeline.index:
                                count = assistant_api.pipeline.index.ntotal
                                return f"✅ Vector DB active: **{count} chunks** loaded."
                        return "❌ No active Vector DB found. Ingest files to start."
                    
                    demo.load(check_db_status, outputs=[info_box])
                    
                # Right Column: Chat window and context output
                with gr.Column(scale=9):
                    chatbot = gr.Chatbot(height=450, bubble_full_width=False)
                    with gr.Row():
                        user_input = gr.Textbox(
                            show_label=False,
                            placeholder="Ask a Linux topic (e.g. 'how to debug oom memory exhaustion?', 'list files recursively')...",
                            scale=9
                        )
                        submit_btn = gr.Button("Send", variant="primary", scale=1)
                        
                    with gr.Row():
                        clear_btn = gr.Button("Clear History", variant="secondary")
                        
                    # Panels for citations and evaluations
                    with gr.Accordion("📎 References & Quality Metrics", open=True):
                        with gr.Row():
                            with gr.Column(scale=1):
                                citations_panel = gr.Markdown(
                                    "### 📚 Retrieved Context & Sources\n\n*References will appear here once you query.*"
                                )
                            with gr.Column(scale=1):
                                eval_panel = gr.Markdown(
                                    "### 📊 RAG Quality metrics\n\n*Evaluation scores will appear here.*"
                                )

            # Wire chatbot actions
            submit_btn.click(
                chatbot_respond, 
                inputs=[user_input, chatbot, top_k, temperature, use_lora, adapter_path_input], 
                outputs=[user_input, chatbot, citations_panel, eval_panel]
            )
            user_input.submit(
                chatbot_respond, 
                inputs=[user_input, chatbot, top_k, temperature, use_lora, adapter_path_input], 
                outputs=[user_input, chatbot, citations_panel, eval_panel]
            )
            clear_btn.click(
                clear_chat,
                outputs=[chatbot, citations_panel, eval_panel]
            )
            
        # Tab 2: Document Ingestion
        with gr.Tab("📂 Ingestion Manager"):
            gr.Markdown("## 📁 Ingest Local Linux Textbooks, Manuals, or PDFs")
            gr.Markdown("Drop your `.pdf`, `.txt`, or `.md` files below. They will be chunked, embedded, and appended to the local FAISS index instantly.")
            
            with gr.Row():
                file_uploader = gr.File(
                    file_count="multiple", 
                    file_types=[".pdf", ".txt", ".md"], 
                    label="Choose Documents"
                )
            
            ingest_btn = gr.Button("🔥 Run Ingestion & Update FAISS DB", variant="primary")
            ingestion_log = gr.Textbox(label="Ingestion Logs", value="Ready to process documents...", interactive=False, lines=5)
            
            # Action connection
            ingest_btn.click(
                upload_and_ingest,
                inputs=[file_uploader],
                outputs=[ingestion_log]
            ).then(
                check_db_status,
                outputs=[info_box]
            )
            
        # Tab 3: System Status & Quantization Guide
        with gr.Tab("⚙️ System Status & Hardware Guide"):
            gr.Markdown("## ⚙️ Model Setup & Hardware Guidelines")
            
            with gr.Row():
                gr.Markdown(
                    "### 🖥️ Local Execution Options\n"
                    "Since this application runs fully offline, model choice dictates performance and speed:\n"
                    "1. **Qwen/Qwen2.5-0.5B-Instruct** (Default): ~900MB weights. Fits easily on 8GB RAM laptops, running fast on CPU.\n"
                    "2. **Qwen/Qwen2.5-1.5B-Instruct**: ~3GB weights. High quality answers for CPU and consumer GPUs.\n"
                    "3. **microsoft/Phi-3-mini-4k-instruct**: ~7.6GB weights. Requires 16GB+ RAM if loaded in Float32 on CPU.\n"
                )
                
                gr.Markdown(
                    "### 📦 CPU vs GPU Quantization Options\n"
                    "- **CPU (No CUDA):** Quantization via Hugging Face `bitsandbytes` requires CUDA. On CPU-only environments (like the free Hugging Face Space), use lightweight models (0.5B or 1.5B) loaded directly in Float32 or Float16.\n"
                    "- **GPU (CUDA):** Load models in 4-bit using `bitsandbytes` by adding `load_in_4bit=True` to the model configuration in `rag_pipeline.py` for maximum speed and minimum VRAM usage."
                )

    gr.HTML("<div class='footer-text'>Linux Learning RAG Assistant — Made for Offline Deployment & Hugging Face Spaces.</div>")

if __name__ == "__main__":
    # Pre-load pipeline model on startup
    print("Pre-loading base SLM to cache...")
    assistant_api.load_pipeline()
    
    # Launch Gradio interface (listens on 7860 by default for Hugging Face Spaces)
    # share=False for offline, can set share=True to generate public link
    demo.queue().launch(server_name="0.0.0.0", server_port=7860, share=False)
