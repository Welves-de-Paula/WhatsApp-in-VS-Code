import * as vscode from 'vscode';
import { WhatsAppClient } from './WhatsAppClient';
import { SidebarProvider } from './SidebarProvider';
import { QRCodePanel } from './QRCodePanel';
import { NotificationManager } from './notificationManager';
import { executeQuickReply } from './quickReply';

// Kept at module scope so deactivate() can await destruction
let clients: WhatsAppClient[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const storagePath = context.globalStorageUri.fsPath;

  // ------------------------------------------------------------------
  // Create the two account clients (not yet initialised / no Puppeteer)
  // ------------------------------------------------------------------
  clients = [
    new WhatsAppClient(0, storagePath),
    new WhatsAppClient(1, storagePath),
  ];

  const qrPanels = clients.map(
    (_, i) => new QRCodePanel(i, context.extensionUri),
  );

  // ------------------------------------------------------------------
  // Wire QR / ready events for each client
  // ------------------------------------------------------------------
  clients.forEach((client, i) => {
    client.on('qr', (qr) => {
      qrPanels[i].show(qr).catch((err) =>
        console.error(`[WhatsApp Multi] Erro ao exibir QR conta ${i + 1}:`, err),
      );
    });

    client.on('ready', () => {
      qrPanels[i].close();
      void vscode.window.showInformationMessage(
        `WhatsApp Conta ${i + 1} conectada com sucesso! ✅`,
      );
    });

    client.on('statusChange', (status) => {
      if (status === 'error') {
        void vscode.window.showErrorMessage(
          `WhatsApp Conta ${i + 1}: falha na autenticação. Reconecte via painel lateral.`,
        );
      }
    });
  });

  // ------------------------------------------------------------------
  // Sidebar WebviewView  (retainContextWhenHidden = true)
  // ------------------------------------------------------------------
  const sidebarProvider = new SidebarProvider(clients, context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'whatsappMulti.sidebar',
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ------------------------------------------------------------------
  // Notification manager — status bar + incoming message toasts
  // ------------------------------------------------------------------
  const notificationManager = new NotificationManager(clients);
  context.subscriptions.push({ dispose: () => notificationManager.dispose() });

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('whatsapp.quickReply', () => {
      void executeQuickReply(clients);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('whatsapp.reconnectAccount1', async () => {
      await clients[0].initialize().catch((err) =>
        vscode.window.showErrorMessage(
          `Erro ao conectar Conta 1: ${(err as Error).message}`,
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('whatsapp.reconnectAccount2', async () => {
      await clients[1].initialize().catch((err) =>
        vscode.window.showErrorMessage(
          `Erro ao conectar Conta 2: ${(err as Error).message}`,
        ),
      );
    }),
  );
}

/**
 * VS Code awaits the Promise returned by deactivate(), ensuring Puppeteer
 * processes are terminated cleanly before the extension host shuts down.
 */
export async function deactivate(): Promise<void> {
  for (const client of clients) {
    await client.destroy();
  }
}
