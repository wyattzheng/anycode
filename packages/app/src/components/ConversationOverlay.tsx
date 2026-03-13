import { useState } from "react";
import "./ConversationOverlay.css";

interface ConversationOverlayProps {
    onClose: () => void;
}

export function ConversationOverlay({ onClose }: ConversationOverlayProps) {
    const [input, setInput] = useState("");

    const handleSend = () => {
        if (!input.trim()) return;
        // TODO: send message to server
        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="conversation-overlay">
            <div className="conversation-panel">
                <div className="conversation-header">
                    <span>💬 对话</span>
                    <button className="conversation-close" onClick={onClose}>✕</button>
                </div>

                <div className="conversation-messages">
                    <div className="message assistant">
                        <p>你好！我是 AnyCode AI 助手。告诉我你想做什么，我来帮你写代码。</p>
                    </div>
                </div>

                <div className="conversation-input">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="输入消息..."
                        rows={1}
                    />
                    <button className="send-btn" onClick={handleSend}>
                        ➤
                    </button>
                </div>
            </div>
        </div>
    );
}
