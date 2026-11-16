/**
 * The dry run: dataset integrity + golden replay, NO model and NO network.
 * Every scenario's `ideal` call sequence is executed through the REAL
 * registerPetTools against the mock pet and a temp home, then graded — a
 * green run proves the dataset is achievable and the teaching errors fire
 * as claimed. Runs as part of the ordinary vitest suite.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { allScenarios } from './scenarios/index.ts'
import { buildScenarioRuntime, buildTurnPrompt, replayIdeal } from './harness.ts'
import { renderMarkdownSummary, summarize } from './grader.ts'
import type { ScenarioVerdict } from './schema.ts'

// The dry run also leaves a report on disk (eval/report/) so the golden
// replay's green bar is auditable without re-running.
const dryrunVerdicts: ScenarioVerdict[] = []
afterAll(async () => {
  if (dryrunVerdicts.length === 0) return
  const report = summarize(dryrunVerdicts, allScenarios(), 'dry-run')
  const outDir = resolve(process.env.PET_EVAL_OUT ?? join('eval', 'report'))
  await mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await writeFile(join(outDir, `run-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(join(outDir, `summary-${stamp}.md`), `${renderMarkdownSummary(report)}\n`, 'utf8')
})

describe('eval dataset integrity', () => {
  const scenarios = allScenarios()

  it('scenario ids are unique', () => {
    const ids = scenarios.map(scenario => scenario.id)
    expect(new Set(ids).size, `duplicated ids: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(', ')}`).toBe(ids.length)
  })

  it('every ideal sequence is non-empty and names registered tools', () => {
    const known = new Set(['pet_say', 'pet_inbox', 'pet_board', 'pet_do', 'pet_express', 'pet_digest', 'pet_journal', 'pet_recall', 'pet_interactions', 'pet_affection', 'pet_schedule_wake', 'pet_set_rhythm', 'pet_leave_letter', 'pet_state'])
    for (const scenario of scenarios) {
      expect(scenario.ideal.length, `${scenario.id}: ideal is empty`).toBeGreaterThan(0)
      for (const item of scenario.ideal) {
        expect(known.has(item.tool), `${scenario.id}: unknown tool ${item.tool}`).toBe(true)
      }
    }
  })

  it('every scenario materializes a seed and builds a prompt', async () => {
    for (const scenario of scenarios) {
      const runtime = await buildScenarioRuntime(scenario)
      try {
        const prompt = await buildTurnPrompt(scenario, runtime)
        expect(prompt.length, `${scenario.id}: empty prompt`).toBeGreaterThan(0)
      } finally {
        await runtime.dispose()
      }
    }
  })
})

describe('eval dry-run (golden replay through the real tools)', () => {
  for (const scenario of allScenarios()) {
    it(`replay ${scenario.id} — ${scenario.title}`, async () => {
      const verdict = await replayIdeal(scenario)
      dryrunVerdicts.push(verdict)
      if (!verdict.pass) {
        expect.fail(`${scenario.id} 干跑失败:\n${verdict.failures.map(failure => `  - ${failure}`).join('\n')}`)
      }
      expect(verdict.pass).toBe(true)
    })
  }
})
