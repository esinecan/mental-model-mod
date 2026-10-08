// The mod's state contract. Each value lives in $.state under 'mental-model'.

export type Note = {
  want: string
  inHisHead: string
  version: number
  at: number
}

export type Change = {
  field: 'want' | 'inHisHead'
  was: string
  now: string
}

export type Check = {
  targets: string[]
  asked: string
  amount: string
  sentence: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'mental-model': {
      note: Note | null
      history: Note[]
      checks: Check[]
      isHidden: boolean
      showHistory: boolean
      remind: boolean
    }
  }
}
