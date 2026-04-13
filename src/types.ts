export type AccountStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr'
  | 'ready'
  | 'error';

export interface ChatInfo {
  id: string;
  name: string;
  lastMessage: string;
  timestamp: number;
  unreadCount: number;
  accountIndex: number;
}

export interface AccountState {
  index: number;
  status: AccountStatus;
  chats: ChatInfo[];
}

export interface WebviewMessage {
  command: 'init' | 'quickReply' | 'reconnect';
  accountIndex?: number;
}

export interface HostMessage {
  type: 'fullState' | 'chatsUpdate' | 'statusUpdate';
  states?: AccountState[];
  accountIndex?: number;
  chats?: ChatInfo[];
  status?: AccountStatus;
}
