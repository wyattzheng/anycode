import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    createUniqueAccountName,
    getDefaultBaseUrlForProvider,
    getDefaultModelForProvider,
    getDuplicateAccountName,
    getForcedProviderForAgent,
    getProviderBrandVendor,
    getProviderOptionsForAgent,
    normalizeProviderForAgent,
} from "@any-code/settings/shared";
import { GearIcon, CloseIcon, ChevronIcon, PlusIcon, VendorIcon, hasVendorIcon } from "./Icons";
import { getApiBase, getServerUrl, setServerUrl } from "../server-url";
import "./WindowSwitcher.css";

export interface WindowInfo {
    id: string;
    title: string;
    directory: string;
    isDefault: boolean;
    createdAt: number;
}

interface AccountInfo {
    id: string;
    name: string;
    AGENT: string;
    PROVIDER: string;
    MODEL: string;
    API_KEY: string;
    BASE_URL?: string;
}

interface SettingsResponse {
    accounts: AccountInfo[];
    currentAccountId: string | null;
}

interface OAuthStartResponse {
    sessionId: string;
    authUrl: string;
}

interface OAuthSessionResponse {
    status: "pending" | "success" | "error";
    refreshToken?: string;
    error?: string;
}

interface ApiResponseBody {
    error?: string;
    code?: string;
}

interface WindowSwitcherProps {
    windows: WindowInfo[];
    activeWindowId: string;
    onSwitch: (id: string) => void;
    onCreate: () => void;
    onDelete: (id: string) => void;
    onSettingsSaved?: () => void;
    creating?: boolean;
}

function windowLabel(w: WindowInfo): string {
    if (w.directory) {
        const parts = w.directory.split("/");
        return parts[parts.length - 1] || w.directory;
    }
    if (w.title) return w.title;
    return w.isDefault ? "默认" : "新窗口";
}

function createAccount(existingAccounts: AccountInfo[]): AccountInfo {
    const provider = normalizeProviderForAgent("anycode", undefined);
    return {
        id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `account-${Date.now()}`,
        name: createUniqueAccountName("新账号", existingAccounts),
        AGENT: "anycode",
        PROVIDER: provider,
        MODEL: getDefaultModelForProvider(provider),
        API_KEY: "",
        BASE_URL: getDefaultBaseUrlForProvider(provider),
    };
}

function createApiError(res: Response, body: ApiResponseBody, fallbackMessage: string) {
    const error = new Error(body.error || fallbackMessage) as Error & { code?: string; status?: number };
    error.code = body.code;
    error.status = res.status;
    return error;
}

function getProviderOAuthConfig(provider: string) {
    if (provider === "antigravity") {
        return {
            buttonLabel: "Google OAuth 登录",
            buttonLabelFilled: "重新 Google OAuth 登录",
            pendingLabel: "等待 Google 授权…",
            helperText: "登录成功后会自动把 refresh token 填入 API_KEY。",
        };
    }
    return null;
}

const PROVIDER_LABELS: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    litellm: "LiteLLM",
    antigravity: "Antigravity",
};

function getProviderLabel(provider: string) {
    const key = provider.trim().toLowerCase();
    return PROVIDER_LABELS[key] ?? (provider.trim() || "未命名厂商");
}

async function readResponseJson<T>(res: Response): Promise<T & ApiResponseBody> {
    const text = await res.text();
    if (!text.trim()) {
        if (!res.ok) throw new Error("服务端返回空响应");
        return {} as T & ApiResponseBody;
    }
    try {
        return JSON.parse(text) as T & ApiResponseBody;
    } catch {
        throw new Error(text);
    }
}

