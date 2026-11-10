import { describe, expect, it } from 'vitest'
import {
  classifyAttachFailure,
  isPetPreset,
  isPetWorkspace,
  patchTouchesElectronBinding,
  sessionOccupiedBy,
} from '../src/binding.ts'

describe('classifyAttachFailure', () => {
  it('maps the host cwd-mismatch rejection to a stable code and keeps the actual cwd', () => {
    const result = classifyAttachFailure(
      "cannot attach session 'session-1' to workspace 'C:\\Users\\me\\whale598': "
      + "its cwd resolves to 'C:\\Users\\me\\other-project'",
    )
    expect(result).toEqual({
      errorCode: 'cwd-mismatch',
      actualCwd: 'C:\\Users\\me\\other-project',
    })
  })

  it('maps a missing session', () => {
    expect(classifyAttachFailure("cannot attach session 'x': no such session").errorCode)
      .toBe('session-missing')
  })

  it('maps missing cwd / unresolvable cwd / non-directory to attach-failed', () => {
    expect(classifyAttachFailure('its stored header carries no cwd to validate against').errorCode)
      .toBe('attach-failed')
    expect(classifyAttachFailure("its cwd 'C:\\gone' does not resolve").errorCode)
      .toBe('attach-failed')
    expect(classifyAttachFailure('its cwd is not a directory').errorCode)
      .toBe('attach-failed')
  })

  it('falls back to attach-failed for unknown host messages', () => {
    expect(classifyAttachFailure('boom')).toEqual({ errorCode: 'attach-failed', actualCwd: null })
  })
})

describe('isPetPreset', () => {
  it('accepts the pet presets, their legacy ids, and the custom clones', () => {
    expect(isPetPreset('whale598')).toBe(true)
    expect(isPetPreset('whale598-standard')).toBe(true)
    expect(isPetPreset('pet-inner-voice')).toBe(true)
    expect(isPetPreset('pet')).toBe(true)
    expect(isPetPreset('whale598-custom-1')).toBe(true)
    expect(isPetPreset('whale598-custom-2')).toBe(true)
  })

  it('rejects a standard session (current-mode check, not the stale header)', () => {
    expect(isPetPreset('standard')).toBe(false)
    expect(isPetPreset('minimal')).toBe(false)
  })

  it('treats an unknown preset as unknown, not a pet preset', () => {
    expect(isPetPreset(undefined)).toBe(false)
    expect(isPetPreset(null)).toBe(false)
    expect(isPetPreset('')).toBe(false)
  })
})

describe('patchTouchesElectronBinding', () => {
  it('is true only when the patch edits innerVoice.boundSessions.electron', () => {
    expect(patchTouchesElectronBinding({
      innerVoice: { boundSessions: { electron: 'session-1' } },
    })).toBe(true)
  })

  it('is false for unrelated settings and for other pets', () => {
    expect(patchTouchesElectronBinding({
      innerVoice: { wakeIntervalMinutes: 30 },
    })).toBe(false)
    expect(patchTouchesElectronBinding({
      innerVoice: { boundSessions: { pure: 'session-pure' } },
    })).toBe(false)
    expect(patchTouchesElectronBinding({
      innerVoice: { boundSessions: {} },
    })).toBe(false)
    expect(patchTouchesElectronBinding({ tts: { enabled: true } })).toBe(false)
    expect(patchTouchesElectronBinding({})).toBe(false)
  })
})

describe('isPetWorkspace', () => {
  const root = 'C:\\Users\\me\\whale598'

  it('accepts only the workspace path itself, case-insensitively', () => {
    expect(isPetWorkspace('C:\\Users\\me\\whale598', root)).toBe(true)
    expect(isPetWorkspace('c:/users/me/whale598/', root)).toBe(true)
  })

  it('rejects descendants, siblings, and missing cwd', () => {
    expect(isPetWorkspace('C:\\Users\\me\\whale598\\sub', root)).toBe(false)
    expect(isPetWorkspace('C:\\Users\\me\\whale598-other', root)).toBe(false)
    expect(isPetWorkspace('C:\\Users\\me\\other', root)).toBe(false)
    expect(isPetWorkspace(undefined, root)).toBe(false)
  })
})

describe('sessionOccupiedBy (防呆：一只宠物一个脑子)', () => {
  const bound = { electron: 'session-e', 'electron-2': 'session-e2' }
  const store = { pure: { sessionId: 'session-pure' } }

  it('returns the other pet when the session is in its configured binding', () => {
    expect(sessionOccupiedBy('session-e', 'electron-2', bound, store)).toBe('electron')
    expect(sessionOccupiedBy('session-e2', 'electron', bound, store)).toBe('electron-2')
  })

  it('returns the other pet when the session is its durable store session', () => {
    expect(sessionOccupiedBy('session-pure', 'electron', bound, store)).toBe('pure')
  })

  it('is silent for the pet itself and for free sessions', () => {
    expect(sessionOccupiedBy('session-e', 'electron', bound, store)).toBeUndefined()
    expect(sessionOccupiedBy('session-free', 'electron-2', bound, store)).toBeUndefined()
  })

  it('config claim wins over a stale store entry', () => {
    const conflicting = { ...bound, pure: 'session-e' }
    expect(sessionOccupiedBy('session-e', 'pure', conflicting, store)).toBe('electron')
  })
})
