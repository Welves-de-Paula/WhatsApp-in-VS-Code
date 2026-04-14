import * as vscode from 'vscode';
import { AccountManager } from './AccountManager';
import { SidebarProvider } from './SidebarProvider';
import { NotificationManager } from './notificationManager';
import { executeQuickReply } from './quickReply';

let accountManager: AccountManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // ------------------------------------------------------------------
  // AccountManager — sem nenhum Puppeteer na inicialização
  // ------------------------------------------------------------------
  accountManager = new AccountManager(context, context.extensionUri);

  // ------------------------------------------------------------------
  // Sidebar WebviewView
  // ------------------------------------------------------------------
  const sidebarProvider = new SidebarProvider(accountManager, context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'whatsappMulti.sidebar',
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ------------------------------------------------------------------
  // Notification manager — status bar + toasts de mensagens recebidas
  // ------------------------------------------------------------------
  const notificationManager = new NotificationManager(accountManager);
  context.subscriptions.push({ dispose: () => notificationManager.dispose() });

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('whatsapp.quickReply', () => {
      void executeQuickReply(accountManager!);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('whatsapp.addAccount', async () => {
      const nickname = await vscode.window.showInputBox({
        title: 'Adicionar conta do WhatsApp',
        prompt: 'Digite um apelido para identificar esta conta',
        placeHolder: 'Ex: Pessoal, Trabalho, Cliente X…',
        validateInput: (value) => {
          if (!value.trim()) return 'O apelido não pode estar em branco.';
          if (accountManager?.getClient(value.trim())) {
            return `Já existe uma conta com o apelido "${value.trim()}".`;
          }
          return null;
        },
      });

      if (!nickname?.trim()) return;

      await accountManager!.addAccount(nickname.trim()).catch((err: unknown) => {
        void vscode.window.showErrorMessage(
          `Erro ao adicionar conta: ${(err as Error).message}`,
        );
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'whatsapp.removeAccount',
      async (nickname?: string) => {
        const target =
          nickname ??
          (await vscode.window.showQuickPick(
            accountManager!.getClients().map((c) => c.nickname),
            { placeHolder: 'Selecione a conta a remover…' },
          ));

        if (!target) return;

        const choice = await vscode.window.showWarningMessage(
          `Remover conta "${target}"? Isso apagará a sessão salva.`,
          { modal: true },
          'Remover',
        );
        if (choice === 'Remover') {
          await accountManager!.removeAccount(target);
        }
      },
    ),
  );

  // ------------------------------------------------------------------
  // Reconecta contas salvas em background (sem bloquear a ativação)
  // ------------------------------------------------------------------
  accountManager.initializeAll().catch((err: unknown) =>
    console.error('[WhatsApp Multi] Erro ao reconectar contas salvas:', (err as Error).message),
  );
}

export async function deactivate(): Promise<void> {
  await accountManager?.destroyAll();
}

