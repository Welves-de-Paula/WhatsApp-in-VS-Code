import * as vscode from 'vscode';
import { WhatsAppClient } from './WhatsAppClient';

export class NotificationManager {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(clients: WhatsAppClient[]) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = 'whatsapp.quickReply';
    this.statusBarItem.tooltip = 'WhatsApp Multi — Clique para Quick Reply';
    this.updateBadge(clients);
    this.statusBarItem.show();

    clients.forEach((client, i) => {
      // Show a VS Code notification for every incoming message
      client.on('message', (msg) => {
        const notifyName: string | undefined = (msg._data as { notifyName?: string } | undefined)?.notifyName;
        const sender = notifyName ?? msg.from.replace(/@[cg]\.us$/, '');
        const preview =
          msg.body.length > 60 ? `${msg.body.slice(0, 60)}…` : msg.body;

        vscode.window
          .showInformationMessage(
            `📱 Conta ${i + 1} — ${sender}: ${preview}`,
            'Responder',
          )
          .then((choice) => {
            if (choice === 'Responder') {
              void vscode.commands.executeCommand('whatsapp.quickReply');
            }
          });
      });

      // Keep status-bar badge in sync
      client.on('chatsUpdate', () => this.updateBadge(clients));
    });
  }

  private updateBadge(clients: WhatsAppClient[]): void {
    const total = clients.reduce(
      (sum, c) => sum + c.chats.reduce((s, ch) => s + ch.unreadCount, 0),
      0,
    );
    this.statusBarItem.text =
      total > 0
        ? `$(comment-discussion) WhatsApp (${total})`
        : `$(comment-discussion) WhatsApp`;
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
