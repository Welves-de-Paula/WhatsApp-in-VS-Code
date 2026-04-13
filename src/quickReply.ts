import * as vscode from 'vscode';
import { WhatsAppClient } from './WhatsAppClient';
import { ChatInfo } from './types';

interface ChatPickItem extends vscode.QuickPickItem {
  chatId: string;
  accountIndex: number;
}

export async function executeQuickReply(
  clients: WhatsAppClient[],
): Promise<void> {
  const readyClients = clients.filter((c) => c.status === 'ready');

  if (readyClients.length === 0) {
    vscode.window.showWarningMessage(
      'Nenhuma conta do WhatsApp está conectada. Abra o painel lateral para iniciar a conexão.',
    );
    return;
  }

  // Flatten all chats from ready accounts, sorted by most recent first
  const allChats: ChatInfo[] = readyClients
    .flatMap((c) => c.chats)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (allChats.length === 0) {
    vscode.window.showInformationMessage(
      'Nenhuma conversa encontrada nas contas conectadas.',
    );
    return;
  }

  const picks: ChatPickItem[] = allChats.map((chat) => {
    const unreadSuffix =
      chat.unreadCount > 0 ? `  ·  ${chat.unreadCount} não lidas` : '';
    return {
      label: chat.name,
      description: `[Conta ${chat.accountIndex + 1}]${unreadSuffix}`,
      detail: chat.lastMessage
        ? `Última: ${chat.lastMessage.slice(0, 100)}`
        : undefined,
      chatId: chat.id,
      accountIndex: chat.accountIndex,
    };
  });

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Selecione uma conversa…',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) return;

  const text = await vscode.window.showInputBox({
    prompt: `Responder para ${selected.label} (${selected.description?.trim()})`,
    placeHolder: 'Digite sua mensagem…',
    validateInput: (value) =>
      value.trim() ? null : 'A mensagem não pode estar em branco.',
  });

  if (!text?.trim()) return;

  const targetClient = clients[selected.accountIndex];
  try {
    await targetClient.sendMessage(selected.chatId, text.trim());
    void vscode.window.showInformationMessage(
      `Mensagem enviada para ${selected.label}`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `Falha ao enviar mensagem: ${message}`,
    );
  }
}
