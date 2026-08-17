import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
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
    // When a 401 is detected at runtime, re-render — the login form will appear naturally
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
  }

  // ── Connected state ───────────────────────────────────────────────────────────

  private renderLoggedIn(root: HTMLElement): void {
    const { username, serverUrl } = this.plugin.togetherAPI.auth;
    const serverLabel = (serverUrl ?? "").replace(/^https?:\/\//, "");

    const desc = document.createDocumentFragment();
    desc.append("Connected as ");
    const b = document.createElement("strong");
    b.textContent = username ?? "";
    desc.append(b);
    desc.append(` @ ${serverLabel}`);

    new Setting(root)
      .setDesc(desc)
      .addButton(btn =>
        btn.setButtonText("Log out").setWarning().onClick(async () => {
          await this.plugin.togetherAPI.logout();
          this.display();
        })
      );

    this.renderPluginsSection(root);
    this.renderDeveloperSection(root);
  }

  private renderPluginsSection(root: HTMLElement): void {
    const pm = this.plugin.pluginManager;
    const updatable = pm.getAvailablePlugins().filter((p) => pm.hasUpdate(p.id));

    root.createEl('h3', { text: 'Plugins' });

    if (updatable.length > 0) {
      const banner = root.createDiv({ cls: 'setting-item-description' });
      banner.style.color = 'var(--text-warning)';
      banner.textContent = `${updatable.length} update${updatable.length > 1 ? 's' : ''} available: ${updatable.map((p) => p.name).join(', ')}`;

      new Setting(root)
        .setName('Updates available')
        .addButton(btn =>
          btn.setButtonText('Update all').setCta().onClick(async () => {
            for (const info of updatable) {
              await pm.downloadPlugin(info);
            }
            await pm.reloadAll();
            this.display();
          })
        );
    } else {
      root.createDiv({ cls: 'setting-item-description', text: 'All plugins are up to date.' });
    }
  }

  private renderDeveloperSection(root: HTMLElement): void {
    root.createEl('h3', { text: 'Developer' });

    new Setting(root)
      .setName('Developer mode')
      .setDesc('Load plugins from local repo instead of downloading.')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.devMode);
        toggle.onChange(async (v) => {
          this.plugin.settings.devMode = v;
          this.plugin.saveSettings();
          this.display();
        });
      });

    if (this.plugin.settings.devMode) {
      new Setting(root)
        .setName('Repo root path')
        .setDesc('Absolute path to the obsidian-together monorepo root.')
        .addText(t => {
          t.setValue(this.plugin.settings.devRepoRoot);
          t.setPlaceholder('/Users/you/obsidian-together');
          t.onChange((v) => {
            this.plugin.settings.devRepoRoot = v.trim();
            this.plugin.saveSettings();
          });
        });

      new Setting(root)
        .addButton(btn =>
          btn.setButtonText('Reload plugins').onClick(async () => {
            await this.plugin.pluginManager.reloadAll();
          })
        );
    }
  }

  // ── Login form ────────────────────────────────────────────────────────────────

  private renderLoginForm(root: HTMLElement): void {
    // Pre-fill from the saved account at activeAccountIndex if available (expired token scenario)
    const { accounts, activeAccountIndex } = this.plugin.settings;
    const saved = (activeAccountIndex >= 0 && activeAccountIndex < accounts.length)
      ? accounts[activeAccountIndex]
      : accounts[0];

    let serverUrl: string;
    let defaultDropdownValue: string;

    if (!saved) {
      serverUrl = PROD_URL;
      defaultDropdownValue = PROD_URL;
    } else if (saved.serverUrl === PROD_URL) {
      serverUrl = PROD_URL;
      defaultDropdownValue = PROD_URL;
    } else if (saved.serverUrl === LOCAL_URL) {
      serverUrl = LOCAL_URL;
      defaultDropdownValue = LOCAL_URL;
    } else {
      serverUrl = saved.serverUrl;
      defaultDropdownValue = "custom";
    }

    let username = saved?.username ?? "";
    let password = "";

    // Error display element (hidden until a login error occurs)
    const errorEl = root.createEl("p", { cls: "setting-item-description" });
    errorEl.style.display = "none";
    errorEl.style.color = "var(--text-error)";

    let customSetting: Setting;
    let customTextComp: TextComponent;

    // Server dropdown
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
            serverUrl = customTextComp.getValue().trim();
            customSetting.settingEl.style.display = "";
          }
        });
      });

    // Custom server URL field (shown only when "Custom…" is selected)
    customSetting = new Setting(root)
      .setName("Custom server URL")
      .addText(t => {
        customTextComp = t;
        t.setPlaceholder("https://…");
        if (defaultDropdownValue === "custom") {
          t.setValue(saved?.serverUrl ?? "");
        }
        t.onChange(v => { serverUrl = v.trim(); });
      });
    customSetting.settingEl.style.display = defaultDropdownValue === "custom" ? "" : "none";

    // Username
    new Setting(root)
      .setName("Username")
      .addText(t => {
        t.setValue(username);
        t.onChange(v => { username = v.trim(); });
      });

    // Password
    new Setting(root)
      .setName("Password")
      .addText(t => {
        t.inputEl.type = "password";
        t.onChange(v => { password = v; });
      });

    // Log in button
    new Setting(root)
      .addButton(btn =>
        btn.setButtonText("Log in").setCta().onClick(async () => {
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
        })
      );
  }
}
