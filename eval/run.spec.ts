/**
 * The real model run: executes the scenario set against a live
 * OpenAI-compatible endpoint and grades every turn deterministically.
 * Skipped entirely unless PET_EVAL_BASE_URL / PET_EVAL_API_KEY /
 * PET_EVAL_MODEL are all set (the dry run in dryrun.spec.ts is the
 * no-network counterpart and always runs).
 *
 * Env knobs:
 *   PET_EVAL_BASE_URL / PET_EVAL_API_KEY / PET_EVAL_MODEL  (required)
 *   PET_EVAL_FILTER       substring match on scenario id or family
 *   PET_EVAL_CONCURRENCY  parallel scenarios (default 2)
 *   PET_EVAL_TEMPERATURE  sampling temperature (default 0.2)
 *   PET_EVAL_MAX_STEPS    tool-loop budget per scenario (default 6)
 *   PET_EVAL_OUT          report directory (default eval/report)
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, describe } from 'vitest'
import { evalConfigFromEnv, type LlmConfig } from './llm-client.ts'
import { runModelScenario } from './harness.ts'
import { renderMarkdownSummary, summarize } from './grader.ts'
import { allScenarios } from './scenarios/index.ts'
import type { EvalScenario, ScenarioVerdict } from './schema.ts'

const config = evalConfigFromEnv()
const filter = process.env.PET_EVAL_FILTER ?? ''
const concurrency = Math.max(1, Number(process.env.PET_EVAL_CONCURRENCY ?? '2') || 2)
const maxSteps = Math.max(1, Number(process.env.PET_EVAL_MAX_STEPS ?? '6') || 6)
const outDir = resolve(process.env.PET_EVAL_OUT ?? join('eval', 'report'))

const selected = (): EvalScenario[] => {
  const scenarios = allScenarios()
  if (filter === '') return scenarios
  return scenarios.filter(scenario => scenario.id.includes(filter) || scenario.family.includes(filter))
}

// Run scenarios through a small promise pool; vitest's per-test it() blocks
// are the unit of reporting (one failing scenario must not hide the rest).
describe.skipIf(config === null)('pet tool-call eval (model run)', () => {
  const verdicts: ScenarioVerdict[] = []
  const scenarios = selected()

  it('runs every selected scenario and writes a report', { timeout: scenarios.length * 180_000 }, async () => {
    expect(config).not.toBeNull()
    const llm = config as LlmConfig
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < scenarios.length) {
        const scenario = scenarios[cursor]
        cursor += 1
        const verdict = await runModelScenario(scenario, llm, { maxSteps })
        verdicts.push(verdict)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, worker))

    const report = summarize(verdicts, scenarios, 'model', llm.model)
    await mkdir(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(outDir, `run-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await writeFile(join(outDir, `summary-${stamp}.md`), `${renderMarkdownSummary(report)}\n`, 'utf8')
    // The console summary is what a human reads first.
    console.log(renderMarkdownSummary(report))
    expect(verdicts.length, 'every selected scenario must produce a verdict').toBe(scenarios.length)
    expect(report.summary.passed, `通过 ${String(report.summary.passed)}/${String(report.summary.total)}（详见 ${outDir}）`).toBe(report.summary.total)
  })
})
