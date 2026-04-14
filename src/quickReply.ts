import * as vscode from 'vscode';
import { AccountManager } from './AccountManager';
import { ChatInfo, MessageInfo } from './types';

interface ChatPickItem extends vscode.QuickPickItem {
  chatId: string;
  accountNickname: string;
}

let chatPanel: vscode.WebviewPanel | undefined;
let currentChatInfo: { chatId: string; chatName: string; accountNickname: string } | undefined;

export async function executeQuickReply(
  accountManager: AccountManager,
): Promise<void> {
  const readyClients = accountManager.getClients().filter((c) => c.status === 'ready');

  if (readyClients.length === 0) {
    vscode.window.showWarningMessage(
      'Nenhuma conta do WhatsApp está conectada. Abra o painel lateral para iniciar a conexão.',
    );
    return;
  }

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
      description: `[${chat.accountNickname}]${unreadSuffix}`,
      detail: chat.lastMessage
        ? `Última: ${chat.lastMessage.slice(0, 100)}`
        : undefined,
      chatId: chat.id,
      accountNickname: chat.accountNickname,
    };
  });

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Selecione uma conversa…',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(eye) Ver mensagens', description: 'Visualizar a conversa' },
      { label: '$(reply) Responder', description: 'Enviar uma mensagem' },
    ],
    { placeHolder: `O que fazer com "${selected.label}"?` },
  );

  if (!action) return;

  if (action.label.includes('Ver')) {
    await showChatMessages(accountManager, selected.chatId, selected.accountNickname, selected.label);
  } else {
    await sendReply(accountManager, selected.chatId, selected.accountNickname, selected.label, selected.description);
  }
}

async function showChatMessages(
  accountManager: AccountManager,
  chatId: string,
  accountNickname: string,
  chatName: string,
): Promise<void> {
  const client = accountManager.getClient(accountNickname);
  if (!client) {
    void vscode.window.showErrorMessage('Conta não encontrada.');
    return;
  }

  try {
    const messages = await client.getChatMessages(chatId);
    
    if (messages.length === 0) {
      void vscode.window.showInformationMessage('Nenhuma mensagem nesta conversa.');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      `chat-${chatId}`,
      `${chatName} - WhatsApp`,
      vscode.ViewColumn.One,
      { enableScripts: true },
    );

    const html = generateChatHtml(messages, chatName, chatId, accountNickname);
    panel.webview.html = html;

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Erro ao carregar mensagens: ${message}`);
  }
}

function generateChatHtml(messages: MessageInfo[], chatName: string, chatId: string, accountNickname: string): string {
  const msgsHtml = messages.map((msg) => {
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const fromMeClass = msg.fromMe ? 'from-me' : 'from-them';
    const senderLabel = msg.fromMe ? 'Você' : msg.sender;
    
    return `
      <div class="message ${fromMeClass}">
        <div class="message-content">${escapeHtml(msg.body)}</div>
        <div class="message-meta">
          <span class="sender">${escapeHtml(senderLabel)}</span>
          <span class="time">${time}</span>
        </div>
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); display: flex; flex-direction: column; height: 100vh; margin: 0; }
    h2 { margin: 0 0 10px 0; font-size: 16px; }
    .chat-container { flex: 1; overflow-y: auto; }
    .message { margin: 8px 0; padding: 8px 12px; border-radius: 4px; max-width: 70%; border: 1px solid var(--vscode-focusBorder); }
    .from-me { margin-left: auto; }
    .message-content { word-wrap: break-word; }
    .message-meta { font-size: 11px; opacity: 0.7; margin-top: 4px; display: flex; justify-content: space-between; }
    .sender { font-weight: bold; }
    .time { margin-left: 8px; }
    .empty { text-align: center; opacity: 0.6; margin-top: 20px; }
    .input-container { display: flex; gap: 8px; padding-top: 10px; border-top: 1px solid var(--vscode-focusBorder); }
    .input-container input { flex: 1; padding: 8px; border: 1px solid var(--vscode-focusBorder); border-radius: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    .input-container button { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
    .input-container button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <h2>${escapeHtml(chatName)}</h2>
  <div class="chat-container">
    ${msgsHtml || '<div class="empty">Nenhuma mensagem</div>'}
  </div>
  <div class="input-container">
    <input type="text" id="msg-input" placeholder="Digite uma mensagem…" />
    <button id="send-btn">Enviar</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const chatId = "${chatId}";
    const accountNickname = "${accountNickname}";
    
    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
    
    function sendMessage() {
      const input = document.getElementById('msg-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      vscode.postMessage({ command: 'sendChatMessage', chatId, accountNickname, text });
    }
  </script>
</body>
</html>
  `;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendReply(
  accountManager: AccountManager,
  chatId: string,
  accountNickname: string,
  chatName: string,
  chatDescription: string | undefined,
): Promise<void> {
  const text = await vscode.window.showInputBox({
    prompt: `Responder para ${chatName} (${chatDescription?.trim()})`,
    placeHolder: 'Digite sua mensagem…',
    validateInput: (value) =>
      value.trim() ? null : 'A mensagem não pode estar estar em branco.',
  });

  if (!text?.trim()) return;

  const targetClient = accountManager.getClient(accountNickname);
  if (!targetClient) {
    void vscode.window.showErrorMessage('Conta não encontrada.');
    return;
  }
  try {
    await targetClient.sendMessage(chatId, text.trim());
    void vscode.window.showInformationMessage(
      `Mensagem enviada para ${chatName}`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Falha ao enviar mensagem: ${message}`);
  }
}

export async function executeOpenChat(
  accountManager: AccountManager,
  chatId: string,
  chatName: string,
  accountNickname: string,
): Promise<void> {
  const client = accountManager.getClient(accountNickname);
  if (!client) {
    void vscode.window.showErrorMessage('Conta não encontrada.');
    return;
  }

  if (client.status !== 'ready') {
    void vscode.window.showWarningMessage('Conta não conectada.');
    return;
  }

  // Armazena info do chat atual
  currentChatInfo = { chatId, chatName, accountNickname };

  // Reutiliza o painel existente ou cria um novo
  if (!chatPanel) {
    chatPanel = vscode.window.createWebviewPanel(
      'whatsappChat',
      'WhatsApp Chat',
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    chatPanel.onDidDispose(() => {
      chatPanel = undefined;
      currentChatInfo = undefined;
    });
  } else {
    chatPanel.reveal(vscode.ViewColumn.One);
  }

  const panel = chatPanel;
  try {
    panel.title = `${chatName} - WhatsApp`;
    panel.webview.html = generateLoadingHtml(chatName);

    const messages = await client.getChatMessages(chatId);

    // O painel pode ter sido fechado durante o await
    if (chatPanel !== panel) return;
    panel.webview.html = generateChatHtml(messages, chatName, chatId, accountNickname);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Erro ao carregar mensagens: ${message}`);
  }
}

function generateLoadingHtml(chatName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); text-align: center; }
  </style>
</head>
<body>
  <p>Carregando ${escapeHtml(chatName)}...</p>
</body>
</html>`;
}
