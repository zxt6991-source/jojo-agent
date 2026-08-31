export type TelegramUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
export type TelegramChat = { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
export type TelegramEntity = { type: string; offset: number; length: number; user?: TelegramUser };
export type TelegramFile = { file_id: string; file_size?: number; file_path?: string };
export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: { message_id: number };
  photo?: Array<TelegramFile & { width: number; height: number }>;
  document?: TelegramFile & { file_name?: string; mime_type?: string };
};
export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};
export type TelegramResponse<T> = { ok: boolean; result?: T; description?: string; error_code?: number };
