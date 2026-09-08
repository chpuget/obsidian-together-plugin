import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianTogetherPlugin from "../main";

const LOCAL_URL = "http://localhost:3001";
const PROD_URL  = "https://obsidian-together-production.up.railway.app";

export class TogetherSettingTab extends PluginSettingTab {

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
    containerEl.createEl("h2", { text: "Obsidian Together" });

    if (this.plugin.togetherAPI.auth.isLoggedIn) {
      this.renderLoggedIn(containerEl);
    } else {
      this.renderLoginForm(containerEl);
    }

    containerEl.createEl("hr");
    this.renderGeneralSection(containerEl);
    containerEl.createEl("hr");
    this.renderDangerSection(containerEl);

    if (this.plugin.settings.devMode) {
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

    let username = saved?.username ?? "";
    let password = "";

    const errorEl = root.createEl("p", { cls: "setting-item-description" });
    errorEl.style.display = "none";
    errorEl.style.color = "var(--text-error)";

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

    // Server dropdown (dev mode only)
    if (isDevMode) {
      let customSetting: Setting;
      let customUrl = defaultDropdownValue === "custom" ? (saved?.serverUrl ?? "") : "";

      new Setting(root)
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

      customSetting = new Setting(root)
        .setName("Custom server URL")
        .addText(t => {
          t.setPlaceholder("https://…");
          t.setValue(customUrl);
          t.onChange(v => {
            customUrl = v.trim();
            serverUrl = customUrl;
          });
        });
      customSetting.settingEl.style.display = defaultDropdownValue === "custom" ? "" : "none";
    }

    // Username
    new Setting(root)
      .setName("Username")
      .addText(t => {
        t.setValue(username);
        t.onChange(v => { username = v.trim(); });
      });

    // Password with show/hide toggle
    let passwordInputEl: HTMLInputElement;
    let showPassword = false;
    new Setting(root)
      .setName("Password")
      .addText(t => {
        passwordInputEl = t.inputEl;
        t.inputEl.type = "password";
        t.onChange(v => { password = v; });
        t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            doLogin();
          }
        });
      })
      .addExtraButton(btn =>
        btn.setIcon("eye")
          .setTooltip("Show/hide password")
          .onClick(() => {
            showPassword = !showPassword;
            passwordInputEl.type = showPassword ? "text" : "password";
          })
      );

    // Login button
    new Setting(root)
      .addButton(btn =>
        btn.setButtonText("Log in").setCta().onClick(doLogin)
      );

    root.appendChild(errorEl);
  }

  // ── General section ───────────────────────────────────────────────────────────

  private renderGeneralSection(root: HTMLElement): void {
    new Setting(root)
      .setName("Auto update plugins")
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.autoUpdate ?? true);
        toggle.onChange(async (v) => {
          this.plugin.settings.autoUpdate = v;
          await this.plugin.saveSettings();
        });
      });
  }

  // ── Danger section ────────────────────────────────────────────────────────────

  private renderDangerSection(root: HTMLElement): void {
    new Setting(root)
      .addButton(btn =>
        btn.setButtonText("Reinitialization").setWarning().onClick(async () => {
          this.plugin.settings.accounts = [];
          this.plugin.settings.activeAccountIndex = -1;
          if (this.plugin.togetherAPI.auth.isLoggedIn) {
            await this.plugin.togetherAPI.logout();
          }
          await this.plugin.saveSettings();
          new Notice("Settings have been reset.");
          this.display();
        })
      );
  }

  // ── Developer section ─────────────────────────────────────────────────────────

  private renderDeveloperSection(root: HTMLElement): void {
    root.createEl("h3", { text: "Developer" });

    new Setting(root)
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
              new Notice(result.message + (v ? "\nRestart Obsidian to load plugin-core from repo." : ""));
            } else {
              new Notice(`Dev symlink: ${result.message}`, 5000);
            }
          }
          this.display();
        });
      });

    if (this.plugin.settings.devMode) {
      new Setting(root)
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

      const corePath = (this.plugin as any)._devPluginCorePath?.() ?? "(unknown)";
      const fs = typeof require !== "undefined" ? (() => { try { return require("fs"); } catch { return null; } })() : null;
      const coreExists = fs ? fs.existsSync(corePath) : false;
      new Setting(root)
        .setName("Plugin-core source")
        .setDesc(`${corePath} ${coreExists ? "✓" : "✗ not found"}`);

      new Setting(root)
        .addButton(btn =>
          btn.setButtonText("Reload plugins").onClick(async () => {
            await this.plugin.pluginManager.reloadAll();
          })
        );
    }
  }
}
