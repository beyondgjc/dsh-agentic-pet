/**
 * "When you were away" facts: per-pet wake/speak/action counters and a
 * last-user-activity checkpoint. Pure helpers; the driver owns the mutable
 * state and persistence.
 * @module dsh-agentic-pet/presence
 */

import { readGlobalJson } from './petdata.ts'

export interface PresenceCounts {
  wakeCount: number
  speakCount: number
  actionCount: number
  selfWakeCount: number
}

export interface PresenceFacts extends PresenceCounts {
  plansPending: number
}

export interface PresenceConfig {
  enabled: boolean
}

/** The user must have been silent this long before a return summary exists. */
export const AWAY_THRESHOLD_MS = 30 * 60 * 1000

export const EMPTY_PRESENCE_COUNTS: PresenceCounts = {
  wakeCount: 0,
  speakCount: 0,
  actionCount: 0,
  selfWakeCount: 0,
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

export function normalizePresenceCounts(raw: unknown): PresenceCounts {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return {
    wakeCount: nonNegative(record.wakeCount),
    speakCount: nonNegative(record.speakCount),
    actionCount: nonNegative(record.actionCount),
    selfWakeCount: nonNegative(record.selfWakeCount),
  }
}

export function diffPresence(current: PresenceCounts, baseline: PresenceCounts): PresenceCounts {
  return {
    wakeCount: Math.max(0, current.wakeCount - baseline.wakeCount),
    speakCount: Math.max(0, current.speakCount - baseline.speakCount),
    actionCount: Math.max(0, current.actionCount - baseline.actionCount),
    selfWakeCount: Math.max(0, current.selfWakeCount - baseline.selfWakeCount),
  }
}

export function hasPresence(facts: PresenceFacts): boolean {
  return facts.plansPending > 0
    || facts.wakeCount + facts.speakCount + facts.actionCount + facts.selfWakeCount > 0
}

/** One compact line; prompt builders prepend the `[你不在的时候]` tag. */
export function formatPresenceLine(facts: PresenceFacts): string {
  const plans = facts.plansPending > 0
    ? `；还有 ${String(facts.plansPending)} 个自己安排的计划`
    : ''
  return `你不在的这段时间里，我醒过 ${String(facts.wakeCount)} 次`
    + `（自主唤醒 ${String(facts.selfWakeCount)} 次），说过 ${String(facts.speakCount)} 句，`
    + `做过 ${String(facts.actionCount)} 个动作${plans}。`
}

export async function readPresenceConfig(home: string): Promise<PresenceConfig> {
  try {
    const raw = await readGlobalJson(home, 'pet-settings.json')
    const summary = raw.presenceSummary
    return {
      enabled: typeof summary === 'object'
        && summary !== null
        && (summary as Record<string, unknown>).enabled === true,
    }
  } catch {
    return { enabled: false }
  }
}
