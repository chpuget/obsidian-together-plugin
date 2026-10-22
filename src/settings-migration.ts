const LOCAL_URL = "http://localhost:3001";
const LEGACY_PROD_URL = "https://obsidian-together-production.up.railway.app";
const PROD_URL = "https://api.hubfolks.com";

/**
 * Transforms a raw data.json payload from the legacy flat format
 * (authToken / username / serverUrl / localServer) into the current
 * accounts-array format. No-op when accounts array already present.
 * Mutates and returns the input object.
 */
export function applyCoreLegacyMigration(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.accounts) && raw.authToken) {
    const serverUrl = raw.localServer
      ? LOCAL_URL
      : String(raw.serverUrl ?? PROD_URL);
    raw.accounts = [{
      username: String(raw.username ?? ""),
      serverUrl,
      userId: "",
      token: String(raw.authToken),
      displayName: undefined,
    }];
    raw.activeAccountIndex = 0;
    delete raw.authToken;
    delete raw.username;
    delete raw.localServer;
    delete raw.serverUrl;
    delete raw.knownUsernames;
  }
  if (Array.isArray(raw.accounts)) {
    for (const acc of raw.accounts as Array<Record<string, unknown>>) {
      if (acc && acc.serverUrl === LEGACY_PROD_URL) acc.serverUrl = PROD_URL;
    }
  }
  return raw;
}
