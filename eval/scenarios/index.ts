/**
 * The scenario dataset index. Each module exports an EvalScenario[]; this
 * file is the single aggregation point (uniqueness is enforced in the
 * dry-run spec).
 * @module dsh-agentic-pet/eval/scenarios/index
 */

import type { EvalScenario } from '../schema.ts'
import say from './say.ts'
import doScenarios from './do.ts'
import stateExpress from './state-express.ts'
import digest from './digest.ts'
import journal from './journal.ts'
import recall from './recall.ts'
import interactionsAffection from './interactions-affection.ts'
import scheduleWake from './schedule-wake.ts'
import setRhythm from './set-rhythm.ts'
import letterInboxBoard from './letter-inbox-board.ts'
import multipet from './multipet.ts'
import turns from './turns.ts'

export const allScenarios = (): EvalScenario[] => [
  ...say,
  ...doScenarios,
  ...stateExpress,
  ...digest,
  ...journal,
  ...recall,
  ...interactionsAffection,
  ...scheduleWake,
  ...setRhythm,
  ...letterInboxBoard,
  ...multipet,
  ...turns,
]
