import type { ClientMsg, ServerMsg } from "../../../shared/events.ts";

export type WSStatus = "connecting" | "open" | "closed";

type Listener = (msg: ServerMsg) => void;
type StatusListener = (status: WSStatus) => void;

export class WSClient {
  private url: string;
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private status: WSStatus = "connecting";
  private outbox: ClientMsg[] = [];

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  private setStatus(s: WSStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.setStatus("open");
      const pending = this.outbox;
      this.outbox = [];
      for (const msg of pending) this.send(msg);
    });

    ws.addEventListener("message", (evt) => {
      let parsed: ServerMsg;
      try {
        parsed = JSON.parse(String(evt.data)) as ServerMsg;
      } catch {
        return;
      }
      for (const l of this.listeners) l(parsed);
    });

    ws.addEventListener("close", () => {
      this.setStatus("closed");
      this.ws = null;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 800);
    });

    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        // ignored
      }
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): WSStatus {
    return this.status;
  }
}
