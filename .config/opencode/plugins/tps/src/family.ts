/**
 * Pure bookkeeping for "which subagents are working under this session": parent links, per-session busy
 * state and the descendant count. Nothing here reads the clock or the host: callers pass `now` and,
 * optionally, a `Host` to consult for sessions the event stream never mentioned.
 */

/** A session that has shown no activity for this long is assumed to have lost its end event. */
export const STALE_MS = 10 * 60 * 1000
const MAX_LINKS = 512
const MAX_STATES = 256
/** Parent chains are short; the cap only guards against a corrupt (cyclic) host cache. */
const MAX_DEPTH = 32

/** What the plugin host knows. Every member is a fallback for what events did not tell us. */
export interface Host {
  parent(id: string): string | undefined
  /** Whether the host reports the session as running. */
  busy(id: string): boolean
  /** Every session in the tree of `root` (descendants, and possibly more). */
  members(root: string): readonly string[]
}

interface State {
  busy: boolean
  /** Last activity, on the caller's clock. */
  at: number
  /** Busy only because the host said so (no event seen); the host can also take it back. */
  adopted?: true
}

export class Family {
  private readonly links = new Map<string, string>()
  private readonly states = new Map<string, State>()

  constructor(private readonly staleMs: number = STALE_MS) {}

  /** `child` was created under `parent` (`session.created` with a `parentID`). */
  link(child: string, parent: string): void {
    this.links.delete(child)
    this.links.set(child, parent)
    if (this.links.size > MAX_LINKS) this.links.delete(this.links.keys().next().value!)
  }

  /** The session started working (execution or step started, status busy/retry). */
  start(id: string, now: number): void {
    this.write(id, { busy: true, at: now })
  }

  /** Any other sign of life. Refreshes a busy session; never revives one that has ended. */
  touch(id: string, now: number): void {
    const state = this.states.get(id)
    if (!state?.busy) return
    state.at = now
    delete state.adopted
  }

  /** The execution ended or the session went idle. The host's opinion no longer counts for it. */
  end(id: string, now: number): void {
    this.write(id, { busy: false, at: now })
  }

  forget(id: string): void {
    this.links.delete(id)
    this.states.delete(id)
  }

  /** Whether the events say `id` is working right now. */
  isBusy(id: string, now: number): boolean {
    const state = this.states.get(id)
    return state !== undefined && state.busy && now - state.at <= this.staleMs
  }

  /** How many sessions below `root` are busy now; see `busy`. */
  count(root: string, now: number, host?: Host): number {
    return this.busy(root, now, host).length
  }

  /**
   * Sessions below `root` (children, grandchildren, ...) that are busy now.
   *
   * Events are authoritative for every session they mentioned. A session they never mentioned (the plugin
   * loaded mid-run) is taken from the host while it reports it running; the first event about it, or the
   * host reporting it idle, hands over to the normal rules. It goes stale like any other, so a host that
   * never reports idle cannot pin the marker either.
   */
  busy(root: string, now: number, host?: Host): string[] {
    if (host) {
      for (const id of host.members(root)) {
        if (id !== root && !this.states.has(id) && host.busy(id)) this.write(id, { busy: true, at: now, adopted: true })
      }
    }
    const found: string[] = []
    for (const [id, state] of this.states) {
      if (!state.busy || id === root) continue
      if (state.adopted && host && !host.busy(id)) {
        state.busy = false
        continue
      }
      if (now - state.at > this.staleMs) continue
      if (this.descends(id, root, host)) found.push(id)
    }
    return found
  }

  private descends(id: string, root: string, host?: Host): boolean {
    const seen = new Set<string>([id])
    let current = id
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const parent = this.links.get(current) ?? host?.parent(current)
      if (parent === undefined) return false
      if (parent === root) return true
      if (seen.has(parent)) return false
      seen.add(parent)
      current = parent
    }
    return false
  }

  private write(id: string, state: State): void {
    // Re-inserting keeps the map ordered by recency, so eviction drops the longest-quiet session
    // that is not working (a busy one that went stale counts as not working).
    this.states.delete(id)
    this.states.set(id, state)
    if (this.states.size <= MAX_STATES) return
    for (const [candidate, existing] of this.states) {
      if (!existing.busy || state.at - existing.at > this.staleMs) {
        this.states.delete(candidate)
        return
      }
    }
  }
}
