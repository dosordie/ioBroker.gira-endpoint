declare module "@iobroker/adapter-core" {
  export class Adapter {
    [key: string]: any;
    constructor(options?: any);
  }
  export type AdapterOptions = any;
}

declare namespace ioBroker {
  interface AdapterConfig {
    [key: string]: any;
  }
  interface StateCommon {
    [key: string]: any;
  }
  interface State {
    [key: string]: any;
  }
}

declare module "ws" {
  export default class WebSocket {
    constructor(url: string, opts?: any);
    on(event: string, listener: (...args: any[]) => void): void;
    send(data: any): void;
    close(code?: number, reason?: string): void;
    readyState: number;
    static OPEN: number;
  }
  namespace WebSocket {
    interface ClientOptions {
      [key: string]: any;
      agent?: any;
    }
  }
}

declare module "events" {
  export class EventEmitter {
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    emit(event: string | symbol, ...args: any[]): boolean;
    removeAllListeners(event?: string | symbol): this;
    static defaultMaxListeners: number;
  }
}

declare var Buffer: any;
type Buffer = any;

declare namespace NodeJS {
  interface Timeout {}
}

declare var process: any;
declare function require(name: string): any;

declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;

declare function clearInterval(handle: any): void;

declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;

declare var module: any;
