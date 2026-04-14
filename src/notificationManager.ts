import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { AccountManager } from './AccountManager';
import { WWebMessage } from './WhatsAppClient';
import { AccountNotificationSettings } from './types';

export class NotificationManager {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  /** Timer de flash da status bar — um por conta, sobrescreve se a conta já está piscando. */
  private readonly flashTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Texto original da status bar antes de qualquer flash ativo. */
  private flashOriginalText: string | undefined;

  constructor(
    private readonly accountManager: AccountManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.output = vscode.window.createOutputChannel('WhatsApp Sound');
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = 'whatsapp.quickReply';
    this.statusBarItem.tooltip = 'WhatsApp — Clique para Quick Reply';
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
    this.output.appendLine(`[${new Date().toISOString()}] mensagem recebida de ${msg.from}`);

    // Canais de broadcast nunca notificam
    if (msg.from.includes('@broadcast')) return;

    const settings = this.accountManager.getNotificationSettings(nickname);
    this.output.appendLine(`  sound=${settings.sound}  filter=${settings.filter}  visual=${settings.visualAlert}`);

    const isGroup = msg.from.endsWith('@g.us');
    const isDirect = !isGroup;

    const notifyName: string | undefined =
      (msg._data as { notifyName?: string } | undefined)?.notifyName;

    // sender = quem mandou a mensagem (nome do contato ou de quem falou no grupo)
    const sender = notifyName ?? msg.from.replace(/@[cg]\.us$/, '');

    // chatName = nome do chat para fins de mute/exibição
    // – direto  : mesmo que sender
    // – grupo   : nome do grupo (buscado no cache de chats) — o sender é o membro,
    //             não o grupo, então não serve para comparar com mutedGroups
    const client = this.accountManager.getClient(nickname);
    const chatName = isGroup
      ? (client?.chats.find(c => c.id === msg.from)?.name ?? msg.from.replace(/@g\.us$/, ''))
      : sender;

    // Filtro de tipo
    if (settings.filter === 'direct' && !isDirect) {
      this.output.appendLine('  → ignorado (filtro: somente diretos)');
      return;
    }
    if (settings.filter === 'groups' && !isGroup) {
      this.output.appendLine('  → ignorado (filtro: somente grupos)');
      return;
    }

    // ── Silenciamento ──────────────────────────────────────────────────────────
    // Regra 1 — mute configurado no próprio WhatsApp (isMuted no chat)
    const chatInfo = client?.chats.find(c => c.id === msg.from);
    if (chatInfo?.isMuted) {
      this.output.appendLine(`  → silenciado pelo WhatsApp: ${chatName}`);
      return;
    }

    // Regra 2 — mute manual configurado nas settings da extensão
    //   • direto : compara pelo nome do contato  (sender)
    //   • grupo  : compara pelo nome do grupo    (chatName)
    // Em ambos os casos: sem som e sem banner, mas o contador de não-lidas e
    // o badge continuam atualizando normalmente (fluxo chatsUpdate é separado).
    const muteList = isGroup ? (settings.mutedGroups ?? []) : (settings.mutedContacts ?? []);
    const muteKey = isGroup ? chatName : sender;
    if (muteList.some(m => m.toLowerCase() === muteKey.toLowerCase())) {
      this.output.appendLine(`  → silenciado nas settings: ${muteKey}`);
      return;
    }

    // Alerta visual
    const preview = msg.body.length > 60 ? `${msg.body.slice(0, 60)}…` : msg.body;
    this.showVisualAlert(nickname, sender, msg.from, preview, settings);

    // Som
    this.playSound(settings);
  }

  // ---------------------------------------------------------------------------
  // Visual alert
  // ---------------------------------------------------------------------------

