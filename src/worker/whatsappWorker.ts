/**
 * Standalone Node.js worker process.
 * Spawned via child_process.fork() — runs Puppeteer/whatsapp-web.js
 * completamente isolado do Extension Host.
 * Toda comunicação com o host é feita via IPC (process.send / process.on('message')).
 */

import * as fs from 'fs';
import * as path from 'path';

// ---- IPC types ----

type HostToWorkerMsg =
  | { type: 'initialize'; storagePath: string; sessionId: string }
  | { type: 'sendMessage'; chatId: string; text: string }
  | { type: 'getMessages'; chatId: string }
  | { type: 'destroy' };

type WorkerToHostMsg =
  | { type: 'qr'; qr: string }
  | { type: 'ready' }
  | { type: 'statusChange'; status: string }
  | { type: 'chatsUpdate'; chats: SerializedChat[] }
  | { type: 'message'; from: string; body: string; notifyName?: string }
  | { type: 'sendResult'; success: boolean; messages?: SerializedMessage[]; error?: string }
  | { type: 'log'; level: 'info' | 'error'; message: string };

interface SerializedChat {
  id: string;
  name: string;
  lastMessage: string;
  timestamp: number;
  unreadCount: number;
}

interface SerializedMessage {
  id: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  sender: string;
}

function send(msg: WorkerToHostMsg): void {
  process.send?.(msg);
}

function log(level: 'info' | 'error', message: string): void {
  send({ type: 'log', level, message });
}

function findSystemChrome(): string | undefined {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(
      process.env['LOCALAPPDATA'] ?? '',
      'Google\\Chrome\\Application\\chrome.exe',
    ),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;

async function initialize(
  storagePath: string,
  sessionId: string,
): Promise<void> {
  fs.mkdirSync(storagePath, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client, LocalAuth } = require('whatsapp-web.js') as typeof import('whatsapp-web.js');

  send({ type: 'statusChange', status: 'connecting' });

  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
  ];

  const executablePath = findSystemChrome();
  if (executablePath) {
    log('info', `Usando Chrome do sistema: ${executablePath}`);
  }

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: storagePath,
    }),
    puppeteer: {
      headless: true,
      args: puppeteerArgs,
      ...(executablePath ? { executablePath } : {}),
    },
  });

  client.on('qr', (qr: string) => {
    send({ type: 'statusChange', status: 'qr' });
    send({ type: 'qr', qr });
  });

  client.on('authenticated', () => {
    send({ type: 'statusChange', status: 'connecting' });
  });

  client.on('auth_failure', () => {
    send({ type: 'statusChange', status: 'error' });
    log('error', 'Falha na autenticação.');
  });

  client.on('ready', async () => {
    send({ type: 'statusChange', status: 'ready' });
    send({ type: 'ready' });
    await loadChats();
  });

  client.on('disconnected', (reason: string) => {
    log('info', `Desconectado: ${reason}`);
    send({ type: 'statusChange', status: 'disconnected' });
    client = null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.on('message', async (msg: any) => {
    if (!msg.fromMe) {
      send({
        type: 'message',
        from: msg.from as string,
        body: msg.body as string,
        notifyName: (msg._data as { notifyName?: string } | undefined)?.notifyName,
      });
    }
    await loadChats();
  });

  await client.initialize();
}

async function loadChats(): Promise<void> {
  if (!client) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawChats: any[] = await client.getChats();
    const filteredChats = rawChats.filter((chat: any) => {
      const isPinned = chat.pinned === true || chat.pin === 1;
      // Filter out archived chats (keep pinned ones)
      const isArchived = chat.archived === true || chat.archived === 1;
      return isPinned || !isArchived;
    });
    const chats: SerializedChat[] = filteredChats.slice(0, 30).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chat: any): SerializedChat => ({
        id: chat.id._serialized as string,
        name: chat.name as string,
        lastMessage: (chat.lastMessage?.body as string | undefined) ?? '',
        timestamp: (chat.lastMessage?.timestamp as number | undefined) ?? 0,
        unreadCount: chat.unreadCount as number,
      }),
    );
    send({ type: 'chatsUpdate', chats });
  } catch (err) {
    // TargetCloseError happens during browser reload/reconnect — not fatal
    const msg = (err as Error).message ?? '';
    if (!msg.includes('Target closed') && !msg.includes('Session closed')) {
      log('error', `loadChats: ${msg}`);
    }
  }
}

// ---- IPC command router ----

