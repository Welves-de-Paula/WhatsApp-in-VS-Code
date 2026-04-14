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
  | { type: 'sendMessage'; requestId: string; chatId: string; text: string }
  | { type: 'getMessages'; requestId: string; chatId: string }
  | { type: 'destroy' };

type WorkerToHostMsg =
  | { type: 'qr'; qr: string }
  | { type: 'ready' }
  | { type: 'statusChange'; status: string }
  | { type: 'chatsUpdate'; chats: SerializedChat[] }
  | { type: 'message'; from: string; body: string; notifyName?: string }
  | { type: 'sendResult'; requestId: string; success: boolean; messages?: SerializedMessage[]; error?: string }
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
/** Cache de todos os chats carregados — evita chamar getChats() repetidamente */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedAllChats: any[] = [];
const recentIncomingMessageIds: string[] = [];

/** Debounce para evitar chamadas duplas de loadChats (message + message_create) */
let loadChatsTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLoadChats(): void {
  if (loadChatsTimer) clearTimeout(loadChatsTimer);
  loadChatsTimer = setTimeout(() => {
    loadChatsTimer = null;
    loadChats().catch(() => {});
  }, 300);
}

function markIncomingMessageSeen(id: string): boolean {
  if (!id) return false;
  if (recentIncomingMessageIds.includes(id)) return true;
  recentIncomingMessageIds.push(id);
  if (recentIncomingMessageIds.length > 200) {
    recentIncomingMessageIds.splice(0, recentIncomingMessageIds.length - 200);
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forwardIncomingMessage(msg: any): void {
  try {
    const rawId = msg?.id?._serialized ?? msg?.id?.id ?? msg?.id ?? '';
    const id = String(rawId);
    if (markIncomingMessageSeen(id)) return;

    const fromMe = Boolean(msg?.fromMe ?? msg?._data?.fromMe ?? msg?.id?.fromMe);
    if (fromMe) return;

    const from = String(msg?.from ?? '');
    if (!from || from.includes('@broadcast')) return;

    const body = String(msg?.body ?? '');
    send({
      type: 'message',
      from,
      body,
      notifyName: (msg?._data as { notifyName?: string } | undefined)?.notifyName,
    });
  } catch (err) {
    log('error', `forwardIncomingMessage: ${(err as Error).message}`);
  }
}

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
  client.on('message', (msg: any) => {
    forwardIncomingMessage(msg);
    scheduleLoadChats();
  });

  // Em algumas versões/sessões multi-device o evento 'message' pode falhar.
  // Escutamos também 'message_create' e deduplicamos por id.
  // O scheduleLoadChats evita chamadas duplas quando ambos disparam juntos.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.on('message_create', (msg: any) => {
    forwardIncomingMessage(msg);
    scheduleLoadChats();
  });

  await client.initialize();
}

async function loadChats(): Promise<void> {
  if (!client) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawChats: any[] = await client.getChats();
    cachedAllChats = rawChats; // mantém cache completo para getMessages
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
          requestId: msg.requestId,
          success: false,
          error: 'Cliente não conectado.',
        });
        break;
      }
      (async () => {
        try {
          await client.sendMessage(msg.chatId, msg.text);
          await loadChats();
          send({ type: 'sendResult', requestId: msg.requestId, success: true });
        } catch (err) {
          send({
            type: 'sendResult',
            requestId: msg.requestId,
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
          requestId: msg.requestId,
          success: false,
          error: 'Cliente não conectado.',
        });
        break;
      }
      (async () => {
        try {
          log('info', `Buscando mensagens do chat: ${msg.chatId}`);

          // fetchMessages() chama internamente ConversationMsgs.loadEarlierMsgs →
          // waitForChatLoading, que falha quando o chat não está ativo na página.
          // Solução: ler diretamente do window.Store via pupPage.evaluate,
          // sem tentar carregar mensagens antigas nem navegar.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const page: any = client.pupPage ?? client.page;
          if (!page) throw new Error('Página do navegador não disponível.');

          type RawMsg = { id: string; body: string; fromMe: boolean; timestamp: number; sender: string };
          type EvalResult = RawMsg[] | { error: string };

          const result: EvalResult = await page.evaluate((chatId: string): EvalResult => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const w = window as any;
              const chat = w.Store?.Chat?.get?.(chatId);
              if (!chat) return { error: 'Chat não encontrado no store.' };

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const models: any[] = chat.msgs?._models ?? chat.msgs?.models ?? [];
              if (!Array.isArray(models)) return { error: 'Estrutura de mensagens inesperada.' };

              return models.slice(-50).map((m) => ({
                id: (m.id?._serialized ?? m.id?.id ?? '') as string,
                body: (m.body ?? '') as string,
                fromMe: !!(m.id?.fromMe ?? m.fromMe),
                timestamp: (m.t ?? m.timestamp ?? 0) as number,
                sender: (m._data?.notifyName ?? m.author?.replace(/@\w+\.us$/, '') ?? '') as string,
              }));
            } catch (e) {
              return { error: (e as Error).message };
            }
          }, msg.chatId);

          if (!Array.isArray(result)) {
            throw new Error(result.error ?? 'Erro desconhecido ao ler mensagens.');
          }

          log('info', `Mensagens obtidas: ${result.length}`);
          send({ type: 'sendResult', requestId: msg.requestId, success: true, messages: result });
        } catch (err) {
          send({
            type: 'sendResult',
            requestId: msg.requestId,
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
