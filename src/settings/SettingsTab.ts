import { App, Notice, Platform, PluginSettingTab, Setting, setIcon } from "obsidian";
import type ObsidianTogetherPlugin from "../main";

const LOCAL_URL = "http://localhost:3001";
const PROD_URL  = "https://obsidian-together-production.up.railway.app";

const CARD_STYLE_ID = "together-settings-card-style";

function injectCardStyles(): void {
  if (document.getElementById(CARD_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CARD_STYLE_ID;
  style.textContent = `
    .together-card {
      border: 1px solid var(--background-modifier-border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    .together-card .setting-item {
      border-top: none !important;
      border-bottom: 1px solid var(--background-modifier-border);
    }
    .together-card .setting-item:last-child {
      border-bottom: none;
    }
  `;
  document.head.appendChild(style);
}

export class TogetherSettingTab extends PluginSettingTab {

  private _lastUsername: string | null = null;

  private readonly reloginHandler = () => {
    this.plugin.authManager.logout();
    this.display();
  };

  constructor(app: App, private plugin: ObsidianTogetherPlugin) {
    super(app, plugin);
    this.plugin.togetherAPI.events.on("together:relogin-required", this.reloginHandler);
  }

  hide(): void {
    this.plugin.togetherAPI.events.off("together:relogin-required", this.reloginHandler);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    injectCardStyles();
    containerEl.createEl("h2", { text: "Obsidian Together" });

    if (this.plugin.togetherAPI.auth.isLoggedIn) {
      this.renderLoggedIn(containerEl);
    } else {
      this.renderLoginForm(containerEl);
    }

    if (Platform.isDesktop) {
      containerEl.createEl("hr");
      this.renderDeveloperSection(containerEl);
    }
  }

  // ── Connected state ───────────────────────────────────────────────────────────

  private renderLoggedIn(root: HTMLElement): void {
    const { username } = this.plugin.togetherAPI.auth;

    const desc = document.createDocumentFragment();
    desc.append("Connected as ");
    const b = document.createElement("strong");
    b.textContent = username ?? "";
    desc.append(b);

    new Setting(root)
      .setDesc(desc)
      .addButton(btn =>
        btn.setButtonText("Log out").setWarning().onClick(async () => {
          this._lastUsername = this.plugin.togetherAPI.auth.username;
          await this.plugin.togetherAPI.logout();
          this.display();
        })
      );

    const pm = this.plugin.pluginManager;
    if (pm) {
      const updatable = pm.getAvailablePlugins().filter((p) => pm.hasUpdate(p.id));
      if (updatable.length > 0) {
        const banner = root.createDiv({ cls: "setting-item-description" });
        banner.style.color = "var(--text-warning)";
        banner.textContent = `${updatable.length} update${updatable.length > 1 ? "s" : ""} available: ${updatable.map((p) => p.name).join(", ")}`;

        new Setting(root)
          .setName("Updates available")
          .addButton(btn =>
            btn.setButtonText("Update all").setCta().onClick(async () => {
              for (const info of updatable) {
                await pm.downloadPlugin(info);
              }
              await pm.reloadAll();
              this.display();
            })
          );
      }
    }
  }

  // ── Login form ────────────────────────────────────────────────────────────────

  private renderLoginForm(root: HTMLElement): void {
    const { accounts, activeAccountIndex } = this.plugin.settings;
    const saved = activeAccountIndex >= 0 && activeAccountIndex < accounts.length
      ? accounts[activeAccountIndex]
      : null;

    const isDevMode = this.plugin.settings.devMode;
    let serverUrl = PROD_URL;
    let defaultDropdownValue = PROD_URL;

    if (isDevMode && saved) {
      if (saved.serverUrl === LOCAL_URL) {
        serverUrl = LOCAL_URL;
        defaultDropdownValue = LOCAL_URL;
      } else if (saved.serverUrl !== PROD_URL) {
        serverUrl = saved.serverUrl;
        defaultDropdownValue = "custom";
      }
    }

    let username = saved?.username ?? this._lastUsername ?? "";
    let password = "";

    // Frame card wrapping the login fields
    const card = root.createDiv({ cls: "together-card" });

    // Server dropdown (dev mode only)
    if (isDevMode) {
      let customSetting: Setting;
      let customUrl = defaultDropdownValue === "custom" ? (saved?.serverUrl ?? "") : "";

      new Setting(card)
        .setName("Server")
        .addDropdown(drop => {
          drop.addOption(PROD_URL, "Production");
          drop.addOption(LOCAL_URL, "Local (localhost:3001)");
          drop.addOption("custom", "Custom…");
          drop.setValue(defaultDropdownValue);
          drop.onChange(v => {
            if (v !== "custom") {
              serverUrl = v;
              customSetting.settingEl.style.display = "none";
            } else {
              serverUrl = customUrl;
              customSetting.settingEl.style.display = "";
            }
          });
        });

      customSetting = new Setting(card)
        .setName("Custom server URL")
        .addText(t => {
          t.setPlaceholder("https://…");
          t.setValue(customUrl);
          t.onChange(v => { customUrl = v.trim(); serverUrl = customUrl; });
        });
      customSetting.settingEl.style.display = defaultDropdownValue === "custom" ? "" : "none";
    }

    // Username
    new Setting(card)
      .setName("Username")
      .addText(t => {
        t.setValue(username);
        t.onChange(v => { username = v.trim(); });
      });

    // Password — eye button injected inside the input
    let passwordInputEl!: HTMLInputElement;
    let showPassword = false;
    const pwdSetting = new Setting(card)
      .setName("Password")
      .addText(t => {
        passwordInputEl = t.inputEl;
        t.inputEl.type = "password";
        t.inputEl.style.paddingRight = "30px";
        t.onChange(v => { password = v; });
      });

    const ctrl = pwdSetting.settingEl.querySelector<HTMLElement>(".setting-item-control");
    if (ctrl) {
      ctrl.style.position = "relative";
      const eye = document.createElement("button");
      eye.type = "button";
      eye.setAttribute("aria-label", "Toggle password visibility");
      eye.style.cssText = "position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:2px;line-height:1;color:var(--text-muted);";
      setIcon(eye, "eye");
      eye.addEventListener("click", () => {
        showPassword = !showPassword;
        passwordInputEl.type = showPassword ? "text" : "password";
        setIcon(eye, showPassword ? "eye-off" : "eye");
      });
      ctrl.appendChild(eye);
    }

    // Error element
    const errorEl = card.createEl("p");
    errorEl.style.cssText = "display:none; margin:0; padding:2px 12px 6px; font-size:var(--font-ui-small); color:var(--text-error);";

    // doLogin — defined after errorEl so it can reference it
    const doLogin = async () => {
      errorEl.style.display = "none";
      try {
        await this.plugin.authManager.login(username, password, serverUrl);
        await this.plugin.saveSettings();
        const state = this.plugin.togetherAPI.auth;
        this.plugin.togetherAPI.events.emit("together:account-switched", {
          username: state.username,
          serverUrl: state.serverUrl,
        });
        new Notice(`Logged in as ${state.username ?? "unknown"}`);
        this.display();
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : String(err);
        errorEl.style.display = "";
      }
    };

    // Wire Enter key now that doLogin is defined
    passwordInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); doLogin(); }
    });

    // Login button
    new Setting(card)
      .addButton(btn => btn.setButtonText("Log in").setCta().onClick(doLogin));
  }

  // ── Developer section ─────────────────────────────────────────────────────────

  private renderDeveloperSection(root: HTMLElement): void {
    root.createEl("h3", { text: "Developer" });
    const card = root.createDiv({ cls: "together-card" });

    new Setting(card)
      .setName("Developer mode")
      .setDesc("Load plugins from local repo instead of downloading.")
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.devMode);
        toggle.onChange(async (v) => {
          this.plugin.settings.devMode = v;
          this.plugin.saveSettings();
          if (this.plugin.settings.devRepoRoot) {
            const result = this.plugin.manageDevSymlink(v);
            if (result.ok) {
              new Notice(result.message);
            } else {
              new Notice(`Dev symlink: ${result.message}`, 5000);
            }
          }
          this.display();
        });
      });

    if (this.plugin.settings.devMode) {
      new Setting(card)
        .setName("Repo root path")
        .setDesc("Absolute path to the obsidian-together monorepo root.")
        .addText(t => {
          t.setValue(this.plugin.settings.devRepoRoot);
          t.setPlaceholder("/Users/you/obsidian-together");
          t.onChange((v) => {
            this.plugin.settings.devRepoRoot = v.trim();
            this.plugin.saveSettings();
            if (v.trim()) {
              const result = this.plugin.manageDevSymlink(true);
              if (!result.ok) new Notice(`Dev symlink: ${result.message}`, 5000);
            }
          });
        });

      new Setting(card)
        .addButton(btn =>
          btn.setButtonText("Reload plugins").onClick(async () => {
            await this.plugin.pluginManager.reloadAll();
          })
        );
    }
  }
}
