import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createOpenBotLogger } from "../packages/logging/src";
import { selectMobileConnectLanAddress } from "./dev-services";

const logger = createOpenBotLogger("selfhost");
const projectRoot = resolve(import.meta.dirname, "..");
const UPSTREAM_REPO_URL = "https://github.com/nightly-labs/openbot.git";

function buildSelfHostPath(): string {
  const home = homedir();
  const preferredDirs = [
    join(home, ".local/bin"),
    join(home, ".hermes/node/bin"),
    join(home, ".bun/bin"),
    join(home, ".config/OpenBot/provider-runtimes/bun/linux-x64/1.4.4/bin"),
  ].filter((dir) => existsSync(dir));
  const currentPath = process.env.PATH ?? "";
  return [...preferredDirs, currentPath].filter(Boolean).join(delimiter);
}

function ensureLinuxChromeSandbox(): void {
  if (process.platform !== "linux") return;
  const localSandbox = join(projectRoot, "node_modules/electron/dist/chrome-sandbox");
  try {
    if (existsSync(localSandbox)) {
      const st = statSync(localSandbox);
      if (st.uid === 0 && (st.mode & 0o4000) !== 0) {
        process.env.CHROME_DEVEL_SANDBOX ??= localSandbox;
        return;
      }
    }
  } catch {
    // Fall through to link a system SUID chrome-sandbox if available.
  }

  const systemCandidates = [
    "/usr/share/antigravity/chrome-sandbox",
    "/opt/google/chrome/chrome-sandbox",
    "/usr/lib/chromium/chrome-sandbox",
  ];
  for (const candidate of systemCandidates) {
    try {
      if (!existsSync(candidate)) continue;
      const st = statSync(candidate);
      if (st.uid === 0 && (st.mode & 0o4000) !== 0) {
        if (existsSync(localSandbox)) unlinkSync(localSandbox);
        symlinkSync(candidate, localSandbox);
        process.env.CHROME_DEVEL_SANDBOX ??= candidate;
        return;
      }
    } catch {
      // Ignore and try next candidate.
    }
  }
}

