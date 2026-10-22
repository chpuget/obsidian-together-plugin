import { describe, it, expect } from "vitest";
import { applyCoreLegacyMigration } from "./settings-migration";

const LOCAL_URL = "http://localhost:3001";
const PROD_URL  = "https://api.hubfolks.com";

describe("applyCoreLegacyMigration", () => {
  it("returns the input unchanged when accounts array already exists", () => {
    const input = {
      accounts: [{ username: "alice", serverUrl: PROD_URL, userId: "1", token: "tok" }],
      activeAccountIndex: 0,
    };
    const result = applyCoreLegacyMigration(input);
    expect(result.accounts).toEqual(input.accounts);
    expect(result.activeAccountIndex).toBe(0);
  });

  it("converts legacy flat format (authToken + username + serverUrl) to accounts array", () => {
    const input = {
      authToken: "old-jwt",
      username: "carol",
      serverUrl: PROD_URL,
    };
    const result = applyCoreLegacyMigration(input);
    expect(result.accounts).toHaveLength(1);
    expect((result.accounts as any[])[0].username).toBe("carol");
    expect((result.accounts as any[])[0].token).toBe("old-jwt");
    expect((result.accounts as any[])[0].serverUrl).toBe(PROD_URL);
    expect(result.activeAccountIndex).toBe(0);
    expect(result.authToken).toBeUndefined();
    expect(result.username).toBeUndefined();
  });

  it("uses LOCAL_URL when localServer flag is set", () => {
    const input = { authToken: "tok", username: "dave", localServer: true };
    const result = applyCoreLegacyMigration(input);
    expect((result.accounts as any[])[0].serverUrl).toBe(LOCAL_URL);
    expect(result.localServer).toBeUndefined();
  });

  it("falls back to PROD_URL when neither serverUrl nor localServer is set", () => {
    const input = { authToken: "tok", username: "eve" };
    const result = applyCoreLegacyMigration(input);
    expect((result.accounts as any[])[0].serverUrl).toBe(PROD_URL);
  });

  it("removes knownUsernames if present", () => {
    const input = { authToken: "tok", username: "frank", knownUsernames: ["frank", "grace"] };
    const result = applyCoreLegacyMigration(input);
    expect(result.knownUsernames).toBeUndefined();
  });

  it("is a no-op when input has no authToken and no accounts (truly fresh)", () => {
    const input = {};
    const result = applyCoreLegacyMigration(input);
    expect(result).toEqual({});
  });
});

describe('server URL migration (Obsidian Together → HubFolks)', () => {
  const OLD = 'https://obsidian-together-production.up.railway.app';
  const NEW = 'https://api.hubfolks.com';

  it('rewrites old Railway URL in all accounts to new api URL', () => {
    const raw = { accounts: [{ username: 'alice', serverUrl: OLD, token: 'tok', userId: '' }], activeAccountIndex: 0 };
    const out = applyCoreLegacyMigration(raw);
    expect((out.accounts as any[])[0].serverUrl).toBe(NEW);
  });

  it('is idempotent — already-new URL unchanged', () => {
    const raw = { accounts: [{ username: 'alice', serverUrl: NEW, token: 'tok', userId: '' }], activeAccountIndex: 0 };
    const before = JSON.stringify(raw);
    applyCoreLegacyMigration(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('leaves custom self-hosted URLs alone', () => {
    const CUSTOM = 'https://my.selfhosted.example';
    const raw = { accounts: [{ username: 'alice', serverUrl: CUSTOM, token: 'tok', userId: '' }], activeAccountIndex: 0 };
    applyCoreLegacyMigration(raw);
    expect((raw.accounts as any[])[0].serverUrl).toBe(CUSTOM);
  });

  it('handles the legacy flat format AND the URL rewrite together', () => {
    const raw = { authToken: 'tok', username: 'alice', serverUrl: OLD, localServer: false };
    const out = applyCoreLegacyMigration(raw);
    expect((out.accounts as any[])[0].serverUrl).toBe(NEW);
  });
});
