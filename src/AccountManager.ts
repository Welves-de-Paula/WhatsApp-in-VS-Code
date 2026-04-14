import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { WhatsAppClient, WWebMessage } from './WhatsAppClient';
import { QRCodePanel } from './QRCodePanel';
import { AccountMeta, AccountNotificationSettings, AccountStatus, DEFAULT_NOTIFICATION_SETTINGS } from './types';
import { getStoragePath, getAccountsFilePath, ensureStorageExists } from './storage';

const NOTIF_SETTINGS_PREFIX = 'whatsapp.notif.';

// ---------------------------------------------------------------------------
// Type-safe overloads
// ---------------------------------------------------------------------------
export declare interface AccountManager {
  on(event: 'listChanged', listener: () => void): this;
  on(event: 'statusChanged', listener: (nickname: string, status: AccountStatus) => void): this;
  on(event: 'chatsUpdated', listener: (nickname: string) => void): this;
  on(event: 'message', listener: (nickname: string, msg: WWebMessage) => void): this;
  emit(event: 'listChanged'): boolean;
  emit(event: 'statusChanged', nickname: string, status: AccountStatus): boolean;
  emit(event: 'chatsUpdated', nickname: string): boolean;
  emit(event: 'message', nickname: string, msg: WWebMessage): boolean;
}

