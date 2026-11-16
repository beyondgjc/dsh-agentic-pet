/**
 * The eval harness: materializes a scenario's seed into a temp home, boots
 * the REAL registerPetTools against the mock pet seam, builds the turn
 * prompt with the REAL inner-voice builders (and the real journal-injection
 * path for first-wake turns), then runs the tool loop — either as a dry-run
 * golden replay (no model, validates the dataset) or a live model turn.
 * @module dsh-agentic-pet/eval/harness
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as yamlLoad } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { petEvalSeam, registerPetTools } from '../src/driver.ts'
import type { PetService } from '../src/service.ts'
import { appendJournal, readJournalConfig } from '../src/journal.ts'
import { appendEpoch, buildJournalInjection, pinEntry } from '../src/journal-recall.ts'
import { leaveNote, replyNote } from '../src/board.ts'
import { writeAffectionRaw, writePetStateJson } from '../src/petdata.ts'
import {
  bondTier,
  buildChatPrompt,
  buildCrossPetPrompt,
  buildDreamPrompt,
  buildGreetPrompt,
  buildTouchPrompt,
  buildWakePrompt,
  type MergedWakePlan,
} from '../src/inner-voice.ts'
import { readPersonaCard } from '../src/persona.ts'
import { createMockPet, type MockPet } from './mock-pet.ts'
import { gradeScenario } from './grader.ts'
import type { EvalScenario, LedgerSeed, RecordedCall, ScenarioVerdict, SeedSpec, TurnSpec } from './schema.ts'
import { buildToolsForWire, chatCompletion, type LlmConfig, type OpenAiMessage } from './llm-client.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SESSION = 'voice-session-1'
const DEFAULT_PET = 'electron'

export interface ScenarioRuntime {
  home: string
  tools: Map<string, ToolDefinition>
  mock: MockPet
  sessionId: string | undefined
  selfPetId: string
  ledgers: Map<string, Record<string, unknown>>
  exec: { agent: { id: string } } | undefined
  dispose: () => Promise<void>
}

// ── seed materialization ────────────────────────────────────────────────────

const normalizeLedger = (seed: LedgerSeed): Record<string, unknown> => {
  const today = new Date().toDateString()
  return {
    affection: seed.affection ?? 40,
    total: seed.total ?? 0,
    byPart: seed.byPart ?? {},
    ...(seed.lastTouchAt !== undefined ? { lastTouchAt: seed.lastTouchAt } : {}),
    recent: seed.recent ?? [],
    ...(seed.adjustments !== undefined ? { adjustments: seed.adjustments } : {}),
    ...(seed.quota !== undefined ? { quota: seed.quota } : {}),
    ...(seed.bond !== undefined
      ? { bond: { value: seed.bond.value, days: seed.bond.days, lastCountedDate: seed.bond.lastCountedDate ?? today } }
      : {}),
    ...(seed.bondAdjustments !== undefined ? { bondAdjustments: seed.bondAdjustments } : {}),
    petAffection: seed.petAffection ?? {},
    petFacts: seed.petFacts ?? {},
  }
}

const writeSettings = async (home: string, seed: SeedSpec): Promise<void> => {
  const extra = seed.settings ?? {}
  const { innerVoice: extraVoice, journal: extraJournal, ...rest } = extra as {
    innerVoice?: Record<string, unknown>
    journal?: Record<string, unknown>
  } & Record<string, unknown>
  const settings: Record<string, unknown> = {
    ...rest,
    innerVoice: {
      selfTuning: seed.selfTuning === true,
      petToPetDelivery: seed.petToPetDelivery ?? 'queue',
      dreaming: true,
      ...(extraVoice ?? {}),
    },
    journal: {
      allowUnboundAppend: seed.allowUnboundAppend === true,
      ...(extraJournal ?? {}),
    },
    ...(seed.focus !== undefined ? { focus: seed.focus } : {}),
  }
  const path = join(home, 'whale598', 'pet-settings.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

async function materializeState(home: string, seed: SeedSpec): Promise<Map<string, Record<string, unknown>>> {
  const journalConfig = await readJournalConfig(home)
  const ledgers = new Map<string, Record<string, unknown>>()
  const petIds = new Set<string>([
    ...(seed.pets ?? [{ id: DEFAULT_PET }]).map(pet => pet.id),
    ...Object.keys(seed.ledger ?? {}),
    ...Object.keys(seed.journal ?? {}),
    ...Object.keys(seed.epochs ?? {}),
    ...Object.keys(seed.letters ?? {}),
  ])
  for (const petId of petIds) {
    const ledgerSeed = seed.ledger?.[petId] ?? {}
    const ledger = normalizeLedger(ledgerSeed)
    ledgers.set(petId, ledger)
    await writeAffectionRaw(home, petId, ledger)
    for (const item of seed.journal?.[petId] ?? []) {
      await appendJournal(home, petId, {
        ...(item.at !== undefined ? { at: item.at } : {}),
        source: item.source ?? 'pet',
        sessionId: item.sessionId ?? null,
        text: item.text,
        ...(item.tags !== undefined ? { tags: item.tags } : {}),
        ...(item.entities !== undefined ? { entities: item.entities } : {}),
      }, journalConfig)
    }
    for (const epoch of seed.epochs?.[petId] ?? []) {
      await appendEpoch(home, petId, {
        text: epoch.text,
        sessionId: null,
        ...(epoch.window !== undefined ? { window: epoch.window } : {}),
      })
    }
    for (const pinnedId of seed.journalPin?.[petId] ?? []) {
      await pinEntry(home, petId, pinnedId)
    }
    if (seed.letters?.[petId] !== undefined) {
      await writePetStateJson(home, petId, 'pet-letters.json', {
        letters: seed.letters[petId].map(letter => ({
          at: letter.at,
          text: letter.text,
          ...(letter.readAt !== undefined ? { readAt: letter.readAt } : {}),
        })),
      })
    }
  }
  for (const noteSeed of seed.boardNotes ?? []) {
    const note = await leaveNote(home, noteSeed.from, noteSeed.text, noteSeed.at ?? Date.now())
    for (const replySeed of noteSeed.replies ?? []) {
      await replyNote(home, replySeed.from, note.id, replySeed.text, replySeed.at ?? note.at + 1)
    }
  }
  if (seed.interactions !== undefined) {
    const path = join(home, 'whale598', 'pet-interactions.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(seed.interactions)}\n`, 'utf8')
  }
  for (const [petId, state] of Object.entries(seed.innerState ?? {})) {
    await writePetStateJson(home, petId, 'pet-inner-state.json', state)
  }
  return ledgers
}

const seedMemoryState = (seed: SeedSpec, sessionId: string): void => {
  const seam = petEvalSeam()
  const owners = seed.owners === undefined ? { [sessionId]: DEFAULT_PET } : seed.owners
  for (const [owner, petId] of Object.entries(owners)) seam.voiceOwners.set(owner, petId)
  for (const [petId, messages] of Object.entries(seed.messages ?? {})) {
    seam.voicePetMessages.set(petId, messages.map(message => ({
      from: message.from,
      text: message.text,
      at: message.at ?? Date.now(),
    })))
  }
  for (const [petId, plans] of Object.entries(seed.wakePlans ?? {})) {
    seam.voiceWakePlans.set(petId, plans.map(plan => ({
      id: plan.id,
      at: plan.at,
      intent: plan.intent,
      createdAt: plan.at,
    })))
  }
  for (const [pair, timestamps] of Object.entries(seed.crossPetLog ?? {})) {
    seam.crossPetLog.set(pair, [...timestamps])
  }
}

export async function buildScenarioRuntime(scenario: EvalScenario): Promise<ScenarioRuntime> {
  // Module-level singletons shared across scenarios: wipe before each run.
  const seam = petEvalSeam()
  seam.voiceOwners.clear()
  seam.voicePetMessages.clear()
  seam.voiceWakePlans.clear()
  seam.crossPetLog.clear()

  const home = await mkdtemp(join(tmpdir(), 'pet-eval-'))
  try {
    await writeSettings(home, scenario.seed)
    const mock = await createMockPet(scenario.seed.pets ?? [{ id: DEFAULT_PET }])
    const ledgers = await materializeState(home, scenario.seed)
    const sessionId = scenario.seed.session === null ? undefined : (scenario.seed.session ?? DEFAULT_SESSION)
    seedMemoryState(scenario.seed, sessionId ?? DEFAULT_SESSION)

    const tools = new Map<string, ToolDefinition>()
    const fakeCtx = {
      inject(_deps: string[], cb: (scope: { tools: { register: (tool: ToolDefinition) => void } }) => void) {
        cb({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } } })
      },
    } as unknown as Context
    const savedLog = console.log
    console.log = () => {}
    try {
      registerPetTools(fakeCtx, home, mock.service as unknown as PetService)
    } finally {
      console.log = savedLog
    }
    if (tools.size === 0) throw new Error('registerPetTools captured no tools')

    const owners = scenario.seed.owners === undefined ? { [sessionId ?? DEFAULT_SESSION]: DEFAULT_PET } : scenario.seed.owners
    const selfPetId = (sessionId !== undefined ? owners[sessionId] : undefined) ?? DEFAULT_PET
    return {
      home,
      tools,
      mock,
      sessionId,
      selfPetId,
      ledgers,
      exec: sessionId === undefined ? undefined : { agent: { id: sessionId } },
      dispose: async () => {
        await rm(home, { recursive: true, force: true })
      },
    }
  } catch (error: unknown) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

// ── turn prompt (real builders, driver-assembly mirror) ─────────────────────

const ledgerOf = (runtime: ScenarioRuntime, petId: string): Record<string, unknown> =>
  runtime.ledgers.get(petId) ?? { affection: 40 }

const wakeFacts = async (runtime: ScenarioRuntime, scenario: EvalScenario, petId: string): Promise<Record<string, unknown>> => {
  const seed = scenario.seed
  const turn = scenario.turn as { kind: 'wake'; facts?: Record<string, unknown> }
  const ledger = ledgerOf(runtime, petId)
  const base: Record<string, unknown> = {
    affection: typeof ledger.affection === 'number' ? ledger.affection : 40,
    bondValue: 0,
    bondDays: 0,
    bondTier: '陌生',
    minutesSinceLastSpoke: 30,
    minutesSinceUserActivity: undefined,
    userActive: false,
  }
  const bond = ledger.bond as { value?: number; days?: number } | undefined
  if (bond !== undefined) {
    base.bondValue = bond.value ?? 0
    base.bondDays = bond.days ?? 0
    base.bondTier = bondTier(bond.value ?? 0)
  }
  const facts = { ...base, ...(turn.facts ?? {}) }
  // Journal injection mirrors the driver (driver.ts:2314-2318): only the
  // first wake after boot carries the recent-entries block.
  if (facts.firstWakeAfterBoot === true && facts.journal === undefined) {
    const config = await readJournalConfig(runtime.home)
    const injection = await buildJournalInjection(runtime.home, petId, config)
    facts.journal = injection.entries
    if (injection.epochLines.length > 0) facts.journalEpochs = injection.epochLines
    if (injection.epochDue !== undefined) facts.journalEpochDue = injection.epochDue.reason
  }
  return facts
}

export async function buildTurnPrompt(scenario: EvalScenario, runtime: ScenarioRuntime): Promise<string> {
  const turn: TurnSpec = scenario.turn
  const petId = runtime.selfPetId
  const ledger = ledgerOf(runtime, petId)
  const affection = typeof ledger.affection === 'number' ? ledger.affection : 40
  switch (turn.kind) {
    case 'wake':
      return buildWakePrompt(await wakeFacts(runtime, scenario, petId) as unknown as Parameters<typeof buildWakePrompt>[0])
    case 'touch':
      return buildTouchPrompt({
        part: turn.part,
        touchesToday: turn.touchesToday ?? 1,
        affection,
        ...(turn.mergedPlan !== undefined ? { mergedPlan: turn.mergedPlan } : {}),
      })
    case 'chat':
      return buildChatPrompt(turn.text, turn.mergedPlan, undefined)
    case 'dream':
      return buildDreamPrompt(turn.memories)
    case 'greet':
      return buildGreetPrompt({
        affection,
        bondValue: 0,
        bondDays: 0,
        bondTier: '陌生',
        name: turn.name ?? '鲸鱼娘',
      })
    case 'cross':
      return buildCrossPetPrompt({
        fromName: turn.fromName,
        fromId: turn.fromId,
        text: turn.text,
        affection: turn.affection ?? 0,
      })
    case 'raw':
      return turn.text
  }
}

export const systemPromptFor = (home: string): string => {
  const presetPath = join(REPO_ROOT, 'presets', 'pet-inner-voice.patch.yml')
  const doc = yamlLoad(readFileSync(presetPath, 'utf8')) as Array<{
    insert?: Array<{ config?: { plugins?: Array<{ id?: string; config?: { prefix?: string } }> } }>
  }>
  let prefix = ''
  for (const row of doc) {
    for (const item of row.insert ?? []) {
      for (const plugin of item.config?.plugins ?? []) {
        if (plugin.id === 'persona' && typeof plugin.config?.prefix === 'string') prefix = plugin.config.prefix
      }
    }
  }
  if (prefix === '') throw new Error('persona prefix not found in presets/pet-inner-voice.patch.yml')
  return `${readPersonaCard(home, 'whale598')}\n${prefix}`
}

// ── tool execution (shared by dry-run replay and model loop) ────────────────

export const executeTool = async (
  runtime: ScenarioRuntime,
  call: { tool: string; args?: Record<string, unknown> },
  step: number,
  setup = false,
): Promise<RecordedCall> => {
  const tool = runtime.tools.get(call.tool)
  if (tool === undefined) {
    return { tool: call.tool, args: call.args ?? {}, ok: false, error: `unknown tool "${call.tool}"`, step, ...(setup ? { setup: true } : {}) }
  }
  try {
    const result = await tool.execute(call.args ?? {}, runtime.exec)
    return { tool: call.tool, args: call.args ?? {}, ok: true, result: String(result), step, ...(setup ? { setup: true } : {}) }
  } catch (error: unknown) {
    return {
      tool: call.tool,
      args: call.args ?? {},
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      step,
      ...(setup ? { setup: true } : {}),
    }
  }
}

// ── dry-run: golden replay (no model) ───────────────────────────────────────

/** Runs the scenario's side-effect verification (null = pass). */
const runVerify = async (scenario: EvalScenario, runtime: ScenarioRuntime): Promise<string | null> => {
  if (scenario.verify === undefined) return null
  return await scenario.verify({
    mockState: runtime.mock.state,
    home: runtime.home,
  })
}

