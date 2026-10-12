// The mod's state contract. Each value lives in $.state under 'mental-model'.

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

declare module 'claude-code' {
  interface PluginState {
    'mental-model': {
      note: Note | null
      history: Note[]
      settled: boolean
      isHidden: boolean
      showHistory: boolean
      remind: boolean
    }
  }
}
