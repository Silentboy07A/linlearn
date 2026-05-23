import numpy as np
from sentence_transformers import SentenceTransformer

class RAGEvaluator:
    """
    Evaluates RAG pipeline quality (Context Relevance and Groundedness/Faithfulness)
    fully locally using sentence embeddings and text overlap.
    """
    def __init__(self, embedding_model: SentenceTransformer = None):
        """
        Args:
            embedding_model (SentenceTransformer): Reuses the embedding model from the pipeline.
        """
        if embedding_model is None:
            self.embed_model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        else:
            self.embed_model = embedding_model

    def evaluate_context_relevance(self, query: str, retrieved_chunks: list) -> float:
        """
        Measures how semantically relevant the retrieved chunks are to the user's query.
        Calculates the mean cosine similarity between the query and all retrieved chunks.
        
        Returns:
            float: Score between 0.0 (unrelated) and 1.0 (highly relevant).
        """
        if not retrieved_chunks:
            return 0.0
            
        # Embed query and chunks
        query_emb = self.embed_model.encode([query], convert_to_numpy=True)
        chunk_texts = [chunk["text"] for chunk in retrieved_chunks]
        chunk_embs = self.embed_model.encode(chunk_texts, convert_to_numpy=True)
        
        # Calculate cosine similarities
        query_norm = query_emb / np.linalg.norm(query_emb, axis=1, keepdims=True)
        chunk_norms = chunk_embs / np.linalg.norm(chunk_embs, axis=1, keepdims=True)
        
        similarities = np.dot(chunk_norms, query_norm.T).flatten()
        return float(np.mean(similarities))

    def evaluate_faithfulness(self, response: str, retrieved_chunks: list) -> float:
        """
        Measures the groundedness of the generated response in the retrieved context.
        Checks if the claims in the response are semantically matched by the retrieved chunks.
        Splits response into sentences, embeds each, and matches against context chunk embeddings.
        
        Returns:
            float: Groundedness score between 0.0 (possible hallucination) and 1.0 (fully grounded).
        """
        if not retrieved_chunks:
            # If no context was retrieved, faithfulness is not applicable (or 0.0 if response is generated)
            return 0.0
            
        if not response.strip():
            return 1.0

        # Split response into sentences
        sentences = [s.strip() for s in response.split(".") if len(s.strip()) > 8]
        if not sentences:
            sentences = [response]

        # Embed sentences and retrieved chunks
        sentence_embs = self.embed_model.encode(sentences, convert_to_numpy=True)
        chunk_texts = [chunk["text"] for chunk in retrieved_chunks]
        chunk_embs = self.embed_model.encode(chunk_texts, convert_to_numpy=True)

        # Normalize for cosine similarity
        sentence_norms = sentence_embs / np.linalg.norm(sentence_embs, axis=1, keepdims=True)
        chunk_norms = chunk_embs / np.linalg.norm(chunk_embs, axis=1, keepdims=True)

        # For each sentence in response, find the maximum similarity with any context chunk
        grounded_sentences = 0
        for sent_norm in sentence_norms:
            similarities = np.dot(chunk_norms, sent_norm)
            max_sim = np.max(similarities)
            # Threshold of 0.60 indicates strong semantic grounding in mini-LM space
            if max_sim >= 0.60:
                grounded_sentences += 1

        score = grounded_sentences / len(sentences)
        return float(score)

    def run_eval(self, query: str, response: str, retrieved_chunks: list) -> dict:
        """Runs the full local evaluation suite and returns metrics."""
        relevance = self.evaluate_context_relevance(query, retrieved_chunks)
        faithfulness = self.evaluate_faithfulness(response, retrieved_chunks)
        
        # Determine RAG Quality Label
        status = "Good"
        if relevance < 0.35:
            status = "Low Retrieval Relevance (Check indexing or chunk size)"
        elif faithfulness < 0.60:
            status = "Potential Hallucination / Low Grounding"
            
        return {
            "context_relevance": round(relevance, 3),
            "faithfulness": round(faithfulness, 3),
            "status": status
        }