export async function replayIdeal(scenario: EvalScenario): Promise<ScenarioVerdict> {
  const runtime = await buildScenarioRuntime(scenario)
  try {
    const calls: RecordedCall[] = []
    for (const [index, item] of scenario.ideal.entries()) {
      const recorded = await executeTool(runtime, { tool: item.tool, ...(item.args !== undefined ? { args: item.args } : {}) }, index, item.setup === true)
      if (item.mistake === true) recorded.mistake = true
      calls.push(recorded)
    }
    const verdict = gradeScenario({ scenario, calls, now: Date.now(), mode: 'dry-run' })
    // Dry-run-only check: every deliberate mistake step must actually fail
    // the way the scenario claims — this is what pins the teaching errors.
    const failures = [...verdict.failures]
    let outcome = verdict.dimensions.outcome
    for (const [index, item] of scenario.ideal.entries()) {
      if (item.mistake !== true) continue
      const recorded = calls[index]
      const wanted = item.outcome ?? 'error'
      if (wanted === 'error' && recorded.ok) {
        failures.push(`dry-run mistake: ${item.tool} 应报错但成功了——刻意错误步的参数不再触发教学报错`)
        outcome = false
      } else if (wanted === 'ok' && !recorded.ok) {
        failures.push(`dry-run mistake: ${item.tool} 应成功但报错：${recorded.error ?? ''}`)
        outcome = false
      } else if (wanted === 'error' && !recorded.ok && item.errorMatches !== undefined
        && !(new RegExp(item.errorMatches)).test(recorded.error ?? '')) {
        failures.push(`dry-run mistake: ${item.tool} 报错文案不匹配 /${item.errorMatches}/，实际「${recorded.error ?? ''}」`)
        outcome = false
      }
    }
    const verifyFailure = await runVerify(scenario, runtime)
    if (verifyFailure !== null) failures.push(`verify: ${verifyFailure}`)
    const pass = verdict.pass && outcome && verifyFailure === null
    return {
      ...verdict,
      failures,
      dimensions: { ...verdict.dimensions, outcome },
      pass,
    }
  } finally {
    await runtime.dispose()
  }
}