process.on('message', (raw: unknown) => {
  const msg = raw as HostToWorkerMsg;
  switch (msg.type) {
    case 'initialize':
      initialize(msg.storagePath, msg.sessionId).catch((err: Error) => {
        send({ type: 'statusChange', status: 'error' });
        log('error', `initialize: ${err.message}`);
      });
      break;

    case 'sendMessage':
      if (!client) {
        send({
          type: 'sendResult',
          success: false,
          error: 'Cliente não conectado.',
        });
        break;
      }
      (async () => {
        try {
          await client.sendMessage(msg.chatId, msg.text);
          await loadChats();
          send({ type: 'sendResult', success: true });
        } catch (err) {
          send({
            type: 'sendResult',
            success: false,
            error: (err as Error).message,
          });
        }
      })();
      break;

    case 'getMessages':
      if (!client) {
        send({
          type: 'sendResult',
          success: false,
          error: 'Cliente não conectado.',
        });
        break;
      }
      (async () => {
        try {
          if (!client) {
            throw new Error('Cliente não está pronto');
          }

          // Tenta primeiro pelo método do cliente
          try {
            log('info', `getChatById para: ${msg.chatId}`);
            const chat = await client.getChatById(msg.chatId);
            log('info', `Chat obtido: ${chat?.name}, buscando mensagens...`);
            const rawMessages = await chat.fetchMessages({ limit: 50 });
            log('info', `Mensagens obtidas: ${rawMessages.length}`);
            const messages = rawMessages.map((m: any) => ({
              id: m.id._serialized,
              body: m.body || '',
              fromMe: m.fromMe,
              timestamp: m.timestamp,
              sender: m._data?.notifyName || m.from?.replace(/@[cg]\.us$/, '')
            }));
            send({ type: 'sendResult', success: true, messages });
            return;
          } catch (innerErr) {
            const errMsg = (innerErr as Error).message || String(innerErr);
            log('info', `Método padrão falhou: ${errMsg}, tentando via Puppeteer`);
          }

          // Fallback: tenta acessar via Puppeteer - método simplificado
          // @ts-ignore
          const page = client.page || (client as any).pupPage;
          if (!page) {
            throw new Error('Navegador não disponível');
          }

          // Vai para o chat primeiro e espera carregar
          await page.goto(`https://web.whatsapp.com/app?chat=${msg.chatId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
          await new Promise(r => setTimeout(r, 5000));

          const messages = await page.evaluate((cid: string) => {
            const result: any[] = [];
            try {
              // Tenta obter mensagens da UI do WhatsApp
              const messageElements = document.querySelectorAll('[data-message-id], .message-[class*="message"]');
              
              messageElements.forEach((el: any) => {
                try {
                  const msgId = el.getAttribute('data-message-id') || Math.random().toString();
                  const bodyEl = el.querySelector('.selectable-text span, [role="button"] span[dir]');
                  const body = bodyEl ? bodyEl.innerText?.trim() : '';
                  
                  if (body) {
                    const fromMe = el.classList.contains('message-out') || el.classList.contains('out');
                    const timeEl = el.querySelector('[data-pre-plain-text], .copyable-text span');
                    let timestamp = Date.now() / 1000;
                    
                    result.push({
                      id: msgId,
                      body: body,
                      fromMe: fromMe,
                      timestamp: timestamp,
                      sender: ''
                    });
                  }
                } catch(e) {}
              });
              
              // Se ainda não achou, tenta via Store
              if (result.length === 0) {
                try {
                  // @ts-ignore
                  const w = window as any;
                  const chat = w.Store?.Chat?.get?.(cid) || w.Store?.Chat?.getById?.(cid);
                  if (chat && chat.msgs) {
                    const msgs = chat.msgs._models || chat.msgs.models || [];
                    msgs.slice(-50).forEach((m: any) => {
                      if (m && m.id && m.body) {
                        result.push({
                          id: m.id._serialized || m.id,
                          body: m.body || '',
                          fromMe: m.isMe || m.fromMe || false,
                          timestamp: m.t || m.timestamp || 0,
                          sender: m._data?.notifyName || ''
                        });
                      }
                    });
                  }
                } catch(e) {}
              }
            } catch (e) {}
            return result;
          }, msg.chatId);

          log('info', `Mensagens via Puppeteer: ${messages.length}`);

          send({ type: 'sendResult', success: true, messages });
        } catch (err) {
          send({
            type: 'sendResult',
            success: false,
            error: (err as Error).message,
          });
        }
      })();
      break;

    case 'destroy':
      (async () => {
        if (client) {
          try {
            await client.destroy();
          } catch {
            // ignore
          }
          client = null;
        }
        process.exit(0);
      })();
      break;
  }
});

process.on('uncaughtException', (err) => {
  log('error', `Exceção não tratada: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log('error', `Rejeição não tratada: ${String(reason)}`);
});
