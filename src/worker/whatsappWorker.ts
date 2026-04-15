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
  isMuted: boolean;
}

interface SerializedMessage {
  id: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  sender: string;
  hasMedia?: boolean;
  mediaType?: string;
  mediaData?: string;
  mediaMime?: string;
  mediaFilename?: string;
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
    loadChats().catch(() => { });
  }, 300);
}

function markIncomingMessageSeen(id: string): boolean {
  if (!id) return false;
  if (recentIncomingMessageIds.includes(id)) return true;
  recentIncomingMessageIds.push(id);
  if (recentIncomingMessageIds.length > 300) {
    recentIncomingMessageIds.splice(0, recentIncomingMessageIds.length - 300);
  }
  return false;
}

function isChannelJid(jid: string): boolean {
  return jid.endsWith('@newsletter');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forwardIncomingMessage(msg: any): void {
  try {
    const fromMe = Boolean(msg?.fromMe ?? msg?._data?.fromMe ?? msg?.id?.fromMe);
    if (fromMe) return;

    const from = String(msg?.from ?? '');
    if (!from || from.includes('@broadcast') || isChannelJid(from)) return;

    const isStatus = Boolean(msg?.isStatus ?? msg?._data?.isStatus);
    if (isStatus || from === 'status@broadcast') return;

    const msgType = String(msg?.type ?? msg?._data?.type ?? '');
    const blockedTypes = new Set([
      'ciphertext',
      'e2e_notification',
      'notification',
      'notification_template',
      'gp2',
      'protocol',
      'revoked',
      'newsletter_notification',
    ]);
    if (blockedTypes.has(msgType)) return;

    const isNewMsg = msg?.isNewMsg ?? msg?._data?.isNewMsg;
    if (isNewMsg === false) return;

    const body = String(msg?.body ?? '');
    const hasMedia = Boolean(msg?.hasMedia ?? msg?._data?.isMedia);

    // Evita alertas vazios que normalmente vêm de eventos internos/sistema.
    if (!hasMedia && body.trim().length === 0) return;

    const rawId = msg?.id?._serialized ?? msg?.id?.id ?? msg?.id ?? '';
    const id = String(rawId).trim();
    if (id && markIncomingMessageSeen(id)) return;

    const notifyName: string | undefined =
      (msg?._data as { notifyName?: string } | undefined)?.notifyName ||
      (msg?.pushname as string | undefined) ||
      (msg?._data as { pushname?: string } | undefined)?.pushname ||
      undefined;

    send({
      type: 'message',
      from,
      body,
      notifyName,
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
    try {
      await client.setDisplayName('VSCode');
    } catch (err) {
      log('error', `Falha ao definir nome de exibição: ${(err as Error).message}`);
    }
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
      (chat: any): SerializedChat => {
        // isMuted — respeita o silenciamento configurado no próprio WhatsApp.
        // muteExpiration: 0 = não silenciado, -1 = sempre, >0 = até timestamp (segundos)
        const exp = (chat.muteExpiration as number | undefined) ?? 0;
        const now = Math.floor(Date.now() / 1000);
        const isMuted =
          (chat.isMuted as boolean | undefined) === true ||
          exp < 0 ||
          exp > now;

        return {
          id: chat.id._serialized as string,
          name: chat.name as string,
          lastMessage: (chat.lastMessage?.body as string | undefined) ?? '',
          timestamp: (chat.lastMessage?.timestamp as number | undefined) ?? 0,
          unreadCount: chat.unreadCount as number,
          isMuted,
        };
      },
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

          // fetchMessages() dispara internamente um while-loop que chama
          // ConversationMsgs.loadEarlierMsgs(chat). Essa função acessa
          // chat.loadingState.waitForChatLoading — mas loadingState é undefined
          // em chats que nunca foram abertos nesta sessão, causando o crash.
          //
          // Solução: patchear loadEarlierMsgs UMA VEZ no contexto do browser
          // para retornar null quando loadingState não existe.
          // Isso quebra o while-loop imediatamente, e fetchMessages devolve
          // apenas as mensagens já presentes em memória — sem crash.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const page: any = client.pupPage ?? client.page;
          if (!page) throw new Error('Página do navegador não disponível.');

          await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            const convMsgs = w.Store?.ConversationMsgs;
            if (convMsgs?.loadEarlierMsgs && !convMsgs.__patchedByCCExt) {
              const orig = convMsgs.loadEarlierMsgs;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              convMsgs.loadEarlierMsgs = async function (chat: any, ...args: any[]) {
                // loadEarlierMsgs acessa chat.loadingState.waitForChatLoading
                // mas loadingState é undefined em chats não abertos nesta sessão.
                // Criamos um stub mínimo para que a função original possa prosseguir
                // e realmente carregar as mensagens — em vez de só retornar null.
                if (!chat?.loadingState) {
                  chat.loadingState = {
                    waitForChatLoading: async () => { },
                    loadingState: 'LOADED',
                  };
                }
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  return await (orig as any).call(this, chat, ...args);
                } catch {
                  // Se a função original ainda falhar por outro motivo,
                  // retorna null para encerrar o loop sem crash
                  return null;
                }
              };
              convMsgs.__patchedByCCExt = true;
            }
          });

          // Com o patch aplicado, fetchMessages é seguro de chamar
          let allChats: any[] = cachedAllChats;
          if (allChats.length === 0) {
            allChats = await client.getChats();
            cachedAllChats = allChats;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chat = allChats.find((c: any) => c.id._serialized === msg.chatId);
          if (!chat) throw new Error('Chat não encontrado.');

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rawMessages: any[] = await chat.fetchMessages({ limit: 50 });
          log('info', `Mensagens obtidas: ${rawMessages.length}`);

          // Baixa mídias em paralelo; vcards são texto (sem download)
          const messages: SerializedMessage[] = await Promise.all(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rawMessages.map(async (m: any): Promise<SerializedMessage> => {
              const base: SerializedMessage = {
                id: m.id._serialized as string,
                body: (m.body as string) || '',
                fromMe: m.fromMe as boolean,
                timestamp: m.timestamp as number,
                sender: (m._data?.notifyName as string | undefined)
                  || (m.from as string | undefined)?.replace(/@[cg]\.us$/, '')
                  || '',
              };

              const msgType = (m.type as string) || '';

              // --- Contatos (vCard) ---
              if (msgType === 'vcard') {
                base.mediaType = 'vcard';
                // body já contém a string vCard completa
              } else if (msgType === 'multi_vcard') {
                base.mediaType = 'multi_vcard';
                // vCards é um array de strings; serializa como JSON no body
                const vcards = (m.vCards as string[] | undefined) ?? [];
                base.body = JSON.stringify(vcards);
              } else if (msgType === 'call_log') {
                base.mediaType = 'call_log';
                const duration = (m._data?.duration as number | undefined) ?? 0;
                const isVideo = Boolean(m._data?.isVideo);
                base.body = JSON.stringify({ duration, isVideo });
                // --- Mídias binárias ---
              } else if (m.hasMedia) {
                base.hasMedia = true;
                base.mediaType = msgType;
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const media: any = await m.downloadMedia();
                  if (media?.data) {
                    base.mediaData = media.data as string;
                    base.mediaMime = media.mimetype as string;
                    base.mediaFilename = (media.filename as string | undefined) ?? undefined;
                  }
                } catch {
                  // download falhou — exibe placeholder no webview
                }
              }

              return base;
            }),
          );

          send({ type: 'sendResult', requestId: msg.requestId, success: true, messages });
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
