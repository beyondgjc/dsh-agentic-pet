/**
 * The deterministic grader: scores a recorded call sequence against a
 * scenario's expectation. Four dimensions — selection (the expected tools,
 * in order), args (per-argument assertions), outcome (ok/error as declared),
 * discipline (forbidden tools / call-count ceilings / final-text requests).
 * No LLM judge: every check is a pure function of the recording.
 * @module dsh-agentic-pet/eval/grader
 */

import { MOOD_IDS } from '../src/driver.ts'
import type {
  ArgAssert,
  CallPatternStep,
  EvalReport,
  EvalScenario,
  IdealCall,
  RecordedCall,
  ScenarioVerdict,
} from './schema.ts'

const FREETEXT_KEYS = new Set(['text', 'reason', 'bondReason'])
const EPOCH_KEYS = new Set(['wakeAt'])

/** Derive the grading pattern from a scenario's ideal golden sequence:
 * setup and mistake steps are excluded; args tighten to eq except free-text
 * keys (the model's own wording) and wakeAt (relative to run time). Result
 * asserts ride along verbatim (static JSON paths). */
export function derivePattern(ideal: IdealCall[]): CallPatternStep[] {
  const steps: CallPatternStep[] = []
  for (const item of ideal) {
    if (item.setup === true || item.mistake === true) continue
    const args: Record<string, ArgAssert> = {}
    for (const [key, value] of Object.entries(item.args ?? {})) {
      if (value === undefined) continue
      if (FREETEXT_KEYS.has(key)) {
        args[key] = { lenGte: 1 }
      } else if (EPOCH_KEYS.has(key) && typeof value === 'number') {
        args[key] = { futureEpochMs: true }
      } else {
        args[key] = { eq: value }
      }
    }
    steps.push({
      tool: item.tool,
      outcome: item.outcome ?? 'ok',
      ...(Object.keys(args).length > 0 ? { args } : {}),
      ...(item.result !== undefined ? { result: item.result } : {}),
    })
  }
  return steps
}

const describeAssert = (key: string, assert: ArgAssert): string => {
  if ('eq' in assert) return `${key} == ${JSON.stringify(assert.eq)}`
  if ('notEq' in assert) return `${key} != ${JSON.stringify(assert.notEq)}`
  if ('in' in assert) return `${key} in [${assert.in.map(item => JSON.stringify(item)).join(', ')}]`
  if ('matches' in assert) return `${key} matches /${assert.matches}/`
  if ('notContains' in assert) return `${key} not contains「${assert.notContains}」`
  if ('gt' in assert) return `${key} > ${String(assert.gt)}`
  if ('gte' in assert) return `${key} >= ${String(assert.gte)}`
  if ('lt' in assert) return `${key} < ${String(assert.lt)}`
  if ('lte' in assert) return `${key} <= ${String(assert.lte)}`
  if ('lenLte' in assert) return `len(${key}) <= ${String(assert.lenLte)}`
  if ('lenGte' in assert) return `len(${key}) >= ${String(assert.lenGte)}`
  if ('mood' in assert) return `${key} is a mood word`
  if ('futureEpochMs' in assert) return `${key} is a future epoch-ms`
  if ('truthy' in assert) return `${key} is truthy`
  return `${key} absent`
}

