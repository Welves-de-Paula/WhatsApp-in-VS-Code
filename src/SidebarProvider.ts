import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AccountManager } from './AccountManager';
import { AccountState, HostMessage, WebviewMessage } from './types';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;

  constructor(
    private readonly accountManager: AccountManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    // Sempre que a lista de contas ou o estado de alguma conta mudar,
    // re-envia o estado completo para o webview.
    accountManager.on('listChanged', () => this.pushFullState());
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

        case 'sendChatMessage':
          if (raw.chatId?.trim() && raw.accountNickname?.trim() && raw.text?.trim()) {
            const client = this.accountManager.getClient(raw.accountNickname.trim());
            if (client) {
              void client.sendMessage(raw.chatId.trim(), raw.text.trim())
                .then(() => {
                  void vscode.window.showInformationMessage('Mensagem enviada!');
                })
                .catch((err: unknown) => {
                  void vscode.window.showErrorMessage(`Erro: ${(err as Error).message}`);
                });
            }
          }
          break;

        case 'addAccount':
          if (raw.nickname?.trim()) {
            void this.accountManager.addAccount(raw.nickname.trim()).catch(
              (err: unknown) => {
                void this._view?.webview.postMessage({
                  type: 'addError',
                  message: (err as Error).message,
                });
              },
            );
          }
          break;

        case 'reconnect':
          if (raw.nickname) {
            void this.accountManager.reconnectAccount(raw.nickname);
          }
          break;

        case 'removeAccount':
          if (raw.nickname) {
            void this.handleRemoveAccount(raw.nickname);
          }
          break;
      }
    });

    // Envia o estado inicial assim que o painel abre
    this.pushFullState();
  }

  // -------------------------------------------------------------------------
  // Push helpers
  // -------------------------------------------------------------------------

  pushFullState(): void {
    if (!this._view) return;
    const states: AccountState[] = this.accountManager.getClients().map((c) => ({
      nickname: c.nickname,
      status: c.status,
      chats: c.chats,
    }));
    const msg: HostMessage = { type: 'fullState', states };
    void this._view.webview.postMessage(msg);
    this.updateBadge();
  }

  private updateBadge(): void {
    if (!this._view) return;
    const total = this.accountManager
      .getClients()
      .reduce((sum, c) => sum + c.chats.reduce((s, ch) => s + ch.unreadCount, 0), 0);
    this._view.badge =
      total > 0
        ? { value: total, tooltip: `${total} mensagens não lidas` }
        : undefined;
  }

  private async handleRemoveAccount(nickname: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Remover conta "${nickname}"? Isso apagará a sessão salva.`,
      { modal: true },
      'Remover',
    );
    if (choice === 'Remover') {
      await this.accountManager.removeAccount(nickname);
    }
  }

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    void webview;

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

    /* ---- Toolbar ---- */
    #toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
    }

    #toolbar-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      opacity: 0.7;
    }

    #btn-add {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 3px 8px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    #btn-add:hover { background: var(--vscode-button-hoverBackground); }

    /* ---- Inline add form ---- */
    #add-form {
      display: none;
      padding: 6px 10px 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    #add-form label {
      display: block;
      font-size: 10px;
      opacity: 0.7;
      margin-bottom: 4px;
    }
    #add-form-row {
      display: flex;
      gap: 4px;
    }
    #add-input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 3px 6px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      outline: none;
    }
    #add-input:focus { border-color: var(--vscode-focusBorder); }
    .btn-form {
      font-size: 11px;
      padding: 3px 8px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    #add-ok {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #add-ok:hover { background: var(--vscode-button-hoverBackground); }
    #add-cancel-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    #add-cancel-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #add-error {
      display: none;
      color: var(--vscode-inputValidation-errorForeground, #f44336);
      font-size: 10px;
      margin-top: 4px;
    }

    /* ---- Empty state ---- */
    #empty-state {
      padding: 24px 16px;
      text-align: center;
      font-size: 12px;
      opacity: 0.6;
      line-height: 1.6;
    }

    /* ---- Account section ---- */
    .section { margin-bottom: 2px; }

    .section-header {
      display: flex;
      align-items: center;
      padding: 5px 10px;
      background: var(--vscode-sideBarSectionHeader-background);
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
      cursor: pointer;
      user-select: none;
      gap: 6px;
    }
    .section-header:hover { background: var(--vscode-list-hoverBackground); }

    .chevron {
      font-size: 10px;
      transition: transform 0.15s;
      opacity: 0.6;
      flex-shrink: 0;
    }
    .chevron.open { transform: rotate(90deg); }

    .dot {
      width: 7px; height: 7px;
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

    .section-name {
      flex: 1;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .section-status {
      font-size: 10px;
      opacity: 0.6;
      flex-shrink: 0;
    }

    .btn-action {
      font-size: 10px;
      padding: 2px 6px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      flex-shrink: 0;
    }
    .btn-action:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .btn-remove {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      opacity: 0.45;
      cursor: pointer;
      font-size: 13px;
      padding: 0 2px;
      line-height: 1;
      flex-shrink: 0;
    }
    .btn-remove:hover { opacity: 1; color: #f44336; }

    /* ---- Chat list ---- */
    .chat-list { padding: 2px 0; }

    .chat-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      cursor: pointer;
    }
    .chat-item:hover { background: var(--vscode-list-hoverBackground); }

    .avatar {
      width: 28px; height: 28px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700;
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

    .state-msg {
      padding: 8px 12px;
      font-size: 11px; opacity: 0.6;
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
  <div id="toolbar">
    <span id="toolbar-title">Contas</span>
    <button id="btn-add">&#xFF0B; Adicionar conta</button>
  </div>
  <div id="add-form">
    <label for="add-input">Apelido da conta</label>
    <div id="add-form-row">
      <input id="add-input" type="text" placeholder="Ex: Pessoal, Trabalho\u2026" maxlength="64" autocomplete="off" spellcheck="false">
      <button id="add-ok" class="btn-form">OK</button>
      <button id="add-cancel-btn" class="btn-form">&#10005;</button>
    </div>
    <div id="add-error"></div>
  </div>
  <div id="root"></div>
  <button id="quick-reply">&#x26A1; Quick Reply&nbsp;&nbsp;(Ctrl+Alt+W)</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ----- State -----
    const state = {
      accounts: [],   // AccountState[]
      expanded: {}    // { [nickname]: boolean }
    };

    const STATUS_LABELS = {
      disconnected: 'Desconectado',
      connecting:   'Conectando\u2026',
      qr:           'Aguardando QR\u2026',
      ready:        'Conectado',
      error:        'Erro'
    };

    // ----- Sanitize -----
    function esc(str) {
      return String(str ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function initials(name) {
      return (name || '?').split(' ').slice(0,2)
        .map(function(w) { return w[0] || ''; }).join('').toUpperCase() || '?';
    }

    // ----- Render -----
    function renderAccount(acct) {
      var isExpanded = !!state.expanded[acct.nickname];
      var dotCls = 'dot dot-' + acct.status;
      var label = STATUS_LABELS[acct.status] || acct.status;
      var chevron = '<span class="chevron' + (isExpanded ? ' open' : '') + '">&#9658;</span>';

      var canConnect = acct.status === 'disconnected' || acct.status === 'error';
      var connectBtn = canConnect
        ? '<button class="btn-action" data-action="reconnect" data-nickname="' + esc(acct.nickname) + '">Conectar</button>'
        : '';

      var removeBtn = '<button class="btn-remove" title="Remover conta" data-action="remove" data-nickname="' + esc(acct.nickname) + '">&#10005;</button>';

      var body = '';
      if (isExpanded) {
        if (acct.status === 'ready' && acct.chats.length > 0) {
          body = '<div class="chat-list">' +
            acct.chats.slice(0, 20).map(function(chat) {
              return '<div class="chat-item" title="' + esc(chat.name) + '">' +
                '<div class="avatar">' + esc(initials(chat.name)) + '</div>' +
                '<div class="chat-body">' +
                  '<div class="chat-name">' + esc(chat.name) + '</div>' +
                  (chat.lastMessage ? '<div class="chat-last">' + esc(chat.lastMessage) + '</div>' : '') +
                '</div>' +
                (chat.unreadCount > 0 ? '<span class="badge">' + chat.unreadCount + '</span>' : '') +
              '</div>';
            }).join('') +
          '</div>';
        } else if (acct.status === 'ready') {
          body = '<p class="state-msg">Nenhuma conversa encontrada.</p>';
        } else {
          body = '<p class="state-msg">' + esc(label) + '</p>';
        }
      }

      return (
        '<div class="section" data-nickname="' + esc(acct.nickname) + '">' +
          '<div class="section-header">' +
            chevron +
            '<span class="' + dotCls + '"></span>' +
            '<span class="section-name">' + esc(acct.nickname) + '</span>' +
            '<span class="section-status">' + esc(label) + '</span>' +
            connectBtn +
            removeBtn +
          '</div>' +
          body +
        '</div>'
      );
    }

    function render() {
      var root = document.getElementById('root');
      if (state.accounts.length === 0) {
        root.innerHTML = '<div id="empty-state">Nenhuma conta adicionada.<br>Clique em <strong>+ Adicionar conta</strong> para come\u00e7ar.</div>';
      } else {
        root.innerHTML = state.accounts.map(renderAccount).join('');
      }
    }

    // ----- Actions (event delegation — sem onclick inline para respeitar CSP) -----
    document.getElementById('root').addEventListener('click', function(e) {
      var target = e.target;

      // Botão "Remover" (×)
      var removeBtn = target.closest('[data-action="remove"]');
      if (removeBtn) {
        e.stopPropagation();
        vscode.postMessage({ command: 'removeAccount', nickname: removeBtn.dataset.nickname });
        return;
      }

      // Botão "Conectar"
      var connectBtn = target.closest('[data-action="reconnect"]');
      if (connectBtn) {
        e.stopPropagation();
        vscode.postMessage({ command: 'reconnect', nickname: connectBtn.dataset.nickname });
        return;
      }

      // Clique no cabeçalho da seção → expandir/recolher
      var header = target.closest('.section-header');
      if (header) {
        var section = header.closest('[data-nickname]');
        if (section) {
          var nickname = section.dataset.nickname;
          state.expanded[nickname] = !state.expanded[nickname];
          render();
        }
      }
    });

    // ---- Inline add-account form ----
    var addForm = document.getElementById('add-form');
    var addInput = document.getElementById('add-input');
    var addError = document.getElementById('add-error');

    document.getElementById('btn-add').addEventListener('click', function() {
      addForm.style.display = addForm.style.display === 'block' ? 'none' : 'block';
      if (addForm.style.display === 'block') {
        addInput.value = '';
        addError.style.display = 'none';
        addInput.focus();
      }
    });

    function submitAdd() {
      var val = addInput.value.trim();
      if (!val) {
        addError.textContent = 'O apelido n\u00e3o pode estar em branco.';
        addError.style.display = 'block';
        return;
      }
      var exists = state.accounts.some(function(a) { return a.nickname === val; });
      if (exists) {
        addError.textContent = 'J\u00e1 existe uma conta com esse apelido.';
        addError.style.display = 'block';
        return;
      }
      addForm.style.display = 'none';
      addInput.value = '';
      addError.style.display = 'none';
      vscode.postMessage({ command: 'addAccount', nickname: val });
    }

    document.getElementById('add-ok').addEventListener('click', submitAdd);
    document.getElementById('add-cancel-btn').addEventListener('click', function() {
      addForm.style.display = 'none';
      addInput.value = '';
      addError.style.display = 'none';
    });
    addInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { submitAdd(); }
      if (e.key === 'Escape') { document.getElementById('add-cancel-btn').click(); }
    });

    document.getElementById('quick-reply').addEventListener('click', function() {
      vscode.postMessage({ command: 'quickReply' });
    });

    // ----- Message bus -----
    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.type) {
        case 'fullState':
          state.accounts = msg.states;
          render();
          break;
        case 'chatsUpdate': {
          var acct = state.accounts.find(function(a) { return a.nickname === msg.nickname; });
          if (acct) { acct.chats = msg.chats; render(); }
          break;
        }
        case 'statusUpdate': {
          var a = state.accounts.find(function(x) { return x.nickname === msg.nickname; });
          if (a) { a.status = msg.status; render(); }
          break;
        }
        case 'addError': {
          var errEl = document.getElementById('add-error');
          errEl.textContent = msg.message;
          errEl.style.display = 'block';
          var form = document.getElementById('add-form');
          form.style.display = 'block';
          break;
        }
      }
    });

    // Solicita estado inicial
    vscode.postMessage({ command: 'init' });
  </script>
</body>
</html>`;
  }
}
