import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import type { Writable } from 'node:stream'
import { z } from 'zod'
import { terminateProcessTree } from './process-tree'

const frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), version: z.literal(1) }),
  z.object({ type: z.literal('changed'), threadId: z.string(), sequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal('result'), id: z.number().int(), result: z.unknown() }),
  z.object({ type: z.literal('error'), id: z.number().int(), message: z.string() })
])

const startupTimeout = 30_000
const commandTimeout = 30_000

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      server.close((error) => {
        if (error) reject(error)
        else if (address && typeof address !== 'string') resolve(address.port)
        else reject(new Error('无法分配 Agent 运行时端口。'))
      })
    })
  })
}

export class T3RuntimeProcess {
  private child: ChildProcess | null = null
  private startup: Promise<ChildProcess> | null = null
  private stopping = false
  private nextId = 1
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pending = new Map<number, {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
  }>()

  constructor(
    private readonly entry: string,
    private readonly dataDirectory: string,
    private readonly executable = process.execPath,
    private readonly runElectronAsNode = true
  ) {}

  async start(): Promise<void> {
    await this.getProcess()
  }

  watch(threadId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(threadId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(threadId)
    }
  }

  async request<T>(command: object, schema: z.ZodType<T>): Promise<T> {
    const child = await this.getProcess()
    const id = this.nextId++
    const result = await new Promise<unknown>((resolve, reject) => {
      const complete = (operation: () => void): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        operation()
      }
      const failed = (error: Error): void => complete(() => reject(error))
      const timer = setTimeout(() => failed(new Error('Agent 运行时命令超时。')), commandTimeout)
      this.pending.set(id, { resolve: (value) => complete(() => resolve(value)), reject: failed })
      try {
        child.send({ id, command }, (error) => { if (error) failed(error) })
      } catch (error) {
        failed(error instanceof Error ? error : new Error('Agent 运行时连接已关闭。'))
      }
    })
    return schema.parse(result)
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.startup?.catch(() => undefined)
    const child = this.child
    if (child) await terminateProcessTree(child, 2_000)
  }

  private getProcess(): Promise<ChildProcess> {
    if (this.stopping) return Promise.reject(new Error('Agent 运行时正在关闭。'))
    return this.startup ??= this.launch()
  }

  private async launch(): Promise<ChildProcess> {
    try {
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
      const port = await allocateLoopbackPort()
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !name.startsWith('T3CODE_') && !name.startsWith('OTEL_') && name !== 'VITE_DEV_SERVER_URL'))
      const child = spawn(this.executable, [this.entry, 'serve', '--bootstrap-fd', '3'], {
        cwd: dirname(this.entry),
        env: {
          ...env,
          ...(this.runElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          FUDDY_T3_BRIDGE: '1',
          T3CODE_TELEMETRY_ENABLED: 'false',
          OTEL_TRACES_EXPORTER: 'none',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_LOGS_EXPORTER: 'none'
        },
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'ipc'],
        detached: process.platform !== 'win32'
      })
      this.child = child
      return await new Promise<ChildProcess>((resolve, reject) => {
        let ready = false
        const disconnect = (error: Error): void => {
          clearTimeout(timer)
          if (this.child !== child) return
          this.child = null
          this.startup = null
          if (!ready) reject(error)
          for (const entry of this.pending.values()) entry.reject(error)
          for (const listeners of this.listeners.values()) {
            for (const listener of listeners) listener()
          }
        }
        const timer = setTimeout(() => {
          const error = new Error('T3 Agent 运行时启动超时。')
          void terminateProcessTree(child).then(() => disconnect(error), () => disconnect(error))
        }, startupTimeout)
        child.on('error', disconnect)
        child.once('exit', (code, signal) => disconnect(new Error(`T3 Agent 运行时已退出（${code ?? signal}）。`)))
        child.on('message', (raw) => {
          if (this.child !== child) return
          const result = frame.safeParse(raw)
          if (!result.success) return
          const message = result.data
          switch (message.type) {
            case 'ready':
              ready = true
              clearTimeout(timer)
              resolve(child)
              break
            case 'changed':
              for (const listener of this.listeners.get(message.threadId) ?? []) listener()
              break
            case 'result':
              this.pending.get(message.id)?.resolve(message.result)
              break
            case 'error':
              this.pending.get(message.id)?.reject(new Error(message.message))
              break
          }
        })
        const bootstrap = child.stdio[3] as Writable
        bootstrap.on('error', (error) => {
          void terminateProcessTree(child).then(() => disconnect(error), () => disconnect(error))
        })
        bootstrap.end(`${JSON.stringify({
          mode: 'desktop',
          noBrowser: true,
          port,
          host: '127.0.0.1',
          t3Home: this.dataDirectory,
          desktopBootstrapToken: randomBytes(32).toString('base64url'),
          shellEnvironmentPrepared: true,
          tailscaleServeEnabled: false,
          tailscaleServePort: 3773,
          desktopAppUpdate: false
        })}\n`)
      })
    } catch (error) {
      this.startup = null
      throw error
    }
  }
}
