export type FeishuEnvelope<T> = {
  code: number;
  msg?: string;
  data?: T;
};

export type FeishuTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

export type FeishuEventHeader = {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  token?: string;
};

export type FeishuMessageEvent = {
  schema?: string;
  header?: FeishuEventHeader;
  event?: {
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
    };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      chat_id?: string;
      thread_id?: string;
      chat_type?: 'p2p' | 'group';
      message_type?: string;
      content?: string;
      mentions?: Array<{
        key?: string;
        id?: { open_id?: string; user_id?: string; union_id?: string };
        name?: string;
      }>;
    };
  };
};

export type FeishuCardActionEvent = {
  schema?: string;
  header?: FeishuEventHeader;
  event?: {
    operator?: { open_id?: string; user_id?: string; union_id?: string };
    action?: { value?: unknown };
    context?: { open_chat_id?: string; open_message_id?: string };
  };
};
