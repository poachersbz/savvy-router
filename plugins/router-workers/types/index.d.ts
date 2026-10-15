export type Status = 'running' | 'done' | 'failed' | 'stopped'

export type Worker = {
  id: string
  title: string
  model: string
  cwd: string
  status: Status
  startedAt: number
  endedAt?: number
  // The latest thing it did: a tool call ("Edit calc.py") or a line of its text.
  activity: string
  toolCalls: number
  tokensIn: number
  tokensOut: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'router-workers': {
      workers: Worker[]
      now: number
      band: { isDismissed: boolean }
    }
  }
}
