// Copyright 2026 Andreas Bogossian
/**
 * End-to-end smoke test for the debug adaptor's exception filters: spawns the real language
 * server over stdio and drives the adaptor the way the extension does, with DebugAdaptorRequest
 * notifications, while running code in MATLAB over the same MVM wire the terminal uses.
 *
 * Without --matlab it checks what the adaptor advertises and how it answers while MATLAB is not
 * connected. With --matlab it checks filters against real stops: errors, identifiers, warnings,
 * caught errors, NaN or Inf, a line breakpoint, a condition typed or cleared in the terminal,
 * watch and Debug Console expressions evaluated while filters are on, and a restart.
 *
 * Usage: node debugSmoke.js [--matlab] [--matlabRoot=/path/to/MATLAB]
 */
'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..', '..')
const SERVER = path.join(REPO, 'server', 'out', 'index.js')
const USE_MATLAB = process.argv.includes('--matlab')

const rootArg = process.argv.find(a => a.startsWith('--matlabRoot='))
const MATLAB_INSTALL_PATH = rootArg ? rootArg.slice('--matlabRoot='.length) : '/usr/local/MATLAB/R2026a'

// A single identifier token that dbstop rejects with MATLAB:badopt
const BAD_IDENTIFIER = 'notAnId'

const FILES = {
    errFn: "function errFn\nx = 1;\nerror('harness:boom', 'Boom %d', x);\nend\n",
    warnFn: "function warnFn\nwarning('harness:warn', 'careful');\ny = 2;\nend\n",
    caughtFn: "function caughtFn\nbefore = 5;\nbs = BadSize();\ntry\n    error('harness:inner', 'inner');\ncatch\nend\nend\n",
    // The variables view asks for each variable's size, which throws here and is caught inside MATLAB's own code
    BadSize: "classdef BadSize\n    methods\n        function varargout = size(obj, varargin)\n            error('harness:badSize', 'size failed');\n        end\n    end\nend\n",
    nanFn: 'function nanFn\nz = 1/0;\nend\n',
    bpScript: 'a = 1;\nb = 2;\nc = 3;\n',
    userThrows: "function y = userThrows\nerror('harness:inWatch', 'thrown in a watch');\ny = 1;\nend\n",
    userWarns: "function y = userWarns\nwarning('harness:warnWatch', 'warned in a watch');\ny = 1;\nend\n"
}

const HOVER_URI = 'file:///tmp/debugSmokeHover.m'
const HOVER_TEXT = "x = plot(1:3);\nparts = strsplit('a b');\n"

const args = ['--stdio']
if (USE_MATLAB) {
    args.push(`--matlabInstallPath=${MATLAB_INSTALL_PATH}`, '--matlabConnectionTiming=onStart')
} else {
    args.push('--matlabConnectionTiming=never')
}

const child = spawn('node', [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })

let buffer = Buffer.alloc(0)
const pending = new Map()
const notifications = []
let nextId = 1

child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.slice(0, headerEnd).toString('ascii')
        const lengthMatch = /Content-Length: (\d+)/i.exec(header)
        if (lengthMatch === null) return
        const length = parseInt(lengthMatch[1], 10)
        const bodyStart = headerEnd + 4
        if (buffer.length < bodyStart + length) return
        const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8')
        buffer = buffer.slice(bodyStart + length)

        let message
        try {
            message = JSON.parse(body)
        } catch (err) {
            continue
        }

        if (message.id !== undefined && message.method === undefined && pending.has(message.id)) {
            const resolve = pending.get(message.id)
            pending.delete(message.id)
            resolve(message)
        } else if (message.id === undefined && message.method !== undefined) {
            notifications.push(message)
        } else if (message.id !== undefined && message.method !== undefined) {
            let result = null
            if (message.method === 'workspace/configuration') {
                result = (message.params.items || []).map(() => ({
                    installPath: USE_MATLAB ? MATLAB_INSTALL_PATH : '',
                    matlabConnectionTiming: USE_MATLAB ? 'onStart' : 'never',
                    indexWorkspace: false,
                    telemetry: false,
                    maxFileSizeForAnalysis: 0,
                    signIn: false,
                    defaultEditor: false
                }))
            }
            send({ jsonrpc: '2.0', id: message.id, result })
        }
    }
})

