import * as vscode from 'vscode';
import { AccountManager } from './AccountManager';
import { SidebarProvider } from './SidebarProvider';
import { NotificationManager } from './notificationManager';
import { NotificationSettingsPanel } from './NotificationSettingsPanel';
import { executeQuickReply, executeOpenChat } from './quickReply';

let accountManager: AccountManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  accountManager = new AccountManager(context, context.extensionUri);

  const sidebarProvider = new SidebarProvider(accountManager, context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'whatsappVsCode.sidebar',
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const notificationManager = new NotificationManager(accountManager, context.extensionUri);
  context.subscriptions.push({ dispose: () => notificationManager.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('whatsapp.quickReply', () => {
      void executeQuickReply(accountManager!, context.extensionUri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('whatsapp.openChat', (chatId: string, chatName: string, accountNickname: string) => {
      void executeOpenChat(accountManager!, chatId, chatName, accountNickname, context.extensionUri);
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
      'whatsapp.openNotificationSettings',
      async (nickname?: string) => {
        const target =
          nickname ??
          (await vscode.window.showQuickPick(
            accountManager!.getClients().map((c) => c.nickname),
            { placeHolder: 'Selecione a conta…' },
          ));
        if (!target) return;
        NotificationSettingsPanel.openOrReveal(target, accountManager!, context.extensionUri);
      },
    ),
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

  accountManager.initializeAll().catch((err: unknown) =>
    console.error('[WhatsApp] Erro ao reconectar contas salvas:', (err as Error).message),
  );
}

export async function deactivate(): Promise<void> {
  await accountManager?.destroyAll();
}