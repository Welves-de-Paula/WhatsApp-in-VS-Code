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
  | { type: 'destroy' };

type WorkerToHostMsg =
  | { type: 'qr'; qr: string }
  | { type: 'ready' }
  | { type: 'statusChange'; status: string }
  | { type: 'chatsUpdate'; chats: SerializedChat[] }
  | { type: 'message'; from: string; body: string; notifyName?: string }
  | { type: 'sendResult'; success: boolean; error?: string }
  | { type: 'log'; level: 'info' | 'error'; message: string };

interface SerializedChat {
  id: string;
  name: string;
  lastMessage: string;
  timestamp: number;
  unreadCount: number;
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
    const chats: SerializedChat[] = rawChats.slice(0, 30).map(
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
