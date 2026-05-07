import { EventEmitter } from 'events'

class BrowserWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  private ws: WebSocket

  get readyState() { return this.ws.readyState }

  constructor(url: string, _opts?: unknown) {
    super()
    this.ws = new WebSocket(url)

    this.ws.onopen = () => this.emit('open')
    this.ws.onclose = (e) => this.emit('close', e.code, e.reason)
    this.ws.onerror = (e) => this.emit('error', e)
    this.ws.onmessage = (e) => this.emit('message', e.data)
  }

  send(data: string | ArrayBuffer) {
    this.ws.send(data)
  }

  close(code?: number, reason?: string) {
    this.ws.close(code, reason)
  }

  terminate() {
    this.ws.close()
  }

  ping() {}
}

export default BrowserWebSocket
