// PKCE helpers for the browser sign-in flow (same scheme as the music-band YouTube flow).
// Uses Web Crypto only, so it works on desktop and mobile Obsidian.

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** 32 random bytes, base64url (43 chars). */
export function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** S256 code challenge: base64url(SHA-256(verifier)). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

/** `state` carries a nonce plus the vault name, so the web page's deep link reopens the right vault. */
export function encodeState(nonce: string, vaultName: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify({ n: nonce, v: vaultName })));
}
