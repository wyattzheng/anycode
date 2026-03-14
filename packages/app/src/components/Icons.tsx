interface IconProps {
    size?: number;
    color?: string;
}

export function MicIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="8" y1="22" x2="16" y2="22" />
        </svg>
    );
}

export function KeyboardIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <line x1="6" y1="9" x2="6" y2="9" />
            <line x1="10" y1="9" x2="10" y2="9" />
            <line x1="14" y1="9" x2="14" y2="9" />
            <line x1="18" y1="9" x2="18" y2="9" />
            <line x1="6" y1="13" x2="6" y2="13" />
            <line x1="18" y1="13" x2="18" y2="13" />
            <line x1="9" y1="13" x2="15" y2="13" />
        </svg>
    );
}

export function SendIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
    );
}

export function CloseIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
    );
}

export function MonitorIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="3" />
            <polygon points="10 8 16 12 10 16" />
        </svg>
    );
}

export function FolderIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="3" />
            <line x1="7" y1="8" x2="17" y2="8" />
            <line x1="7" y1="12" x2="14" y2="12" />
            <line x1="7" y1="16" x2="17" y2="16" />
        </svg>
    );
}

export function DiffIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="3" />
            <path d="M12 8v8" />
            <path d="M8 12h8" />
        </svg>
    );
}

export function FolderOpenIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    );
}

export function ChevronIcon({ size = 10, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
        </svg>
    );
}

export function FileDocIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    );
}

export function AddedIcon({ size = 12, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    );
}

export function ModifiedIcon({ size = 12, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round">
            <circle cx="12" cy="12" r="6" fill={color} />
        </svg>
    );
}

export function DeletedIcon({ size = 12, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    );
}

export function ChatIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    );
}
