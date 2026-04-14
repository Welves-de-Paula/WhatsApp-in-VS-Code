import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as QRCode from 'qrcode';

export class QRCodePanel {
  private panel: vscode.WebviewPanel | null = null;
  private readonly nickname: string;
  private readonly extensionUri: vscode.Uri;

  constructor(nickname: string, extensionUri: vscode.Uri) {
    this.nickname = nickname;
    this.extensionUri = extensionUri;
  }

  async show(qrString: string): Promise<void> {
    // Generate QR code as base64 PNG data URL
    const qrDataUrl = await QRCode.toDataURL(qrString, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        `whatsappQR_${this.nickname}`,
        `WhatsApp "${this.nickname}" — QR Code`,
        vscode.ViewColumn.Active,
        {
          enableScripts: false,
          retainContextWhenHidden: false,
        },
      );

      this.panel.onDidDispose(() => {
        this.panel = null;
      });
    }

    this.panel.webview.html = this.buildHtml(qrDataUrl);
    this.panel.reveal(vscode.ViewColumn.Active, true);
  }

  close(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private buildHtml(qrDataUrl: string): string {
    // Data-URL images don't need a nonce — CSP restricts to data: only
    const nonce = crypto.randomBytes(16).toString('base64');
    const acct = this.nickname;

    return /* html */ `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 20px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      padding: 32px;
      text-align: center;
    }
    h2 { font-size: 16px; font-weight: 600; }
    img {
      border-radius: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.35);
      background: #fff;
      padding: 10px;
    }
    .hint {
      font-size: 12px;
      opacity: 0.65;
      max-width: 320px;
      line-height: 1.5;
    }
    .steps {
      font-size: 12px;
      opacity: 0.75;
      text-align: left;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <h2>"${acct}" — Escanear QR Code</h2>
  <img src="${qrDataUrl}" alt="QR Code WhatsApp" width="280" height="280">
  <ol class="steps">
    <li>Abra o WhatsApp no celular</li>
    <li>Toque em <strong>Dispositivos Vinculados</strong></li>
    <li>Toque em <strong>Vincular Dispositivo</strong></li>
    <li>Aponte a câmera para o código acima</li>
  </ol>
  <p class="hint">Este painel fechará automaticamente após a autenticação ser concluída.</p>
</body>
</html>`;
  }
}
