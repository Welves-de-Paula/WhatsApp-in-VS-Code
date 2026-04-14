import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { AccountManager } from './AccountManager';
import { AccountNotificationSettings, DEFAULT_NOTIFICATION_SETTINGS } from './types';

/** Um painel de configurações por conta — reutiliza o mesmo panel se já aberto. */
export class NotificationSettingsPanel {
  private static readonly panels: Map<string, NotificationSettingsPanel> = new Map();

  private readonly panel: vscode.WebviewPanel;
  private readonly nickname: string;

  static openOrReveal(
    nickname: string,
    accountManager: AccountManager,
    extensionUri: vscode.Uri,
  ): void {
    const existing = NotificationSettingsPanel.panels.get(nickname);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    new NotificationSettingsPanel(nickname, accountManager, extensionUri);
  }

  private constructor(
    nickname: string,
    private readonly accountManager: AccountManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.nickname = nickname;

    this.panel = vscode.window.createWebviewPanel(
      'whatsappNotifSettings',
      `Notificações — ${nickname}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
        retainContextWhenHidden: false,
      },
    );

    NotificationSettingsPanel.panels.set(nickname, this);

    const settings = accountManager.getNotificationSettings(nickname);
    this.panel.webview.html = this.buildHtml(settings);

    this.panel.webview.onDidReceiveMessage(async (msg: { command: string; settings?: AccountNotificationSettings }) => {
      if (msg.command === 'save' && msg.settings) {
        await accountManager.saveNotificationSettings(nickname, msg.settings);
        void vscode.window.showInformationMessage(
          `Configurações de notificação de "${nickname}" salvas.`,
        );
      } else if (msg.command === 'cancel') {
        this.panel.dispose();
      }
    });

    this.panel.onDidDispose(() => {
      NotificationSettingsPanel.panels.delete(nickname);
    });
  }

  private soundUri(filename: string): vscode.Uri {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this.extensionUri.fsPath, 'media', 'sounds', filename),
      ),
    );
  }

  private buildHtml(settings: AccountNotificationSettings): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const s = { ...DEFAULT_NOTIFICATION_SETTINGS, ...settings };

    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `media-src ${this.panel.webview.cspSource}`,
    ].join('; ');

    const dingUri = this.soundUri('ding.wav');
    const chimeUri = this.soundUri('chime.wav');
    const popUri = this.soundUri('pop.wav');
    const universfieldUri = this.soundUri('universfield.wav');

    function sel(option: string, current: string, label: string): string {
      return `<option value="${option}"${current === option ? ' selected' : ''}>${label}</option>`;
    }

    const mutedContactsVal = (s.mutedContacts ?? []).join('\n');
    const mutedGroupsVal = (s.mutedGroups ?? []).join('\n');

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
      background: var(--vscode-editor-background);
      padding: 24px 32px 40px;
      max-width: 560px;
    }

    h1 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      padding-bottom: 10px;
    }

    section {
      margin-bottom: 20px;
    }

    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      opacity: 0.6;
      margin-bottom: 10px;
    }

    .field {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }

    .field label {
      flex: 0 0 160px;
      font-size: 12px;
    }

    .field select,
    .field input[type="text"],
    .field input[type="color"] {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 4px 7px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      outline: none;
    }

    .field select:focus,
    .field input[type="text"]:focus {
      border-color: var(--vscode-focusBorder);
    }

    .field input[type="color"] {
      padding: 2px 3px;
      height: 26px;
      cursor: pointer;
    }

    .field input[type="range"] {
      flex: 1;
      accent-color: var(--vscode-button-background);
    }

    .field .range-val {
      flex: 0 0 32px;
      text-align: right;
      font-size: 12px;
      opacity: 0.8;
    }

    .btn-preview {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 3px 10px;
      font-size: 11px;
      font-family: var(--vscode-font-family);
      cursor: pointer;
      flex-shrink: 0;
    }
    .btn-preview:hover { background: var(--vscode-button-secondaryHoverBackground); }

    .custom-path-row {
      display: none;
      margin-bottom: 10px;
    }
    .custom-path-row.visible { display: flex; }

    textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 5px 7px;
      font-size: 11px;
      font-family: var(--vscode-font-family);
      outline: none;
      resize: vertical;
      min-height: 60px;
    }
    textarea:focus { border-color: var(--vscode-focusBorder); }

    .hint {
      font-size: 10px;
      opacity: 0.55;
      margin-top: 3px;
    }

    .actions {
      display: flex;
      gap: 8px;
      margin-top: 28px;
    }

    .btn-save {
      padding: 6px 20px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      font-family: var(--vscode-font-family);
    }
    .btn-save:hover { background: var(--vscode-button-hoverBackground); }

    .btn-cancel {
      padding: 6px 16px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      font-family: var(--vscode-font-family);
    }
    .btn-cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <h1>&#x2699;&#xFE0F; Notificações — ${escapeHtml(settings.badgeColor ? this.nickname : this.nickname)}</h1>

  <!-- ---- Som ---- -->
  <section>
    <div class="section-title">Som</div>

    <div class="field">
      <label for="sel-sound">Arquivo de som</label>
      <select id="sel-sound">
        ${sel('ding', s.sound, 'Ding (padrão)')}
        ${sel('chime', s.sound, 'Chime')}
        ${sel('pop', s.sound, 'Pop')}
        ${sel('custom', s.sound, 'Personalizado…')}
        ${sel('none', s.sound, 'Sem som')}
      </select>
      <button class="btn-preview" id="btn-preview">&#x25B6; Ouvir</button>
    </div>

    <div class="field custom-path-row${s.sound === 'custom' ? ' visible' : ''}" id="custom-path-row">
      <label for="inp-custom-path">Caminho do arquivo</label>
      <input id="inp-custom-path" type="text" placeholder="/caminho/para/som.wav" value="${escapeHtml(s.customSoundPath)}">
    </div>

    <div class="field">
      <label for="inp-volume">Volume</label>
      <input id="inp-volume" type="range" min="0" max="100" value="${s.volume}">
      <span class="range-val" id="vol-label">${s.volume}%</span>
    </div>
  </section>

  <!-- ---- Alerta visual ---- -->
  <section>
    <div class="section-title">Alerta visual</div>

    <div class="field">
      <label for="sel-visual">Tipo de alerta</label>
      <select id="sel-visual">
        ${sel('banner', s.visualAlert, 'Banner (notificação nativa)')}
        ${sel('statusBarFlash', s.visualAlert, 'Flash na status bar (3s)')}
        ${sel('badgeOnly', s.visualAlert, 'Somente badge de contagem')}
        ${sel('none', s.visualAlert, 'Nenhum')}
      </select>
    </div>

    <div class="field">
      <label for="inp-badge-color">Cor do badge / status bar</label>
      <input id="inp-badge-color" type="color" value="${escapeHtml(s.badgeColor)}">
      <span style="font-size:11px;opacity:0.6;" id="color-hex">${escapeHtml(s.badgeColor)}</span>
    </div>
  </section>

  <!-- ---- Filtros ---- -->
  <section>
    <div class="section-title">Filtros</div>

    <div class="field">
      <label for="sel-filter">Notificar</label>
      <select id="sel-filter">
        ${sel('all', s.filter, 'Todas as mensagens')}
        ${sel('direct', s.filter, 'Somente mensagens diretas')}
        ${sel('groups', s.filter, 'Somente grupos')}
      </select>
    </div>

    <div style="margin-bottom:10px;">
      <label style="font-size:12px;display:block;margin-bottom:4px;">Contatos silenciados</label>
      <textarea id="inp-muted-contacts" placeholder="Um nome por linha">${escapeHtml(mutedContactsVal)}</textarea>
      <p class="hint">Um contato por linha. O nome deve coincidir exatamente com o exibido na conversa.</p>
    </div>

    <div>
      <label style="font-size:12px;display:block;margin-bottom:4px;">Grupos silenciados</label>
      <textarea id="inp-muted-groups" placeholder="Um nome por linha">${escapeHtml(mutedGroupsVal)}</textarea>
      <p class="hint">Um grupo por linha.</p>
    </div>
  </section>

  <div class="actions">
    <button class="btn-save" id="btn-save">Salvar</button>
    <button class="btn-cancel" id="btn-cancel">Cancelar</button>
  </div>

  <!-- hidden audio elements for preview -->
  <audio id="audio-ding"  src="${dingUri}"  preload="auto"></audio>
  <audio id="audio-chime" src="${chimeUri}" preload="auto"></audio>
  <audio id="audio-pop"   src="${popUri}"   preload="auto"></audio>
  <audio id="audio-universfield" src="${universfieldUri}" preload="auto"></audio>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    var selSound      = document.getElementById('sel-sound');
    var customPathRow = document.getElementById('custom-path-row');
    var inpCustomPath = document.getElementById('inp-custom-path');
    var inpVolume     = document.getElementById('inp-volume');
    var volLabel      = document.getElementById('vol-label');
    var selVisual     = document.getElementById('sel-visual');
    var inpBadgeColor = document.getElementById('inp-badge-color');
    var colorHex      = document.getElementById('color-hex');
    var selFilter     = document.getElementById('sel-filter');
    var inpContacts   = document.getElementById('inp-muted-contacts');
    var inpGroups     = document.getElementById('inp-muted-groups');
    var btnPreview    = document.getElementById('btn-preview');
    var btnSave       = document.getElementById('btn-save');
    var btnCancel     = document.getElementById('btn-cancel');

    selSound.addEventListener('change', function() {
      if (selSound.value === 'custom') {
        customPathRow.classList.add('visible');
      } else {
        customPathRow.classList.remove('visible');
      }
    });

    inpVolume.addEventListener('input', function() {
      volLabel.textContent = inpVolume.value + '%';
    });

    inpBadgeColor.addEventListener('input', function() {
      colorHex.textContent = inpBadgeColor.value;
    });

    btnPreview.addEventListener('click', function() {
      var vol = parseInt(inpVolume.value, 10) / 100;
      var soundName = selSound.value;
      if (soundName === 'none' || soundName === 'custom') return;
      var audio = document.getElementById('audio-' + soundName);
      if (!audio) return;
      audio.volume = vol;
      audio.currentTime = 0;
      audio.play().catch(function() {});
    });

    btnSave.addEventListener('click', function() {
      var lines = function(val) {
        return val.split('\\n').map(function(l) { return l.trim(); }).filter(Boolean);
      };
      var settings = {
        sound: selSound.value,
        customSoundPath: inpCustomPath.value.trim(),
        volume: parseInt(inpVolume.value, 10),
        visualAlert: selVisual.value,
        badgeColor: inpBadgeColor.value,
        filter: selFilter.value,
        mutedContacts: lines(inpContacts.value),
        mutedGroups: lines(inpGroups.value),
      };
      vscode.postMessage({ command: 'save', settings: settings });
    });

    btnCancel.addEventListener('click', function() {
      vscode.postMessage({ command: 'cancel' });
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(str: string | undefined): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
