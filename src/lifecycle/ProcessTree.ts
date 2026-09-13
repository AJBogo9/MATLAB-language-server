// Copyright 2026 Andreas Bogossian

import { execFileSync } from 'child_process'
import * as os from 'os'

import Logger from '../logging/Logger'

/**
 * A row of the process table
 */
export interface ProcessEntry {
    pid: number
    ppid: number
    // The state ps reports, such as S when sleeping, T when stopped or Z for a zombie
    state: string
}

/**
 * What killing a process tree needs from the operating system. Tests pass their own.
 */
export interface ProcessSystem {
    platform: NodeJS.Platform

    /**
     * Runs a program without a shell and returns its output. Throws when it fails.
     */
    run: (file: string, args: string[]) => string

    /**
     * Sends a signal to a process. Throws when there is no such process.
     */
    kill: (pid: number, signal: NodeJS.Signals) => void
}

const nodeSystem: ProcessSystem = {
    platform: os.platform(),
    run: (file, args) => execFileSync(file, args, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
    }),
    kill: (pid, signal) => {
        process.kill(pid, signal)
    }
}

// A tree that keeps changing is killed as last listed after this many listings
const MAX_LISTINGS = 10

/**
 * Parses the output of `ps -A -o pid=,ppid=,stat=`, skipping lines that do not fit.
 *
 * @param output What ps printed
 * @returns The processes
 */
export function parseProcessTable (output: string): ProcessEntry[] {
    const entries: ProcessEntry[] = []
    for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
        if (match != null) {
            entries.push({ pid: Number(match[1]), ppid: Number(match[2]), state: match[3] })
        }
    }
    return entries
}

/**
 * Lists the descendants of a process, deepest first, so that every process comes before
 * its parent.
 *
 * @param entries The process table
 * @param rootPid The process whose descendants are listed. It is not listed itself.
 * @returns The process IDs of the descendants
 */
export function listDescendantsDeepestFirst (entries: ProcessEntry[], rootPid: number): number[] {
    const childrenOf = new Map<number, number[]>()
    for (const { pid, ppid } of entries) {
        const children = childrenOf.get(ppid) ?? []
        children.push(pid)
        childrenOf.set(ppid, children)
    }

    const levels: number[][] = []
    const seen = new Set<number>([rootPid])
    let frontier = [rootPid]
    while (frontier.length > 0) {
        const level: number[] = []
        for (const parent of frontier) {
            for (const child of childrenOf.get(parent) ?? []) {
                if (!seen.has(child)) {
                    seen.add(child)
                    level.push(child)
                }
            }
        }
        levels.unshift(level)
        frontier = level
    }

    return ([] as number[]).concat(...levels)
}

/**
 * Kills a process and every process below it. It runs synchronously, so it is done before
 * the language server can exit.
 *
 * On Linux and macOS the tree is first frozen with SIGSTOP, parents before children, and
 * listed again until every process in it has stopped: a stopped process cannot start one
 * that the listing would miss. The frozen tree is then killed with SIGKILL, deepest first.
 * On Windows, taskkill kills the tree.
 *
 * @param rootPid The process at the top of the tree
 * @param system The operating system calls
 */
export function killProcessTree (rootPid: number, system: ProcessSystem = nodeSystem): void {
    if (system.platform === 'win32') {
        try {
            system.run('taskkill', ['/PID', String(rootPid), '/T', '/F'])
        } catch (err) {
            Logger.warn(`Unable to kill the MATLAB process tree: ${errorMessage(err)}`)
        }
        return
    }

    const signal = (pid: number, name: NodeJS.Signals): void => {
        try {
            system.kill(pid, name)
        } catch {
            // The process has already exited
        }
    }

    signal(rootPid, 'SIGSTOP')
    const frozen = new Set<number>([rootPid])
    let tree: number[] = []
    for (let listing = 0; listing < MAX_LISTINGS; listing++) {
        let entries: ProcessEntry[]
        try {
            entries = parseProcessTable(system.run('ps', ['-A', '-o', 'pid=,ppid=,stat=']))
        } catch (err) {
            Logger.warn(`Unable to list the MATLAB process tree: ${errorMessage(err)}`)
            break
        }
        tree = listDescendantsDeepestFirst(entries, rootPid)

        for (const pid of tree.slice().reverse()) {
            if (!frozen.has(pid)) {
                signal(pid, 'SIGSTOP')
                frozen.add(pid)
            }
        }
        // Done once the listing shows every frozen process stopped. A process frozen in this
        // pass was listed before its SIGSTOP, and until one lands the process can start another.
        const running = entries.filter(entry => frozen.has(entry.pid) && !/^[TtZX]/.test(entry.state))
        if (running.length === 0) {
            break
        }
    }

    const order = tree.concat(Array.from(frozen).filter(pid => pid !== rootPid && !tree.includes(pid)), rootPid)
    for (const pid of order) {
        signal(pid, 'SIGKILL')
    }
}

function errorMessage (err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