child.stderr.on('data', d => {
    const text = d.toString()
    if (/error|Error/.test(text)) process.stderr.write('[server stderr] ' + text)
})

function send (message) {
    const json = JSON.stringify(message)
    child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
}

function request (method, params) {
    const id = nextId++
    const promise = new Promise(resolve => pending.set(id, resolve))
    send({ jsonrpc: '2.0', id, method, params })
    return promise
}

function notify (method, params) {
    send({ jsonrpc: '2.0', method, params })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
function check (name, condition, detail) {
    results.push({ name, ok: Boolean(condition), detail: detail === undefined ? '' : detail })
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

function info (name, detail) {
    console.log(`INFO  ${name}  :: ${detail}`)
}

async function waitFor (predicate, timeoutMs, from = 0) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        for (let i = from; i < notifications.length; i++) {
            if (predicate(notifications[i])) return notifications[i]
        }
        if (Date.now() > deadline) return undefined
        await sleep(50)
    }
}

let dapSeq = 1
async function dap (command, dapArgs, timeoutMs = 30000) {
    const seq = dapSeq++
    const mark = notifications.length
    notify('DebugAdaptorRequest', { debugRequest: { seq, type: 'request', command, arguments: dapArgs }, tag: 1 })
    const reply = await waitFor(n => n.method === 'DebugAdaptorResponse' && n.params.tag === 1 &&
        n.params.debugResponse.request_seq === seq, timeoutMs, mark)
    return reply === undefined ? undefined : reply.params.debugResponse
}

const setFilters = filterOptions => dap('setExceptionBreakpoints', { filters: [], filterOptions })
const breakpointsOf = response => response && response.body && Array.isArray(response.body.breakpoints) ? response.body.breakpoints : undefined

let mvmRequestId = 1
async function feval (functionName, nargout, fevalArgs, timeoutMs = 30000) {
    const requestId = 'debug-smoke-feval-' + (mvmRequestId++)
    const mark = notifications.length
    notify('fevalRequest', { requestId, functionName, nargout, args: fevalArgs, isUserEval: false })
    const reply = await waitFor(n => n.method === 'fevalResponse' && n.params.requestId === requestId, timeoutMs, mark)
    return reply === undefined ? undefined : reply.params.result
}

function startEval (command, isUserEval) {
    const requestId = 'debug-smoke-eval-' + (mvmRequestId++)
    const mark = notifications.length
    notify('evalRequest', { requestId, command, isUserEval })
    return {
        mark,
        done: timeoutMs => waitFor(n => n.method === 'evalResponse' && n.params.requestId === requestId, timeoutMs, mark)
    }
}

const stoppedBodies = from => notifications.slice(from)
    .filter(n => n.method === 'DebugAdaptorEvent' && n.params.debugEvent.event === 'stopped')
    .map(n => n.params.debugEvent.body)

async function dbstatus () {
    const reply = await feval('evalc', 1, ['dbstatus'])
    return reply && Array.isArray(reply.result) ? reply.result[0] : JSON.stringify(reply)
}

async function quitDebugging () {
    await startEval("if system_dependent('IsDebugMode')==1, dbquit all; end", false).done(30000)
    await sleep(300)
}

/** Runs a command as the terminal does and returns the stopped event bodies once MATLAB stops. */
async function runUntilStopped (command) {
    const run = startEval(command, true)
    await waitFor(n => n.method === 'DebugAdaptorEvent' && n.params.debugEvent.event === 'stopped', 20000, run.mark)
    // Each stop sends two stopped events; give the second one time to arrive
    await sleep(500)
    return stoppedBodies(run.mark)
}

