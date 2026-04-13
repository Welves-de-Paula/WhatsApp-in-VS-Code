import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { WhatsAppClient } from './WhatsAppClient';
import { AccountState, HostMessage, WebviewMessage } from './types';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private initialized = false;

  constructor(
    private readonly clients: WhatsAppClient[],
    private readonly extensionUri: vscode.Uri,
  ) {
    // Attach event listeners once at construction time.
    // Updates will be forwarded to the webview whenever _view is available.
    clients.forEach((client, i) => {
      client.on('chatsUpdate', () => this.pushChatsUpdate(i));
      client.on('statusChange', () => this.pushStatusUpdate(i));
    });
  }

  // -------------------------------------------------------------------------
  // WebviewViewProvider implementation
  // -------------------------------------------------------------------------

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((raw: WebviewMessage) => {
      switch (raw.command) {
        case 'init':
          this.pushFullState();
          break;
        case 'quickReply':
          void vscode.commands.executeCommand('whatsapp.quickReply');
          break;
        case 'reconnect':
          if (raw.accountIndex === 0) {
            void vscode.commands.executeCommand('whatsapp.reconnectAccount1');
          } else {
            void vscode.commands.executeCommand('whatsapp.reconnectAccount2');
          }
          break;
      }
    });

    // Lazy-initialize clients the first time the panel is opened
    if (!this.initialized) {
      this.initialized = true;
      this.initializeClients();
    }
  }

  // -------------------------------------------------------------------------
  // Push helpers
  // -------------------------------------------------------------------------

  pushFullState(): void {
    if (!this._view) return;
    const states: AccountState[] = this.clients.map((c) => ({
      index: c.accountIndex,
      status: c.status,
      chats: c.chats,
    }));
    const msg: HostMessage = { type: 'fullState', states };
    void this._view.webview.postMessage(msg);
    this.updateBadge();
  }

  private pushChatsUpdate(accountIndex: number): void {
    if (!this._view) return;
    const msg: HostMessage = {
      type: 'chatsUpdate',
      accountIndex,
      chats: this.clients[accountIndex].chats,
    };
    void this._view.webview.postMessage(msg);
    this.updateBadge();
  }

  private pushStatusUpdate(accountIndex: number): void {
    if (!this._view) return;
    const msg: HostMessage = {
      type: 'statusUpdate',
      accountIndex,
      status: this.clients[accountIndex].status,
    };
    void this._view.webview.postMessage(msg);
  }

  private updateBadge(): void {
    if (!this._view) return;
    const total = this.clients.reduce(
      (sum, c) => sum + c.chats.reduce((s, ch) => s + ch.unreadCount, 0),
      0,
    );
    this._view.badge =
      total > 0
        ? { value: total, tooltip: `${total} mensagens não lidas` }
        : undefined;
  }

  private initializeClients(): void {
    Promise.all(this.clients.map((c) => c.initialize())).catch((err) =>
      console.error('[WhatsApp Multi] Erro ao inicializar clientes:', err),
    );
  }

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');

    // CSP: allow inline scripts/styles (nonce-based), no external resources
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    void webview; // reserved for future local resource URIs

    return /* html */ `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      padding: 0 0 8px;
    }

    /* ---- Account section ---- */
    .section { margin-bottom: 4px; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
      user-select: none;
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }

    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      transition: background 0.3s;
    }
    .dot-ready        { background: #25d366; }
    .dot-connecting   { background: #ffc107; animation: pulse 1.2s infinite; }
    .dot-qr           { background: #2196f3; animation: pulse 1.2s infinite; }
    .dot-disconnected { background: #757575; }
    .dot-error        { background: #f44336; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }

    .section-status {
      font-size: 10px;
      opacity: 0.65;
    }

    /* ---- Connect button ---- */
    .btn-connect {
      font-size: 10px;
      padding: 2px 7px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    .btn-connect:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    /* ---- Chat list ---- */
    .chat-list { padding: 2px 0; }

    .chat-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      cursor: pointer;
      border-radius: 0;
    }
    .chat-item:hover { background: var(--vscode-list-hoverBackground); }

    .avatar {
      width: 30px; height: 30px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 700;
      flex-shrink: 0;
    }

    .chat-body { flex: 1; min-width: 0; }

    .chat-name {
      font-size: 12px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .chat-last {
      font-size: 11px; opacity: 0.6;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .badge {
      background: #25d366; color: #fff;
      font-size: 10px; font-weight: 700;
      padding: 1px 5px; border-radius: 10px;
      flex-shrink: 0; min-width: 18px; text-align: center;
    }

    /* ---- State messages ---- */
    .state-msg {
      padding: 10px 12px;
      font-size: 11px; opacity: 0.65;
      text-align: center;
    }

    /* ---- Quick Reply bar ---- */
    #quick-reply {
      width: calc(100% - 16px); margin: 6px 8px 0;
      padding: 7px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      cursor: pointer; font-size: 12px;
      font-family: var(--vscode-font-family);
    }
    #quick-reply:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div id="root"></div>
  <button id="quick-reply" nonce="${nonce}">⚡ Quick Reply  (Ctrl+Alt+W)</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ----- State -----
    const state = {
      accounts: [
        { index: 0, status: 'disconnected', chats: [] },
        { index: 1, status: 'disconnected', chats: [] }
      ]
    };

    const STATUS_LABELS = {
      disconnected: 'Desconectado',
      connecting:   'Conectando…',
      qr:           'Aguardando QR…',
      ready:        'Conectado',
      error:        'Erro de autenticação'
    };

    // ----- Sanitize -----
    function esc(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function initials(name) {
      return (name || '?')
        .split(' ')
        .slice(0, 2)
        .map(w => w[0] || '')
        .join('')
        .toUpperCase() || '?';
    }

    // ----- Render -----
    function renderAccount(acct) {
      const dotClass = 'dot dot-' + acct.status;
      const label = STATUS_LABELS[acct.status] || acct.status;

      const connectBtn = (acct.status === 'disconnected' || acct.status === 'error')
        ? '<button class="btn-connect" onclick="reconnect(' + acct.index + ')">Conectar</button>'
        : '';

      let body;
      if (acct.status === 'ready' && acct.chats.length > 0) {
        body = '<div class="chat-list">' +
          acct.chats.slice(0, 20).map(chat =>
            '<div class="chat-item" title="' + esc(chat.name) + '">' +
              '<div class="avatar">' + esc(initials(chat.name)) + '</div>' +
              '<div class="chat-body">' +
                '<div class="chat-name">' + esc(chat.name) + '</div>' +
                (chat.lastMessage
                  ? '<div class="chat-last">' + esc(chat.lastMessage) + '</div>'
                  : '') +
              '</div>' +
              (chat.unreadCount > 0 ? '<span class="badge">' + chat.unreadCount + '</span>' : '') +
            '</div>'
          ).join('') +
        '</div>';
      } else if (acct.status === 'ready') {
        body = '<p class="state-msg">Nenhuma conversa encontrada.</p>';
      } else {
        body = '<p class="state-msg">' + esc(label) + '</p>';
      }

      return (
        '<div class="section">' +
          '<div class="section-header">' +
            '<span class="section-title">' +
              '<span class="' + dotClass + '"></span>' +
              'Conta ' + (acct.index + 1) +
            '</span>' +
            '<span style="display:flex;align-items:center;gap:6px;">' +
              '<span class="section-status">' + esc(label) + '</span>' +
              connectBtn +
            '</span>' +
          '</div>' +
          body +
        '</div>'
      );
    }

    function render() {
      document.getElementById('root').innerHTML =
        state.accounts.map(renderAccount).join('');
    }

    // ----- Actions -----
    function reconnect(idx) {
      vscode.postMessage({ command: 'reconnect', accountIndex: idx });
    }

    document.getElementById('quick-reply').addEventListener('click', () => {
      vscode.postMessage({ command: 'quickReply' });
    });

    // ----- Message bus -----
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'fullState':
          state.accounts = msg.states;
          render();
          break;
        case 'chatsUpdate':
          state.accounts[msg.accountIndex].chats = msg.chats;
          render();
          break;
        case 'statusUpdate':
          state.accounts[msg.accountIndex].status = msg.status;
          render();
          break;
      }
    });

    // Request initial snapshot
    vscode.postMessage({ command: 'init' });
  </script>
</body>
</html>`;
  }
}
