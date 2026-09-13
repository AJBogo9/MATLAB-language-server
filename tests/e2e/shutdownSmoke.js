// Copyright 2026 Andreas Bogossian
/**
 * End-to-end check that no MATLAB process outlives the language server when it shuts down.
 * Spawns the real language server over stdio against a live MATLAB install, in a session of
 * its own, and shuts it down (a shutdown request, then exit) in three states:
 *
 *   launcher   as soon as a MATLAB process appears below the server, while the launcher
 *              script still runs
 *   starting   once MATLAB has started processes of its own, before it connects
 *   connected  once MATLAB reports connected
 *
 * Every process seen below the server until the shutdown is recorded. A MATLAB that has not
 * connected is killed as the server shuts down, so none of them may run 1 s after the server
 * exited. A connected MATLAB is asked to exit, as before. 20 s after the server exited, in
 * every state, none of them may still run, nor anything else in the server's session, such
 * as a process started after the last look or a crash reporter. Survivors are then killed
 * with SIGKILL, with their descendants, so that a failing run leaks no MATLAB.
 *
 * Before the fix, a shutdown while MATLAB started did nothing: the lifecycle manager held no
 * session until MATLAB connected. MATLAB kept starting after the server exited, and either
 * exited by itself seconds later or kept running, on R2026a with a CrashReporter beside it.
 *
 * Linux only (ps etimes). Usage:
 *   node shutdownSmoke.js [--matlabRoot=/path/to/MATLAB] [--server=/path/to/index.js] [--scenarios=launcher,starting,connected]
 */
'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const REPO = path.resolve(__dirname, '..', '..', '..')
const argValue = name => {
    const arg = process.argv.find(a => a.startsWith(`--${name}=`))
    return arg === undefined ? undefined : arg.slice(name.length + 3)
}
const SERVER = argValue('server') ?? path.join(REPO, 'server', 'out', 'index.js')
const MATLAB_INSTALL_PATH = argValue('matlabRoot') ?? '/usr/local/MATLAB/R2026a'
const SCENARIOS = (argValue('scenarios') ?? 'launcher,starting,connected').split(',')
const HARD_TIMEOUT_MS = 10 * 60 * 1000
const SURVIVAL_WAIT_MS = 20000
// A MATLAB that has not connected is killed as the server shuts down, so it is gone by then
const PROMPT_WAIT_MS = 1000
const POLL_MS = 25

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shutdownSmoke-')))
const t0 = Date.now()
const seconds = (from = t0) => ((Date.now() - from) / 1000).toFixed(1) + ' s'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
function check (name, condition, detail) {
    results.push({ name, ok: Boolean(condition) })
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

/** The process table, with an approximate start time that tells a reused pid apart */
function processTable () {
    const now = Date.now() / 1000
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,sid=,stat=,etimes=,comm='], { encoding: 'utf8' })
        .trim().split('\n')
        .map(line => line.trim().split(/\s+/))
        .map(([pid, ppid, sid, stat, etimes, ...comm]) => ({
            pid: Number(pid),
            ppid: Number(ppid),
            sid: Number(sid),
            stat,
            started: Math.round(now - Number(etimes)),
            comm: comm.join(' ')
        }))
}

function descendantsOf (rows, rootPid) {
    const levels = []
    let frontier = [rootPid]
    while (frontier.length > 0) {
        const children = rows.filter(row => frontier.includes(row.ppid) && row.pid !== rootPid)
        if (children.length > 0) levels.push(children)
        frontier = children.map(row => row.pid)
    }
    return levels.reverse().flat()
}

const isLive = row => !/^[ZX]/.test(row.stat)
const sameProcess = (a, b) => a.pid === b.pid && Math.abs(a.started - b.started) <= 2
const label = row => `${row.comm}(${row.pid})`

/** Spawns the language server and speaks LSP to it over stdio */
function startServer (workspace) {
    const child = spawn('node', [SERVER, '--stdio', `--matlabInstallPath=${MATLAB_INSTALL_PATH}`, '--matlabConnectionTiming=onStart'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
    })

    let buffer = Buffer.alloc(0)
    const pending = new Map()
    const notifications = []
    let nextId = 1

    const send = message => {
        const json = JSON.stringify(message)
        child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
    }

    child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
            const headerEnd = buffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            const lengthMatch = /Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd).toString('ascii'))
            if (lengthMatch === null) return
            const bodyStart = headerEnd + 4
            const length = parseInt(lengthMatch[1], 10)
            if (buffer.length < bodyStart + length) return
            const message = JSON.parse(buffer.slice(bodyStart, bodyStart + length).toString('utf8'))
            buffer = buffer.slice(bodyStart + length)

            if (message.id !== undefined && message.method === undefined && pending.has(message.id)) {
                pending.get(message.id)(message)
                pending.delete(message.id)
            } else if (message.id === undefined && message.method !== undefined) {
                notifications.push({ at: Date.now(), ...message })
            } else if (message.id !== undefined && message.method !== undefined) {
                let result = null
                if (message.method === 'workspace/configuration') {
                    result = (message.params.items || []).map(item => item.section === 'MATLAB' || item.section === undefined
                        ? {
                            installPath: MATLAB_INSTALL_PATH,
                            matlabConnectionTiming: 'onStart',
                            indexWorkspace: false,
                            telemetry: false,
                            maxFileSizeForAnalysis: 0,
                            signIn: false,
                            prewarmGraphics: false,
                            defaultEditor: false
                        }
                        : {})
                } else if (message.method === 'workspace/workspaceFolders') {
                    result = [{ uri: workspace.uri, name: path.basename(workspace.folder) }]
                }
                send({ jsonrpc: '2.0', id: message.id, result })
            }
        }
    })
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})

    let exited = false
    const exitPromise = new Promise(resolve => child.once('exit', () => { exited = true; resolve() }))

    return {
        child,
        exitPromise,
        hasExited: () => exited,
        request: (method, params) => {
            const id = nextId++
            const promise = new Promise(resolve => pending.set(id, resolve))
            send({ jsonrpc: '2.0', id, method, params })
            return promise
        },
        notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
        statuses: (since = 0) => notifications
            .filter(n => n.method === 'matlab/connection/update/server' && n.at >= since)
            .map(n => n.params.connectionStatus)
    }
}

