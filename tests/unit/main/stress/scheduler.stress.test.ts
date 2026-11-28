import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Scheduler from '@main/scheduler'
import { listAgents } from '@main/agents'
import { listWorkspaces } from '@main/workspace'
import { bug } from './bug'

// Scheduler.check() runs an agent when a cron occurrence lies within 30 seconds of "now" on either
// side, and then re-arms a timer for the next minute boundary. Nothing remembers which occurrence
// was already served, so two wake-ups inside the same +/-30s window both run the agent. That happens
// whenever a wake-up lands before its minute boundary: Node timers do fire 1 ms early against the
// wall clock (measured on this machine: 4 of 400 timers aimed at a boundary), and a resume from
// sleep or a clock adjustment gives larger offsets.
//
// cron-parser is real. Timers and Date are faked, the agent executor base class is replaced by a
// stub and runAgent is spied on: no agent, model or network is involved.

vi.mock('@main/agents', () => ({ listAgents: vi.fn() }))
vi.mock('@main/workspace', () => ({ listWorkspaces: vi.fn() }))
vi.mock('@main/agent_utils', () => ({
  AgentExecutor: class {
    app: unknown
    constructor(app: unknown) { this.app = app }
    async runAgent(): Promise<unknown> { return null }
  },
}))

const kMinute = 60 * 1000

// local time on purpose: cron-parser evaluates expressions in the system time zone
const kDue = new Date(2026, 0, 15, 10, 3, 0, 0).getTime()

let runs: number[]

const newScheduler = (schedule: string): Scheduler => {
  vi.mocked(listWorkspaces).mockReturnValue([{ uuid: 'w1' }] as any)
  vi.mocked(listAgents).mockReturnValue([{ uuid: 'a1', name: 'agent', schedule, invocationValues: {} }] as any)
  const scheduler = new Scheduler({} as any, {} as any, {} as any)
  runs = []
  vi.spyOn(scheduler, 'runAgent').mockImplementation(async () => { runs.push(Date.now()); return null as any })
  return scheduler
}

// Arms the scheduler 10 seconds before kDue, then moves the wall clock by `offset` ms without
// touching the pending timer (what setSystemTime does), so that the wake-up aimed at kDue happens
// at wall time kDue + offset: negative is an early wake-up, positive a late one. Then lets the
// following two minutes of wake-ups happen and returns the wall times at which the agent was run.
const wakeAt = (schedule: string, offset: number): number[] => {
  const scheduler = newScheduler(schedule)
  vi.setSystemTime(kDue - 10 * 1000)
  scheduler.start()
  vi.setSystemTime(kDue - 10 * 1000 + offset)
  vi.advanceTimersByTime(10 * 1000)
  vi.advanceTimersByTime(2 * kMinute)
  vi.clearAllTimers()
  return runs
}