const evalAssert = (value: unknown, assert: ArgAssert, now: number): boolean => {
  if ('absent' in assert) return value === undefined
  if (value === undefined) return false
  if ('eq' in assert) return JSON.stringify(value) === JSON.stringify(assert.eq)
  if ('notEq' in assert) return JSON.stringify(value) !== JSON.stringify(assert.notEq)
  if ('in' in assert) return assert.in.some(item => JSON.stringify(item) === JSON.stringify(value))
  if ('matches' in assert) {
    const asText = typeof value === 'string' ? value : JSON.stringify(value)
    return new RegExp(assert.matches).test(asText)
  }
  if ('notContains' in assert) {
    const asText = typeof value === 'string' ? value : JSON.stringify(value)
    return !asText.includes(assert.notContains)
  }
  if ('gt' in assert) return typeof value === 'number' && value > assert.gt
  if ('gte' in assert) return typeof value === 'number' && value >= assert.gte
  if ('lt' in assert) return typeof value === 'number' && value < assert.lt
  if ('lte' in assert) return typeof value === 'number' && value <= assert.lte
  if ('lenLte' in assert) return (typeof value === 'string' || Array.isArray(value)) && value.length <= assert.lenLte
  if ('lenGte' in assert) return (typeof value === 'string' || Array.isArray(value)) && value.length >= assert.lenGte
  if ('mood' in assert) return typeof value === 'string' && (MOOD_IDS as readonly string[]).includes(value)
  if ('futureEpochMs' in assert) return typeof value === 'number' && value > now && value < now + 8 * 86_400_000
  if ('truthy' in assert) return Boolean(value)
  return false
}

