import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectActiveLabel,
  formatUsageReport,
  loadStore,
  normalizeUsagePayload,
  saveStore,
  tokenize,
  writeActiveCodexCredential,
  type AccountsStore,
  type CodexCredential,
} from "../src/index";

let previousAgentDir: string | undefined;
let agentDir: string;

const credential = (suffix: string): CodexCredential => ({
  type: "oauth",
  access: `ACCESS_${suffix}`,
  refresh: `REFRESH_${suffix}`,
  expires: 4_102_444_800_000,
  accountId: `acct_${suffix}`,
});

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "pi-codex-accounts-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("account store", () => {
  test("loadStore returns an empty store when no file exists", () => {
    expect(loadStore()).toEqual({ accounts: {}, active: undefined });
  });

  test("saveStore persists accounts", () => {
    const store: AccountsStore = {
      accounts: {
        work: { credential: credential("WORK"), savedAt: 123 },
      },
      active: "work",
    };

    saveStore(store);

    expect(loadStore()).toEqual(store);
  });

  test("detectActiveLabel matches by accountId first", () => {
    const store: AccountsStore = {
      accounts: {
        work: { credential: credential("WORK"), savedAt: 1 },
        home: { credential: credential("HOME"), savedAt: 2 },
      },
      active: "home",
    };

    expect(detectActiveLabel(store, { ...credential("WORK"), refresh: "rotated" })).toBe("work");
  });

  test("detectActiveLabel falls back to refresh token", () => {
    const work = credential("WORK");
    delete work.accountId;
    const active = { ...work };
    const store: AccountsStore = {
      accounts: { work: { credential: work, savedAt: 1 } },
    };

    expect(detectActiveLabel(store, active)).toBe("work");
  });
});

describe("auth switching", () => {
  test("writeActiveCodexCredential preserves other auth entries and forces refresh", () => {
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "secret" } }, null, 2),
    );

    writeActiveCodexCredential(credential("WORK"));

    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    expect(auth.anthropic).toEqual({ type: "api_key", key: "secret" });
    expect(auth["openai-codex"].refresh).toBe("REFRESH_WORK");
    expect(auth["openai-codex"].expires).toBe(0);
  });
});

describe("usage normalization", () => {
  test("normalizes and formats backend usage payload", () => {
    const report = normalizeUsagePayload(
      {
        plan_type: "pro_lite",
        rate_limit: {
          primary_window: {
            used_percent: 25,
            reset_at: 1_700_000_000,
          },
          secondary_window: {
            used_percent: 50,
            reset_at: 1_700_100_000,
          },
        },
        credits: {
          has_credits: true,
          unlimited: false,
          balance: "12.5",
        },
      },
      1_700_000_000_000,
    );

    expect(report.planType).toBe("pro_lite");
    expect(report.snapshots).toHaveLength(1);
    expect(report.snapshots[0]?.primary?.usedPercent).toBe(25);

    const formatted = formatUsageReport(report, credential("WORK"));
    expect(formatted).toContain("Codex usage");
    expect(formatted).toContain("Plan: Pro Lite");
    expect(formatted).toContain("5h limit:");
    expect(formatted).toContain("Weekly limit:");
    expect(formatted).toContain("75% left");
    expect(formatted).toContain("12.5 credits");
  });
});

describe("argument parsing", () => {
  test("tokenize trims and splits whitespace", () => {
    expect(tokenize("  switch   work  ")).toEqual(["switch", "work"]);
  });
});
