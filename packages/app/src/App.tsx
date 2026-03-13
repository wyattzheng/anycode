import { useState } from "react";
import { TabBar } from "./components/TabBar";
import { MainView } from "./components/MainView";
import { ConversationOverlay } from "./components/ConversationOverlay";
import { VoiceButton } from "./components/VoiceButton";

export type TabId = "files" | "changes" | string;

export function App() {
    const [activeTab, setActiveTab] = useState<TabId>("files");
    const [chatOpen, setChatOpen] = useState(false);

    return (
        <div className="app">
            <MainView activeTab={activeTab} />

            {chatOpen && (
                <ConversationOverlay onClose={() => setChatOpen(false)} />
            )}

            <VoiceButton />

            <TabBar
                activeTab={activeTab}
                onTabChange={setActiveTab}
                chatOpen={chatOpen}
                onChatToggle={() => setChatOpen((v) => !v)}
            />
        </div>
    );
}