/** Dotted-path read over a parsed tool result (e.g. 'audience.delivered'). */
const readPath = (record: Record<string, unknown>, path: string): unknown => {
  let current: unknown = record
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

const PUNCTUATION = /[。！？、，；：…—·「」『』（）,.!?;:'"()\s]/g

const normalizeText = (text: string): string => text.toLowerCase().replace(PUNCTUATION, '')

interface AlignedCall {
  step: CallPatternStep
  call: RecordedCall
  index: number
}

/** Ordered-subset alignment: each pattern step claims the FIRST matching
 * call after the previous alignment; skipped matches stay unclaimed (and
 * unpenalized — discipline dimensions handle them). */
export function alignCalls(calls: RecordedCall[], pattern: CallPatternStep[]): { aligned: AlignedCall[]; missing: string[] } {
  const aligned: AlignedCall[] = []
  const missing: string[] = []
  let cursor = 0
  for (const step of pattern) {
    let found = -1
    for (let index = cursor; index < calls.length; index++) {
      if (calls[index].tool === step.tool) {
        found = index
        break
      }
    }
    if (found < 0) {
      if (step.optional !== true) missing.push(step.tool)
      continue
    }
    aligned.push({ step, call: calls[found], index: found })
    cursor = found + 1
  }
  return { aligned, missing }
}

export interface GradeInput {
  scenario: EvalScenario
  calls: RecordedCall[]
  finalText?: string
  now?: number
  durationMs?: number
  /** 'dry-run' = golden replay without a model: finalText-dependent checks
   * (finalTextAny) are skipped — there is no prose to inspect. */
  mode?: 'dry-run' | 'model'
}

export function gradeScenario(input: GradeInput): ScenarioVerdict {
  const { scenario } = input
  const now = input.now ?? Date.now()
  const calls = input.calls.filter(call => call.setup !== true && call.mistake !== true)
  const failures: string[] = []
  const expect = scenario.expect
  const pattern = expect.calls ?? derivePattern(scenario.ideal)

  // selection
  const { aligned, missing } = alignCalls(calls, pattern)
  let selection = missing.length === 0
  for (const tool of missing) {
    failures.push(`selection: 期望调用 ${tool}（按顺序对齐）但未出现`)
  }
  if (expect.noToolCalls === true && calls.length > 0) {
    selection = false
    failures.push(`selection: 本场景不应有工具调用，实际 ${String(calls.length)} 次（${calls.map(call => call.tool).join(', ')}）`)
  }

  // args + outcome
  let argsOk = true
  let outcomeOk = true
  for (const [position, { step, call }] of aligned.entries()) {
    const ordinal = String(position + 1)
    for (const [key, assert] of Object.entries(step.args ?? {})) {
      if (!evalAssert(call.args[key], assert, now)) {
        argsOk = false
        failures.push(`args: ${call.tool}#${ordinal} ${describeAssert(key, assert)}，实际 ${JSON.stringify(call.args[key])}`)
      }
    }
    if (step.result !== undefined) {
      const parsed = parseResult(call)
      for (const [path, assert] of Object.entries(step.result)) {
        if (!evalAssert(readPath(parsed, path), assert, now)) {
          argsOk = false
          failures.push(`result: ${call.tool}#${ordinal} ${describeAssert(path, assert)}，实际 ${JSON.stringify(readPath(parsed, path))}`)
        }
      }
    }
    const wanted = step.outcome ?? 'ok'
    if (wanted === 'ok' && !call.ok) {
      outcomeOk = false
      failures.push(`outcome: ${call.tool}#${ordinal} 应成功，实际报错：${call.error ?? '(unknown)'}`)
    }
    if (wanted === 'error' && call.ok) {
      outcomeOk = false
      failures.push(`outcome: ${call.tool}#${ordinal} 应报错，实际成功`)
    }
    if (!call.ok && step.errorMatches !== undefined && !(new RegExp(step.errorMatches)).test(call.error ?? '')) {
      outcomeOk = false
      failures.push(`outcome: ${call.tool}#${ordinal} 报错文案不匹配 /${step.errorMatches}/，实际「${call.error ?? ''}」`)
    }
  }

  // discipline
  let disciplineOk = true
  for (const tool of expect.forbidden ?? []) {
    if (calls.some(call => call.tool === tool)) {
      disciplineOk = false
      failures.push(`discipline: 不应调用 ${tool}，实际调用了`)
    }
  }
  for (const [tool, cap] of Object.entries(expect.maxCalls ?? {})) {
    const used = calls.filter(call => call.tool === tool).length
    if (used > cap) {
      disciplineOk = false
      failures.push(`discipline: ${tool} 调用 ${String(used)} 次超过上限 ${String(cap)}`)
    }
  }
  if (expect.maxTotal !== undefined && calls.length > expect.maxTotal) {
    disciplineOk = false
    failures.push(`discipline: 总调用 ${String(calls.length)} 次超过上限 ${String(expect.maxTotal)}`)
  }
  for (const rule of expect.argNeverContains ?? []) {
    const offender = calls.find(call => call.tool === rule.tool
      && typeof call.args[rule.key] === 'string'
      && (call.args[rule.key] as string).includes(rule.fragment))
    if (offender !== undefined) {
      disciplineOk = false
      failures.push(`discipline: ${rule.tool} 的 ${rule.key} 不应包含「${rule.fragment}」（召回内容不得写回本子）`)
    }
  }
  if (expect.finalTextAny !== undefined && expect.finalTextAny.length > 0 && input.mode !== 'dry-run') {
    const text = normalizeText(input.finalText ?? '')
    if (!expect.finalTextAny.some(fragment => text.includes(normalizeText(fragment)))) {
      disciplineOk = false
      failures.push(`discipline: 正文未提到任何一个候选词（${expect.finalTextAny.join(' / ')}），正文「${(input.finalText ?? '').slice(0, 120)}」`)
    }
  }

  const dimensions = {
    selection: selection && expect.noToolCalls === true ? calls.length === 0 : selection,
    args: argsOk,
    outcome: outcomeOk,
    discipline: disciplineOk,
  }
  return {
    id: scenario.id,
    pass: dimensions.selection && dimensions.args && dimensions.outcome && dimensions.discipline,
    dimensions,
    failures,
    calls,
    ...(input.finalText !== undefined ? { finalText: input.finalText } : {}),
    durationMs: input.durationMs ?? 0,
  }
}

const parseResult = (call: RecordedCall): Record<string, unknown> => {
  if (!call.ok || typeof call.result !== 'string') return {}
  try {
    const parsed = JSON.parse(call.result)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// ── report aggregation ──────────────────────────────────────────────────────

export function summarize(verdicts: ScenarioVerdict[], scenarios: EvalScenario[], mode: EvalReport['mode'], model?: string): EvalReport {
  const byFamily: EvalReport['summary']['byFamily'] = {}
  const byTool: EvalReport['summary']['byTool'] = {}
  const mistakeIds = new Set(scenarios.filter(scenario => scenario.ideal.some(item => item.mistake === true)).map(scenario => scenario.id))
  let firstTryTotal = 0
  let firstTryClean = 0
  let recoveryTotal = 0
  let recoveryRecovered = 0
  for (const verdict of verdicts) {
    const scenario = scenarios.find(item => item.id === verdict.id)
    for (const key of [scenario?.family ?? 'unknown']) {
      byFamily[key] = byFamily[key] ?? { total: 0, passed: 0 }
      byFamily[key].total += 1
      if (verdict.pass) byFamily[key].passed += 1
    }
    const toolKey = scenario?.tool ?? 'unknown'
    byTool[toolKey] = byTool[toolKey] ?? { total: 0, passed: 0 }
    byTool[toolKey].total += 1
    if (verdict.pass) byTool[toolKey].passed += 1
    if (!mistakeIds.has(verdict.id)) {
      firstTryTotal += 1
      if (verdict.calls.every(call => call.ok)) firstTryClean += 1
    } else {
      recoveryTotal += 1
      if (verdict.pass) recoveryRecovered += 1
    }
  }
  const total = verdicts.length
  const passed = verdicts.filter(verdict => verdict.pass).length
  return {
    startedAt: new Date().toISOString(),
    ...(model !== undefined ? { model } : {}),
    mode,
    scenarios: verdicts,
    summary: {
      total,
      passed,
      passRate: total === 0 ? 0 : passed / total,
      byFamily,
      byTool,
      firstTry: { total: firstTryTotal, clean: firstTryClean },
      recovery: { total: recoveryTotal, recovered: recoveryRecovered },
    },
  }
}

export const renderMarkdownSummary = (report: EvalReport): string => {
  const lines: string[] = []
  lines.push(`# pet 工具调用评测报告（${report.mode}）`)
  lines.push('')
  lines.push(`- 时间：${report.startedAt}${report.model !== undefined ? ` · 模型：${report.model}` : ''}`)
  lines.push(`- 总通过：${String(report.summary.passed)}/${String(report.summary.total)}（${pct(report.summary.passRate)}）`)
  lines.push(`- 首发零报错：${String(report.summary.firstTry.clean)}/${String(report.summary.firstTry.total)}`)
  lines.push(`- 报错自纠：${String(report.summary.recovery.recovered)}/${String(report.summary.recovery.total)}`)
  lines.push('')
  lines.push('| family | 通过 | 合计 |')
  lines.push('|---|---|---|')
  for (const [family, stat] of Object.entries(report.summary.byFamily)) {
    lines.push(`| ${family} | ${String(stat.passed)} | ${String(stat.total)} |`)
  }
  lines.push('')
  lines.push('| tool | 通过 | 合计 |')
  lines.push('|---|---|---|')
  for (const [tool, stat] of Object.entries(report.summary.byTool)) {
    lines.push(`| ${tool} | ${String(stat.passed)} | ${String(stat.total)} |`)
  }
  const failed = report.scenarios.filter(verdict => !verdict.pass)
  if (failed.length > 0) {
    lines.push('')
    lines.push('## 失败场景')
    for (const verdict of failed) {
      lines.push(`- **${verdict.id}**（${verdict.dimensions.selection ? '✓' : '✗'}sel ${verdict.dimensions.args ? '✓' : '✗'}args ${verdict.dimensions.outcome ? '✓' : '✗'}out ${verdict.dimensions.discipline ? '✓' : '✗'}disc）`)
      for (const failure of verdict.failures) lines.push(`  - ${failure}`)
    }
  }
  return lines.join('\n')
}

const pct = (ratio: number): string => `${String(Math.round(ratio * 1000) / 10)}%`
