import { execSync, spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import readline from "readline";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { AnyCodeServer } from "@any-code/server";
import {
    getDefaultBaseUrlForProvider,
    getDefaultModelForProvider,
    SettingsStore,
    getForcedProviderForAgent,
    getProviderOptionsForAgent,
    normalizeProviderForAgent,
    type AccountSettings,
    type UserSettingsFile,
} from "@any-code/settings";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROCESS_NAME = "anycode-server";
const settingsStore = new SettingsStore();
const ANYCODE_DIR = settingsStore.anycodeDir;
const SETTINGS_PATH = settingsStore.path;
const DEFAULT_PORT = 3210;

// ── Colors ────────────────────────────────────────────────────────────────

const c = {
    reset:   "\x1b[0m",
    bold:    "\x1b[1m",
    dim:     "\x1b[2m",
    italic:  "\x1b[3m",
    cyan:    "\x1b[36m",
    green:   "\x1b[32m",
    yellow:  "\x1b[33m",
    red:     "\x1b[31m",
    magenta: "\x1b[35m",
    blue:    "\x1b[34m",
    white:   "\x1b[37m",
    gray:    "\x1b[90m",
    bgGreen: "\x1b[42m",
    bgRed:   "\x1b[41m",
    bgCyan:  "\x1b[46m",
    bgBlue:  "\x1b[44m",
};

// ── UI Helpers ────────────────────────────────────────────────────────────

const LOGO = `
${c.cyan}${c.bold}     ╔══════════════════════════════════╗
     ║${c.reset}${c.white}${c.bold}          ◆  AnyCode              ${c.cyan}${c.bold}║
     ╚══════════════════════════════════╝${c.reset}
`;

function banner() {
    console.log(LOGO);
}

function info(msg: string) {
    console.log(`  ${c.cyan}▸${c.reset} ${msg}`);
}

function success(msg: string) {
    console.log(`  ${c.green}✔${c.reset} ${msg}`);
}

function warn(msg: string) {
    console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}

function fail(msg: string) {
    console.error(`  ${c.red}✖${c.reset} ${msg}`);
}

function step(label: string) {
    console.log(`  ${c.gray}─${c.reset} ${label}${c.gray}...${c.reset}`);
}

function blank() {
    console.log();
}

function divider() {
    console.log(`  ${c.gray}${"─".repeat(44)}${c.reset}`);
}

function keyValue(key: string, value: string, pad = 12) {
    console.log(`  ${c.white}${key.padEnd(pad)}${c.reset} ${c.gray}│${c.reset} ${value}`);
}

// ── Settings ──────────────────────────────────────────────────────────────

type Settings = UserSettingsFile;

function loadSettings(): Settings {
    return settingsStore.read().toJSON();
}

function saveSettings(settings: Settings) {
    settingsStore.write(settings);
}

function getCurrentAccount(settings: Settings): AccountSettings | undefined {
    if (typeof settings.currentAccountId !== "string") return undefined;
    return settings.accounts?.find((account) => account.id === settings.currentAccountId);
}

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function ensureSettings(): Promise<Settings> {
    const settings = loadSettings();
    let changed = false;
    let account = getCurrentAccount(settings);
    const hasStoredAccounts = (settings.accounts?.length ?? 0) > 0;

    if (!account && !hasStoredAccounts) {
        blank();
        console.log(`  ${c.bold}${c.white}Welcome! Let's configure your first account.${c.reset}`);
        blank();
        divider();
        blank();
        const name = await prompt(`  ${c.cyan}?${c.reset} ${c.bold}Account Name${c.reset} ${c.gray}(default account)${c.reset}: `);
        account = {
            id: randomUUID(),
            name: name || "默认账号",
            AGENT: "anycode",
            PROVIDER: normalizeProviderForAgent("anycode", undefined),
            MODEL: getDefaultModelForProvider(normalizeProviderForAgent("anycode", undefined)),
            BASE_URL: getDefaultBaseUrlForProvider(normalizeProviderForAgent("anycode", undefined)),
            API_KEY: "",
        };
        settings.accounts = [account];
        settings.currentAccountId = account.id;
        changed = true;
    }

    if (!account) {
        return settings;
    }

    if (!account.AGENT) {
        if (!changed) {
            blank();
            console.log(`  ${c.bold}${c.white}Let's finish configuring your current account.${c.reset}`);
            blank();
            divider();
            blank();
        }
        const val = await prompt(`  ${c.cyan}?${c.reset} ${c.bold}Agent${c.reset} ${c.gray}(anycode, claudecode, codex, antigravity)${c.reset}: `);
        account.AGENT = val || "anycode";
        changed = true;
    }

    const forcedProvider = getForcedProviderForAgent(account.AGENT);
    if (forcedProvider && account.PROVIDER !== forcedProvider) {
        account.PROVIDER = forcedProvider;
        changed = true;
    }

    if (!forcedProvider && !account.PROVIDER) {
        if (!changed) {
            blank();
            console.log(`  ${c.bold}${c.white}Let's finish configuring your current account.${c.reset}`);
            blank();
            divider();
            blank();
        }
        const providerOptions = getProviderOptionsForAgent(account.AGENT).join(", ");
        const val = await prompt(`  ${c.cyan}?${c.reset} ${c.bold}Provider${c.reset} ${c.gray}(${providerOptions})${c.reset}: `);
        account.PROVIDER = normalizeProviderForAgent(account.AGENT, val);
        changed = true;
    }

    if (!account.API_KEY) {
        if (!changed) {
            blank();
            console.log(`  ${c.bold}${c.white}Let's finish configuring your current account.${c.reset}`);
            blank();
            divider();
            blank();
        }
        account.API_KEY = await prompt(`  ${c.cyan}?${c.reset} ${c.bold}API Key${c.reset} ${c.gray}(required)${c.reset}: `);
        if (!account.API_KEY) {
            fail("API Key is required to continue.");
            process.exit(1);
        }
        changed = true;
    }

    if (!account.MODEL) {
        const defaultModel = getDefaultModelForProvider(account.PROVIDER);
        const val = await prompt(`  ${c.cyan}?${c.reset} ${c.bold}Model${c.reset} ${c.gray}(${defaultModel})${c.reset}: `);
        account.MODEL = val || defaultModel;
        changed = true;
    }

    if (account.BASE_URL === undefined) {
        const defaultBaseUrl = getDefaultBaseUrlForProvider(account.PROVIDER);
        const promptText = defaultBaseUrl
            ? `  ${c.cyan}?${c.reset} ${c.bold}Base URL${c.reset} ${c.gray}(${defaultBaseUrl})${c.reset}: `
            : `  ${c.cyan}?${c.reset} ${c.bold}Base URL${c.reset} ${c.gray}(optional, Enter to skip)${c.reset}: `;
        const val = await prompt(promptText);
        account.BASE_URL = val || defaultBaseUrl || undefined;
        changed = true;
    }

    if (changed) {
        saveSettings(settings);
        blank();
        divider();
        blank();
        success("Configuration saved!");
        blank();
        console.log(`  ${c.gray}Config file: ${c.yellow}${SETTINGS_PATH}${c.reset}`);
        console.log(`  ${c.gray}Edit anytime: ${c.green}anycode config${c.reset}`);
        blank();
    }

    return settings;
}

// ── PM2 Helpers ───────────────────────────────────────────────────────────

function hasPm2(): boolean {
    try {
        execSync("pm2 --version", { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function ensurePm2() {
    if (hasPm2()) return;
    step("Installing pm2");
    try {
        execSync("npm install -g pm2", { stdio: "pipe" });
    } catch {
        fail("Failed to install pm2.");
        console.log(`  ${c.gray}Try manually: ${c.white}npm install -g pm2${c.reset}`);
        process.exit(1);
    }
    if (!hasPm2()) {
        fail("pm2 installed but not found in PATH.");
        process.exit(1);
    }
    success("pm2 installed.");
}

function pm2Silent(args: string) {
    return spawnSync("pm2", args.split(" "), {
        stdio: "pipe",
        shell: true,
    });
}

function getPm2Process(): any | null {
    const list = pm2Silent("jlist");
    if (!list.stdout) return null;
    try {
        const processes = JSON.parse(list.stdout.toString());
        return processes.find((p: any) => p.name === PROCESS_NAME) ?? null;
    } catch {
        return null;
    }
}

// ── PM2 ecosystem config ──────────────────────────────────────────────────

function getBinScript(): string {
    return path.resolve(__dirname, "bin.js");
}

function writeEcosystem(): string {
    const ecosystemPath = path.join(ANYCODE_DIR, "ecosystem.config.cjs");
    const script = getBinScript();
    const content = `module.exports = {
  apps: [{
    name: ${JSON.stringify(PROCESS_NAME)},
    script: ${JSON.stringify(script)},
    args: "server",
    interpreter: "node"
  }]
};
`;
    fs.mkdirSync(ANYCODE_DIR, { recursive: true });
    fs.writeFileSync(ecosystemPath, content);
    return ecosystemPath;
}

function getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        for (const iface of interfaces[devName] ?? []) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }
    return "localhost";
}

function showAccessInfo(settings: Settings) {
    const port = DEFAULT_PORT;
    const ip = getLocalIP();
    const account = getCurrentAccount(settings);

    blank();
    console.log(`  ${c.bold}${c.green}Server is running!${c.reset}`);
    blank();
    divider();
    blank();
    keyValue("Local", `${c.cyan}${c.bold}http://localhost:${port}${c.reset}`);
    keyValue("Network", `${c.cyan}http://${ip}:${port}${c.reset}`);
    if (account) keyValue("Account", `${c.green}${account.name}${c.reset}`);
    if (account) keyValue("Provider", `${c.yellow}${account.PROVIDER}${c.reset}`);
    if (account) keyValue("Model", `${c.yellow}${account.MODEL}${c.reset}`);
    blank();
    divider();
    blank();
    console.log(`  ${c.gray}Logs${c.reset}      ${c.white}anycode logs${c.reset}`);
    console.log(`  ${c.gray}Stop${c.reset}      ${c.white}anycode stop${c.reset}`);
    console.log(`  ${c.gray}Restart${c.reset}   ${c.white}anycode restart${c.reset}`);
    blank();
}

// ── Commands ──────────────────────────────────────────────────────────────

async function cmdServer() {
    banner();
    await ensureSettings();

    info("Starting server in foreground...");
    blank();
    await new AnyCodeServer().start();
}

async function cmdStart() {
    banner();

    const settings = await ensureSettings();

    step("Checking pm2");
    ensurePm2();

    const ecosystemPath = writeEcosystem();

    // Register pm2 startup (silent)
    step("Registering auto-start on boot");
    pm2Silent("startup");

    // Check if already running
    const existing = getPm2Process();
    if (existing) {
        step("Restarting server");
        pm2Silent(`delete ${PROCESS_NAME}`);
    } else {
        step("Starting server");
    }

    const result = pm2Silent(`start ${ecosystemPath}`);
    pm2Silent("save");

    // Check if actually started
    await new Promise(r => setTimeout(r, 1500));
    const proc = getPm2Process();
    if (proc && proc.pm2_env?.status === "online") {
        showAccessInfo(settings);
    } else {
        fail("Server failed to start.");
        blank();
        console.log(`  ${c.gray}Check logs: ${c.white}anycode logs${c.reset}`);
        blank();
        process.exit(1);
    }
}

function cmdStop() {
    banner();
    ensurePm2();

    const proc = getPm2Process();
    if (!proc) {
        warn("Server is not running.");
        blank();
        return;
    }

    step("Stopping server");
    pm2Silent(`stop ${PROCESS_NAME}`);
    pm2Silent("save");

    success("Server stopped.");
    blank();
}

function cmdRestart() {
    banner();
    ensurePm2();

    const proc = getPm2Process();
    if (!proc) {
        warn("Server is not running. Use ${c.white}anycode start${c.reset} instead.");
        blank();
        return;
    }

    step("Restarting server");
    pm2Silent(`restart ${PROCESS_NAME}`);
    pm2Silent("save");

    // Check status
    setTimeout(() => {
        const updated = getPm2Process();
        if (updated && updated.pm2_env?.status === "online") {
            success("Server restarted.");
        } else {
            fail("Server failed to restart.");
            console.log(`  ${c.gray}Check logs: ${c.white}anycode logs${c.reset}`);
        }
        blank();
    }, 1500);
}

function cmdStatus() {
    banner();
    ensurePm2();

    const proc = getPm2Process();
    if (!proc) {
        keyValue("Status", `${c.gray}not running${c.reset}`);
        blank();
        console.log(`  ${c.gray}Run ${c.white}anycode start${c.gray} to launch.${c.reset}`);
        blank();
        return;
    }

    const status = proc.pm2_env?.status ?? "unknown";
    const statusColor = status === "online" ? c.green : status === "stopped" ? c.red : c.yellow;
    const pid = proc.pid ?? "-";
    const uptime = proc.pm2_env?.pm_uptime
        ? formatUptime(Date.now() - proc.pm2_env.pm_uptime)
        : "-";
    const restarts = proc.pm2_env?.restart_time ?? 0;
    const memory = proc.monit?.memory
        ? `${Math.round(proc.monit.memory / 1024 / 1024)} MB`
        : "-";
    const cpu = proc.monit?.cpu !== undefined ? `${proc.monit.cpu}%` : "-";

    blank();
    keyValue("Status", `${statusColor}${c.bold}${status}${c.reset}`);
    keyValue("PID", `${c.white}${pid}${c.reset}`);
    keyValue("Uptime", `${c.white}${uptime}${c.reset}`);
    keyValue("Restarts", `${c.white}${restarts}${c.reset}`);
    keyValue("Memory", `${c.white}${memory}${c.reset}`);
    keyValue("CPU", `${c.white}${cpu}${c.reset}`);
    blank();
}

function formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

function cmdLogs() {
    ensurePm2();

    const proc = getPm2Process();
    if (!proc) {
        banner();
        warn("Server is not running.");
        blank();
        return;
    }

    // Logs are interactive, let pm2 handle output
    spawnSync("pm2", ["logs", PROCESS_NAME, "--lines", "50"], {
        stdio: "inherit",
        shell: true,
    });
}

function getMonorepoRoot(): string | null {
    // __dirname is packages/cli/dist, monorepo root is 3 levels up
    const candidate = path.resolve(__dirname, "../../..");
    if (fs.existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
        return candidate;
    }
    return null;
}

async function cmdUpdate() {
    banner();

    const monorepoRoot = getMonorepoRoot();

    if (monorepoRoot) {
        // Development environment — build all packages in the monorepo
        info(`Dev environment detected (${c.yellow}${monorepoRoot}${c.reset})`);
        blank();

        step("Building all packages");
        try {
            execSync("pnpm -r build", { cwd: monorepoRoot, stdio: "inherit" });
        } catch {
            fail("Build failed.");
            process.exit(1);
        }
        success("All packages built.");

        // Restart/start via pm2
        ensurePm2();
        const ecosystemPath = writeEcosystem();
        const existing = hasPm2() ? getPm2Process() : null;
        if (existing) {
            step("Restarting server");
            pm2Silent(`delete ${PROCESS_NAME}`);
        } else {
            step("Starting server");
        }
        pm2Silent(`start ${ecosystemPath}`);
        pm2Silent("save");

        await new Promise(r => setTimeout(r, 1500));
        const proc = getPm2Process();
        if (proc && proc.pm2_env?.status === "online") {
            const settings = loadSettings();
            showAccessInfo(settings);
        } else {
            fail("Server failed to start.");
            console.log(`  ${c.gray}Check logs: ${c.white}anycode logs${c.reset}`);
        }
    } else {
        // Production environment — update from npm
        step("Updating anycodex");
        try {
            execSync("npm install -g anycodex@latest", { stdio: "pipe" });
        } catch {
            fail("Failed to update.");
            console.log(`  ${c.gray}Try manually: ${c.white}npm install -g anycodex@latest${c.reset}`);
            process.exit(1);
        }
        success("Updated to latest version.");

        // Restart if pm2 is running
        if (hasPm2()) {
            const existing = getPm2Process();
            if (existing) {
                step("Restarting server");
                const ecosystemPath = writeEcosystem();
                pm2Silent(`delete ${PROCESS_NAME}`);
                pm2Silent(`start ${ecosystemPath}`);
                pm2Silent("save");
                success("Server restarted with new version.");
            }
        }
    }

    blank();
}

function cmdConfig() {
    banner();

    const settings = loadSettings();
    const account = getCurrentAccount(settings);

    console.log(`  ${c.gray}Config file:${c.reset} ${c.yellow}${SETTINGS_PATH}${c.reset}`);
    blank();
    divider();
    blank();

    if (account) {
        keyValue("Account", `${c.green}${account.name}${c.reset}`);
        keyValue("Agent", `${c.green}${account.AGENT}${c.reset}`);
        keyValue("Provider", `${c.green}${account.PROVIDER}${c.reset}`);
        keyValue("Model", account.MODEL ? `${c.green}${account.MODEL}${c.reset}` : `${c.gray}(not set)${c.reset}`);
        if (account.API_KEY.length > 8) {
            const masked = account.API_KEY.slice(0, 4) + "····" + account.API_KEY.slice(-4);
            keyValue("API_KEY", `${c.green}${masked}${c.reset}`);
        } else if (account.API_KEY) {
            keyValue("API_KEY", `${c.green}${account.API_KEY}${c.reset}`);
        } else {
            keyValue("API_KEY", `${c.gray}(not set)${c.reset}`);
        }
        keyValue("BASE_URL", account.BASE_URL ? `${c.green}${account.BASE_URL}${c.reset}` : `${c.gray}(not set)${c.reset}`);
    } else {
        keyValue("Account", `${c.gray}(not set)${c.reset}`);
    }
    keyValue("Accounts", `${c.white}${settings.accounts?.length ?? 0}${c.reset}`);

    blank();

    if (!account) {
        console.log(`  ${c.gray}Run ${c.green}anycode start${c.gray} to set up.${c.reset}`);
        blank();
    }
}

async function cmdUninstall() {
    banner();

    // 1. Remove from pm2
    if (hasPm2()) {
        const proc = getPm2Process();
        if (proc) {
            step("Stopping and removing daemon");
            pm2Silent(`delete ${PROCESS_NAME}`);
            pm2Silent("save");
            success("Daemon removed.");
        } else {
            info("No daemon running.");
        }
    } else {
        info("No daemon running.");
    }

    // 2. Ask about config
    blank();
    const removeConfig = await prompt(`  ${c.yellow}?${c.reset} ${c.bold}Remove config directory?${c.reset} ${c.gray}(${c.yellow}~/.anycode${c.gray})${c.reset} ${c.gray}(y/N)${c.reset}: `);
    if (removeConfig.toLowerCase() === "y") {
        step("Removing config directory");
        try {
            fs.rmSync(ANYCODE_DIR, { recursive: true, force: true });
            success(`Removed ${ANYCODE_DIR}`);
        } catch {
            warn(`Could not remove ${ANYCODE_DIR}, please delete manually.`);
        }
    } else {
        info(`Config preserved at ${c.yellow}${ANYCODE_DIR}${c.reset}`);
    }

    blank();
    success("Done.");
    blank();
}

function showHelp() {
    banner();

    console.log(`  ${c.bold}${c.white}Usage:${c.reset}  ${c.cyan}anycode${c.reset} ${c.gray}<command>${c.reset}`);
    blank();
    divider();
    blank();

    const commands = [
        ["start",   "Start server as a background daemon"],
        ["stop",    "Stop the server"],
        ["restart", "Restart the server"],
        ["server",  "Run server in foreground (blocking)"],
        ["status",  "Show server status"],
        ["logs",    "Stream server logs"],
        ["config",  "View current configuration"],
        ["update",  "Update to latest version"],
        ["uninstall","Stop daemon and clean up"],
    ];

    for (const [cmd, desc] of commands) {
        console.log(`  ${c.green}${cmd.padEnd(12)}${c.reset}${c.gray}${desc}${c.reset}`);
    }

    blank();
    divider();
    blank();
    console.log(`  ${c.gray}Config:${c.reset}  ${c.yellow}~/.anycode/settings.json${c.reset}`);
    blank();
}

// ── Main ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
    case "start":
        cmdStart();
        break;
    case "stop":
        cmdStop();
        break;
    case "restart":
        cmdRestart();
        break;
    case "status":
        cmdStatus();
        break;
    case "logs":
        cmdLogs();
        break;
    case "server":
        cmdServer();
        break;
    case "config":
        cmdConfig();
        break;
    case "update":
        cmdUpdate();
        break;
    case "uninstall":
        cmdUninstall();
        break;
    case "--help":
    case "-h":
    case undefined:
        showHelp();
        break;
    default:
        banner();
        fail(`Unknown command: ${c.white}${command}${c.reset}`);
        blank();
        console.log(`  ${c.gray}Run ${c.green}anycode --help${c.gray} to see available commands.${c.reset}`);
        blank();
        process.exit(1);
}