// number of runs attributed to each cron minute (a run belongs to the nearest minute boundary)
const runsPerMinute = (times: number[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const time of times) {
    const minute = new Date(Math.round(time / kMinute) * kMinute)
    const key = `${minute.getHours()}:${String(minute.getMinutes()).padStart(2, '0')}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

// small deterministic PRNG so a failing fuzz case can be reproduced from its seed
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scheduler: wake-ups exactly on the minute', () => {

  test('a daily schedule runs once, at its minute', () => {
    const scheduler = newScheduler('3 10 * * *')
    vi.setSystemTime(kDue - 3 * kMinute + 250)
    scheduler.start()
    vi.advanceTimersByTime(10 * kMinute)
    expect(runs).toEqual([kDue])
  })

  test('an every-minute schedule runs once per minute', () => {
    const scheduler = newScheduler('* * * * *')
    vi.setSystemTime(kDue - 20 * 1000)
    scheduler.start()
    vi.advanceTimersByTime(5 * kMinute)
    expect(runs).toEqual([0, 1, 2, 3, 4].map((i) => kDue + i * kMinute))
  })

  test('an agent without a schedule or with an invalid one never runs and does not stop the others', () => {
    const scheduler = newScheduler('3 10 * * *')
    vi.mocked(listAgents).mockReturnValue([
      { uuid: 'none', name: 'none', schedule: null },
      { uuid: 'bad', name: 'bad', schedule: 'not a cron expression' },
      { uuid: 'a1', name: 'agent', schedule: '3 10 * * *', invocationValues: {} },
    ] as any)
    vi.setSystemTime(kDue - 30 * 1000)
    scheduler.start()
    vi.advanceTimersByTime(2 * kMinute)
    expect(runs).toEqual([kDue])
    expect(vi.mocked(scheduler.runAgent).mock.calls[0][1].uuid).toBe('a1')
  })

})

describe('scheduler: wake-ups that miss the minute boundary', () => {

  test('seeded sweep: a late wake-up inside the tolerance window runs the occurrence exactly once', () => {
    const rand = mulberry32(0x5C4ED)
    const offsets = [0, 1, 999, 29999, ...Array.from({ length: 60 }, () => Math.floor(rand() * 30000))]
    for (const offset of offsets) {
      expect(wakeAt('3 10 * * *', offset), `seed 0x5C4ED: wake-up ${offset} ms late`).toHaveLength(1)
    }
  })

  bug('a wake-up 1 ms before the minute runs a daily agent once, not twice', () => {
    // fails today: the check at 10:02:59.999 runs it, re-arms for 1 ms later, and that check runs it again
    expect(wakeAt('3 10 * * *', -1)).toHaveLength(1)
  })

  bug('a wake-up 1 ms before the minute runs an every-minute agent once for that minute', () => {
    // fails today: the 10:03 occurrence is served by both the early check and the one on the boundary
    // (the two simulated minutes end at 10:04:59.999, so 10:03 and 10:04 are the only occurrences)
    expect(runsPerMinute(wakeAt('* * * * *', -1))).toEqual({ '10:03': 1, '10:04': 1 })
  })

  bug('a wake-up 15 s before the minute (resume from sleep) runs the agent once, not twice', () => {
    // fails today: 15 s early is inside the 30 s tolerance, and so is the re-armed check on the boundary
    expect(wakeAt('3 10 * * *', -15 * 1000)).toHaveLength(1)
  })

  bug('seeded sweep: an early wake-up inside the tolerance window runs the occurrence exactly once', () => {
    // fails today: every early offset in the window produces two runs of the same occurrence
    const rand = mulberry32(0x5C4ED)
    const offsets = [1, 2, 999, 1000, 29999, ...Array.from({ length: 60 }, () => 1 + Math.floor(rand() * 29999))]
    const doubled = offsets.filter((offset) => wakeAt('3 10 * * *', -offset).length !== 1)
    expect(doubled.length, `seed 0x5C4ED: ${doubled.length} of ${offsets.length} early wake-ups ran the agent more than once, first ${doubled[0]} ms early`).toBe(0)
  })

})

describe('scheduler: timer handle and failures', () => {

  bug('stop() cancels the pending wake-up', () => {
    // fails today: start() never stores the setTimeout handle, so stop() clears nothing
    const scheduler = newScheduler('3 10 * * *')
    vi.setSystemTime(kDue - 10 * 1000)
    scheduler.start()
    scheduler.stop()
    vi.advanceTimersByTime(30 * 1000)
    expect(runs).toHaveLength(0)
  })

  bug('calling start() twice does not run every occurrence twice', () => {
    // fails today: same cause, the first timer survives and both chains keep re-arming themselves
    const scheduler = newScheduler('3 10 * * *')
    vi.setSystemTime(kDue - 10 * 1000)
    scheduler.start()
    scheduler.start()
    vi.advanceTimersByTime(30 * 1000)
    expect(runs).toHaveLength(1)
  })

  bug('a rejected agent run has a rejection handler attached', () => {
    // fails today: runAgent is called without await inside try/catch, so the catch can never see the
    // rejection and it surfaces as an unhandled promise rejection in the main process
    const scheduler = newScheduler('3 10 * * *')
    const run: any = { handled: false }
    const reject = (onRejected: any) => {
      if (typeof onRejected === 'function') { run.handled = true; onRejected(new Error('agent failed')) }
      return run
    }
    run.then = vi.fn((_: any, onRejected: any) => reject(onRejected))
    run.catch = vi.fn((onRejected: any) => reject(onRejected))
    vi.mocked(scheduler.runAgent).mockReturnValue(run)

    vi.setSystemTime(kDue - 10 * 1000)
    scheduler.start()
    vi.advanceTimersByTime(10 * 1000)
    expect(scheduler.runAgent).toHaveBeenCalledTimes(1)
    expect(run.handled, 'the promise returned by runAgent was dropped without a rejection handler').toBe(true)
  })

})
