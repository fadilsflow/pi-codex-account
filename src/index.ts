/**
 * codex-accounts — switch between multiple OpenAI Codex (ChatGPT) logins in pi.
 *
 * pi only stores ONE set of `openai-codex` OAuth credentials in auth.json at a
 * time. This extension keeps named snapshots of those credentials in its own
 * store (~/.pi/agent/codex-accounts.json) and lets you swap which one is active.
 *
 * Commands:
 *   /codex                 Interactive: pick an account to switch to
 *   /codex list            List saved accounts (active one marked)
 *   /codex current         Show which account is active right now
 *   /codex save <label>    Snapshot the CURRENT logged-in codex creds
 *   /codex switch <label>  Make <label> the active codex account
 *   /codex usage           Show usage for the active account
 *   /codex rename <a> <b>  Rename account <a> to <b>
 *   /codex remove <label>  Delete a saved account
 *
 * Typical flow:
 *   1. /login openai-codex            (log in to account #1)
 *   2. /codex save work               (snapshot it as "work")
 *   3. /login openai-codex            (log in to account #2 — overwrites auth.json)
 *   4. /codex save personal           (snapshot it as "personal")
 *   5. /codex switch work             (swap back to account #1 — auto reloads)
 *   6. /codex usage                   (show usage for the active account)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_SETTINGS_URL = "https://chatgpt.com/codex/settings/usage";
const DEFAULT_USAGE_TIMEOUT_MS = 15_000;
const BAR_SEGMENTS = 20;
const LIMIT_VALUE_COLUMN = 29;
const MAX_ERROR_BODY_CHARS = 600;

/** Shape of an `openai-codex` OAuth credential as stored in auth.json. */
export interface CodexCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
}

export interface SavedAccount {
  /** The credential snapshot. `expires` is the real expiry from auth.json. */
  credential: CodexCredential;
  /** When this snapshot was saved (ms). */
  savedAt: number;
  /** Last time this account was made active (ms). */
  lastUsedAt?: number;
}

export interface AccountsStore {
  /** label -> account */
  accounts: Record<string, SavedAccount>;
  /** Label of the account last activated via this extension. */
  active?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve pi's agent dir the same way pi does: the PI_CODING_AGENT_DIR override
 * (with ~ expansion), else ~/.pi/agent. We keep both the canonical auth.json
 * and our own accounts store inside it.
 */
function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim().length > 0) {
    const trimmed = override.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
    return trimmed;
  }
  return join(homedir(), ".pi", "agent");
}

function getAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

function getStorePath(): string {
  return join(getAgentDir(), "codex-accounts.json");
}

// ---------------------------------------------------------------------------
// auth.json access
// ---------------------------------------------------------------------------

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf-8").trim();
    if (raw.length === 0) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileSecure(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}

/** Read the currently-active openai-codex credential from auth.json, if any. */
function readActiveCodexCredential(): CodexCredential | undefined {
  const auth = readJsonFile<Record<string, unknown>>(getAuthPath(), {});
  const cred = auth[CODEX_PROVIDER_ID];
  if (
    cred &&
    typeof cred === "object" &&
    (cred as Record<string, unknown>).type === "oauth" &&
    typeof (cred as Record<string, unknown>).access === "string" &&
    typeof (cred as Record<string, unknown>).refresh === "string"
  ) {
    return cred as CodexCredential;
  }
  return undefined;
}

/**
 * Write a codex credential into auth.json as the active openai-codex entry.
 *
 * We set `expires: 0` so pi's in-memory AuthStorage (which caches credentials
 * and only re-reads auth.json from disk on a refresh) treats the token as
 * expired on the next request. That forces a locked refresh, which re-reads the
 * file (picking up this swap) and rotates the access token using the new
 * account's refresh token. The on-disk `refresh` token is the source of truth,
 * so the swapped account becomes active cleanly.
 */
export function writeActiveCodexCredential(credential: CodexCredential): void {
  const authPath = getAuthPath();
  const auth = readJsonFile<Record<string, unknown>>(authPath, {});
  auth[CODEX_PROVIDER_ID] = {
    ...credential,
    type: "oauth",
    // Force pi to refresh-from-disk on next use so the swap takes effect.
    expires: 0,
  };
  writeJsonFileSecure(authPath, auth);
}

// ---------------------------------------------------------------------------
// accounts store access
// ---------------------------------------------------------------------------