function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
    const [url, setUrl] = useState(getServerUrl() || "");
    const [editingServerUrl, setEditingServerUrl] = useState(false);

    const [accounts, setAccounts] = useState<AccountInfo[]>([]);
    const [currentAccountId, setCurrentAccountId] = useState<string | null>(null);
    const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
    const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [dirty, setDirty] = useState(false);
    const [oauthPendingAccountId, setOauthPendingAccountId] = useState<string | null>(null);
    const oauthPollTimerRef = useRef<number | null>(null);
    const oauthPollStartedAtRef = useRef(0);
    const accountsRef = useRef<AccountInfo[]>([]);
    const currentAccountIdRef = useRef<string | null>(null);
    const selectedAccount = useMemo(
        () => accounts.find((account) => account.id === selectedAccountId) ?? null,
        [accounts, selectedAccountId],
    );
    const currentAccount = useMemo(
        () => accounts.find((account) => account.id === currentAccountId) ?? null,
        [accounts, currentAccountId],
    );
    const selectedAccountForcedProvider = selectedAccount ? getForcedProviderForAgent(selectedAccount.AGENT) : null;
    const selectedAccountProviderOptions = useMemo(() => {
        if (!selectedAccount) return [];
        const options = getProviderOptionsForAgent(selectedAccount.AGENT);
        const currentProvider = selectedAccount.PROVIDER.trim();
        return currentProvider && !options.includes(currentProvider)
            ? [...options, currentProvider]
            : options;
    }, [selectedAccount]);
    const selectedAccountOAuth = selectedAccount ? getProviderOAuthConfig(selectedAccount.PROVIDER) : null;

    useEffect(() => {
        accountsRef.current = accounts;
    }, [accounts]);

    useEffect(() => {
        currentAccountIdRef.current = currentAccountId;
    }, [currentAccountId]);

    useEffect(() => {
        if (editingAccountId && !accounts.some((account) => account.id === editingAccountId)) {
            setEditingAccountId(null);
        }
    }, [accounts, editingAccountId]);

    const clearOAuthPolling = useCallback(() => {
        if (oauthPollTimerRef.current != null) {
            window.clearTimeout(oauthPollTimerRef.current);
            oauthPollTimerRef.current = null;
        }
        oauthPollStartedAtRef.current = 0;
        setOauthPendingAccountId(null);
    }, []);

    useEffect(() => () => clearOAuthPolling(), [clearOAuthPolling]);

    const fetchSettings = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const res = await fetch(`${getApiBase()}/api/settings`);
            const data = await readResponseJson<SettingsResponse>(res);
            if (!res.ok || data.error) throw createApiError(res, data, `HTTP ${res.status}`);
            setAccounts(data.accounts ?? []);
            setCurrentAccountId(data.currentAccountId ?? data.accounts?.[0]?.id ?? null);
            setSelectedAccountId((prev) => prev && data.accounts?.some((item) => item.id === prev)
                ? prev
                : (data.currentAccountId ?? data.accounts?.[0]?.id ?? null));
        } catch (e: any) {
            setError(e?.message || "读取账号配置失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    const sanitizeAccounts = useCallback((items: AccountInfo[]) => (
        items.map((account) => ({
            ...account,
            name: account.name.trim(),
            AGENT: account.AGENT.trim(),
            PROVIDER: normalizeProviderForAgent(account.AGENT, account.PROVIDER),
            MODEL: account.MODEL.trim(),
            API_KEY: account.API_KEY.trim(),
            BASE_URL: account.BASE_URL?.trim() || "",
        }))
    ), []);

    const persistSettings = useCallback(async (
        nextAccounts: AccountInfo[],
        nextCurrentAccountId: string | null,
        options?: { applyCurrentAccount?: boolean; nextSelectedAccountId?: string | null; closeOnMobile?: boolean },
    ) => {
        setSaving(true);
        setError("");
        try {
            const sanitizedAccounts = sanitizeAccounts(nextAccounts);
            const duplicateAccountName = getDuplicateAccountName(sanitizedAccounts);
            if (duplicateAccountName) {
                throw new Error(`Account name "${duplicateAccountName}" already exists`);
            }
            const res = await fetch(`${getApiBase()}/api/settings`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accounts: sanitizedAccounts,
                    currentAccountId: nextCurrentAccountId,
                    applyCurrentAccount: options?.applyCurrentAccount === true,
                }),
            });
            const data = await readResponseJson<SettingsResponse>(res);
            if (!res.ok || data.error) throw createApiError(res, data, `HTTP ${res.status}`);

            const resolvedAccounts = data.accounts ?? [];
            const resolvedCurrentAccountId = data.currentAccountId ?? null;
            const preferredSelectedId = options?.nextSelectedAccountId ?? selectedAccountId;

            setAccounts(resolvedAccounts);
            setCurrentAccountId(resolvedCurrentAccountId);
            setSelectedAccountId(
                preferredSelectedId && resolvedAccounts.some((account) => account.id === preferredSelectedId)
                    ? preferredSelectedId
                    : (resolvedCurrentAccountId ?? resolvedAccounts[0]?.id ?? null),
            );
            setDirty(false);
            onSaved?.();
            if (options?.closeOnMobile && typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches) {
                onClose();
            }
            return true;
        } catch (e: any) {
            setError(e?.message || "保存账号配置失败");
            return false;
        } finally {
            setSaving(false);
        }
    }, [onClose, onSaved, sanitizeAccounts, selectedAccountId]);

    const handleSaveServerUrl = () => {
        setServerUrl(url.trim());
        setEditingServerUrl(false);
    };

    const updateSelectedAccount = (patch: Partial<AccountInfo>) => {
        if (!selectedAccountId) return;
        setAccounts((prev) => prev.map((account) => (
            account.id === selectedAccountId ? { ...account, ...patch } : account
        )));
        setDirty(true);
    };

    const handleSelectedAgentChange = (nextAgent: string) => {
        if (!selectedAccount) return;
        const nextProvider = normalizeProviderForAgent(nextAgent, selectedAccount.PROVIDER);
        updateSelectedAccount({
            AGENT: nextAgent,
            PROVIDER: nextProvider,
            MODEL: getDefaultModelForProvider(nextProvider),
            BASE_URL: getDefaultBaseUrlForProvider(nextProvider),
        });
    };

    const handleAddAccount = async () => {
        const account = createAccount(accounts);
        const nextAccounts = [...accounts, account];
        const nextCurrentAccountId = currentAccountId;
        setAccounts(nextAccounts);
        setSelectedAccountId(account.id);
        setEditingAccountId(account.id);
        const ok = await persistSettings(nextAccounts, nextCurrentAccountId, { nextSelectedAccountId: account.id });
        if (!ok) setDirty(true);
    };

    const startEditingAccount = useCallback((accountId: string) => {
        setSelectedAccountId(accountId);
        setEditingAccountId(accountId);
    }, []);

    const handleDeleteAccount = useCallback(async (accountId: string = selectedAccountId || "") => {
        if (!accountId) return;
        const remaining = accounts.filter((account) => account.id !== accountId);
        const deletingCurrent = currentAccountId === accountId;
        const nextCurrentAccountId = deletingCurrent ? null : currentAccountId;
        const nextSelectedAccountId = selectedAccountId === accountId
            ? (remaining[0]?.id ?? null)
            : (selectedAccountId ?? remaining[0]?.id ?? null);
        setAccounts(remaining);
        setCurrentAccountId(nextCurrentAccountId);
        setSelectedAccountId(nextSelectedAccountId);
        if (editingAccountId === accountId) {
            setEditingAccountId(null);
        }
        const ok = await persistSettings(remaining, nextCurrentAccountId, {
            applyCurrentAccount: deletingCurrent,
            nextSelectedAccountId,
        });
        if (!ok) setDirty(true);
    }, [accounts, currentAccountId, editingAccountId, persistSettings, selectedAccountId]);

    const handleActivateAccount = async (accountId: string, closeOnMobile = true) => {
        const ok = await persistSettings(accounts, accountId, {
            applyCurrentAccount: true,
            nextSelectedAccountId: accountId,
            closeOnMobile,
        });
        if (ok) {
            setCurrentAccountId(accountId);
        }
    };

    const handleAgentOAuthLogin = useCallback(async () => {
        if (!selectedAccount) return;
        const oauthConfig = getProviderOAuthConfig(selectedAccount.PROVIDER);
        if (!oauthConfig) return;

        const accountId = selectedAccount.id;
        const provider = selectedAccount.PROVIDER;
        const popup = typeof window !== "undefined" ? window.open("", "_blank") : null;
        setError("");
        setOauthPendingAccountId(accountId);
        oauthPollStartedAtRef.current = Date.now();

        const pollSession = async (oauthProvider: string, sessionId: string) => {
            try {
                const res = await fetch(`${getApiBase()}/api/oauth/${oauthProvider}/sessions/${encodeURIComponent(sessionId)}`);
                const data = await readResponseJson<OAuthSessionResponse>(res);
                if (!res.ok || data.error) throw createApiError(res, data, `HTTP ${res.status}`);

                if (data.status === "pending") {
                    if (Date.now() - oauthPollStartedAtRef.current > 5 * 60 * 1000) {
                        clearOAuthPolling();
                        setError("OAuth 登录超时，请重试。");
                        try { popup?.close(); } catch { /* ignore */ }
                        return;
                    }
                    oauthPollTimerRef.current = window.setTimeout(() => {
                        void pollSession(oauthProvider, sessionId);
                    }, 1200);
                    return;
                }

                clearOAuthPolling();
                try { popup?.close(); } catch { /* ignore */ }

                if (data.status === "error" || !data.refreshToken) {
                    setError(data.error || "OAuth 登录失败");
                    return;
                }
                const refreshToken = data.refreshToken;

                const nextAccounts = accountsRef.current.map((account) => (
                    account.id === accountId
                        ? { ...account, API_KEY: refreshToken }
                        : account
                ));

                setAccounts(nextAccounts);
                setSelectedAccountId(accountId);
                setDirty(true);

                const ok = await persistSettings(nextAccounts, currentAccountIdRef.current, {
                    nextSelectedAccountId: accountId,
                });
                if (!ok) setDirty(true);
            } catch (e: any) {
                clearOAuthPolling();
                try { popup?.close(); } catch { /* ignore */ }
                setError(e?.message || "OAuth 登录失败");
            }
        };

        try {
            const publicBaseUrl = getApiBase() || window.location.origin;
            const res = await fetch(`${getApiBase()}/api/oauth/${provider}/start`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ publicBaseUrl }),
            });
            const data = await readResponseJson<OAuthStartResponse>(res);
            if (!res.ok || data.error) throw createApiError(res, data, `HTTP ${res.status}`);

            if (popup) {
                popup.location.href = data.authUrl;
            } else if (typeof window !== "undefined") {
                const link = document.createElement("a");
                link.href = data.authUrl;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.click();
            }

            await pollSession(provider, data.sessionId);
        } catch (e: any) {
            clearOAuthPolling();
            try { popup?.close(); } catch { /* ignore */ }
            setError(e?.message || "无法启动 OAuth 登录");
        }
    }, [clearOAuthPolling, persistSettings, selectedAccount]);

    const handleClose = useCallback(async () => {
        if (saving) return;
        if (!dirty) {
            onClose();
            return;
        }
        const ok = await persistSettings(accounts, currentAccountId, {
            nextSelectedAccountId: selectedAccountId,
        });
        if (ok) onClose();
    }, [accounts, currentAccountId, dirty, onClose, persistSettings, saving, selectedAccountId]);

    return (
        <div className="settings-overlay" onClick={() => { void handleClose(); }}>
            <div className="settings-modal settings-modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="settings-header">
                    <span className="settings-title">设置</span>
                    <button className="settings-close" onClick={() => { void handleClose(); }}>
                        <CloseIcon size={12} />
                    </button>
                </div>
                <div className="settings-body settings-body-stack">
                    <div className="settings-section">
                        <div className="settings-section-head">
                            <span className="settings-section-title">服务器</span>
                        </div>
                        <div className="settings-row">
                            <label className="settings-label">服务器地址</label>
                            {editingServerUrl ? (
                                <div className="settings-edit-row">
                                    <input
                                        className="settings-input"
                                        type="url"
                                        value={url}
                                        onChange={(e) => setUrl(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && handleSaveServerUrl()}
                                        autoFocus
                                    />
                                    <button className="settings-btn" onClick={handleSaveServerUrl}>保存</button>
                                    <button
                                        className="settings-btn settings-btn-dim"
                                        onClick={() => {
                                            setEditingServerUrl(false);
                                            setUrl(getServerUrl() || "");
                                        }}
                                    >
                                        取消
                                    </button>
                                </div>
                            ) : (
                                <div className="settings-value-row">
                                    <span className="settings-value">{getServerUrl() || "(未配置)"}</span>
                                    <button className="settings-btn" onClick={() => setEditingServerUrl(true)}>修改</button>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="settings-section">
                        {editingAccountId && selectedAccount ? (
                            <div className="settings-section-head settings-section-head-sticky settings-section-head-editing">
                                <button className="settings-back-btn" onClick={() => setEditingAccountId(null)}>
                                    <ChevronIcon size={10} />
                                    <span>返回</span>
                                </button>
                                <div className="settings-editing-title">
                                    <span className="settings-section-title">编辑账号</span>
                                    <span className="settings-field-hint">{selectedAccount.name || "未命名账号"}</span>
                                </div>
                            </div>
                        ) : (
                            <div className="settings-section-head settings-section-head-sticky">
                                <span className="settings-section-title">账号</span>
                                <div className="settings-current-note">
                                    <span className="settings-current-note-label">当前</span>
                                    <span className="settings-current-note-value">{currentAccount?.name || "未启用"}</span>
                                </div>
                            </div>
                        )}

                        {loading ? (
                            <div className="settings-placeholder">读取账号配置中…</div>
                        ) : editingAccountId && selectedAccount ? (
                            <div className="settings-account-editor">
                                <div className="settings-grid">
                                    <div className="settings-row">
                                        <label className="settings-label">账号名称</label>
                                        <input
                                            className="settings-input"
                                            value={selectedAccount.name}
                                            onChange={(e) => updateSelectedAccount({ name: e.target.value })}
                                            autoFocus
                                        />
                                    </div>
                                    <div className="settings-row">
                                        <label className="settings-label">AGENT</label>
                                        <select
                                            className="settings-input"
                                            value={selectedAccount.AGENT}
                                            onChange={(e) => handleSelectedAgentChange(e.target.value)}
                                        >
                                            <option value="anycode">anycode</option>
                                            <option value="claudecode">claudecode</option>
                                            <option value="codex">codex</option>
                                            <option value="antigravity">antigravity</option>
                                        </select>
                                    </div>
                                    <div className="settings-row">
                                        <label className="settings-label">PROVIDER</label>
                                        <select
                                            className="settings-input"
                                            value={selectedAccount.PROVIDER}
                                            onChange={(e) => {
                                                const nextProvider = e.target.value;
                                                updateSelectedAccount({
                                                    PROVIDER: nextProvider,
                                                    MODEL: getDefaultModelForProvider(nextProvider),
                                                    BASE_URL: getDefaultBaseUrlForProvider(nextProvider),
                                                });
                                            }}
                                            disabled={Boolean(selectedAccountForcedProvider)}
                                        >
                                            {selectedAccountProviderOptions.map((provider) => (
                                                <option key={provider} value={provider}>{provider}</option>
                                            ))}
                                        </select>
                                        {selectedAccountForcedProvider && (
                                            <span className="settings-field-hint">
                                                {selectedAccount.AGENT} 固定使用 {selectedAccountForcedProvider}。
                                            </span>
                                        )}
                                    </div>
                                    <div className="settings-row">
                                        <label className="settings-label">MODEL</label>
                                        <input
                                            className="settings-input"
                                            value={selectedAccount.MODEL}
                                            onChange={(e) => updateSelectedAccount({ MODEL: e.target.value })}
                                            placeholder="claude-opus-4-6 / gpt-5.4 / gemini-3.1-pro"
                                        />
                                    </div>
                                    <div className="settings-row">
                                        <label className="settings-label">BASE_URL</label>
                                        <input
                                            className="settings-input"
                                            type="url"
                                            value={selectedAccount.BASE_URL || ""}
                                            onChange={(e) => updateSelectedAccount({ BASE_URL: e.target.value })}
                                            placeholder="https://api.example.com/v1"
                                        />
                                    </div>
                                </div>

                                <div className="settings-row">
                                    <label className="settings-label">API_KEY</label>
                                    <input
                                        className="settings-input"
                                        type="password"
                                        value={selectedAccount.API_KEY}
                                        onChange={(e) => updateSelectedAccount({ API_KEY: e.target.value })}
                                        placeholder="输入 API Key"
                                    />
                                    {selectedAccountOAuth && (
                                        <div className="settings-oauth-row">
                                            <button
                                                className="settings-btn settings-btn-primary"
                                                onClick={() => { void handleAgentOAuthLogin(); }}
                                                disabled={saving || oauthPendingAccountId === selectedAccount.id}
                                            >
                                                {oauthPendingAccountId === selectedAccount.id
                                                    ? selectedAccountOAuth.pendingLabel
                                                    : (selectedAccount.API_KEY ? selectedAccountOAuth.buttonLabelFilled : selectedAccountOAuth.buttonLabel)}
                                            </button>
                                            <span className="settings-oauth-hint">{selectedAccountOAuth.helperText}</span>
                                        </div>
                                    )}
                                </div>
                                <div className="settings-editor-actions">
                                    <button
                                        className="settings-btn settings-editor-action-btn"
                                        onClick={() => setEditingAccountId(null)}
                                    >
                                        返回列表
                                    </button>
                                    <button
                                        className="settings-btn settings-editor-action-btn"
                                        onClick={() => { void handleDeleteAccount(selectedAccount.id); }}
                                        disabled={saving}
                                    >
                                        删除账号
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="settings-account-list">
                                {accounts.length > 0 ? accounts.map((account) => {
                                    const brandVendor = getProviderBrandVendor(account.PROVIDER);
                                    return (
                                        <div
                                            key={account.id}
                                            className={`settings-account-item ${account.id === currentAccountId ? "current" : ""}`}
                                        >
                                        <button
                                            className={`settings-btn settings-account-selector ${account.id === currentAccountId ? "checked" : ""}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void handleActivateAccount(account.id);
                                            }}
                                            disabled={saving}
                                            role="checkbox"
                                            aria-checked={account.id === currentAccountId}
                                            aria-label={account.id === currentAccountId ? "当前账号" : "设为当前账号"}
                                        >
                                            <span className="settings-account-current-box" aria-hidden="true">
                                                <span className="settings-account-current-fill" />
                                            </span>
                                        </button>
                                        <button
                                            className="settings-account-summary"
                                            type="button"
                                            onClick={() => startEditingAccount(account.id)}
                                        >
                                            <div className="settings-account-top-row">
                                                <div className="settings-account-identity">
                                                    <span className="settings-account-name">{account.name || "未命名账号"}</span>
                                                </div>
                                            </div>
                                            <div className="settings-account-middle-row">
                                                <div
                                                    className="settings-account-model-row"
                                                    title={`${getProviderLabel(account.PROVIDER)} / ${account.MODEL || "未配置模型"}`}
                                                >
                                                    {hasVendorIcon(brandVendor) && (
                                                        <span className="settings-account-vendor-icon">
                                                            <VendorIcon vendor={brandVendor} size={12} />
                                                        </span>
                                                    )}
                                                    <span className="settings-account-vendor-name">{getProviderLabel(account.PROVIDER)}</span>
                                                    <span className="settings-account-divider">/</span>
                                                    <span className="settings-account-model">{account.MODEL || "未配置模型"}</span>
                                                </div>
                                            </div>
                                            <div className="settings-account-quota-row">
                                                <div className="settings-account-quota" aria-label="额度占位">
                                                    <span className="settings-account-quota-bar" aria-hidden="true">
                                                        <span className="settings-account-quota-fill" />
                                                    </span>
                                                </div>
                                            </div>
                                        </button>
                                        </div>
                                    );
                                }) : (
                                    <div className="settings-account-empty-row">
                                        <span className="settings-account-empty-text">还没有账号</span>
                                        <span className="settings-field-hint">创建一个账号后就可以在这里切换。</span>
                                    </div>
                                )}
                                <button className="settings-account-add-row" onClick={handleAddAccount}>
                                    <PlusIcon size={12} />
                                    <span>{accounts.length > 0 ? "新增账号" : "新增第一个账号"}</span>
                                </button>
                            </div>
                        )}

                        {error && <div className="settings-error">{error}</div>}
                    </div>
                </div>
            </div>
        </div>
    );
}

export function WindowSwitcher({
    windows,
    activeWindowId,
    onSwitch,
    onCreate,
    onDelete,
    onSettingsSaved,
    creating = false,
}: WindowSwitcherProps) {
    const [popoverId, setPopoverId] = useState<string | null>(null);
    const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const taskbarRef = useRef<HTMLElement>(null);
    const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

    useEffect(() => {
        if (!popoverId) return;
        const handler = (e: MouseEvent | TouchEvent) => {
            if (taskbarRef.current && !taskbarRef.current.contains(e.target as Node)) {
                setPopoverId(null);
            }
        };
        document.addEventListener("mousedown", handler);
        document.addEventListener("touchstart", handler);
        return () => {
            document.removeEventListener("mousedown", handler);
            document.removeEventListener("touchstart", handler);
        };
    }, [popoverId]);

    const handleClick = useCallback((w: WindowInfo) => {
        if (w.id === activeWindowId) {
            if (!w.isDefault) {
                setPopoverId((prev) => {
                    if (prev === w.id) return null;
                    const btn = btnRefs.current.get(w.id);
                    if (btn) {
                        const rect = btn.getBoundingClientRect();
                        setPopoverPos({ x: rect.left + rect.width / 2, y: rect.bottom });
                    }
                    return w.id;
                });
            }
        } else {
            setPopoverId(null);
            onSwitch(w.id);
        }
    }, [activeWindowId, onSwitch]);

    return (
        <>
            <nav className="taskbar" ref={taskbarRef}>
                <div className="taskbar-items">
                    {windows.map((w) => (
                        <button
                            key={w.id}
                            ref={(el) => { if (el) btnRefs.current.set(w.id, el); }}
                            className={`taskbar-item ${w.id === activeWindowId ? "active" : ""}`}
                            onClick={() => handleClick(w)}
                        >
                            <span className="taskbar-label">{windowLabel(w)}</span>
                        </button>
                    ))}
                </div>
                <button className="taskbar-add" onClick={onCreate} disabled={creating} title="新建窗口">{creating ? "…" : "+"}</button>
                <button className="taskbar-gear" onClick={() => setShowSettings(true)} title="设置">
                    <GearIcon size={12} />
                </button>

                {popoverId && popoverPos && (
                    <div
                        className="taskbar-popover"
                        style={{ left: popoverPos.x, top: popoverPos.y }}
                    >
                        <button
                            className="taskbar-popover-btn"
                            onClick={() => {
                                const id = popoverId;
                                setPopoverId(null);
                                onDelete(id);
                            }}
                        >
                            关闭窗口
                        </button>
                    </div>
                )}
            </nav>

            {showSettings && (
                <SettingsModal
                    onClose={() => setShowSettings(false)}
                    onSaved={onSettingsSaved}
                />
            )}
        </>
    );
}
