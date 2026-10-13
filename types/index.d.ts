// The mod's state contract. Each value lives in $.state under 'mental-model'.

export type Note = {
  want: string
  inTheirHead: string
  version: number
  at: number
  // Set on a history entry the user removed with Remove.
  isRemoved?: boolean
}

export type Change = {
  field: 'want' | 'inTheirHead'
  was: string
  now: string
}

// How the current note relates to the entry before it in the history.
export type Origin =
  | { kind: 'first' }
  | { kind: 'changed'; previous: Note; changes: Change[] }
  | { kind: 'replaces'; removed: Note }

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
