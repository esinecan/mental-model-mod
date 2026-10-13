
export type Note = {
  want: string
  inTheirHead: string
  version: number
  at: number
}

export type Change = {
  field: 'want' | 'inTheirHead'
  was: string
  now: string
}

export type Origin =
  | { kind: 'first' }
  | { kind: 'changed'; previous: Note; changes: Change[] }

declare module 'claude-code' {
  interface PluginState {
    'mental-model': {
      note: Note | null
      history: Note[]
      settled: boolean
      isHidden: boolean
      showHistory: boolean
      remind: boolean
      isRemoveAllArmed: boolean
      prompts: number
      loadedFor: string | null
    }
  }
}
