import { describe, it, expect } from "vitest";
import { deriveCodeChallenge, encodeState, randomVerifier } from "./pkce";

describe("pkce", () => {
  it("derives the RFC 7636 S256 challenge", async () => {
    expect(await deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a 43-char base64url verifier, different each time", () => {
    const a = randomVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomVerifier()).not.toBe(a);
  });

  it("encodes state as base64url JSON { n, v }", () => {
    const state = encodeState("nonce1", "My Vault");
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(state, "base64url").toString())).toEqual({ n: "nonce1", v: "My Vault" });
  });
});