function runCommandChecked(command: string, args: string[], description: string): string {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(`${description} failed (exit ${result.status ?? 1})${stderr ? `: ${stderr}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

function runCommandInherited(command: string, args: string[], description: string): void {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? 1}.`);
  }
}

async function clearStaleLocalSignalHomes(): Promise<void> {
  const d1Dir = join(projectRoot, "apps/auth-api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) return;
  const { Database } = await import("bun:sqlite");
  for (const file of readdirSync(d1Dir)) {
    if (!file.endsWith(".sqlite")) continue;
    const db = new Database(join(d1Dir, file));
    try {
      const hasTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_hosts'").get();
      if (hasTable) {
        db.exec("UPDATE remote_hosts SET signal_home = NULL WHERE signal_home IS NOT NULL;");
        db.exec("DELETE FROM remote_auth_events;");
      }
    } finally {
      db.close();
    }
  }
}

async function hasLocalMarketplaceAgents(): Promise<boolean> {
  const d1Dir = join(projectRoot, "apps/auth-api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(d1Dir)) return false;
  const { Database } = await import("bun:sqlite");
  for (const file of readdirSync(d1Dir)) {
    if (!file.endsWith(".sqlite")) continue;
    const db = new Database(join(d1Dir, file));
    try {
      const hasTable = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='marketplace_agents'")
        .get();
      if (hasTable) {
        const row = db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM marketplace_agents WHERE approved_version_id IS NOT NULL",
          )
          .get();
        if ((row?.count ?? 0) > 0) return true;
      }
    } finally {
      db.close();
    }
  }
  return false;
}

async function ensureLocalMarketplaceCatalog(force = false): Promise<void> {
  if (!force && (await hasLocalMarketplaceAgents())) return;
  logger.info("Seeding local Marketplace catalog (Agents & Skills)...");
  runCommandInherited(process.execPath, ["run", "marketplace:seed:local"], "Seeding local Marketplace catalog");
}

async function syncWithUpstream(): Promise<void> {
  logger.info("Checking official upstream repository for updates...");
  const remotes = runCommandChecked("git", ["remote"], "Listing git remotes")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!remotes.includes("upstream")) {
    runCommandChecked("git", ["remote", "add", "upstream", UPSTREAM_REPO_URL], "Adding upstream remote");
  } else {
    runCommandChecked("git", ["remote", "set-url", "upstream", UPSTREAM_REPO_URL], "Updating upstream remote URL");
  }

  runCommandInherited("git", ["fetch", "upstream", "main"], "Fetching upstream/main");

  const behindCount = Number(
    runCommandChecked("git", ["rev-list", "--count", "HEAD..upstream/main"], "Checking new upstream commits"),
  );
  const latestCommit = runCommandChecked(
    "git",
    ["log", "-1", "--format=%h (%ci) %s", "upstream/main"],
    "Reading latest upstream commit",
  );

  if (behindCount === 0) {
    logger.info(`Already up to date with official upstream: ${latestCommit}`);
  } else {
    logger.info(`Found ${behindCount} new commit(s) from official upstream. Latest: ${latestCommit}`);
    const statusOutput = runCommandChecked(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      "Checking working tree status",
    );
    const stashed = statusOutput.length > 0;
    if (stashed) {
      logger.info("Stashing local self-host modifications before rebasing...");
      runCommandInherited("git", ["stash", "push", "-m", "openbot-selfhost-auto-sync"], "Stashing local changes");
    }
    try {
      logger.info("Rebasing onto upstream/main...");
      runCommandInherited("git", ["rebase", "upstream/main"], "Rebasing onto upstream/main");
    } finally {
      if (stashed) {
        logger.info("Re-applying local self-host modifications...");
        runCommandInherited("git", ["stash", "pop"], "Restoring local self-host modifications");
      }
    }
    logger.info("Installing updated dependencies...");
    runCommandInherited(process.execPath, ["install"], "Installing dependencies with Bun");
  }

  logger.info("Ensuring local D1 database migrations are up to date...");
  runCommandInherited(process.execPath, ["run", "api:migrate:local"], "Applying local D1 migrations");
  await ensureLocalMarketplaceCatalog(behindCount > 0);
  await clearStaleLocalSignalHomes();
  ensureLinuxChromeSandbox();
  logger.info("Self-hosted OpenBot is synced and ready.");
}

async function main(): Promise<void> {
  process.env.PATH = buildSelfHostPath();
  ensureLinuxChromeSandbox();
  const rawArgs = process.argv.slice(2);
  const shouldSync =
    rawArgs[0] === "sync" ||
    rawArgs.includes("--sync") ||
    process.env.OPENBOT_AUTO_SYNC === "1" ||
    process.env.OPENBOT_AUTO_SYNC === "true";

  if (shouldSync) {
    await syncWithUpstream();
    if (rawArgs[0] === "sync") {
      return;
    }
  } else {
    await ensureLocalMarketplaceCatalog(false);
  }

  const args = rawArgs.filter((arg) => arg !== "--sync");
  const mode = args[0] === "web" || args[0] === "api" ? "web" : args[0] === "app" ? "app" : defaultTarget();
  const restArgs = args[0] === "web" || args[0] === "api" || args[0] === "app" ? args.slice(1) : args;

  const lanAddress = process.env.OPENBOT_PUBLIC_HOST?.trim() || selectMobileConnectLanAddress(networkInterfaces());
  const apiPort = process.env.OPENBOT_API_PORT?.trim() || "3100";
  const signalPort = process.env.REMOTE_SIGNAL_PORT?.trim() || "3101";
  const publicHost = lanAddress ?? "127.0.0.1";

  logger.info("============================================================");
  logger.info("OpenBot 100% Self-Hosted Stack");
  logger.info(
    `Mode:              ${mode === "web" ? "Control Plane + WebUI + Signal (web)" : "Full Stack + Desktop Host (app)"}`,
  );
  logger.info(`WebUI (Local):     http://127.0.0.1:${apiPort}/app`);
  if (lanAddress) {
    logger.info(`WebUI (LAN/VPN):   http://${lanAddress}:${apiPort}/app`);
  }
  logger.info(`Account API URL:   http://${publicHost}:${apiPort}`);
  logger.info(`Signal WebSocket:  ws://${publicHost}:${signalPort}/v1/signal`);
  logger.info("Login OTP Mode:    Displayed directly on screen (unless SMTP is configured)");
  logger.info("Upstream Sync:     Run `bun scripts/selfhost.ts sync` or pass `--sync`");
  logger.info("============================================================");

  const child = spawn(process.execPath, [resolve(projectRoot, "scripts/dev-services.ts"), mode, ...restArgs], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: process.env.PATH,
      OPENBOT_API_HOST: process.env.OPENBOT_API_HOST ?? "0.0.0.0",
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function defaultTarget(): "web" | "app" {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "web";
  }
  return "app";
}

void main();
