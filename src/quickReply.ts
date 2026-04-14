import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AccountManager } from './AccountManager';
import { ChatInfo, MessageInfo } from './types';

interface ChatPickItem extends vscode.QuickPickItem {
  chatId: string;
  accountNickname: string;
}

/**
 * Painel único reutilizado para todas as conversas.
 * Ao abrir um chat diferente, o mesmo painel é atualizado em vez de criar um novo.
 */
let activeChatPanel: vscode.WebviewPanel | undefined;
let activeChatContext: { chatId: string; accountNickname: string } | undefined;
let activeChatSyncTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function executeQuickReply(
  accountManager: AccountManager,
  extensionUri: vscode.Uri,
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
    await openChatPanel(accountManager, selected.chatId, selected.label, selected.accountNickname, extensionUri);
  } else {
    await sendReply(accountManager, selected.chatId, selected.accountNickname, selected.label, selected.description);
  }
}

export async function executeOpenChat(
  accountManager: AccountManager,
  chatId: string,
  chatName: string,
  accountNickname: string,
  extensionUri: vscode.Uri,
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
  await openChatPanel(accountManager, chatId, chatName, accountNickname, extensionUri);
}

// ---------------------------------------------------------------------------
// Panel management — um painel por chatId, reutilizado em aberturas seguintes
// ---------------------------------------------------------------------------

