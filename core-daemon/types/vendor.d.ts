declare module "ws" {
  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: 0 | 1 | 2 | 3;
    constructor(url: string);
    send(data: string): void;
    close(code?: number, reason?: string): void;
    once(event: "open", handler: () => void): void;
    once(event: "message", handler: (data: RawData) => void): void;
    once(event: "error", handler: (error: Error) => void): void;
    once(event: "close", handler: () => void): void;
    on(event: "message", handler: (data: RawData) => void): void;
    on(event: "close", handler: () => void): void;
    on(event: "error", handler: (error: Error) => void): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: "message", handler: (data: RawData) => void): void;
    removeAllListeners(event?: string): void;
  }

  export default WebSocket;

  export class WebSocketServer {
    constructor(options: { host: string; port: number });
    on(event: "connection", handler: (socket: WebSocket) => void): void;
    once(event: "listening", handler: () => void): void;
    once(event: "error", handler: (error: Error) => void): void;
    address(): null | string | { port: number };
    close(callback: (error?: Error) => void): void;
  }
}

declare module "node-telegram-bot-api" {
  namespace TelegramBot {
    interface User {
      id: number;
      username?: string;
      first_name?: string;
      is_bot?: boolean;
    }

    interface Chat {
      id: number | string;
    }

    interface PhotoSize {
      file_id: string;
      file_size?: number;
    }

    interface Document {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    }

    interface Message {
      message_id: number;
      message_thread_id?: number;
      chat: Chat;
      from?: User;
      text?: string;
      caption?: string;
      photo?: PhotoSize[];
      document?: Document;
      reply_to_message?: Message;
    }

    interface InlineKeyboardButton {
      text: string;
      callback_data?: string;
      url?: string;
    }

    interface InlineKeyboardMarkup {
      inline_keyboard: InlineKeyboardButton[][];
    }

    interface SendMessageOptions {
      message_thread_id?: number;
      caption?: string;
      reply_parameters?: { message_id: number };
      parse_mode?: "HTML" | "MarkdownV2" | "Markdown";
      reply_markup?: InlineKeyboardMarkup;
    }

    interface CallbackQuery {
      id: string;
      from: { id: number; is_bot: boolean; username?: string; first_name?: string };
      message?: { message_id: number; chat: { id: number } };
      data?: string;
    }

    interface AnswerCallbackQueryOptions {
      text?: string;
      show_alert?: boolean;
      cache_time?: number;
    }

    interface EditMessageTextOptions {
      chat_id: number | string;
      message_id: number;
      parse_mode?: "HTML" | "MarkdownV2" | "Markdown";
      reply_markup?: InlineKeyboardMarkup;
    }
  }

  class TelegramBot {
    constructor(token: string, options?: { polling?: boolean });
    getMe(): Promise<TelegramBot.User>;
    getFileLink(fileId: string): Promise<string>;
    on(event: "message", handler: (message: TelegramBot.Message) => void): void;
    on(event: "polling_error", handler: (error: Error) => void): void;
    on(event: "callback_query", handler: (query: TelegramBot.CallbackQuery) => void): void;
    isPolling(): boolean;
    stopPolling(): Promise<void>;
    sendMessage(
      chatId: string,
      text: string,
      options?: TelegramBot.SendMessageOptions,
    ): Promise<TelegramBot.Message>;
    sendDocument(
      chatId: string,
      path: string,
      options?: TelegramBot.SendMessageOptions,
    ): Promise<TelegramBot.Message>;
    answerCallbackQuery(
      callbackQueryId: string,
      options?: TelegramBot.AnswerCallbackQueryOptions,
    ): Promise<boolean>;
    editMessageText(
      text: string,
      options: TelegramBot.EditMessageTextOptions,
    ): Promise<TelegramBot.Message | boolean>;
  }

  export default TelegramBot;
}
