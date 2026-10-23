import { App, Modal, Setting } from "obsidian";
import type HubFolksPlugin from "../main";
import { OFFLINE_MESSAGE } from "../settings/SettingsTab";
import { welcomeMode } from "./first-run";

type SignInMode = "signin" | "signup";

/** First-run window: sign in or create an account through the browser. */
export class WelcomeModal extends Modal {
  /** Set by the owner to release its reference once the window is closed. */
  onClosed: (() => void) | null = null;

  private pending = false;
  private closed = false;
  private errorEl!: HTMLElement;
  private row!: Setting;
  private offline = false;

  private readonly onAccountSwitched = ({ username }: { username: string | null }) => {
    if (username) this.close();
  };

  constructor(app: App, private plugin: HubFolksPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const api = this.plugin.togetherAPI;
    api.events.on("together:account-switched", this.onAccountSwitched);

    this.titleEl.setText("Welcome to HubFolks");
    this.contentEl.createEl("p", { text: "Sign in or create an account to start using HubFolks." });
    this.errorEl = this.contentEl.createEl("p");
    this.errorEl.style.cssText = "display:none; color:var(--text-error);";
    this.row = new Setting(this.contentEl);

    const mode = welcomeMode(await api.getAuthCapabilities());
    if (this.closed) return;
    if (mode === "settings") {
      this.close();
      this.plugin.openSettingsTab();
      return;
    }
    this.offline = mode === "offline";
    this.renderButtons();
    if (this.offline) {
      this.contentEl.createEl("p", { text: OFFLINE_MESSAGE }).style.color = "var(--text-muted)";
    }
  }

  onClose(): void {
    this.closed = true;
    this.plugin.togetherAPI.events.off("together:account-switched", this.onAccountSwitched);
    if (this.pending) {
      this.pending = false;
      this.plugin.togetherAPI.cancelWebSignIn?.();
    }
    this.contentEl.empty();
    this.onClosed?.();
  }

  private renderButtons(): void {
    this.row.clear();
    this.row
      .addButton(btn => btn.setButtonText("Sign in").setCta().setDisabled(this.offline).onClick(() => this.start("signin")))
      .addButton(btn => btn.setButtonText("Create an account").setDisabled(this.offline).onClick(() => this.start("signup")));
  }

  private start(mode: SignInMode): void {
    this.errorEl.style.display = "none";
    this.pending = true;
    this.row.clear();
    this.row.setName("Waiting for browser…")
      .addButton(btn => btn.setButtonText("Cancel").onClick(() => this.plugin.togetherAPI.cancelWebSignIn?.()));
    this.plugin.togetherAPI.startWebSignIn(mode).then(
      () => { this.pending = false; },
      (err) => {
        this.pending = false;
        if (this.closed) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Cancelled") {
          this.errorEl.textContent = msg;
          this.errorEl.style.display = "";
        }
        this.row.setName("");
        this.renderButtons();
      },
    );
  }
}