async function openChatPanel(
  accountManager: AccountManager,
  chatId: string,
  chatName: string,
  accountNickname: string,
  extensionUri: vscode.Uri,
): Promise<void> {
  const client = accountManager.getClient(accountNickname);
  if (!client) {
    void vscode.window.showErrorMessage('Conta não encontrada.');
    return;
  }

  if (!activeChatPanel) {
    // Cria o painel uma única vez
    activeChatPanel = vscode.window.createWebviewPanel(
      'whatsappChat',
      `${chatName} - WhatsApp`,
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri], retainContextWhenHidden: true },
    );
    activeChatPanel.onDidDispose(() => {
      if (activeChatSyncTimer) {
        clearInterval(activeChatSyncTimer);
        activeChatSyncTimer = undefined;
      }
      activeChatPanel = undefined;
      activeChatContext = undefined;
    });
  } else {
    // Reutiliza o painel existente: atualiza título e traz para frente
    activeChatPanel.title = `${chatName} - WhatsApp`;
    activeChatPanel.reveal(vscode.ViewColumn.One, true);
  }

  // Atualiza contexto e registra handler para o novo chat
  activeChatContext = { chatId, accountNickname };
  registerChatWebviewHandler(activeChatPanel, accountManager, activeChatContext);

  const panel = activeChatPanel;
  panel.webview.html = generateLoadingHtml(chatName);

  try {
    const messages = await client.getChatMessages(chatId);
    // Garante que o painel não foi fechado nem trocado durante o await
    if (activeChatPanel === panel && activeChatContext?.chatId === chatId) {
      panel.webview.html = generateChatHtml(panel.webview, messages, chatName, chatId, accountNickname);
      startChatSync(accountManager, panel, chatId, accountNickname);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Erro ao carregar mensagens: ${message}`);
  }
}

function startChatSync(
  accountManager: AccountManager,
  panel: vscode.WebviewPanel,
  chatId: string,
  accountNickname: string,
): void {
  if (activeChatSyncTimer) clearInterval(activeChatSyncTimer);
  activeChatSyncTimer = setInterval(() => {
    void refreshChatMessages(accountManager, panel, chatId, accountNickname);
  }, 8000);
}

async function refreshChatMessages(
  accountManager: AccountManager,
  panel: vscode.WebviewPanel,
  chatId: string,
  accountNickname: string,
): Promise<void> {
  if (activeChatPanel !== panel) return;
  if (activeChatContext?.chatId !== chatId || activeChatContext.accountNickname !== accountNickname) return;

  const client = accountManager.getClient(accountNickname);
  if (!client || client.status !== 'ready') return;

  try {
    const messages = await client.getChatMessages(chatId);
    if (activeChatPanel !== panel) return;
    if (activeChatContext?.chatId !== chatId || activeChatContext.accountNickname !== accountNickname) return;
    void panel.webview.postMessage({
      command: 'replaceMessages',
      html: buildMessagesHtml(messages),
    });
  } catch {
    // Evita ruído visual em reconexões momentâneas.
  }
}

// ---------------------------------------------------------------------------
// WebviewPanel message handler
// ---------------------------------------------------------------------------

/**
 * Registra (ou re-registra) o handler de mensagens do painel.
 * Como o mesmo painel é reutilizado para diferentes chats, usamos uma
 * referência mutável ao contexto ativo em vez de capturar um valor fixo.
 */
function registerChatWebviewHandler(
  panel: vscode.WebviewPanel,
  accountManager: AccountManager,
  contextRef: { chatId: string; accountNickname: string },
): void {
  // Remove listeners anteriores substituindo o HTML (feito pelo chamador).
  // O listener do webview é acumulativo — registramos apenas uma vez por painel.
  if ((panel as vscode.WebviewPanel & { __handlerRegistered?: boolean }).__handlerRegistered) {
    return;
  }
  (panel as vscode.WebviewPanel & { __handlerRegistered?: boolean }).__handlerRegistered = true;

  panel.webview.onDidReceiveMessage(async (raw: { command?: string; chatId?: string; text?: string }) => {
    if (raw.command !== 'sendMessage') return;

    const chatId = raw.chatId?.trim();
    const text = raw.text?.trim();

    if (!chatId || !text) {
      void panel.webview.postMessage({ command: 'messageSent', success: false, error: 'Chat ou mensagem inválida.' });
      return;
    }

    // Lê o contexto atual no momento do envio (pode ter mudado desde o registro)
    const current = activeChatContext;
    if (!current || chatId !== current.chatId) {
      void panel.webview.postMessage({ command: 'messageSent', success: false, error: 'Conversa ativa mudou. Abra a conversa novamente.' });
      return;
    }

    const client = accountManager.getClient(current.accountNickname);
    if (!client) {
      void panel.webview.postMessage({ command: 'messageSent', success: false, error: 'Conta não encontrada para esta conversa.' });
      return;
    }

    try {
      await client.sendMessage(chatId, text);
      void panel.webview.postMessage({ command: 'messageSent', success: true });
    } catch (err: unknown) {
      void panel.webview.postMessage({
        command: 'messageSent',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  void contextRef; // referência usada indiretamente via activeChatContext
}

// ---------------------------------------------------------------------------
// Quick reply (send only, sem abrir painel)
// ---------------------------------------------------------------------------

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
      value.trim() ? null : 'A mensagem não pode estar em branco.',
  });

  if (!text?.trim()) return;

  const targetClient = accountManager.getClient(accountNickname);
  if (!targetClient) {
    void vscode.window.showErrorMessage('Conta não encontrada.');
    return;
  }
  try {
    await targetClient.sendMessage(chatId, text.trim());
    void vscode.window.showInformationMessage(`Mensagem enviada para ${chatName}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Falha ao enviar mensagem: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

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

function generateChatHtml(webview: vscode.Webview, messages: MessageInfo[], chatName: string, chatId: string, accountNickname: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = [
    `default-src 'none'`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src data: blob:`,
    `media-src data: blob:`,
  ].join('; ');

  const msgsHtml = messages.map((msg) => {
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const fromMeClass = msg.fromMe ? 'from-me' : 'from-them';
    const senderLabel = msg.fromMe ? 'Você' : msg.sender;

    return `
      <div class="message ${fromMeClass}">
        <div class="message-content">${renderMediaContent(msg)}</div>
        <div class="message-meta">
          <span class="sender">${escapeHtml(senderLabel)}</span>
          <span class="time">${time}</span>
        </div>
      </div>
    `;
  }).join('');

  void webview;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    h2 {
      font-size: 14px;
      font-weight: 600;
      padding: 10px 14px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
    }
    .chat-container {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 10px 14px 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .message {
      padding: 7px 11px;
      border-radius: 8px;
      max-width: 72%;
      word-wrap: break-word;
      background: var(--vscode-editorWidget-background, #2a2a2a);
      border: 1px solid var(--vscode-panel-border, transparent);
    }
    .from-me {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .from-them { align-self: flex-start; }
    .message-content { font-size: 13px; line-height: 1.4; }
    .message-meta {
      font-size: 10px;
      opacity: 0.6;
      margin-top: 3px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .sender { font-weight: 600; }
    .empty { text-align: center; opacity: 0.5; margin-top: 32px; font-size: 12px; }
    .input-wrapper {
      flex-shrink: 0;
      padding: 8px 12px 10px;
      background: var(--vscode-editor-background);
      box-shadow: 0 -4px 12px rgba(0,0,0,0.25);
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    .input-container {
      display: flex;
      gap: 8px;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 8px;
      padding: 4px 4px 4px 12px;
      transition: border-color 0.15s;
    }
    .input-container:focus-within { border-color: var(--vscode-focusBorder); }
    .input-container input {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-size: 13px;
      font-family: var(--vscode-font-family);
      outline: none;
      padding: 4px 0;
    }
    .input-container button {
      padding: 5px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      flex-shrink: 0;
    }
    .input-container button:hover { background: var(--vscode-button-hoverBackground); }
    .input-container button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .send-error {
      min-height: 16px;
      margin-top: 6px;
      color: var(--vscode-errorForeground, #f14c4c);
      font-size: 11px;
    }

    /* ---- Mídia ---- */
    .media-img {
      display: block;
      max-width: 220px;
      max-height: 280px;
      border-radius: 6px;
      object-fit: cover;
      cursor: zoom-in;
    }
    .media-sticker {
      display: block;
      max-width: 140px;
      max-height: 140px;
      background: transparent;
    }
    /* ---- Player de áudio customizado ---- */
    .audio-player {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      min-width: 210px;
      max-width: 260px;
    }
    .audio-play-btn {
      width: 30px; height: 30px;
      border-radius: 50%;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 11px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      user-select: none;
    }
    .audio-play-btn:hover { background: var(--vscode-button-hoverBackground); }
    .audio-progress-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .audio-bar-track {
      width: 100%;
      height: 4px;
      background: rgba(128,128,128,0.3);
      border-radius: 2px;
      cursor: pointer;
      position: relative;
    }
    .audio-bar-fill {
      height: 100%;
      background: var(--vscode-button-background);
      border-radius: 2px;
      width: 0%;
      pointer-events: none;
    }
    .audio-time {
      font-size: 10px;
      opacity: 0.55;
      letter-spacing: 0.3px;
    }
    .audio-icon {
      font-size: 14px;
      opacity: 0.6;
      flex-shrink: 0;
    }
    .media-video {
      display: block;
      max-width: 260px;
      max-height: 300px;
      border-radius: 6px;
    }
    .media-doc {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 2px 0;
    }
    .media-doc-icon { font-size: 18px; }
    .media-none {
      font-size: 11px;
      opacity: 0.5;
      font-style: italic;
    }

    /* ---- Contato (vCard) ---- */
    .media-contact {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 2px;
      min-width: 160px;
    }
    .contact-avatar {
      width: 36px; height: 36px;
      border-radius: 50%;
      background: var(--vscode-button-secondaryBackground, #444);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
      flex-shrink: 0;
    }
    .contact-info { display: flex; flex-direction: column; gap: 2px; }
    .contact-name { font-size: 13px; font-weight: 600; }
    .contact-phone { font-size: 11px; opacity: 0.65; }
    .contact-divider {
      border: none;
      border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
      margin: 4px 0 2px;
    }
  </style>
</head>
<body data-chat-id="${escapeHtml(chatId)}" data-account-nickname="${escapeHtml(accountNickname)}">
  <h2>${escapeHtml(chatName)}</h2>
  <div class="chat-container" id="chat-container">
    ${msgsHtml || '<div class="empty">Nenhuma mensagem</div>'}
  </div>
  <div class="input-wrapper">
    <div class="input-container">
      <input type="text" id="msg-input" placeholder="Digite uma mensagem…" autocomplete="off" />
      <button id="send-btn">Enviar</button>
    </div>
    <div id="send-error" class="send-error"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const currentChatId = document.body.dataset.chatId || '';
    let isSending = false;
    let pendingText = '';

    var container = document.getElementById('chat-container');
    container.scrollTop = container.scrollHeight;

    const sendButton = document.getElementById('send-btn');
    const input = document.getElementById('msg-input');
    const errorEl = document.getElementById('send-error');

    sendButton.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    });

    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.command === 'replaceMessages') {
        const wasNearBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight < 60;
        container.innerHTML = data.html || '<div class="empty">Nenhuma mensagem</div>';
        if (wasNearBottom) {
          container.scrollTop = container.scrollHeight;
        }
        return;
      }
      if (data.command !== 'messageSent') return;

      isSending = false;
      sendButton.disabled = false;

      if (data.success) {
        appendLocalMessage(pendingText);
        input.value = '';
        pendingText = '';
        errorEl.textContent = '';
        return;
      }
      errorEl.textContent = data.error || 'Falha ao enviar a mensagem.';
    });

    function sendMessage() {
      const text = input.value.trim();
      if (!text || isSending || !currentChatId) return;
      isSending = true;
      pendingText = text;
      sendButton.disabled = true;
      errorEl.textContent = '';
      vscode.postMessage({ command: 'sendMessage', chatId: currentChatId, text });
    }

    function appendLocalMessage(text) {
      const emptyEl = container.querySelector('.empty');
      if (emptyEl) emptyEl.remove();

      const msgEl = document.createElement('div');
      msgEl.className = 'message from-me';

      const contentEl = document.createElement('div');
      contentEl.className = 'message-content';
      contentEl.textContent = text;

      const metaEl = document.createElement('div');
      metaEl.className = 'message-meta';

      const senderEl = document.createElement('span');
      senderEl.className = 'sender';
      senderEl.textContent = 'Você';

      const timeEl = document.createElement('span');
      timeEl.className = 'time';
      const now = new Date();
      timeEl.textContent = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

      metaEl.appendChild(senderEl);
      metaEl.appendChild(timeEl);
      msgEl.appendChild(contentEl);
      msgEl.appendChild(metaEl);
      container.appendChild(msgEl);
      container.scrollTop = container.scrollHeight;
    }

    // ----------------------------------------------------------------
    // Player de áudio customizado
    // Usa elementos <audio> já presentes no DOM (criados pelo servidor).
    // NÃO usa "new Audio()" — bloqueado pelo sandbox do VS Code webview.
    // ----------------------------------------------------------------

    function getAudio(player) {
      const elemId = player.dataset.audioElem;
      return elemId ? document.getElementById(elemId) : null;
    }

    function fmtTime(sec) {
      if (!sec || isNaN(sec) || !isFinite(sec)) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + String(s).padStart(2, '0');
    }

    // Vincula os listeners de um <audio> ao seu player container (uma vez)
    function bindAudio(audio, player) {
      if (audio.__bound) return;
      audio.__bound = true;

      audio.addEventListener('loadedmetadata', function () {
        player.querySelector('.audio-time').textContent =
          '0:00 / ' + fmtTime(audio.duration);
      });

      audio.addEventListener('timeupdate', function () {
        const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
        player.querySelector('.audio-bar-fill').style.width = pct + '%';
        player.querySelector('.audio-time').textContent =
          fmtTime(audio.currentTime) + ' / ' + fmtTime(audio.duration);
      });

      audio.addEventListener('ended', function () {
        player.querySelector('.audio-play-btn').textContent = '▶';
        player.querySelector('.audio-bar-fill').style.width = '0%';
        player.querySelector('.audio-time').textContent =
          '0:00 / ' + fmtTime(audio.duration);
      });

      // Se os metadados já foram carregados antes do bind, atualiza o tempo
      if (audio.readyState >= 1 && audio.duration) {
        player.querySelector('.audio-time').textContent =
          '0:00 / ' + fmtTime(audio.duration);
      }
    }

    // Pausa todos os outros players
    function pauseOthers(exceptPlayer) {
      document.querySelectorAll('.audio-player').forEach(function (p) {
        if (p === exceptPlayer) return;
        const a = getAudio(p);
        if (a && !a.paused) {
          a.pause();
          p.querySelector('.audio-play-btn').textContent = '▶';
        }
      });
    }

    // Clique no botão play/pause
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('.audio-play-btn');
      if (!btn) return;
      const player = btn.closest('.audio-player');
      if (!player) return;

      const audio = getAudio(player);
      if (!audio) return;

      bindAudio(audio, player);
      pauseOthers(player);

      if (audio.paused) {
        audio.play().catch(function () { /* autoplay bloqueado — ignora */ });
        btn.textContent = '⏸';
      } else {
        audio.pause();
        btn.textContent = '▶';
      }
    });

    // Clique na barra para seekar
    document.addEventListener('click', function (e) {
      const track = e.target.closest('.audio-bar-track');
      if (!track) return;
      const player = track.closest('.audio-player');
      if (!player) return;

      const audio = getAudio(player);
      if (!audio || !audio.duration) return;

      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
    });
  </script>
</body>
</html>
  `;
}

function buildMessagesHtml(messages: MessageInfo[]): string {
  return messages.map((msg) => {
    const time = new Date(msg.timestamp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const fromMeClass = msg.fromMe ? 'from-me' : 'from-them';
    const senderLabel = msg.fromMe ? 'VocÃª' : msg.sender;

    return `
      <div class="message ${fromMeClass}">
        <div class="message-content">${renderMediaContent(msg)}</div>
        <div class="message-meta">
          <span class="sender">${escapeHtml(senderLabel)}</span>
          <span class="time">${time}</span>
        </div>
      </div>
    `;
  }).join('');
}

/** Extrai nome e telefone de uma string vCard */
function parseVCard(vcard: string): { name: string; phone: string } {
  const name = vcard.match(/^FN:(.+)$/m)?.[1]?.trim() ?? 'Contato';
  const phone = vcard.match(/^TEL[^:\r\n]*:(.+)$/m)?.[1]?.trim() ?? '';
  return { name, phone };
}

function renderVCardHtml(vcard: string): string {
  const { name, phone } = parseVCard(vcard);
  return `
    <div class="media-contact">
      <div class="contact-avatar">👤</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(name)}</div>
        ${phone ? `<div class="contact-phone">${escapeHtml(phone)}</div>` : ''}
      </div>
    </div>`;
}

function renderMediaContent(msg: MessageInfo): string {
  const type = msg.mediaType ?? '';

  // --- Contatos vCard ---
  if (type === 'vcard') {
    return renderVCardHtml(msg.body);
  }

  if (type === 'multi_vcard') {
    let vcards: string[] = [];
    try { vcards = JSON.parse(msg.body) as string[]; } catch { /* ignore */ }
    if (vcards.length === 0) {
      return `<span class="media-none">👤 Contatos</span>`;
    }
    return vcards
      .map((vc, i) => `${i > 0 ? '<hr class="contact-divider">' : ''}${renderVCardHtml(vc)}`)
      .join('');
  }

  // Sem mídia — texto simples
  if (!msg.hasMedia) {
    return msg.body ? escapeHtml(msg.body) : '';
  }

  // Mídia baixada com sucesso
  if (msg.mediaData && msg.mediaMime) {
    const src = `data:${escapeHtml(msg.mediaMime)};base64,${msg.mediaData}`;

    if (type === 'sticker') {
      return `<img class="media-sticker" src="${src}" alt="Figurinha">`;
    }

    if (type === 'image') {
      return `<img class="media-img" src="${src}" alt="Imagem">`;
    }

    if (type === 'gif') {
      // GIFs no WhatsApp chegam como vídeo mp4 sem áudio
      return `<video class="media-video" autoplay loop muted playsinline src="${src}"></video>`;
    }

    if (type === 'video') {
      return `<video class="media-video" controls src="${src}"></video>`;
    }

    if (type === 'audio' || type === 'ptt') {
      const icon = type === 'ptt' ? '🎙️' : '🎵';
      // Usa elemento <audio> real no DOM — mais confiável que new Audio() no webview
      const elemId = 'aud_' + msg.id.replace(/[^a-zA-Z0-9]/g, '_');
      return `
        <audio id="${elemId}" src="${src}" preload="auto" style="display:none"></audio>
        <div class="audio-player" data-audio-elem="${elemId}">
          <button class="audio-play-btn" title="Reproduzir/Pausar">▶</button>
          <div class="audio-progress-wrap">
            <div class="audio-bar-track">
              <div class="audio-bar-fill"></div>
            </div>
            <span class="audio-time">0:00 / 0:00</span>
          </div>
          <span class="audio-icon">${icon}</span>
        </div>`;
    }

    if (type === 'document') {
      const name = escapeHtml(msg.mediaFilename ?? 'documento');
      return `<div class="media-doc"><span class="media-doc-icon">📎</span>${name}</div>`;
    }

    // Tipo desconhecido mas com dados — tenta imagem como fallback
    return `<img class="media-img" src="${src}" alt="${escapeHtml(type)}">`;
  }

  // Mídia existe mas download falhou
  const labels: Record<string, string> = {
    image: '🖼️ Imagem',
    sticker: '😊 Figurinha',
    audio: '🔊 Áudio',
    ptt: '🎙️ Áudio',
    video: '🎬 Vídeo',
    gif: '🎞️ GIF',
    document: '📎 Documento',
  };
  const label = labels[type] ?? '📎 Mídia';
  const filename = msg.mediaFilename ? ` — ${escapeHtml(msg.mediaFilename)}` : '';
  return `<span class="media-none">${label}${filename}</span>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
