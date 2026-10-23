import type { AuthCapabilities, TogetherSettings } from "../types";

/** Where the welcome flow sends the user to sign in. */
export type WelcomeMode = "web" | "offline" | "settings";

/** What the `obsidian://hubfolks?action=login` link should open. */
export type LoginAction = "welcome" | "settings";

/** The welcome modal is shown until at least one account is saved. */
export function shouldShowWelcome(settings: Pick<TogetherSettings, "accounts">): boolean {
  return settings.accounts.length === 0;
}

/** Pick the sign-in path from the server's capabilities. */
export function welcomeMode(caps: AuthCapabilities | "unreachable"): WelcomeMode {
  if (caps === "unreachable") return "offline";
  if (caps.webFlow && caps.webUrl !== "") return "web";
  return "settings";
}

/** A first setup is needed until the `community` plugin is installed. */
export function needsFirstSetup(installed: { id: string }[]): boolean {
  return !installed.some((plugin) => plugin.id === "community");
}

/** Logged-out users get the welcome flow; logged-in users go straight to settings. */
export function loginLinkAction(isLoggedIn: boolean): LoginAction {
  return isLoggedIn ? "settings" : "welcome";
}