// ── model run ───────────────────────────────────────────────────────────────

export interface ModelRunOptions {
  maxSteps?: number
  /** Per-call override surface for tests; defaults to fetch with retries. */
  llm?: LlmConfig
}

export async function runModelScenario(
  scenario: EvalScenario,
  config: LlmConfig,
  options: ModelRunOptions = {},
): Promise<ScenarioVerdict> {
  const runtime = await buildScenarioRuntime(scenario)
  const started = Date.now()
  try {
    const system = systemPromptFor(runtime.home)
    const user = await buildTurnPrompt(scenario, runtime)
    const descriptors = [...runtime.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, { type?: unknown; required?: unknown; description?: unknown }>,
    }))
    const wireTools = buildToolsForWire(descriptors)
    const messages: OpenAiMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
    const calls: RecordedCall[] = []
    let finalText: string | undefined
    const maxSteps = options.maxSteps ?? 6
    for (let step = 0; step < maxSteps; step++) {
      const turn = await chatCompletion(config, messages, wireTools)
      if (turn.rawError !== undefined) {
        finalText = `(模型调用失败: ${turn.rawError})`
        break
      }
      if (turn.toolCalls === undefined || turn.toolCalls.length === 0) {
        finalText = turn.text ?? ''
        break
      }
      messages.push({
        role: 'assistant',
        content: turn.text ?? '',
        tool_calls: turn.toolCalls.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.argsJson },
        })),
      })
      for (const call of turn.toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(call.argsJson)
          if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>
        } catch {
          // malformed JSON args: execute with empty args, the tool's own
          // validation is the graded behavior
        }
        const recorded = await executeTool(runtime, { tool: call.name, args }, step)
        calls.push(recorded)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: recorded.ok ? recorded.result ?? '' : `Error: ${recorded.error ?? ''}`,
        })
      }
    }
    const verdict = gradeScenario({ scenario, calls, ...(finalText !== undefined ? { finalText } : {}), now: Date.now(), durationMs: Date.now() - started })
    const verifyFailure = await runVerify(scenario, runtime)
    if (verifyFailure !== null) {
      verdict.failures.push(`verify: ${verifyFailure}`)
      verdict.pass = false
    }
    return verdict
  } finally {
    await runtime.dispose()
  }
}

export const mergedPlanOf = (at: number, intent: string): MergedWakePlan => ({ at, intent })
