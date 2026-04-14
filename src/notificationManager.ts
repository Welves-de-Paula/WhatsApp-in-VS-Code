import * as vscode from 'vscode';
import { AccountManager } from './AccountManager';

export class NotificationManager {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(accountManager: AccountManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = 'whatsapp.quickReply';
    this.statusBarItem.tooltip = 'WhatsApp Multi — Clique para Quick Reply';
    this.updateBadge(accountManager);
    this.statusBarItem.show();

    // Toast para mensagens recebidas e atualização do badge
    accountManager.on('message', (nickname, msg) => {
      // Ignorar notificações de canais
      if (msg.from.includes('@broadcast')) return;
      
      const notifyName: string | undefined = (msg._data as { notifyName?: string } | undefined)?.notifyName;
      const sender = notifyName ?? msg.from.replace(/@[cg]\.us$/, '');
      const preview = msg.body.length > 60 ? `${msg.body.slice(0, 60)}…` : msg.body;

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
    });

    // Atualiza badge sempre que qualquer estado mudar
    accountManager.on('listChanged', () => this.updateBadge(accountManager));
  }

  private updateBadge(accountManager: AccountManager): void {
    const total = accountManager
      .getClients()
      .reduce((sum, c) => sum + c.chats.reduce((s, ch) => s + ch.unreadCount, 0), 0);
    this.statusBarItem.text =
      total > 0
        ? `$(comment-discussion) WhatsApp (${total})`
        : `$(comment-discussion) WhatsApp`;
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
