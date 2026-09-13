// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import { killProcessTree, listDescendantsDeepestFirst, parseProcessTable, ProcessEntry, ProcessSystem } from '../../src/lifecycle/ProcessTree'

// `ps -A -o pid=,ppid=,stat=` on Linux while the language server started R2026a, trimmed to
// the MATLAB tree and its neighbours. 3932576 is the launcher, 3932913 the MATLAB it starts,
// 3933400 MATLABWindow with its helpers, and 3932716 a crash monitor that detached itself.
const RECORDED_PS = [
    '      1       0 Ss',
    '      2       0 S',
    '  32218       1 Ss',
    '3932557 3929397 Sl+',
    '3932564 3932557 Sl+',
    '3932576 3932564 Sl+',
    '3932716   32218 Ssl',
    '3932729 3932576 Sl+',
    '3932913 3932576 Sl+',
    '3933232 3932913 Sl+',
    '3933400 3932576 Sl',
    '3933409 3933400 S',
    '3933410 3933400 S',
    '3933450 3933400 Sl',
    '3933455 3933410 Sl',
    '3933522 3933410 Sl',
    '3933524 3933410 Sl',
    '3933541 3933409 Sl',
    '3934739 3934736 R',
    ''
].join('\n')

const LAUNCHER = 3932576

// The launcher's descendants: three levels, deepest first, each level in table order
const EXPECTED_DEEPEST_FIRST = [
    3933541, 3933455, 3933522, 3933524,
    3933232, 3933409, 3933410, 3933450,
    3932729, 3932913, 3933400
]

/**
 * A process table that answers ps and signals as the kernel would: SIGSTOP stops a process,
 * SIGKILL removes it, and a signal to a process that is gone throws.
 */
class FakeSystem implements ProcessSystem {
    platform: NodeJS.Platform = 'linux'
    readonly signals: Array<[number, NodeJS.Signals]> = []
    readonly runs: Array<[string, string[]]> = []
    listings = 0
    // Called with the listing number before ps prints the table
    beforeListing: (listing: number) => void = () => {}
    // Called before a signal takes effect
    beforeSignal: (pid: number, signal: NodeJS.Signals) => void = () => {}
    // Processes that stay running for one more listing after SIGSTOP
    readonly slowToStop = new Set<number>()
    private readonly pendingStops = new Set<number>()

    constructor (public table: ProcessEntry[]) {}

    run (file: string, args: string[]): string {
        this.runs.push([file, args])
        this.listings++
        this.beforeListing(this.listings)
        const output = this.table.map(entry => `${entry.pid} ${entry.ppid} ${entry.state}`).join('\n')
        // A stop that was pending when this listing was taken lands afterwards
        for (const pid of this.pendingStops) {
            const entry = this.table.find(e => e.pid === pid)
            if (entry != null) entry.state = 'T'
        }
        this.pendingStops.clear()
        return output
    }

    kill (pid: number, signal: NodeJS.Signals): void {
        this.beforeSignal(pid, signal)
        const entry = this.table.find(e => e.pid === pid)
        if (entry == null) {
            throw new Error(`kill ESRCH ${pid}`)
        }
        this.signals.push([pid, signal])
        if (signal === 'SIGSTOP') {
            if (this.slowToStop.has(pid)) {
                this.slowToStop.delete(pid)
                this.pendingStops.add(pid)
            } else {
                entry.state = 'T'
            }
        } else if (signal === 'SIGKILL') {
            this.table = this.table.filter(e => e.pid !== pid)
        }
    }

    killed (): number[] {
        return this.signals.filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid)
    }

    stopped (): number[] {
        return this.signals.filter(([, signal]) => signal === 'SIGSTOP').map(([pid]) => pid)
    }
}

