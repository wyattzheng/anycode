import { useState } from "react";
import "./VoiceButton.css";

export function VoiceButton() {
    const [recording, setRecording] = useState(false);

    const handleClick = () => {
        setRecording((v) => !v);
        // TODO: start/stop audio recording via Web Audio API
    };

    return (
        <button
            className={`voice-button ${recording ? "recording" : ""}`}
            onClick={handleClick}
            title={recording ? "停止录音" : "开始录音"}
        >
            🎤
        </button>
    );
}
