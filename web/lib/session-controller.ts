// Drives one conversation against PromptAgentSession / LoadAgentSession and implements the documented stream rules:
// - HTTP 200, EOF or a heartbeat never prove a result; only the terminal frame matching this call's Id does.
// - A dropped stream does not cancel the turn and a Prompt is never resent; reading resumes through Load.
// - A plain Load ending with end_turn only means loading finished, so it never reports an earlier turn as successful.
// - A resume dedupes by cursor while live, then rebuilds from a plain Load, because cursor-less history can only be
//   trusted as a whole.
import type { Frame } from '../../server/sse.ts'
import {
  EMPTY_VIEW,
  addNotice,
  addUserMessage,
  applyFrame,
  frameOffset,
  isHeartbeat,
  readMarkers,
  resolveInteraction,
  type ChatView,
  type Markers,
  type Phase,
} from './session-state.ts'
import { asObject, asText } from './wire.ts'

export interface HttpFailure extends Error {
  status: number
  code: string
  requestId?: string
}

export interface SessionTransport {
  /** Resolves when the stream ends. Rejects with an `HttpFailure` for HTTP errors, or another error for network ones. */
  stream(action: 'PromptAgentSession' | 'LoadAgentSession', body: object, signal: AbortSignal, onFrame: (frame: Frame) => void): Promise<void>
  /** Returns the decoded `result` object of the JSON-RPC response. */
  rpc(action: 'ReplyAgentSession' | 'CancelAgentSession', body: object): Promise<Record<string, unknown>>
  newId(): string
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export interface ReplyInput {
  requestId: string
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
  answers?: Record<string, string>
}

type Step =
  | { kind: 'prompt'; text: string }
  | { kind: 'resume' }
  /** A plain Load replaces the current items with what the server returns. */
  | { kind: 'load' }

type Outcome = { type: 'terminal'; frame: Frame } | { type: 'eof' }

const MAX_RETRIES = 5
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]
/** A stream that delivers nothing, not even a heartbeat, for this long is treated as dropped. */
const IDLE_TIMEOUT_MS = 120_000
const RESULT_UNKNOWN = '连接曾中断，未能确认上一回合的结果，已重新加载会话内容。'
const UNSENT_RESTORED = '会话里没有找到刚才的消息，它可能没有发送成功，已放回输入框。确认后可以重新发送。'

/** Delays between quiet reloads while a delegated sub-task runs; about 15 minutes in total. */
const DELEGATION_POLL_MS = [5000, 10000, 20000, ...Array<number>(27).fill(30000)]

export interface ControllerOptions {
  idleTimeoutMs?: number
}

function agentMessageCount(view: ChatView): number {
  return view.items.filter((item) => item.type === 'agent').length
}

/** The latest turn handed work to another agent. ADA reports the result in a later turn that no Prompt starts. */
function delegatedInLatestTurn(view: ChatView): boolean {
  const lastUser = view.items.findLastIndex((item) => item.type === 'user')
  return view.items.slice(lastUser + 1).some((item) => item.type === 'tool' && /^delegate\b/i.test(item.title))
}

function isHttpFailure(error: unknown): error is HttpFailure {
  return error instanceof Error && typeof (error as Partial<HttpFailure>).status === 'number'
}

export class SessionController {
  readonly sessionId: string
  private readonly transport: SessionTransport
  private readonly listeners = new Set<() => void>()
  private view: ChatView = EMPTY_VIEW
  private active: AbortController | undefined
  private watching: AbortController | undefined
  private markers: Markers | undefined
  private onTurnSettled: (() => void) | undefined
  private readonly idleTimeoutMs: number