describe('ProcessTree', () => {
    describe('parseProcessTable', () => {
        it('should read the pid, parent pid and state of every row of recorded ps output', () => {
            const entries = parseProcessTable(RECORDED_PS)

            assert.strictEqual(entries.length, 19)
            assert.deepStrictEqual(entries[0], { pid: 1, ppid: 0, state: 'Ss' })
            assert.deepStrictEqual(entries.find(e => e.pid === 3933541), { pid: 3933541, ppid: 3933409, state: 'Sl' })
            assert.deepStrictEqual(entries.find(e => e.pid === 3932729), { pid: 3932729, ppid: 3932576, state: 'Sl+' })
        })

        it('should skip headers, blank lines and rows that are not numbers, and accept CRLF', () => {
            const entries = parseProcessTable('  PID  PPID STAT\r\n\r\n  12    1 S\r\nabc 1 S\r\npid 16 12 S\r\n 13 x S\r\n 14 12\r\n   15   12 Z\r\n')

            assert.deepStrictEqual(entries, [
                { pid: 12, ppid: 1, state: 'S' },
                { pid: 15, ppid: 12, state: 'Z' }
            ])
        })
    })

    describe('listDescendantsDeepestFirst', () => {
        it('should list the launcher\'s descendants over three levels, deepest first', () => {
            const order = listDescendantsDeepestFirst(parseProcessTable(RECORDED_PS), LAUNCHER)

            assert.deepStrictEqual(order, EXPECTED_DEEPEST_FIRST)
        })

        it('should list every process before its parent, and nothing outside the tree', () => {
            const entries = parseProcessTable(RECORDED_PS)
            const order = listDescendantsDeepestFirst(entries, LAUNCHER)

            for (const pid of order) {
                const parent = entries.find(e => e.pid === pid)?.ppid as number
                if (parent !== LAUNCHER) {
                    assert.ok(order.indexOf(pid) < order.indexOf(parent), `${pid} comes after its parent ${parent}`)
                }
            }
            for (const outside of [LAUNCHER, 3932564, 3932716, 1, 32218, 3934739]) {
                assert.ok(!order.includes(outside), `${outside} is not below the launcher`)
            }
        })

        it('should list nothing for a process without children or one that is not in the table', () => {
            const entries = parseProcessTable(RECORDED_PS)

            assert.deepStrictEqual(listDescendantsDeepestFirst(entries, 3933541), [])
            assert.deepStrictEqual(listDescendantsDeepestFirst(entries, 999), [])
        })

        it('should end on a table whose parent links form a loop', () => {
            const entries = parseProcessTable('0 0 S\n5 6 S\n6 5 S\n7 5 S\n')

            assert.deepStrictEqual(listDescendantsDeepestFirst(entries, 0), [])
            assert.deepStrictEqual(listDescendantsDeepestFirst(entries, 5), [6, 7])
        })
    })

    describe('killProcessTree on Linux and macOS', () => {
        it('should freeze the tree, then kill each process before its parent and the launcher last', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))

            killProcessTree(LAUNCHER, system)

            assert.deepStrictEqual(system.killed(), [...EXPECTED_DEEPEST_FIRST, LAUNCHER])
            const firstKill = system.signals.findIndex(([, signal]) => signal === 'SIGKILL')
            const stoppedBeforeKilling = system.signals.slice(0, firstKill).map(([pid]) => pid)
            const ascending = (a: number, b: number): number => a - b
            assert.deepStrictEqual(stoppedBeforeKilling.slice().sort(ascending), [...EXPECTED_DEEPEST_FIRST, LAUNCHER].sort(ascending))
            assert.strictEqual(stoppedBeforeKilling[0], LAUNCHER, 'the launcher is frozen before the tree is listed')
            assert.ok(system.signals.every(([pid]) => pid === LAUNCHER || EXPECTED_DEEPEST_FIRST.includes(pid)), 'nothing outside the tree is signalled')
            assert.deepStrictEqual(system.runs[0], ['ps', ['-A', '-o', 'pid=,ppid=,stat=']])
            assert.strictEqual(system.listings, 2, 'a tree that stops at once is listed to freeze it, then once to see it stopped')
        })

        it('should kill a frozen process that a later listing no longer shows below the launcher', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))
            // The network helper is reparented before the second listing, as if its parent had exited
            system.beforeListing = listing => {
                const helper = system.table.find(e => e.pid === 3933450)
                if (listing === 2 && helper != null) {
                    helper.ppid = 1
                }
            }

            killProcessTree(LAUNCHER, system)

            const killed = system.killed()
            assert.ok(killed.includes(3933450), JSON.stringify(system.signals))
            assert.strictEqual(killed[killed.length - 1], LAUNCHER)
        })

        it('should freeze each parent before its children', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))

            killProcessTree(LAUNCHER, system)

            const stops = system.stopped()
            const entries = parseProcessTable(RECORDED_PS)
            for (const pid of EXPECTED_DEEPEST_FIRST) {
                const parent = entries.find(e => e.pid === pid)?.ppid as number
                assert.ok(stops.indexOf(parent) < stops.indexOf(pid), `${parent} is frozen before its child ${pid}`)
            }
        })

        it('should kill a process that a parent started while the tree was being frozen', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))
            // MATLAB forks just before the SIGSTOP reaches it
            system.beforeSignal = (pid, signal) => {
                if (pid === 3932913 && signal === 'SIGSTOP' && !system.table.some(e => e.pid === 3999001)) {
                    system.table.push({ pid: 3999001, ppid: 3932913, state: 'R' })
                }
            }

            killProcessTree(LAUNCHER, system)

            const killed = system.killed()
            assert.ok(killed.includes(3999001), 'the late child is killed')
            assert.ok(killed.indexOf(3999001) < killed.indexOf(3932913), 'before its parent')
            assert.strictEqual(system.table.length, parseProcessTable(RECORDED_PS).length - EXPECTED_DEEPEST_FIRST.length - 1)
        })

        it('should list again until a signalled process has stopped, and kill what it started meanwhile', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))
            // mwdocsearch is still running at the next listing, and starts a child before it stops
            system.slowToStop.add(3933232)
            system.beforeListing = listing => {
                if (listing === 3) {
                    system.table.push({ pid: 3999002, ppid: 3933232, state: 'S' })
                }
            }

            killProcessTree(LAUNCHER, system)

            assert.ok(system.killed().includes(3999002), `the child started before the stop is killed: ${JSON.stringify(system.signals)}`)
            assert.ok(system.listings >= 4)
        })

        it('should kill the launcher alone when ps cannot run', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))
            system.run = () => { throw new Error('spawnSync ps ENOENT') }

            killProcessTree(LAUNCHER, system)

            assert.deepStrictEqual(system.signals, [[LAUNCHER, 'SIGSTOP'], [LAUNCHER, 'SIGKILL']])
        })

        it('should stop listing a tree that keeps growing, and still kill all of it', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))
            let next = 3999100
            system.beforeListing = () => {
                system.table.push({ pid: next, ppid: 3932913, state: 'R' })
                next++
            }

            killProcessTree(LAUNCHER, system)

            assert.strictEqual(system.listings, 10)
            // Each child was started before a listing, so the last listing has them all
            assert.deepStrictEqual(system.table.filter(e => e.ppid === 3932913), [])
            assert.strictEqual(system.killed().filter(pid => pid >= 3999100).length, 10)
            assert.ok(!system.table.some(e => e.pid === LAUNCHER || EXPECTED_DEEPEST_FIRST.includes(e.pid)))
        })

        it('should go on killing when a process exits before its signal', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))
            system.beforeSignal = (pid, signal) => {
                if (pid === 3933400 && signal === 'SIGKILL') {
                    system.table = system.table.filter(e => e.pid !== 3933400)
                }
            }

            killProcessTree(LAUNCHER, system)

            assert.deepStrictEqual(system.killed(), [...EXPECTED_DEEPEST_FIRST.filter(pid => pid !== 3933400), LAUNCHER])
        })
    })

    describe('killProcessTree on Windows', () => {
        it('should run taskkill for the launcher\'s tree, without a shell, ps or signals', () => {
            const system = new FakeSystem(parseProcessTable(RECORDED_PS))
            system.platform = 'win32'

            killProcessTree(4242, system)

            assert.deepStrictEqual(system.runs, [['taskkill', ['/PID', '4242', '/T', '/F']]])
            assert.deepStrictEqual(system.signals, [])
        })

        it('should not throw when taskkill fails', () => {
            const system = new FakeSystem([])
            system.platform = 'win32'
            system.run = () => { throw new Error('Command failed: taskkill /PID 4242 /T /F') }

            assert.doesNotThrow(() => killProcessTree(4242, system))
        })
    })
})
