import { EventEmitter } from 'events';
import * as path from 'path';
import { ChildProcess, fork } from 'child_process';
import { AccountStatus, ChatInfo, MessageInfo } from './types';

// ---- IPC types (espelhadas do worker) ----

type WorkerToHostMsg =
  | { type: 'qr'; qr: string }
  | { type: 'ready' }
  | { type: 'statusChange'; status: AccountStatus }
  | { type: 'chatsUpdate'; chats: Omit<ChatInfo, 'accountNickname'>[] }
  | { type: 'message'; from: string; body: string; notifyName?: string }
  | { type: 'sendResult'; success: boolean; error?: string }
  | { type: 'log'; level: 'info' | 'error'; message: string };

type HostToWorkerMsg =
  | { type: 'initialize'; storagePath: string; sessionId: string }
  | { type: 'sendMessage'; chatId: string; text: string }
  | { type: 'getMessages'; chatId: string }
  | { type: 'destroy' };

// ---------------------------------------------------------------------------
// Type-safe EventEmitter overloads for WhatsAppClient
// ---------------------------------------------------------------------------
export declare interface WhatsAppClient {
  on(event: 'qr', listener: (qr: string) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'message', listener: (msg: WWebMessage) => void): this;
  on(event: 'statusChange', listener: (status: AccountStatus) => void): this;
  on(event: 'chatsUpdate', listener: (chats: ChatInfo[]) => void): this;
  emit(event: 'qr', qr: string): boolean;
  emit(event: 'ready'): boolean;
  emit(event: 'message', msg: WWebMessage): boolean;
  emit(event: 'statusChange', status: AccountStatus): boolean;
  emit(event: 'chatsUpdate', chats: ChatInfo[]): boolean;
}

export interface WWebMessage {
  from: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  _data?: { notifyName?: string };
}

export class WhatsAppClient extends EventEmitter {
  public readonly nickname: string;
  public status: AccountStatus = 'disconnected';
  public chats: ChatInfo[] = [];

  private readonly storagePath: string;
  private worker: ChildProcess | null = null;
  private isInitializing = false;

  /** FIFO de resolvers aguardando resposta de sendMessage */
  private sendResultHandlers: Array<
    (result: { success: boolean; error?: string }) => void
  > = [];

  constructor(nickname: string, storagePath: string) {
    super();
    this.nickname = nickname;
    this.storagePath = storagePath;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.worker !== null || this.isInitializing) return;
    this.isInitializing = true;

    try {
      // O worker compilado fica em out/worker/whatsappWorker.js
      const workerScript = path.join(__dirname, 'worker', 'whatsappWorker.js');

      // fork() cria canal IPC automaticamente além dos pipes stdio
      this.worker = fork(workerScript, [], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      this.worker.stdout?.on('data', (d: Buffer) =>
        console.log(`[WA Worker "${this.nickname}"]`, d.toString().trimEnd()),
      );
      this.worker.stderr?.on('data', (d: Buffer) =>
        console.error(`[WA Worker "${this.nickname}"]`, d.toString().trimEnd()),
      );

      this.worker.on('message', (raw: unknown) =>
        this.handleWorkerMessage(raw as WorkerToHostMsg),
      );

      this.worker.on('error', (err) => {
        console.error(`[WA Worker "${this.nickname}"] erro:`, err);
        this.worker = null;
        this.isInitializing = false;
        this.setStatus('error');
      });

      this.worker.on('exit', (code, signal) => {
        console.log(
          `[WA Worker "${this.nickname}"] encerrado — código: ${code} sinal: ${signal}`,
        );
        this.worker = null;
        this.isInitializing = false;
        // Rejeitar qualquer sendMessage pendente
        const pending = this.sendResultHandlers.splice(0);
        pending.forEach((h) =>
          h({ success: false, error: 'Worker encerrado inesperadamente.' }),
        );
        if (this.status !== 'ready') {
          this.setStatus('error');
        } else {
          this.setStatus('disconnected');
        }
      });

      // Disparar inicialização no worker
      this.sendToWorker({
        type: 'initialize',
        storagePath: this.storagePath,
        sessionId: this.nickname,
      });
    } finally {
      this.isInitializing = false;
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.worker || this.status !== 'ready') {
      throw new Error(`Conta "${this.nickname}" não está conectada.`);
    }

    return new Promise((resolve, reject) => {
      const handler = (result: { success: boolean; error?: string }) => {
        if (result.success) resolve();
        else reject(new Error(result.error ?? 'Falha ao enviar mensagem.'));
      };
      this.sendResultHandlers.push(handler);
      this.sendToWorker({ type: 'sendMessage', chatId, text });
    });
  }

  async getChatMessages(chatId: string): Promise<MessageInfo[]> {
    if (!this.worker || this.status !== 'ready') {
      throw new Error(`Conta "${this.nickname}" não está conectada.`);
    }

    return new Promise((resolve, reject) => {
      const handler = (result: { success: boolean; messages?: MessageInfo[]; error?: string }) => {
        if (result.success && result.messages) resolve(result.messages);
        else reject(new Error(result.error ?? 'Falha ao carregar mensagens.'));
      };
      this.sendResultHandlers.push(handler);
      this.sendToWorker({ type: 'getMessages', chatId });
    });
  }

  async destroy(): Promise<void> {
    if (!this.worker) return;

    this.sendToWorker({ type: 'destroy' });

    // Aguarda o processo encerrar (máx. 8 s) antes de forçar kill
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[WA Worker "${this.nickname}"] forçando encerramento.`);
        this.worker?.kill('SIGKILL');
        resolve();
      }, 8000);

      this.worker?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.worker = null;
    this.setStatus('disconnected');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private sendToWorker(msg: HostToWorkerMsg): void {
    this.worker?.send(msg);
  }

  private handleWorkerMessage(msg: WorkerToHostMsg): void {
    switch (msg.type) {
      case 'qr':
        this.emit('qr', msg.qr);
        break;

      case 'ready':
        this.emit('ready');
        break;

      case 'statusChange':
        this.setStatus(msg.status);
        break;

      case 'chatsUpdate':
        this.chats = msg.chats.map((c) => ({
          ...c,
          accountNickname: this.nickname,
        }));
        this.emit('chatsUpdate', this.chats);
        break;

      case 'message':
        this.emit('message', {
          from: msg.from,
          body: msg.body,
          fromMe: false,
          timestamp: Date.now(),
          _data: { notifyName: msg.notifyName },
        } as WWebMessage);
        break;

      case 'sendResult': {
        const handler = this.sendResultHandlers.shift();
        handler?.(msg);
        break;
      }

      case 'log':
        if (msg.level === 'error') {
          console.error(`[WA Worker "${this.nickname}"]`, msg.message);
        } else {
          console.log(`[WA Worker "${this.nickname}"]`, msg.message);
        }
        break;
    }
  }

  private setStatus(status: AccountStatus): void {
    this.status = status;
    this.emit('statusChange', status);
  }
}