export function loadStore(): AccountsStore {
  const store = readJsonFile<Partial<AccountsStore>>(getStorePath(), {});
  return {
    accounts:
      store.accounts && typeof store.accounts === "object"
        ? store.accounts
        : {},
    active: typeof store.active === "string" ? store.active : undefined,
  };
}

export function saveStore(store: AccountsStore): void {
  writeJsonFileSecure(getStorePath(), store);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function shortAccountId(credential: CodexCredential | undefined): string {
  const id = credential?.accountId;
  if (!id || typeof id !== "string") return "unknown account";
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatExpiry(expires: number): string {
  if (!expires || expires <= 0) return "needs refresh";
  const now = Date.now();
  if (expires <= now) return "expired";
  const mins = Math.round((expires - now) / 60000);
  if (mins < 60) return `~${mins}m left`;
  const hours = Math.round(mins / 60);
  return `~${hours}h left`;
}

/**
 * Determine which saved label matches the credential currently in auth.json.
 * Matches on accountId first (stable), then on refresh token.
 */
export function detectActiveLabel(
  store: AccountsStore,
  active: CodexCredential | undefined,
): string | undefined {
  if (!active) return undefined;
  for (const [label, acct] of Object.entries(store.accounts)) {
    const c = acct.credential;
    if (
      active.accountId &&
      c.accountId &&
      active.accountId === c.accountId
    ) {
      return label;
    }
  }
  // Fallback: match by refresh token (account may not expose accountId).
  for (const [label, acct] of Object.entries(store.accounts)) {
    if (acct.credential.refresh === active.refresh) return label;
  }
  return store.active;
}

function summarizeAccount(label: string, acct: SavedAccount): string {
  const id = shortAccountId(acct.credential);
  const exp = formatExpiry(acct.credential.expires);
  return `${label} — ${id} (${exp})`;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function doList(ctx: ExtensionCommandContext): void {
  const store = loadStore();
  const labels = Object.keys(store.accounts).sort();
  const active = readActiveCodexCredential();
  const activeLabel = detectActiveLabel(store, active);

  if (labels.length === 0) {
    ctx.ui.notify(
      "No saved Codex accounts. Use /codex save <label> while logged in.",
      "info",
    );
    return;
  }

  const lines = labels.map((label) => {
    const marker = label === activeLabel ? "● " : "  ";
    return marker + summarizeAccount(label, store.accounts[label]!);
  });
  ctx.ui.setWidget("codex-accounts", [
    "Codex accounts (● = active):",
    ...lines,
  ]);
  ctx.ui.notify(
    `${labels.length} saved Codex account(s). Active: ${activeLabel ?? "unknown"}.`,
    "info",
  );
}

function doCurrent(ctx: ExtensionCommandContext): void {
  const store = loadStore();
  const active = readActiveCodexCredential();
  if (!active) {
    ctx.ui.notify(
      "No openai-codex credentials in auth.json. Run /login openai-codex first.",
      "warning",
    );
    return;
  }
  const label = detectActiveLabel(store, active);
  ctx.ui.notify(
    `Active Codex account: ${label ?? "(unsaved)"} — ${shortAccountId(active)} (${formatExpiry(active.expires)}).`,
    "info",
  );
}

function doSave(ctx: ExtensionCommandContext, label: string): void {
  if (!label) {
    ctx.ui.notify("Usage: /codex save <label>", "warning");
    return;
  }
  const active = readActiveCodexCredential();
  if (!active) {
    ctx.ui.notify(
      "No openai-codex credentials to save. Run /login openai-codex first.",
      "warning",
    );
    return;
  }
  const store = loadStore();
  const existed = label in store.accounts;
  store.accounts[label] = {
    credential: { ...active, type: "oauth" },
    savedAt: Date.now(),
    lastUsedAt: store.accounts[label]?.lastUsedAt,
  };
  // The thing we just saved is the active one.
  store.active = label;
  saveStore(store);
  ctx.ui.notify(
    `${existed ? "Updated" : "Saved"} Codex account "${label}" — ${shortAccountId(active)}.`,
    "info",
  );
}

async function doSwitch(
  ctx: ExtensionCommandContext,
  label: string,
): Promise<void> {
  const store = loadStore();
  const acct = store.accounts[label];
  if (!acct) {
    const known = Object.keys(store.accounts).sort().join(", ") || "(none)";
    ctx.ui.notify(
      `No saved account "${label}". Known accounts: ${known}.`,
      "warning",
    );
    return;
  }

  // Before clobbering auth.json, auto-snapshot the currently-active account so
  // we don't lose its (possibly rotated) tokens.
  const active = readActiveCodexCredential();
  if (active) {
    const activeLabel = detectActiveLabel(store, active);
    if (activeLabel && store.accounts[activeLabel]) {
      store.accounts[activeLabel] = {
        ...store.accounts[activeLabel]!,
        credential: { ...active, type: "oauth" },
      };
    }
  }

  writeActiveCodexCredential(acct.credential);
  acct.lastUsedAt = Date.now();
  store.active = label;
  saveStore(store);

  ctx.ui.notify(
    `Switched to Codex account "${label}" — ${shortAccountId(acct.credential)}. Reloading…`,
    "info",
  );

  // Reload so the model registry / providers re-resolve. The next Codex API
  // call triggers a token refresh that re-reads auth.json from disk.
  await ctx.reload();
}

function doRename(
  ctx: ExtensionCommandContext,
  from: string,
  to: string,
): void {
  if (!from || !to) {
    ctx.ui.notify("Usage: /codex rename <old> <new>", "warning");
    return;
  }
  const store = loadStore();
  if (!store.accounts[from]) {
    ctx.ui.notify(`No saved account "${from}".`, "warning");
    return;
  }
  if (store.accounts[to]) {
    ctx.ui.notify(`Account "${to}" already exists.`, "warning");
    return;
  }
  store.accounts[to] = store.accounts[from]!;
  delete store.accounts[from];
  if (store.active === from) store.active = to;
  saveStore(store);
  ctx.ui.notify(`Renamed Codex account "${from}" → "${to}".`, "info");
}

async function doUsage(ctx: ExtensionCommandContext): Promise<void> {
  const active = readActiveCodexCredential();
  if (!active) {
    ctx.ui.notify(
      "No openai-codex credentials in auth.json. Run /login openai-codex first.",
      "warning",
    );
    return;
  }

  if (active.expires > 0 && active.expires <= Date.now()) {
    ctx.ui.notify(
      "The active Codex access token is expired. Send one Codex model request first so pi refreshes it, then run /codex usage again.",
      "warning",
    );
    return;
  }

  // Do not write usage to the footer/statusline. The full terminal output is
  // the source of truth; footer summaries can be misleading for multi-window
  // limits.
  ctx.ui.setStatus("codex-accounts-usage", undefined);
  try {
    const report = await queryCodexUsage(active, DEFAULT_USAGE_TIMEOUT_MS);
    ctx.ui.notify(formatUsageReport(report, active), "info");
  } catch (error) {
    ctx.ui.notify(`Unable to read Codex usage: ${errorMessage(error)}`, "error");
  }
}

export type UsageReport = {
  capturedAt: number;
  planType?: string;
  snapshots: UsageSnapshot[];
};

export type UsageSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: UsageCredits;
};

export type UsageWindow = {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
};

export type UsageCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

async function queryCodexUsage(
  credential: CodexCredential,
  timeoutMs: number,
): Promise<UsageReport> {
  const response = await fetchWithTimeout(
    CODEX_USAGE_URL,
    {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "User-Agent": "pi-codex-accounts",
      },
    },
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
    );
  }

  const payload = parseJsonObject(text, "Codex usage endpoint response");
  return normalizeUsagePayload(payload, Date.now());
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeUsagePayload(
  payload: Record<string, unknown>,
  capturedAt: number,
): UsageReport {
  const snapshots: UsageSnapshot[] = [];
  const planType = asString(payload.plan_type);

  const primary = normalizeUsageSnapshot(
    "codex",
    undefined,
    payload.rate_limit,
    payload.credits,
  );
  if (primary) snapshots.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const item of additional) {
    const additionalLimit = assertObject(item, "additional rate limit");
    const limitId =
      asString(additionalLimit.metered_feature) ??
      asString(additionalLimit.limit_name);
    if (!limitId) continue;
    const snapshot = normalizeUsageSnapshot(
      limitId,
      asString(additionalLimit.limit_name),
      additionalLimit.rate_limit,
      undefined,
    );
    if (snapshot) snapshots.push(snapshot);
  }

  if (snapshots.length === 0) {
    throw new Error("usage endpoint returned no displayable rate-limit windows");
  }

  return { capturedAt, planType, snapshots };
}

function normalizeUsageSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
  credits: unknown,
): UsageSnapshot | undefined {
  const normalizedCredits = normalizeUsageCredits(credits);
  if (rateLimit === null || rateLimit === undefined) {
    return normalizedCredits ? { limitId, limitName, credits: normalizedCredits } : undefined;
  }

  const details = assertObject(rateLimit, "rate limit");
  const primary = normalizeUsageWindow(details.primary_window);
  const secondary = normalizeUsageWindow(details.secondary_window);
  if (!primary && !secondary && !normalizedCredits) return undefined;
  return { limitId, limitName, primary, secondary, credits: normalizedCredits };
}

function normalizeUsageWindow(value: unknown): UsageWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "rate-limit window");
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const limitSeconds = asNumber(window.limit_window_seconds);
  const resetsAt = asNumber(window.reset_at);
  return {
    usedPercent,
    windowMinutes: limitSeconds && limitSeconds > 0 ? Math.ceil(limitSeconds / 60) : undefined,
    resetsAt,
  };
}

function normalizeUsageCredits(value: unknown): UsageCredits | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = assertObject(value, "credits");
  const hasCredits = asBoolean(credits.has_credits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

export function formatUsageReport(
  report: UsageReport,
  credential: CodexCredential,
): string {
  const lines = [
    `Codex usage — ${shortAccountId(credential)}`,
    report.planType ? `Plan: ${formatPlanType(report.planType)}` : undefined,
    `Captured: ${new Date(report.capturedAt).toLocaleString()}`,
    `Details: ${USAGE_SETTINGS_URL}`,
    "",
  ].filter((line): line is string => Boolean(line));

  for (const snapshot of report.snapshots) {
    const label = snapshot.limitName ?? snapshot.limitId;
    if (!isPrimaryUsageSnapshot(snapshot)) lines.push(`${label} limit:`);
    if (snapshot.primary) lines.push(formatUsageWindowLine("5h limit:", snapshot.primary));
    if (snapshot.secondary) lines.push(formatUsageWindowLine("Weekly limit:", snapshot.secondary));
    if (!snapshot.primary && !snapshot.secondary) lines.push("Limits unavailable for this account");
    if (snapshot.credits) lines.push(`Credits: ${formatCredits(snapshot.credits)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function isPrimaryUsageSnapshot(snapshot: UsageSnapshot): boolean {
  return normalizedUsageKey(snapshot.limitId) === "codex" || normalizedUsageKey(snapshot.limitName) === "codex";
}

function formatUsageWindowLine(label: string, window: UsageWindow): string {
  return `${label.padEnd(LIMIT_VALUE_COLUMN)}${formatUsageWindow(window)}`;
}

function formatUsageWindow(window: UsageWindow): string {
  const remaining = 100 - clampPercent(window.usedPercent);
  const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt)})` : "";
  return `${progressBar(remaining)} ${remaining.toFixed(0)}% left${reset}`;
}

function progressBar(percentRemaining: number): string {
  const filled = Math.round((clampPercent(percentRemaining) / 100) * BAR_SEGMENTS);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function formatCredits(credits: UsageCredits): string {
  if (!credits.hasCredits) return "no credits";
  if (credits.unlimited) return "unlimited credits";
  const balance = credits.balance?.trim();
  if (!balance) return "credits available";
  return `${formatNumber(Number(balance), balance)} credits`;
}

function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "at an unknown time";
  const now = new Date();
  const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  if (reset.toDateString() === now.toDateString()) return time;
  const day = reset.getDate().toString();
  const month = reset.toLocaleDateString(undefined, { month: "short" });
  return `${time} on ${day} ${month}`;
}

function formatPlanType(planType: string): string {
  const key = planType
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (key === "pro_lite" || key === "prolite") return "Pro Lite";
  if (key === "team" || key === "self_serve_business_usage_based" || key === "business") return "Business";
  if (key === "enterprise_cbp_usage_based") return "Enterprise";
  return planType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function parseJsonObject(text: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${description} was not valid JSON: ${errorMessage(error)}`);
  }
  return assertObject(parsed, description);
}

function assertObject(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatNumber(value: number, fallback: string): string {
  if (!Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function doRemove(ctx: ExtensionCommandContext, label: string): void {
  if (!label) {
    ctx.ui.notify("Usage: /codex remove <label>", "warning");
    return;
  }
  const store = loadStore();
  if (!store.accounts[label]) {
    ctx.ui.notify(`No saved account "${label}".`, "warning");
    return;
  }
  delete store.accounts[label];
  if (store.active === label) store.active = undefined;
  saveStore(store);
  ctx.ui.notify(
    `Removed Codex account "${label}". (auth.json was not modified.)`,
    "info",
  );
}

async function doInteractive(ctx: ExtensionCommandContext): Promise<void> {
  const store = loadStore();
  const labels = Object.keys(store.accounts).sort();
  if (labels.length === 0) {
    ctx.ui.notify(
      "No saved Codex accounts yet. Log in (/login openai-codex), then run /codex save <label>.",
      "info",
    );
    return;
  }
  const active = readActiveCodexCredential();
  const activeLabel = detectActiveLabel(store, active);

  const options = labels.map((label) => {
    const marker = label === activeLabel ? "● " : "  ";
    return marker + summarizeAccount(label, store.accounts[label]!);
  });

  const choice = await ctx.ui.select("Switch to Codex account:", options);
  if (!choice) return;
  const idx = options.indexOf(choice);
  if (idx < 0) return;
  const label = labels[idx]!;
  if (label === activeLabel) {
    ctx.ui.notify(`"${label}" is already active.`, "info");
    return;
  }
  await doSwitch(ctx, label);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function tokenize(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const clearUsageStatuslines = (ctx: ExtensionCommandContext | ExtensionContext) => {
    ctx.ui.setStatus("codex-accounts-usage", undefined);
  };

  pi.on("session_start", (_event, ctx) => clearUsageStatuslines(ctx));
  pi.on("model_select", (_event, ctx) => clearUsageStatuslines(ctx));
  pi.on("session_shutdown", (_event, ctx) => clearUsageStatuslines(ctx));

  const command = {
    description:
      "Switch between multiple OpenAI Codex logins and show usage (save/switch/usage/list/current/rename/remove)",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        "list",
        "current",
        "save",
        "switch",
        "usage",
        "rename",
        "remove",
      ];
      const tokens = prefix.split(/\s+/);
      // Completing the subcommand itself.
      if (tokens.length <= 1) {
        const items = subcommands
          .filter((s) => s.startsWith(tokens[0] ?? ""))
          .map((s) => ({ value: s, label: s }));
        return items.length > 0 ? items : null;
      }
      // Completing a label for switch/rename/remove. Pi replaces the full
      // command argument string with the selected completion value, so include
      // the subcommand prefix. Returning only the label would turn
      // `/codex rename old new` into `/codex old`.
      const sub = tokens[0];
      if (sub === "switch" || sub === "remove" || sub === "rename") {
        // Do not complete the new name in `rename <old> <new>`; it is free text.
        if (sub === "rename" && tokens.length > 2) return null;

        const labelPrefix = tokens[1] ?? "";
        const labels = Object.keys(loadStore().accounts).sort();
        const items = labels
          .filter((l) => l.startsWith(labelPrefix))
          .map((l) => ({ value: `${sub} ${l}`, label: l }));
        return items.length > 0 ? items : null;
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = tokenize(args);
      const sub = (tokens[0] ?? "").toLowerCase();

      switch (sub) {
        case "":
          await doInteractive(ctx);
          return;
        case "list":
        case "ls":
          doList(ctx);
          return;
        case "current":
        case "active":
          doCurrent(ctx);
          return;
        case "save":
          doSave(ctx, tokens[1] ?? "");
          return;
        case "switch":
        case "use":
          await doSwitch(ctx, tokens[1] ?? "");
          return;
        case "usage":
        case "status":
          await doUsage(ctx);
          return;
        case "rename":
        case "mv":
          doRename(ctx, tokens[1] ?? "", tokens[2] ?? "");
          return;
        case "remove":
        case "rm":
        case "delete":
          doRemove(ctx, tokens[1] ?? "");
          return;
        default:
          // Treat a bare unknown token as a label to switch to.
          await doSwitch(ctx, tokens[0]!);
          return;
      }
    },
  };

  pi.registerCommand("codex", command);
  // Backward-compatible alias for users who installed earlier local builds.
  pi.registerCommand("codex-account", {
    ...command,
    description: "Alias for /codex",
  });
}