  constructor(sessionId: string, transport: SessionTransport, onTurnSettled?: () => void, options: ControllerOptions = {}) {
    this.sessionId = sessionId
    this.transport = transport
    this.onTurnSettled = onTurnSettled
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getView = (): ChatView => this.view

  private update(next: ChatView): void {
    if (next === this.view) return
    this.view = next
    for (const listener of this.listeners) listener()
  }

  private setPhase(phase: Phase): void {
    if (this.view.phase !== phase) this.update({ ...this.view, phase })
  }

  /** Loads history and attaches to any output still in progress. */
  open(): void {
    if (this.active) return
    void this.drive({ kind: 'load' })
  }

  prompt(text: string): void {
    if (this.active && this.view.phase !== 'idle') return
    const { restoredDraft: _dropped, composerNotice: _notice, ...view } = this.view
    this.update({ ...addUserMessage(view, text), phase: 'running' })
    void this.drive({ kind: 'prompt', text })
  }

  /** Manual retry after automatic reconnection gave up. */
  reconnect(): void {
    void this.drive(this.markers ? { kind: 'resume' } : { kind: 'load' })
  }

  async cancel(): Promise<void> {
    const promptId = this.markers?.promptId
    this.setPhase('cancelling')
    try {
      await this.transport.rpc('CancelAgentSession', {
        Jsonrpc: '2.0',
        Id: this.transport.newId(),
        Params: { sessionId: this.sessionId, ...(promptId ? { _meta: { promptId } } : {}) },
      })
    } catch (error) {
      this.update({ ...addNotice(this.view, { level: 'error', ...this.describe(error, '停止请求失败') }), phase: 'running' })
      return
    }
    // The receipt is not a terminal state: the outcome is still read from the stream.
    if (!this.active) this.reconnect()
  }

  async reply(input: ReplyInput): Promise<void> {
    let accepted = false
    try {
      const result = await this.transport.rpc('ReplyAgentSession', {
        Jsonrpc: '2.0',
        Id: this.transport.newId(),
        Params: {
          sessionId: this.sessionId,
          permissionRequestId: input.requestId,
          outcome: input.outcome,
          ...(input.answers ? { answers: input.answers } : {}),
        },
      })
      accepted = result.accepted === true || result.Accepted === true
    } catch (error) {
      this.update(addNotice(this.view, { level: 'error', ...this.describe(error, '提交失败') }))
      return
    }
    if (accepted) {
      this.update(resolveInteraction(this.view, input.requestId))
      if (!this.active) this.reconnect()
      return
    }
    // Not accepted: the request may be stale. Re-read the current interaction, never pick another decision.
    this.update(addNotice(this.view, { level: 'info', text: '这次提交未被采纳，已重新读取当前交互。' }))
    this.reconnect()
  }

  dispose(): void {
    this.active?.abort()
    this.active = undefined
    this.watching?.abort()
    this.watching = undefined
    this.listeners.clear()
  }

  /**
   * Waits for the result of a delegated sub-task. A plain Load of an idle session ends at once, so the history is
   * reloaded quietly in the background and swapped in once a new agent message appears. A Load that attaches to the
   * background turn ends with that turn, so its result is shown complete.
   */
  private async watchDelegation(): Promise<void> {
    this.watching?.abort()
    const owner = new AbortController()
    this.watching = owner
    const baseline = agentMessageCount(this.view)
    this.update({ ...this.view, waitingForDelegation: true })
    try {
      for (const delay of DELEGATION_POLL_MS) {
        await this.transport.sleep(delay, owner.signal)
        if (owner.signal.aborted || this.active) return
        const loaded = await this.quietLoad(owner.signal)
        if (owner.signal.aborted || this.active) return
        if (loaded && agentMessageCount(loaded) > baseline) {
          this.update({ ...this.view, items: loaded.items, interactions: loaded.interactions, nextId: loaded.nextId })
          return
        }
      }
    } finally {
      if (this.watching === owner) this.watching = undefined
      if (this.view.waitingForDelegation) {
        const { waitingForDelegation: _done, ...view } = this.view
        this.update(view)
      }
    }
  }

  /** A plain Load into a separate view, so the page does not flash while nothing has changed. */
  private async quietLoad(signal: AbortSignal): Promise<ChatView | undefined> {
    const id = this.transport.newId()
    let view: ChatView = { ...EMPTY_VIEW, phase: 'idle' }
    let ended = false
    try {
      await this.transport.stream('LoadAgentSession', { Jsonrpc: '2.0', Id: id, Params: { sessionId: this.sessionId } }, signal, (frame) => {
        if (frame.result || frame.error) {
          if (frame.id === undefined || String(frame.id) === id) ended = !frame.error
          return
        }
        if (!isHeartbeat(frame)) view = applyFrame(view, frame)
      })
    } catch {
      return undefined
    }
    return ended ? view : undefined
  }

  private describe(error: unknown, fallback: string): { text: string; code?: string; requestId?: string } {
    if (isHttpFailure(error)) {
      return {
        text: error.message || fallback,
        code: error.code,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      }
    }
    return { text: fallback }
  }

  private async readStream(step: Step, signal: AbortSignal): Promise<Outcome | undefined> {
    const id = this.transport.newId()
    const markers = this.markers
    const params: object =
      step.kind === 'prompt'
        ? { sessionId: this.sessionId, prompt: [{ type: 'text', text: step.text }] }
        : step.kind === 'resume' && markers
          ? {
              sessionId: this.sessionId,
              _meta: {
                isReload: true,
                beginLogOffset: markers.offset,
                eventEpoch: markers.eventEpoch,
                promptId: markers.promptId,
              },
            }
          : { sessionId: this.sessionId }

    let terminal: Frame | undefined
    // A half-open connection never ends on its own, so silence is handled like a dropped stream.
    const idle = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), this.idleTimeoutMs)
    }
    arm()
    try {
      await this.transport.stream(
        step.kind === 'prompt' ? 'PromptAgentSession' : 'LoadAgentSession',
        { Jsonrpc: '2.0', Id: id, Params: params },
        AbortSignal.any([signal, idle.signal]),
        (frame) => {
          arm()
          if (terminal) return
          if (frame.result || frame.error) {
            // A frame without Id cannot belong to another call on this stream; a different Id can.
            if (frame.id === undefined || String(frame.id) === id) terminal = frame
            return
          }
          if (isHeartbeat(frame)) return
          this.applyLive(step, frame)
        },
      )
    } catch (error) {
      if (!idle.signal.aborted || signal.aborted) throw error
    } finally {
      clearTimeout(timer)
    }
    if (signal.aborted) return undefined
    return terminal ? { type: 'terminal', frame: terminal } : { type: 'eof' }
  }

  private applyLive(step: Step, frame: Frame): void {
    const offset = frameOffset(frame)
    const saved = this.markers
    const next = readMarkers(frame)
    if (step.kind === 'resume') {
      const isInteraction = frame.method === '_qwen/notify'
      // Cursor-less frames are history replay here. The rebuild after the turn ends restores them from the server.
      if (offset === undefined && !isInteraction) return
      if (offset !== undefined && saved && offset <= saved.offset && (!next || next.eventEpoch === saved.eventEpoch)) return
    }
    if (next) this.markers = next
    let view = applyFrame(this.view, frame, { skipUserChunks: step.kind !== 'load' })
    // During a plain Load, a cursor means this is live output of a running turn.
    if (step.kind === 'load' && offset !== undefined && view.phase === 'loading') view = { ...view, phase: 'running' }
    this.update(view)
  }

  private finish(owner: AbortController, phase: Phase): void {
    if (this.active !== owner) return
    this.active = undefined
    this.setPhase(phase)
    this.onTurnSettled?.()
  }

  private async drive(initial: Step): Promise<void> {
    this.active?.abort()
    this.watching?.abort()
    const owner = new AbortController()
    this.active = owner
    const { signal } = owner

    let step = initial
    let failures = 0
    let unknownResult = false
    /** Turn outcome found while resuming, shown after the rebuild replaces the items. */
    let pendingNotice: Parameters<typeof addNotice>[1] | undefined
    const promptText = initial.kind === 'prompt' ? initial.text : undefined
    // Markers left by an earlier turn point at that turn. A Prompt that drops before its first frame must not resume
    // it, so the new turn starts without markers and falls back to the "result unknown" rebuild instead.
    if (initial.kind === 'prompt') this.markers = undefined

    /** After a rebuild with an unknown result, a prompt that is not in the history goes back to the composer. */
    const keepUnsent = (view: ChatView): ChatView => {
      if (!unknownResult || promptText === undefined) return view
      const sent = view.items.some((item) => item.type === 'user' && item.text.trim() === promptText.trim())
      return sent ? view : { ...addNotice(view, { level: 'info', text: UNSENT_RESTORED }), restoredDraft: promptText }
    }

    const retry = async (): Promise<boolean> => {
      if (failures >= MAX_RETRIES) {
        this.update(
          keepUnsent(addNotice(this.view, { level: 'error', text: '与服务的连接已中断，回合可能仍在继续。可稍后点击“重新连接”查看结果。' })),
        )
        this.finish(owner, 'lost')
        return false
      }
      this.setPhase(this.view.phase === 'cancelling' ? 'cancelling' : 'reconnecting')
      await this.transport.sleep(BACKOFF_MS[failures] ?? 16000, signal)
      failures += 1
      return !signal.aborted
    }

    const continueAfterDrop = (): void => {
      if (this.markers) {
        step = { kind: 'resume' }
      } else {
        unknownResult = step.kind === 'prompt' || unknownResult
        step = { kind: 'load' }
      }
    }

    while (!signal.aborted) {
      if (step.kind === 'load') {
        this.markers = undefined
        const phase = this.view.phase === 'cancelling' ? 'cancelling' : 'loading'
        this.update({ ...this.view, items: [], interactions: [], phase, nextId: 1 })
      }

      let outcome: Outcome | undefined
      try {
        outcome = await this.readStream(step, signal)
      } catch (error) {
        if (signal.aborted) return
        if (isHttpFailure(error) && error.status >= 400 && error.status < 500) {
          if (step.kind === 'prompt') {
            if (error.code === 'AgentSession.SessionBusy' || error.code === 'AgentSession.PermissionPending') {
              // Nothing was sent, and the rebuild below clears the items, so the text goes back to the composer. The
              // rebuild attaches to the running turn and only ends with it, so the notice cannot wait for that.
              const unsent = this.view.items.at(-1)
              this.update({
                ...this.view,
                composerNotice: '会话正在执行或等待确认，消息未发送。',
                ...(unsent?.type === 'user' ? { restoredDraft: unsent.text } : {}),
              })
              step = { kind: 'load' }
              continue
            }
            // A definite rejection: nothing was started, so the text goes back to the composer.
            const items = this.view.items.slice(0, -1)
            const last = this.view.items.at(-1)
            this.update({
              ...addNotice({ ...this.view, items }, { level: 'error', ...this.describe(error, '发送失败') }),
              ...(last?.type === 'user' ? { restoredDraft: last.text } : {}),
            })
            this.finish(owner, 'idle')
            return
          }
          if (step.kind === 'resume') {
            // A stale eventEpoch surfaces as InvalidParameter before the stream opens. Rebuild without old markers.
            step = { kind: 'load' }
            continue
          }
          this.update(addNotice(this.view, { level: 'error', ...this.describe(error, '加载会话失败') }))
          this.finish(owner, 'idle')
          return
        }
        // Network and 5xx failures leave the result unknown, so they are handled like a dropped stream.
        if (step.kind === 'prompt') continueAfterDrop()
        if (!(await retry())) return
        continue
      }
      if (!outcome) return

      if (outcome.type === 'eof') {
        if (step.kind === 'prompt') continueAfterDrop()
        if (!(await retry())) return
        continue
      }

      const { frame } = outcome
      const errorCode = asText(asObject(frame.error).errorCode)
      if (errorCode === 'CLI_RELOAD_REQUIRED') {
        this.markers = undefined
        step = { kind: 'load' }
        continue
      }
      if (errorCode === 'CLI_STREAM_FAILED') {
        // A read failure, not an execution failure.
        if (step.kind === 'prompt') continueAfterDrop()
        if (!(await retry())) return
        continue
      }

      // A resume ends in a rebuild, so its outcome waits in `pendingNotice`; a prompt outcome is shown right away.
      const notice = this.describeTerminal(frame, step)
      if (step.kind === 'resume') {
        pendingNotice = notice
        failures = 0
        step = { kind: 'load' }
        continue
      }
      let view = this.view
      if (step.kind === 'load' && unknownResult && !frame.error) view = addNotice(view, { level: 'info', text: RESULT_UNKNOWN })
      if (pendingNotice) view = addNotice(view, pendingNotice)
      if (notice) view = addNotice(view, notice)
      if (step.kind === 'load') view = keepUnsent(view)
      // The Prompt's own terminal frame means its turn ended, so a card that outlived it would only block the composer.
      // A plain Load is different: its end_turn may only mean loading finished, so its cards stay.
      this.update(step.kind === 'prompt' ? { ...view, interactions: [] } : view)
      this.finish(owner, 'idle')
      if (initial.kind !== 'load' && this.active === undefined && delegatedInLatestTurn(this.view)) void this.watchDelegation()
      return
    }
  }

  private describeTerminal(frame: Frame, step: Step): Parameters<typeof addNotice>[1] | undefined {
    if (frame.error) {
      const code = asText(frame.error.errorCode) || String(frame.error.code ?? '')
      return {
        level: 'error',
        text: frame.error.message || '回合执行失败。',
        ...(code ? { code } : {}),
        ...(frame.requestId ? { requestId: frame.requestId } : {}),
      }
    }
    // A plain Load's stop reason describes the load only.
    if (step.kind === 'load') return undefined
    const stopReason = asText(frame.result?.stopReason)
    if (stopReason === 'end_turn') return undefined
    if (stopReason === 'cancelled') return { level: 'info', text: '已停止。已经发生的外部操作不会被撤销。' }
    return { level: 'info', text: stopReason ? `回合已结束，结束原因：${stopReason}` : '回合已结束，未返回结束原因。' }
  }
}
