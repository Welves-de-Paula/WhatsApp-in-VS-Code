import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { AccountManager } from './AccountManager';
import { WWebMessage } from './WhatsAppClient';
import { AccountNotificationSettings } from './types';

export class NotificationManager {
  private readonly statusBarItem: vscode.StatusBarItem;
  /** Timer de flash da status bar — um por conta, sobrescreve se a conta já está piscando. */
  private readonly flashTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private readonly accountManager: AccountManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = 'whatsapp.quickReply';
    this.statusBarItem.tooltip = 'WhatsApp Multi — Clique para Quick Reply';
    this.updateBadge();
    this.statusBarItem.show();

    accountManager.on('message', (nickname, msg) => {
      this.handleMessage(nickname, msg);
    });

    accountManager.on('listChanged', () => this.updateBadge());
  }

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  private handleMessage(nickname: string, msg: WWebMessage): void {
    // Canais de broadcast nunca notificam
    if (msg.from.includes('@broadcast')) return;

    const settings = this.accountManager.getNotificationSettings(nickname);

    const isGroup   = msg.from.endsWith('@g.us');
    const isDirect  = !isGroup;
    const notifyName: string | undefined =
      (msg._data as { notifyName?: string } | undefined)?.notifyName;
    const sender = notifyName ?? msg.from.replace(/@[cg]\.us$/, '');

    // Filtro de tipo
    if (settings.filter === 'direct' && !isDirect) return;
    if (settings.filter === 'groups'  && !isGroup)  return;

    // Contatos / grupos silenciados
    const muteList = isGroup ? (settings.mutedGroups ?? []) : (settings.mutedContacts ?? []);
    if (muteList.some((m) => m.toLowerCase() === sender.toLowerCase())) return;

    // Alerta visual
    const preview = msg.body.length > 60 ? `${msg.body.slice(0, 60)}…` : msg.body;
    this.showVisualAlert(nickname, sender, preview, settings);

    // Som
    this.playSound(settings);
  }

  // ---------------------------------------------------------------------------
  // Visual alert
  // ---------------------------------------------------------------------------

  private showVisualAlert(
    nickname: string,
    sender: string,
    preview: string,
    settings: AccountNotificationSettings,
  ): void {
    switch (settings.visualAlert) {
      case 'banner':
        vscode.window
          .showInformationMessage(
            `📱 "${nickname}" — ${sender}: ${preview}`,
            'Responder',
          )
          .then((choice) => {
            if (choice === 'Responder') {
              void vscode.commands.executeCommand('whatsapp.quickReply');
            }
          });
        break;

      case 'statusBarFlash':
        this.flashStatusBar(nickname, sender, settings);
        break;

      case 'badgeOnly':
        // apenas o badge (já atualizado via updateBadge)
        break;

      case 'none':
        break;
    }
  }

  private flashStatusBar(
    nickname: string,
    sender: string,
    settings: AccountNotificationSettings,
  ): void {
    const color = settings.badgeColor ?? '#25d366';
    const original = this.statusBarItem.text;
    this.statusBarItem.text     = `$(comment-discussion) ${nickname}: ${sender}`;
    this.statusBarItem.color    = color;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // Cancela flash anterior da mesma conta se houver
    const existing = this.flashTimers.get(nickname);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.statusBarItem.color             = undefined;
      this.statusBarItem.backgroundColor   = undefined;
      this.statusBarItem.text              = original;
      this.updateBadge();
      this.flashTimers.delete(nickname);
    }, 3000);

    this.flashTimers.set(nickname, timer);
  }

  // ---------------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------------

  private playSound(settings: AccountNotificationSettings): void {
    if (settings.sound === 'none') return;

    const volume = Math.max(0, Math.min(100, settings.volume ?? 80));
    let filePath: string;

    if (settings.sound === 'custom') {
      if (!settings.customSoundPath?.trim()) return;
      filePath = settings.customSoundPath.trim();
    } else {
      filePath = path.join(
        this.extensionUri.fsPath,
        'media',
        'sounds',
        `${settings.sound}.wav`,
      );
    }

    if (!fs.existsSync(filePath)) return;

    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      // afplay não tem controle de volume direto via flag simples; use -v 0-255 (mapeamos 0-100 → 0-255)
      const vol = Math.round((volume / 100) * 255);
      cmd = 'afplay';
      args = ['-v', String(vol), filePath];
    } else if (platform === 'linux') {
      cmd = 'paplay';
      args = ['--volume', String(Math.round((volume / 100) * 65536)), filePath];
    } else {
      // Windows — PowerShell SoundPlayer
      const escaped = filePath.replace(/'/g, "''");
      const ps = `$ErrorActionPreference='Stop';$p=New-Object System.Media.SoundPlayer '${escaped}';$p.Load();$p.PlaySync()`;
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps];
    }

    const child = cp.spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => { /* ignora se player não disponível */ });
  }

  // ---------------------------------------------------------------------------
  // Badge
  // ---------------------------------------------------------------------------

  private updateBadge(): void {
    const total = this.accountManager
      .getClients()
      .reduce((sum, c) => sum + c.chats.reduce((s, ch) => s + ch.unreadCount, 0), 0);
    this.statusBarItem.text =
      total > 0
        ? `$(comment-discussion) WhatsApp (${total})`
        : `$(comment-discussion) WhatsApp`;
  }

  dispose(): void {
    for (const t of this.flashTimers.values()) clearTimeout(t);
    this.statusBarItem.dispose();
  }
}