/** Evaluates as VS Code does at a stop: the stack trace first, then the expression in the top frame. */
async function evaluateAtStop (expression, context, timeoutMs) {
    const stack = await dap('stackTrace', { threadId: 0 })
    const frames = stack && stack.body ? stack.body.stackFrames : []
    const mark = notifications.length
    const reply = await dap('evaluate', { expression, context, frameId: frames.length > 0 ? frames[0].id : undefined }, timeoutMs)
    await sleep(500)
    const stops = stoppedBodies(mark).length
    return { ok: reply !== undefined && stops === 0, detail: `${reply === undefined ? `no answer within ${timeoutMs} ms` : JSON.stringify(reply.body)}, stops ${stops}` }
}

const isStop = (bodies, expected) => bodies.length === 2 && bodies.every(body =>
    Object.keys(expected).every(key => body[key] === expected[key]) &&
    (expected.text !== undefined || body.text === undefined))

async function runMatlabChecks (early) {
    const connected = await waitFor(n => n.method === 'mvmStateChange' && n.params.state === 'connected', 240000)
    check('MATLAB connects', connected !== undefined, connected ? JSON.stringify(connected.params) : 'timed out')
    if (connected === undefined) return
    await sleep(3000)

    // --- a filter answered before MATLAB connected is updated by a breakpoint event once the filters sent on connect set it
    if (early !== undefined && early.length === 1 && early[0].verified === false) {
        const mark = notifications.length
        const replay = await setFilters([{ filterId: 'error' }])
        await sleep(300)
        const changed = notifications.slice(mark)
            .filter(n => n.method === 'DebugAdaptorEvent' && n.params.debugEvent.event === 'breakpoint')
            .map(n => n.params.debugEvent.body)
        const status = await dbstatus()
        check('a filter answered before MATLAB connected is reported verified by a breakpoint event once it is set',
            JSON.stringify(changed) === JSON.stringify([{ reason: 'changed', breakpoint: { id: 100001, verified: true } }]) && /Stop if error\./.test(status),
            `first ${JSON.stringify(early)}, then ${JSON.stringify(breakpointsOf(replay))}, events ${JSON.stringify(changed)}, ${JSON.stringify(status)}`)
        await setFilters([])
    } else {
        info('a filter answered before MATLAB connected', `not checked, the first answer was ${JSON.stringify(early)}`)
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debugSmoke-'))
    for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, name + '.m'), text)

    try {
        await feval('addpath', 0, [dir])
        await feval('dbclear', 0, ['all'])

        // --- a condition typed in the terminal survives the first request, which a session start sends
        await startEval('dbstop if error', true).done(20000)
        const first = await setFilters([])
        const afterFirst = await dbstatus()
        check('the first filter request leaves a condition typed in the terminal alone',
            first !== undefined && /Stop if error\./.test(afterFirst), JSON.stringify(afterFirst))
        await feval('dbclear', 0, ['all'])

        // --- Errors
        let response = await setFilters([{ filterId: 'error' }])
        const withErrors = await dbstatus()
        check('checking Errors sets dbstop if error in MATLAB',
            JSON.stringify(breakpointsOf(response)) === JSON.stringify([{ id: 100001, verified: true }]) && /Stop if error\./.test(withErrors),
            JSON.stringify(breakpointsOf(response)) + ' ' + JSON.stringify(withErrors))

        let bodies = await runUntilStopped('errFn')
        check('an uncaught error stops with reason exception and its message on both stopped events',
            isStop(bodies, { reason: 'exception', text: 'Boom 1', description: 'Paused on error' }), JSON.stringify(bodies))

        let exceptionInfo = await dap('exceptionInfo', { threadId: 0 })
        check('exceptionInfo at the error reports the identifier from lasterr',
            exceptionInfo && JSON.stringify(exceptionInfo.body) === JSON.stringify({ exceptionId: 'harness:boom', description: 'Boom 1', breakMode: 'unhandled' }),
            JSON.stringify(exceptionInfo && exceptionInfo.body))
        await quitDebugging()

        // --- a condition cleared in the terminal is set again by the next request with the same filters
        await startEval('dbclear all', true).done(20000)
        const afterTerminalClear = await dbstatus()
        response = await setFilters([{ filterId: 'error' }])
        const reapplied = await dbstatus()
        check('the same filters sent after dbclear all in the terminal set the condition again',
            !/Stop if error/.test(afterTerminalClear) && JSON.stringify(breakpointsOf(response)) === JSON.stringify([{ id: 100001, verified: true }]) && /Stop if error\./.test(reapplied),
            `after dbclear all ${JSON.stringify(afterTerminalClear)}, then ${JSON.stringify(breakpointsOf(response))} ${JSON.stringify(reapplied)}`)

        response = await setFilters([])
        const cleared = await dbstatus()
        check('unchecking Errors clears it in MATLAB', response !== undefined && !/Stop if error/.test(cleared), JSON.stringify(cleared))

        // --- identifier conditions
        await setFilters([{ filterId: 'error', condition: 'harness:other' }])
        const otherRun = startEval('errFn', true)
        const otherDone = await otherRun.done(20000)
        check('an identifier condition does not stop on an error with another identifier',
            otherDone !== undefined && stoppedBodies(otherRun.mark).length === 0, JSON.stringify(stoppedBodies(otherRun.mark)))

        await setFilters([{ filterId: 'error', condition: 'harness:boom' }])
        bodies = await runUntilStopped('errFn')
        check('changing the condition to the identifier thrown stops', isStop(bodies, { reason: 'exception', text: 'Boom 1' }), JSON.stringify(bodies))
        await quitDebugging()
        await setFilters([])

        // --- an identifier MATLAB rejects, next to a filter it accepts
        const rejected = [{ filterId: 'error' }, { filterId: 'warning', condition: BAD_IDENTIFIER }]
        const describeRejected = bps => bps !== undefined && bps.length === 2 && bps[0].verified === true &&
            bps[1].verified === false && /Unknown command option/.test(bps[1].message || '')
        response = await setFilters(rejected)
        check('an identifier MATLAB rejects is unverified with its message while Errors still applies',
            describeRejected(breakpointsOf(response)), JSON.stringify(breakpointsOf(response)))
        response = await setFilters(rejected)
        check('the rejected identifier stays unverified when the same filters are sent again',
            describeRejected(breakpointsOf(response)), JSON.stringify(breakpointsOf(response)))
        await setFilters([])

        // --- Warnings
        await setFilters([{ filterId: 'warning' }])
        bodies = await runUntilStopped('warnFn')
        check('a warning stops with reason exception and its message',
            isStop(bodies, { reason: 'exception', text: 'careful', description: 'Paused on warning' }), JSON.stringify(bodies))
        exceptionInfo = await dap('exceptionInfo', { threadId: 0 })
        check('exceptionInfo at the warning reports the identifier from lastwarn',
            exceptionInfo && JSON.stringify(exceptionInfo.body) === JSON.stringify({ exceptionId: 'harness:warn', description: 'careful', breakMode: 'always' }),
            JSON.stringify(exceptionInfo && exceptionInfo.body))
        let evaluated = await evaluateAtStop('userWarns()', 'watch', 10000)
        check('with Warnings on, a watch expression that warns answers without another stop', evaluated.ok, evaluated.detail)
        await quitDebugging()
        await setFilters([])

        // --- Caught Errors, and what else it stops in
        await setFilters([{ filterId: 'caught error' }])
        bodies = await runUntilStopped('caughtFn')
        check('a caught error stops with reason exception and its message',
            isStop(bodies, { reason: 'exception', text: 'inner', description: 'Paused on caught error' }), JSON.stringify(bodies))

        let mark = notifications.length
        const stack = await dap('stackTrace', { threadId: 0 })
        const frames = stack && stack.body ? stack.body.stackFrames : []
        const scopes = frames.length > 0 ? await dap('scopes', { frameId: frames[0].id }) : undefined
        const scope = scopes && scopes.body && scopes.body.scopes[0]
        const variables = scope ? await dap('variables', { variablesReference: scope.variablesReference }, 20000) : undefined
        await sleep(500)
        const variableNames = variables && variables.body ? variables.body.variables.map(v => v.name) : []
        check('with Caught Errors on, the call stack and variables at a stop answer without another stop, even for an object whose size throws',
            variableNames.includes('before') && variableNames.includes('bs') && stoppedBodies(mark).length === 0,
            `frames ${frames.length}, variables ${JSON.stringify(variableNames)}, stops ${stoppedBodies(mark).length}`)

        for (const context of ['watch', 'repl']) {
            evaluated = await evaluateAtStop('userThrows()', context, 10000)
            check(`with Caught Errors on, a ${context} expression that throws answers without another stop`, evaluated.ok, evaluated.detail)
        }
        await quitDebugging()

        notify('textDocument/didOpen', { textDocument: { uri: HOVER_URI, languageId: 'matlab', version: 1, text: HOVER_TEXT } })
        await sleep(1000)
        mark = notifications.length
        const hoverPlot = await Promise.race([request('textDocument/hover', { textDocument: { uri: HOVER_URI }, position: { line: 0, character: 5 } }), sleep(20000)])
        const hoverSplit = await Promise.race([request('textDocument/hover', { textDocument: { uri: HOVER_URI }, position: { line: 1, character: 10 } }), sleep(20000)])
        await sleep(500)
        check('with Caught Errors on, hovers answer without stopping MATLAB',
            hoverPlot !== undefined && hoverSplit !== undefined && stoppedBodies(mark).length === 0,
            `plot ${hoverPlot && hoverPlot.result ? 'has contents' : 'empty'}, strsplit ${hoverSplit && hoverSplit.result ? 'has contents' : 'empty'}, stops ${stoppedBodies(mark).length}`)

        mark = notifications.length
        const discovery = await feval('matlabls.handlers.testing.discoverTests', 1, [[path.join(dir, 'noSuchFolder')], 'folder'], 10000)
        const discoveryStops = stoppedBodies(mark)
        info('with Caught Errors on, test discovery of a missing folder',
            `${discovery === undefined ? 'no answer within 10 s' : 'answered'}; stopped events ${JSON.stringify(discoveryStops)}`)
        if (discoveryStops.length > 0) {
            await quitDebugging()
            await sleep(500)
        }
        await setFilters([])

        // --- NaN or Inf
        await setFilters([{ filterId: 'naninf' }])
        bodies = await runUntilStopped('nanFn')
        check('NaN or Inf stops with reason exception and its own text',
            isStop(bodies, { reason: 'exception', text: 'NaN or Inf', description: 'Paused on NaN or Inf' }), JSON.stringify(bodies))
        await quitDebugging()
        await setFilters([])

        // --- a line breakpoint is still a breakpoint stop
        const bpPath = path.join(dir, 'bpScript.m')
        await dap('setBreakpoints', { source: { path: bpPath }, breakpoints: [{ line: 2 }] })
        bodies = await runUntilStopped('bpScript')
        check('a line breakpoint still stops with reason breakpoint and no text', isStop(bodies, { reason: 'breakpoint' }), JSON.stringify(bodies))
        exceptionInfo = await dap('exceptionInfo', { threadId: 0 })
        check('exceptionInfo at a line breakpoint still answers with a body',
            exceptionInfo && exceptionInfo.body && exceptionInfo.body.exceptionId === 'exception', JSON.stringify(exceptionInfo && exceptionInfo.body))
        await quitDebugging()
        await dap('setBreakpoints', { source: { path: bpPath }, breakpoints: [] })

        // --- an identifier condition on top of a condition typed in the terminal (reported, not checked)
        await startEval('dbstop if error', true).done(20000)
        response = await setFilters([{ filterId: 'error', condition: 'harness:other' }])
        info('identifier condition over a terminal dbstop if error',
            `response ${JSON.stringify(breakpointsOf(response))}, dbstatus ${JSON.stringify(await dbstatus())}`)
        await feval('dbclear', 0, ['all'])
        await setFilters([])

        // --- a filter request while MATLAB runs code waits until MATLAB is idle (reported, not checked)
        const busyRun = startEval('pause(3)', true)
        await sleep(500)
        const busyStarted = Date.now()
        response = await setFilters([{ filterId: 'error' }])
        const busyMs = Date.now() - busyStarted
        await busyRun.done(20000)
        info('a filter request sent while MATLAB runs pause(3)', `answered after ${busyMs} ms with ${JSON.stringify(breakpointsOf(response))}`)
        await setFilters([])

        // --- a MATLAB restart loses the conditions; the filters the client sends again restore them
        await setFilters([{ filterId: 'error' }])
        let restartMark = notifications.length
        notify('matlab/connection/update/client', { connectionAction: 'disconnect' })
        const down = await waitFor(n => n.method === 'mvmStateChange' && n.params.state === 'disconnected', 60000, restartMark)
        await sleep(2000)
        restartMark = notifications.length
        notify('matlab/connection/update/client', { connectionAction: 'connect' })
        const up = await waitFor(n => n.method === 'mvmStateChange' && n.params.state === 'connected', 240000, restartMark)
        check('MATLAB restarts', down !== undefined && up !== undefined, `${down ? 'disconnected' : 'no disconnect'}, ${up ? 'connected' : 'no connect'}`)
        if (up !== undefined) {
            await sleep(3000)
            const fresh = await dbstatus()
            check('a restarted MATLAB has lost the condition', typeof fresh === 'string' && !/Stop if error/.test(fresh), JSON.stringify(fresh))

            const started = Date.now()
            response = await setFilters([{ filterId: 'error' }])
            let restored = ''
            while (Date.now() - started < 15000) {
                restored = await dbstatus()
                if (/Stop if error\./.test(restored)) break
                await sleep(250)
            }
            check('the same filters sent again after the restart are set in the new MATLAB',
                JSON.stringify(breakpointsOf(response)) === JSON.stringify([{ id: 100001, verified: true }]) && /Stop if error\./.test(restored),
                `${Date.now() - started} ms, ${JSON.stringify(restored)}`)
        }
    } finally {
        await feval('dbclear', 0, ['all'], 10000)
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

async function main () {
    await request('initialize', {
        processId: process.pid,
        rootUri: 'file:///tmp',
        capabilities: { workspace: { configuration: true } }
    })
    notify('initialized', {})

    const init = await dap('initialize', { adapterID: 'matlab', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' })
    const capabilities = init && init.body ? init.body : {}
    const filters = capabilities.exceptionBreakpointFilters || []
    check('initialize advertises the four MATLAB stop conditions as exception filters',
        JSON.stringify(filters.map(f => [f.filter, f.label])) ===
            JSON.stringify([['error', 'Errors'], ['caught error', 'Caught Errors'], ['warning', 'Warnings'], ['naninf', 'NaN or Inf']]),
        JSON.stringify(filters.map(f => f.filter)))
    check('initialize advertises filter options and exception info',
        capabilities.supportsExceptionFilterOptions === true && capabilities.supportsExceptionInfoRequest === true,
        `supportsExceptionFilterOptions=${capabilities.supportsExceptionFilterOptions} supportsExceptionInfoRequest=${capabilities.supportsExceptionInfoRequest}`)

    if (USE_MATLAB) {
        // Sent while MATLAB is still starting, as VS Code does for a session started before MATLAB connects
        const early = breakpointsOf(await setFilters([{ filterId: 'error' }]))
        await runMatlabChecks(early)
    } else {
        const response = await setFilters([{ filterId: 'error' }])
        const bps = breakpointsOf(response)
        check('a filter set while MATLAB is not connected is reported unverified',
            bps !== undefined && bps.length === 1 && bps[0].verified === false && /not connected/.test(bps[0].message || ''),
            JSON.stringify(bps))

        const exceptionInfo = await dap('exceptionInfo', { threadId: 0 })
        check('exceptionInfo without an exception stop still answers with a body',
            exceptionInfo && exceptionInfo.body && exceptionInfo.body.exceptionId === 'exception', JSON.stringify(exceptionInfo && exceptionInfo.body))
    }

    console.log('')
    const failed = results.filter(r => !r.ok)
    console.log(`SMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed`)
    if (failed.length > 0) {
        console.log('FAILED: ' + failed.map(f => f.name).join('; '))
    }

    child.kill('SIGTERM')
    process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(err => {
    console.error('SMOKE ERROR:', err)
    child.kill('SIGTERM')
    process.exit(2)
})
