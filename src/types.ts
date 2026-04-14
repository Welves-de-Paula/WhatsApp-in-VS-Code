export type AccountStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr'
  | 'ready'
  | 'error';

export type VisualAlert = 'banner' | 'statusBarFlash' | 'badgeOnly' | 'none';
export type NotifFilter  = 'all' | 'direct' | 'groups';
export type SoundOption  = 'ding' | 'chime' | 'pop' | 'none' | 'custom';

export interface AccountNotificationSettings {
  /** 'ding' | 'chime' | 'pop' | 'none' | 'custom' */
  sound: SoundOption;
  /** Caminho absoluto para arquivo .wav customizado (usado apenas quando sound==='custom') */
  customSoundPath: string;
  /** 0–100 */
  volume: number;
  visualAlert: VisualAlert;
  /** Cor hex do badge/status-bar desta conta, ex.: '#25d366' */
  badgeColor: string;
  /** Filtrar quais mensagens geram notificação */
  filter: NotifFilter;
  /** Nomes de contatos individuais silenciados */
  mutedContacts: string[];
  /** Nomes de grupos silenciados */
  mutedGroups: string[];
}

export const DEFAULT_NOTIFICATION_SETTINGS: AccountNotificationSettings = {
  sound: 'ding',
  customSoundPath: '',
  volume: 80,
  visualAlert: 'banner',
  badgeColor: '#25d366',
  filter: 'all',
  mutedContacts: [],
  mutedGroups: [],
};

export interface AccountMeta {
  nickname: string;
}

export interface ChatInfo {
  id: string;
  name: string;
  lastMessage: string;
  timestamp: number;
  unreadCount: number;
  accountNickname: string;
}

export type MediaType = 'image' | 'sticker' | 'audio' | 'ptt' | 'video' | 'gif' | 'document' | string;

export interface MessageInfo {
  id: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  sender: string;
  /** true se a mensagem tem mídia (imagem, áudio, figurinha, etc.) */
  hasMedia?: boolean;
  /** 'image' | 'sticker' | 'audio' | 'ptt' | 'video' | 'gif' | 'document' */
  mediaType?: MediaType;
  /** Conteúdo em base64 */
  mediaData?: string;
  /** MIME type, ex.: 'image/jpeg', 'audio/ogg; codecs=opus' */
  mediaMime?: string;
  /** Nome do arquivo (documentos) */
  mediaFilename?: string;
}

export interface AccountState {
  nickname: string;
  status: AccountStatus;
  chats: ChatInfo[];
}

export interface WebviewMessage {
  command: 'init' | 'quickReply' | 'reconnect' | 'addAccount' | 'removeAccount' | 'sendChatMessage' | 'openChat' | 'openSettings';
  nickname?: string;
  chatId?: string;
  accountNickname?: string;
  chatName?: string;
  text?: string;
}

export interface HostMessage {
  type: 'fullState' | 'chatsUpdate' | 'statusUpdate' | 'addError';
  states?: AccountState[];
  nickname?: string;
  chats?: ChatInfo[];
  status?: AccountStatus;
  message?: string;
}
