import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AccountManager } from './AccountManager';
import { SidebarProvider } from './SidebarProvider';
import { NotificationManager } from './notificationManager';
import { NotificationSettingsPanel } from './NotificationSettingsPanel';
import { executeQuickReply, executeOpenChat } from './quickReply';

let accountManager: AccountManager | undefined;
let lockFilePath: string | undefined;

// ---------------------------------------------------------------------------
// Multi-window lock — garante que apenas uma janela do VS Code executa workers
// ---------------------------------------------------------------------------

function acquireLock(storagePath: string): boolean {
  lockFilePath = path.join(storagePath, 'instance.lock');

  try {
    fs.mkdirSync(storagePath, { recursive: true });

    // Tenta ler lock existente
    let existingPid: number | undefined;
    try {
      existingPid = parseInt(fs.readFileSync(lockFilePath, 'utf8').trim(), 10);
    } catch {
      // arquivo não existe — podemos assumir o lock
    }

    if (existingPid !== undefined && !isNaN(existingPid)) {
      try {
        // kill(pid, 0) não mata nada, só verifica se o processo existe
        process.kill(existingPid, 0);
        // Processo ainda vivo → outra janela tem o lock
        return false;
      } catch {
        // Processo morto → lock obsoleto, podemos sobrescrever
      }
    }

    fs.writeFileSync(lockFilePath, String(process.pid), 'utf8');
    return true;
  } catch {
    // Falha ao escrever o lock → não bloqueia, assume proprietário
    return true;
  }
}

function releaseLock(): void {
  if (!lockFilePath) return;
  try {
    const content = fs.readFileSync(lockFilePath, 'utf8').trim();
    if (parseInt(content, 10) === process.pid) {
      fs.unlinkSync(lockFilePath);
    }
  } catch {
    // ignora se o arquivo já não existe
  }
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  accountManager = new AccountManager(context, context.extensionUri);

  // ------------------------------------------------------------------
  // Sidebar WebviewView
  // ------------------------------------------------------------------
  const sidebarProvider = new SidebarProvider(accountManager, context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'whatsappVsCode.sidebar',
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ------------------------------------------------------------------
  // Notification manager — status bar + toasts de mensagens recebidas
  // ------------------------------------------------------------------
  const notificationManager = new NotificationManager(accountManager, context.extensionUri);
  context.subscriptions.push({ dispose: () => notificationManager.dispose() });

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // Multi-window lock: só a janela proprietária inicia workers
  // ------------------------------------------------------------------
  const isOwner = acquireLock(context.globalStorageUri.fsPath);

  if (isOwner) {
    accountManager.initializeAll().catch((err: unknown) =>
      console.error('[WhatsApp] Erro ao reconectar contas salvas:', (err as Error).message),
    );
  } else {
    void vscode.window.showInformationMessage(
      'WhatsApp: já está ativo em outra janela do VS Code. ' +
      'Os workers não foram iniciados aqui para evitar conflitos de sessão.',
    );
  }
}

export async function deactivate(): Promise<void> {
  releaseLock();
  await accountManager?.destroyAll();
}