  private showVisualAlert(
    nickname: string,
    sender: string,
    chatId: string,
    preview: string,
    settings: AccountNotificationSettings,
  ): void {
    switch (settings.visualAlert) {
      case 'banner': {
        // Tenta encontrar o nome do chat na lista em cache (útil para grupos)
        const client = this.accountManager.getClient(nickname);
        const chatName = client?.chats.find(c => c.id === chatId)?.name ?? sender;

        vscode.window
          .showInformationMessage(
            `📱 "${nickname}" — ${sender}: ${preview}`,
            'Abrir chat',
          )
          .then((choice) => {
            if (choice === 'Abrir chat') {
              void vscode.commands.executeCommand(
                'whatsapp.openChat',
                chatId,
                chatName,
                nickname,
              );
            }
          });
        break;
      }

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

    // Só captura o texto original se não há nenhum flash ativo
    if (this.flashTimers.size === 0) {
      this.flashOriginalText = this.statusBarItem.text;
    }

    this.statusBarItem.text = `$(comment-discussion) ${nickname}: ${sender}`;
    this.statusBarItem.color = color;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // Cancela flash anterior da mesma conta se houver
    const existing = this.flashTimers.get(nickname);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.flashTimers.delete(nickname);
      // Só restaura visual quando não há mais nenhum flash ativo
      if (this.flashTimers.size === 0) {
        this.statusBarItem.color = undefined;
        this.statusBarItem.backgroundColor = undefined;
        if (this.flashOriginalText !== undefined) {
          this.statusBarItem.text = this.flashOriginalText;
          this.flashOriginalText = undefined;
        }
        this.updateBadge();
      }
    }, 3000);

    this.flashTimers.set(nickname, timer);
  }

  // ---------------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------------

  private playSound(settings: AccountNotificationSettings): void {
    if (settings.sound === 'none') {
      this.output.appendLine('  → som desativado (none)');
      return;
    }

    const volume = Math.max(0, Math.min(100, settings.volume ?? 80));
    let filePath: string;

    if (settings.sound === 'custom') {
      if (settings.customSoundPath?.trim()) {
        filePath = settings.customSoundPath.trim();
      } else {
        filePath = path.join(this.extensionUri.fsPath, 'media', 'sounds', 'ding.wav');
      }
    } else {
      filePath = path.join(
        this.extensionUri.fsPath,
        'media',
        'sounds',
        `${settings.sound}.wav`,
      );
    }

    if (!fs.existsSync(filePath)) {
      const fallback = path.join(this.extensionUri.fsPath, 'media', 'sounds', 'ding.wav');
      if (!fs.existsSync(fallback)) {
        this.output.appendLine(`  → arquivo de som não encontrado: ${filePath}`);
        return;
      }
      filePath = fallback;
    }

    this.output.appendLine(`  → tocando som: ${filePath} (volume ${volume}%)`);

    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      const vol = Math.round((volume / 100) * 255);
      cmd = 'afplay';
      args = ['-v', String(vol), filePath];
    } else if (platform === 'linux') {
      cmd = 'paplay';
      args = ['--volume', String(Math.round((volume / 100) * 65536)), filePath];
    } else {
      // Windows — PowerShell SoundPlayer via -EncodedCommand (UTF-16LE base64)
      const escaped = filePath.replace(/'/g, "''");
      const ps = [
        `Add-Type -AssemblyName System.Windows.Forms`,
        `try {`,
        `  $p = New-Object System.Media.SoundPlayer -ArgumentList '${escaped}'`,
        `  $p.Load()`,
        `  $p.PlaySync()`,
        `} catch {`,
        `  Write-Error $_.Exception.Message`,
        `}`,
      ].join('\n');
      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded];
    }

    const child = cp.spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr?.on('data', (d: Buffer) => {
      this.output.appendLine(`  [som-erro] ${d.toString().trim()}`);
    });
    child.on('error', (err) => {
      this.output.appendLine(`  [som-spawn-erro] ${err.message}`);
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        this.output.appendLine(`  [som-exit] código ${code}`);
      }
    });
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
    this.output.dispose();
  }
}
