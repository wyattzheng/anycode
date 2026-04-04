import { siAnthropic, siGoogle } from "simple-icons";

interface IconProps {
    size?: number;
    color?: string;
}

interface VendorIconProps extends IconProps {
    vendor: string;
}

const REAL_VENDOR_ICONS = {
    anthropic: siAnthropic,
    google: siGoogle,
} as const;

const CUSTOM_VENDOR_ICONS = new Set(["openai"]);

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

export function ChatIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="3" />
            <line x1="7" y1="9" x2="15" y2="9" />
            <line x1="9" y1="15" x2="17" y2="15" />
        </svg>
    );
}

export function ChatBubbleIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "translateY(1px)" }}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    );
}

export function TerminalIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="3" />
            <polyline points="7 9 10 12 7 15" />
            <line x1="13" y1="15" x2="17" y2="15" />
        </svg>
    );
}

export function WindowIcon({ size = 18, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <rect x="7" y="7" width="10" height="10" rx="1.5" />
        </svg>
    );
}

export function PlusIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    );
}

export function CheckIcon({ size = 12, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="5 13 9 17 19 7" />
        </svg>
    );
}

export function StopIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
            <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
    );
}

/* Dock to sidebar */
export function PinIcon({ size = 10, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="1" width="14" height="14" rx="1.5" />
            <line x1="10" y1="1" x2="10" y2="15" />
        </svg>
    );
}

/* Undock / float */
export function UndockIcon({ size = 10, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="4" width="11" height="11" rx="1.5" />
            <polyline points="8 4 8 1 15 1 15 8 12 8" />
        </svg>
    );
}

export function GearIcon({ size = 14, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
}

/* Minimize — simple horizontal line */
export function MinimizeIcon({ size = 10, color = "currentColor" }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round">
            <line x1="2" y1="8" x2="14" y2="8" />
        </svg>
    );
}

function getVendorIconData(vendor: string) {
    const key = vendor.trim().toLowerCase();
    return REAL_VENDOR_ICONS[key as keyof typeof REAL_VENDOR_ICONS] ?? null;
}

export function hasVendorIcon(vendor: string) {
    const key = vendor.trim().toLowerCase();
    return CUSTOM_VENDOR_ICONS.has(key) || Boolean(getVendorIconData(vendor));
}

export function VendorIcon({ vendor, size = 14, color = "currentColor" }: VendorIconProps) {
    const key = vendor.trim().toLowerCase();
    if (key === "openai") {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <g stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="10.15" y="2.9" width="3.7" height="9" rx="1.85" transform="rotate(0 12 12)" />
                    <rect x="10.15" y="2.9" width="3.7" height="9" rx="1.85" transform="rotate(60 12 12)" />
                    <rect x="10.15" y="2.9" width="3.7" height="9" rx="1.85" transform="rotate(120 12 12)" />
                    <rect x="10.15" y="2.9" width="3.7" height="9" rx="1.85" transform="rotate(180 12 12)" />
                    <rect x="10.15" y="2.9" width="3.7" height="9" rx="1.85" transform="rotate(240 12 12)" />
                    <rect x="10.15" y="2.9" width="3.7" height="9" rx="1.85" transform="rotate(300 12 12)" />
                    <circle cx="12" cy="12" r="2.2" />
                </g>
            </svg>
        );
    }

    const icon = getVendorIconData(vendor);
    if (!icon) return null;

    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d={icon.path} fill={color} />
        </svg>
    );
}
