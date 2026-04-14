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

export interface AccountState {
  nickname: string;
  status: AccountStatus;
  chats: ChatInfo[];
}

export interface WebviewMessage {
  command: 'init' | 'quickReply' | 'reconnect' | 'addAccount' | 'removeAccount';
  nickname?: string;
}

export interface HostMessage {
  type: 'fullState' | 'chatsUpdate' | 'statusUpdate';
  states?: AccountState[];
  nickname?: string;
  chats?: ChatInfo[];
  status?: AccountStatus;
}
