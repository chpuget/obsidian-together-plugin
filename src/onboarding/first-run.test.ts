import { describe, it, expect } from "vitest";
import {
  shouldShowWelcome,
  welcomeMode,
  needsFirstSetup,
  loginLinkAction,
  isLoginLink,
} from "./first-run";

describe("shouldShowWelcome", () => {
  it("true with no saved account", () => expect(shouldShowWelcome({ accounts: [] })).toBe(true));
  it("false with a saved account", () => expect(shouldShowWelcome({ accounts: [{} as any] })).toBe(false));
});
describe("welcomeMode", () => {
  it("offline when unreachable", () => expect(welcomeMode("unreachable")).toBe("offline"));
  it("web when the server offers the web flow", () => expect(welcomeMode({ webFlow: true, webUrl: "https://www.hubfolks.com" })).toBe("web"));
  it("settings when the server has no web flow", () => expect(welcomeMode({ webFlow: false, webUrl: "" })).toBe("settings"));
  it("settings when webUrl is empty", () => expect(welcomeMode({ webFlow: true, webUrl: "" })).toBe("settings"));
});
describe("needsFirstSetup", () => {
  it("true without community", () => expect(needsFirstSetup([])).toBe(true));
  it("false with community", () => expect(needsFirstSetup([{ id: "community" }])).toBe(false));
});
describe("loginLinkAction", () => {
  it("welcome when logged out", () => expect(loginLinkAction(false)).toBe("welcome"));
  it("settings when logged in", () => expect(loginLinkAction(true)).toBe("settings"));
});
describe("isLoginLink", () => {
  it("true for open=login (real Obsidian shape)", () => expect(isLoginLink({ action: "hubfolks", open: "login" })).toBe(true));
  it("false without open", () => expect(isLoginLink({ action: "hubfolks" })).toBe(false));
  it("false for another open value", () => expect(isLoginLink({ action: "hubfolks", open: "other" })).toBe(false));
});
