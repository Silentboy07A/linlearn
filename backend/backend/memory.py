class ConversationMemory:
    """
    Manages the rolling conversation history to keep chat context 
    without overflowing the Small Language Model's context window.
    """
    def __init__(self, max_turns: int = 5):
        """
        Args:
            max_turns (int): Maximum number of recent question-answer pairs to retain.
        """
        self.max_turns = max_turns
        self.history = []  # List of dicts with keys 'role' ('user' or 'assistant') and 'content'

    def add_message(self, role: str, content: str):
        """Adds a message to the conversation history."""
        if role not in ["user", "assistant"]:
            raise ValueError("Role must be 'user' or 'assistant'")
        
        self.history.append({"role": role, "content": content})
        
        # Enforce rolling window (each turn has 2 messages: user and assistant)
        max_messages = self.max_turns * 2
        if len(self.history) > max_messages:
            # Keep the oldest system prompt instructions if any, or just slice recent messages
            self.history = self.history[-max_messages:]

    def get_messages(self) -> list:
        """Returns the conversation history as a list of message dicts."""
        return self.history

    def get_history_as_string(self) -> str:
        """
        Formats the conversation history as a plain text string 
        for older models that don't support chat templates.
        """
        formatted = ""
        for msg in self.history:
            role_label = "User" if msg["role"] == "user" else "Assistant"
            formatted += f"{role_label}: {msg['content']}\n"
        return formatted

    def clear(self):
        """Clears the conversation history."""
        self.history = []
