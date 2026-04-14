export type AccountStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr'
  | 'ready'
  | 'error';

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

export interface MessageInfo {
  id: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  sender: string;
}

export interface AccountState {
  nickname: string;
  status: AccountStatus;
  chats: ChatInfo[];
}

export interface WebviewMessage {
  command: 'init' | 'quickReply' | 'reconnect' | 'addAccount' | 'removeAccount' | 'sendChatMessage' | 'openChat';
  nickname?: string;
  chatId?: string;
  accountNickname?: string;
  chatName?: string;
  text?: string;
}

export interface HostMessage {
  type: 'fullState' | 'chatsUpdate' | 'statusUpdate';
  states?: AccountState[];
  nickname?: string;
  chats?: ChatInfo[];
  status?: AccountStatus;
}