export class AccountManager extends EventEmitter {
  private readonly clients: Map<string, WhatsAppClient> = new Map();
  private readonly qrPanels: Map<string, QRCodePanel> = new Map();
  private readonly storagePath: string;

constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
  ) {
    super();
    this.storagePath = getStoragePath();
    ensureStorageExists();
    this.setupAccountsFileWatcher();
  }

  // -------------------------------------------------------------------------
  // Public read API
  // -------------------------------------------------------------------------

  getClients(): WhatsAppClient[] {
    return [...this.clients.values()];
  }

  getClient(nickname: string): WhatsAppClient | undefined {
    return this.clients.get(nickname);
  }

  getNotificationSettings(nickname: string): AccountNotificationSettings {
    return this.context.globalState.get<AccountNotificationSettings>(
      `${NOTIF_SETTINGS_PREFIX}${nickname}`,
      { ...DEFAULT_NOTIFICATION_SETTINGS },
    );
  }

  async saveNotificationSettings(
    nickname: string,
    settings: AccountNotificationSettings,
  ): Promise<void> {
    await this.context.globalState.update(
      `${NOTIF_SETTINGS_PREFIX}${nickname}`,
      settings,
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Reconecta todas as contas salvas no globalState (sem pedir QR se sessão existir). */
  async initializeAll(): Promise<void> {
    const saved = this.loadSavedAccounts();
    for (const meta of saved) {
      await this.createAndRegisterClient(meta.nickname, /* autoConnect */ true).catch(
        (err: unknown) =>
          console.error(
            `[AccountManager] Erro ao reconectar "${meta.nickname}":`,
            (err as Error).message,
          ),
      );
    }
  }

  /** Adiciona uma nova conta com o apelido fornecido e inicia a conexão imediatamente. */
  async addAccount(nickname: string): Promise<void> {
    const sanitized = AccountManager.sanitizeNickname(nickname);
    if (!sanitized) {
      throw new Error('Apelido inválido.');
    }
    if (this.clients.has(sanitized)) {
      throw new Error(`Conta "${sanitized}" já existe.`);
    }
    await this.createAndRegisterClient(sanitized, /* autoConnect */ true);
    this.saveAccounts();
    this.emit('listChanged');
  }

  /** Remove a conta, derruba o worker e apaga a pasta de sessão. */
  async removeAccount(nickname: string): Promise<void> {
    const client = this.clients.get(nickname);
    if (!client) return;

    await client.destroy();
    this.clients.delete(nickname);

    const panel = this.qrPanels.get(nickname);
    panel?.close();
    this.qrPanels.delete(nickname);

    // Apaga pasta de sessão do LocalAuth
    const sessionDir = path.join(
      this.storagePath,
      '.wwebjs_auth',
      `session-${nickname}`,
    );
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // ignora se não existir
    }

    this.saveAccounts();
    this.emit('listChanged');
  }

  /** Reconecta uma conta já existente que está desconectada/com erro. */
  async reconnectAccount(nickname: string): Promise<void> {
    const client = this.clients.get(nickname);
    if (!client) return;
    await client.initialize();
  }

  /** Destrói todos os workers (chamado no deactivate). */
  async destroyAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async createAndRegisterClient(
    nickname: string,
    autoConnect: boolean,
  ): Promise<void> {
    const client = new WhatsAppClient(nickname, this.storagePath);
    const qrPanel = new QRCodePanel(nickname, this.extensionUri);

    client.on('qr', (qr) => {
      qrPanel.show(qr).catch((err: unknown) =>
        console.error(
          `[AccountManager] Erro ao exibir QR "${nickname}":`,
          (err as Error).message,
        ),
      );
    });

    client.on('ready', () => {
      qrPanel.close();
      void vscode.window.showInformationMessage(
        `WhatsApp "${nickname}" conectado com sucesso! ✅`,
      );
      this.emit('statusChanged', nickname, 'ready');
      this.emit('listChanged');
    });

    client.on('statusChange', (status) => {
      if (status === 'error') {
        void vscode.window.showErrorMessage(
          `WhatsApp "${nickname}": falha na autenticação. Reconecte via painel lateral.`,
        );
      }
      this.emit('statusChanged', nickname, status);
      this.emit('listChanged');
    });

    client.on('chatsUpdate', () => {
      this.emit('chatsUpdated', nickname);
      this.emit('listChanged');
    });

    client.on('message', (msg) => {
      this.emit('message', nickname, msg);
    });

    this.clients.set(nickname, client);
    this.qrPanels.set(nickname, qrPanel);

    if (autoConnect) {
      // Fire-and-forget: o QR aparece quando o evento 'qr' disparar
      client.initialize().catch((err: unknown) =>
        console.error(
          `[AccountManager] Erro ao inicializar "${nickname}":`,
          (err as Error).message,
        ),
      );
    }
  }

private setupAccountsFileWatcher(): void {
    ensureStorageExists();
    const accountsFilePath = getAccountsFilePath();

    let watcher: fs.FSWatcher | null = null;

    const startWatcher = (): void => {
      if (watcher) return;
      try {
        watcher = fs.watch(accountsFilePath, (eventType) => {
          if (eventType === 'change') {
            setTimeout(() => this.reloadAccountsFromFile(), 100);
          }
        });
      } catch {
        // silent fail if watcher fails
      }
    };

    startWatcher();
  }

  private reloadAccountsFromFile(): void {
    try {
      const accountsFilePath = getAccountsFilePath();
      if (!fs.existsSync(accountsFilePath)) return;

      const data = fs.readFileSync(accountsFilePath, 'utf-8');
      const saved: AccountMeta[] = JSON.parse(data);

      const currentNicknames = new Set([...this.clients.keys()].map((n) => n));
      const savedNicknames = new Set(saved.map((m) => m.nickname));

      for (const nickname of currentNicknames) {
        if (!savedNicknames.has(nickname)) {
          this.clients.get(nickname)?.destroy();
          this.clients.delete(nickname);
          this.qrPanels.get(nickname)?.close();
          this.qrPanels.delete(nickname);
        }
      }

      for (const meta of saved) {
        if (!this.clients.has(meta.nickname)) {
          this.createAndRegisterClient(meta.nickname, false).catch((err: unknown) =>
            console.error(
              `[AccountManager] Erro ao carregar conta "${meta.nickname}":`,
              (err as Error).message,
            ),
          );
        }
      }

      this.emit('listChanged');
    } catch {
      // silent fail on reload errors
    }
  }

  private saveAccounts(): void {
    ensureStorageExists();
    const accountsFilePath = getAccountsFilePath();
    const metas: AccountMeta[] = [...this.clients.keys()].map((n) => ({
      nickname: n,
    }));
    fs.writeFileSync(accountsFilePath, JSON.stringify(metas, null, 2), 'utf-8');
  }

  private loadSavedAccounts(): AccountMeta[] {
    try {
      const accountsFilePath = getAccountsFilePath();
      if (!fs.existsSync(accountsFilePath)) return [];

      const data = fs.readFileSync(accountsFilePath, 'utf-8');
      return JSON.parse(data) as AccountMeta[];
    } catch {
      return [];
    }
  }

  /**
   * Garante que o nickname não contenha caracteres perigosos para
   * nomes de pasta / clientId do LocalAuth.
   */
  private static sanitizeNickname(raw: string): string {
    return raw
      .trim()
      .replace(/[/\\:*?"<>|]/g, '_')
      .slice(0, 64);
  }
}
