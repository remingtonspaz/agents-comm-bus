declare module "ws" {
  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket {
    constructor(url: string);
    send(data: string): void;
    close(code?: number, reason?: string): void;
    once(event: "open", handler: () => void): void;
    once(event: "message", handler: (data: RawData) => void): void;
    once(event: "error", handler: (error: Error) => void): void;
    once(event: "close", handler: () => void): void;
    on(event: "message", handler: (data: RawData) => void): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: "message", handler: (data: RawData) => void): void;
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

    interface SendMessageOptions {
      message_thread_id?: number;
      caption?: string;
      reply_parameters?: { message_id: number };
    }
  }

  class TelegramBot {
    constructor(token: string, options?: { polling?: boolean });
    getMe(): Promise<TelegramBot.User>;
    on(event: "message", handler: (message: TelegramBot.Message) => void): void;
    on(event: "polling_error", handler: (error: Error) => void): void;
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
  }

  export default TelegramBot;
}