/** The state in which each scenario shuts the server down */
const TRIGGERS = {
    launcher: (tree) => tree.some(row => /matlab/i.test(row.comm)),
    starting: (tree, server) => !server.statuses().includes('connected') &&
        tree.some(row => tree.some(parent => parent.pid === row.ppid && parent.comm === 'MATLAB')),
    connected: (tree, server) => server.statuses().includes('connected')
}

function killSurvivors (serverPid, recorded) {
    const rows = processTable()
    const targets = new Map()
    const add = row => { if (isLive(row)) targets.set(row.pid, row) }
    for (const row of rows) {
        if (row.sid === serverPid) add(row)
        if (recorded.some(r => sameProcess(r, row))) {
            add(row)
            descendantsOf(rows, row.pid).forEach(add)
        }
    }
    // Descendants first
    const ordered = [...targets.values()].sort((a, b) => descendantsOf(rows, b.pid).length - descendantsOf(rows, a.pid).length).reverse()
    for (const row of ordered) {
        try { process.kill(row.pid, 'SIGKILL') } catch (err) { /* already gone */ }
    }
    return ordered.map(label)
}

async function scenario (name) {
    console.log(`\n== Scenario ${name} (${seconds()})`)
    const folder = path.join(scratch, name)
    fs.mkdirSync(folder)
    const workspace = { folder, uri: pathToFileURL(folder).href }
    const server = startServer(workspace)
    const recorded = []
    const record = rows => {
        for (const row of descendantsOf(rows, server.child.pid)) {
            if (!recorded.some(r => sameProcess(r, row))) recorded.push(row)
        }
    }

    try {
        await server.request('initialize', {
            processId: process.pid,
            rootUri: workspace.uri,
            capabilities: { workspace: { configuration: true, workspaceFolders: true } },
            initializationOptions: { workspaceTrusted: true },
            workspaceFolders: [{ uri: workspace.uri, name }]
        })
        server.notify('initialized', {})

        const startedAt = Date.now()
        let triggered = false
        while (Date.now() - startedAt < 180000 && !server.hasExited()) {
            const rows = processTable()
            record(rows)
            const tree = descendantsOf(rows, server.child.pid)
            if (TRIGGERS[name](tree, server)) {
                triggered = true
                break
            }
            await sleep(POLL_MS)
        }
        const matlabRecorded = recorded.filter(row => row.comm !== 'node')
        check(`[${name}] the server is shut down in that state`, triggered,
            `after ${seconds(startedAt)}, statuses ${JSON.stringify(server.statuses())}, recorded ${JSON.stringify(matlabRecorded.map(label))}`)

        const shutdownAt = Date.now()
        const answer = await Promise.race([server.request('shutdown', null), sleep(5000).then(() => null)])
        record(processTable())
        server.notify('exit', null)
        await Promise.race([server.exitPromise, sleep(10000)])
        check(`[${name}] the server answers the shutdown request and exits`, answer !== null && server.hasExited(),
            `answered ${answer !== null}, exited ${server.hasExited()} ${seconds(shutdownAt)} after the request`)

        const statusesAfter = server.statuses(shutdownAt)
        check(`[${name}] the server reports no connection once asked to shut down`, !statusesAfter.includes('connected'), JSON.stringify(statusesAfter))
        if (name !== 'connected') {
            check(`[${name}] the server reports MATLAB disconnected as it shuts down`, statusesAfter.includes('disconnected'), JSON.stringify(server.statuses()))
        }

        await sleep(PROMPT_WAIT_MS)
        if (name !== 'connected') {
            // A MATLAB left to exit by itself, once it finds the server gone, can still be running here
            const early = processTable()
            const earlyAlive = recorded.filter(r => early.some(row => sameProcess(r, row) && isLive(row)))
            check(`[${name}] no process recorded below the server runs ${PROMPT_WAIT_MS / 1000} s after it exited`, earlyAlive.length === 0, JSON.stringify(earlyAlive.map(label)))
        }

        await sleep(SURVIVAL_WAIT_MS - PROMPT_WAIT_MS)
        const rows = processTable()
        const recordedAlive = recorded.filter(r => rows.some(row => sameProcess(r, row) && isLive(row)))
        const sessionAlive = rows.filter(row => row.sid === server.child.pid && isLive(row) && !recorded.some(r => sameProcess(r, row)))
        check(`[${name}] no process recorded below the server runs ${SURVIVAL_WAIT_MS / 1000} s after it exited`, recordedAlive.length === 0,
            `recorded ${recorded.length}: ${JSON.stringify(recorded.map(label))}, alive ${JSON.stringify(recordedAlive.map(label))}`)
        check(`[${name}] nothing else in the server's session runs either`, sessionAlive.length === 0, JSON.stringify(sessionAlive.map(label)))
    } finally {
        const killed = killSurvivors(server.child.pid, recorded)
        if (killed.length > 0) {
            console.log(`   cleanup: SIGKILL ${JSON.stringify(killed)}`)
        }
    }
}

async function main () {
    console.log(`server ${SERVER}\nscratch ${scratch}`)
    const hardTimeout = setTimeout(() => {
        console.log('HARD TIMEOUT')
        process.exit(3)
    }, HARD_TIMEOUT_MS)

    for (const name of SCENARIOS) {
        if (TRIGGERS[name] === undefined) {
            throw new Error(`Unknown scenario ${name}`)
        }
        await scenario(name)
    }

    clearTimeout(hardTimeout)
    const failed = results.filter(r => !r.ok)
    console.log(`\nSHUTDOWN SMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed (${seconds()})`)
    if (failed.length > 0) {
        console.log('FAILED: ' + failed.map(f => f.name).join('; '))
    }
    fs.rmSync(scratch, { recursive: true, force: true })
    process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(err => {
    console.error('SHUTDOWN SMOKE ERROR:', err)
    process.exit(2)
})
