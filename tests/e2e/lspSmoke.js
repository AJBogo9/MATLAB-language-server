/**
 * End-to-end smoke test: spawns the real language server over stdio, performs a
 * real LSP handshake, and issues real textDocument/hover requests.
 *
 * This is the only check that exercises capability negotiation, the document
 * manager, the provider wiring and the MATLAB round trip together. The unit
 * suite stubs the MATLAB-facing method by design, so it cannot catch a wiring
 * mistake in server.ts.
 *
 * Usage: node lspSmoke.js [--matlab]
 */
'use strict'

const { spawn } = require('child_process')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..', '..')
const SERVER = path.join(REPO, 'server', 'out', 'index.js')
const USE_MATLAB = process.argv.includes('--matlab')

// Override with: node lspSmoke.js --matlab --matlabRoot=/path/to/MATLAB
const rootArg = process.argv.find(a => a.startsWith('--matlabRoot='))
const MATLAB_INSTALL_PATH = rootArg ? rootArg.slice('--matlabRoot='.length) : '/usr/local/MATLAB/R2026a'

const DOC_URI = 'file:///tmp/hoverSmoke.m'
const DOC_TEXT = [
    'function y = hoverSmoke(x)',                       // 0
    '%HOVERSMOKE Doubles the input.',                   // 1
    'arguments',                                        // 2
    '    x (:,1) double {mustBeFinite} = 1',            // 3
    'end',                                              // 4
    'y = x .* 2;          % remember to plot this',     // 5
    "label = 'plot';",                                  // 6
    'z = localHelper(y);',                              // 7
    'w = fft(z);',                                      // 8
    "t = y(1)' + 1;",                                   // 9
    'end',                                              // 10
    '',                                                 // 11
    'function out = localHelper(a)',                    // 12
    '%LOCALHELPER Passes a straight through.',          // 13
    'out = a;',                                         // 14
    'end',                                              // 15
    "kind = 'x'; switch kind, case 'plot', disp(1); end" // 16
].join('\n')

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

        // A request from the server carries an id too, and the two id sequences overlap
        if (message.id !== undefined && message.method === undefined && pending.has(message.id)) {
            const resolve = pending.get(message.id)
            pending.delete(message.id)
            resolve(message)
        } else if (message.id === undefined && message.method !== undefined) {
            // Server-to-client notification.
            notifications.push(message)
        } else if (message.id !== undefined && message.method !== undefined) {
            // Server-to-client request: answer the ones the server waits on.
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

async function hoverAt (line, character) {
    const response = await request('textDocument/hover', {
        textDocument: { uri: DOC_URI },
        position: { line, character }
    })
    return response.result
}

const firstLine = hover => {
    if (hover == null) return '(null)'
    const value = hover.contents && hover.contents.value ? hover.contents.value : ''
    return value.split('\n')[0]
}

// Polls the recorded notifications until the newest publishDiagnostics for uri
// satisfies predicate. Returns that newest list, or null if none arrived.
async function latestDiagnostics (uri, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let latest = null
    for (;;) {
        const pushes = notifications.filter(n =>
            n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri)
        if (pushes.length > 0) {
            latest = pushes[pushes.length - 1].params.diagnostics
            if (predicate(latest)) return latest
        }
        if (Date.now() > deadline) return latest
        await sleep(100)
    }
}

const diagnosticCodes = diagnostics =>
    diagnostics == null ? '(no publish)' : (diagnostics.map(d => d.code).join(',') || '(empty)')

async function main () {
    const init = await request('initialize', {
        processId: process.pid,
        rootUri: 'file:///tmp',
        capabilities: {
            textDocument: {
                hover: { contentFormat: ['markdown', 'plaintext'] },
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                synchronization: { dynamicRegistration: false }
            },
            workspace: { configuration: true, workspaceFolders: true }
        },
        workspaceFolders: [{ uri: 'file:///tmp', name: 'tmp' }]
    })

    const capabilities = init.result.capabilities
    check('server advertises hoverProvider', capabilities.hoverProvider === true,
        'hoverProvider=' + JSON.stringify(capabilities.hoverProvider))
    check('server advertises workspaceSymbolProvider', capabilities.workspaceSymbolProvider === true,
        'workspaceSymbolProvider=' + JSON.stringify(capabilities.workspaceSymbolProvider))
    check('existing capabilities still advertised',
        capabilities.definitionProvider === true && capabilities.completionProvider != null &&
        capabilities.documentSymbolProvider === true && capabilities.renameProvider != null,
        'no regression in the capability object')

    notify('initialized', {})
    notify('textDocument/didOpen', {
        textDocument: { uri: DOC_URI, languageId: 'matlab', version: 1, text: DOC_TEXT }
    })

    // Folding needs no MATLAB, so ask before MATLAB has had time to start
    const FOLD_URI = 'file:///tmp/foldingSmoke.m'
    const foldingCase = require('../providers/folding/foldingCases.json')[0]
    notify('textDocument/didOpen', {
        textDocument: { uri: FOLD_URI, languageId: 'matlab', version: 1, text: foldingCase.code }
    })
    const expectedFolds = JSON.stringify(foldingCase.expected.map(([startLine, endLine, kind]) => ({ startLine, endLine, kind: kind ?? null })))
    const foldsOf = response => JSON.stringify((response.result || []).map(r => ({ startLine: r.startLine, endLine: r.endLine, kind: r.kind ?? null })))
    const earlyFolds = foldsOf(await request('textDocument/foldingRange', { textDocument: { uri: FOLD_URI } }))
    check('folding ranges come with kinds before MATLAB is ready', earlyFolds === expectedFolds, earlyFolds)

    if (USE_MATLAB) {
        process.stdout.write('waiting for MATLAB to connect ')
        for (let i = 0; i < 45; i++) {
            await sleep(2000)
            process.stdout.write('.')
        }
        console.log('')
    } else {
        await sleep(1500)
    }

    // Operator: line 5 is "y = x .* 2;", the .* starts at column 6.
    const operator = await hoverAt(5, 7)
    check('hover on .* operator returns a card', operator != null, firstLine(operator))
    check('.* card names the operator',
        operator != null && operator.contents.value.includes('.*'), firstLine(operator))

    // Keyword: line 2 is "arguments".
    const keyword = await hoverAt(2, 2)
    check('hover on a keyword returns a card', keyword != null, firstLine(keyword))

    // Comment: line 5 contains "% remember to plot this"; find the word plot.
    const commentCol = DOC_TEXT.split('\n')[5].indexOf('plot')
    const inComment = await hoverAt(5, commentCol)
    check('hover inside a comment returns null', inComment == null, firstLine(inComment))

    // String: line 6 is "label = 'plot';".
    const stringCol = DOC_TEXT.split('\n')[6].indexOf('plot')
    const inString = await hoverAt(6, stringCol)
    check('hover inside a char array returns null', inString == null, firstLine(inString))

    // Line 9 is "t = y(1)' + 1;". If the transpose were read as opening a char
    // array, everything after it would be classified as a string and hover would
    // be suppressed. Probe the `+` after it, which resolves from the bundled
    // operator table and so works with no index and no MATLAB.
    const transposeLine = DOC_TEXT.split('\n')[9]
    const afterTranspose = await hoverAt(9, transposeLine.indexOf('+'))
    check('transpose does not swallow the rest of the line',
        afterTranspose != null, firstLine(afterTranspose))

    // Local function on line 7: help() returns 0 chars for this, so anything we
    // get here came from the document.
    const local = await hoverAt(7, 6)
    check('hover on a local function returns a card', local != null, firstLine(local))
    check('local function card carries its doc comment',
        local != null && local.contents.value.includes('Passes a straight through'), firstLine(local))

    // The function's own declaration, which should carry the arguments table.
    const own = await hoverAt(0, 14)
    check('hover on the function declaration returns a card', own != null, firstLine(own))
    if (own != null) {
        check('arguments table appears', own.contents.value.includes('mustBeFinite'),
            own.contents.value.includes('mustBeFinite') ? 'present' : own.contents.value.slice(0, 120))
    }

    // Diagnostics come from the buffer being edited, with or without MATLAB. The
    // file is absent on disk, so a linter that reads the saved file finds nothing.
    const LINT_URI = 'file:///tmp/lintSmokeAbsentDir/lintSmoke.m'
    const hasCode = code => diagnostics => diagnostics.some(d => d.code === code)
    notify('textDocument/didOpen', {
        textDocument: {
            uri: LINT_URI,
            languageId: 'matlab',
            version: 1,
            text: 'function y = lintSmoke(x)\ny = x + 1\nend\n'
        }
    })
    const opened = await latestDiagnostics(LINT_URI, hasCode('NOPRT'), 8000)
    check('diagnostics lint the open buffer, not the file on disk',
        opened != null && hasCode('NOPRT')(opened), diagnosticCodes(opened))
    check('the buffer is linted under its own file name',
        opened != null && hasCode('NOPRT')(opened) && !hasCode('BDFIL')(opened) && !hasCode('FNDEF')(opened),
        diagnosticCodes(opened))

    notify('textDocument/didChange', {
        textDocument: { uri: LINT_URI, version: 2 },
        contentChanges: [{ text: 'function y = lintSmoke(x)\ny = (x + 1\nend\n' }]
    })
    const edited = await latestDiagnostics(LINT_URI, hasCode('EOLPAR'), 8000)
    check('an edit is re-linted without a save',
        edited != null && hasCode('EOLPAR')(edited), diagnosticCodes(edited))

    if (USE_MATLAB) {
        // A char array preceded by whitespace must still suppress hover. This is
        // only a real assertion with MATLAB attached: without it, `plot` yields
        // no card whatever the gate decides, so the check would pass vacuously.
        const caseLine = DOC_TEXT.split('\n')[16]
        const inCaseString = await hoverAt(16, caseLine.indexOf('plot'))
        check('hover suppressed inside a whitespace-preceded char array',
            inCaseString == null, firstLine(inCaseString))

        // Control for the check above: the same builtin DOES produce a card when
        // it is genuinely code, so suppression cannot be passing by accident.
        const realCall = await hoverAt(16, caseLine.indexOf('disp'))
        check('the same line still hovers real code',
            realCall != null, firstLine(realCall))

        // --- the mechanism Run Section relies on: a documentSymbol request must
        // --- make the server recompute and push section ranges.
        const beforeCount = notifications.filter(n => n.method === 'matlab/sections').length
        const symbolResp = await request('textDocument/documentSymbol', { textDocument: { uri: DOC_URI } })
        await sleep(1500)
        const sectionPushes = notifications.filter(n => n.method === 'matlab/sections')
        check('documentSymbol makes the server push section ranges',
            sectionPushes.length > beforeCount,
            sectionPushes.length + ' matlab/sections notifications seen')
        if (sectionPushes.length > 0) {
            const last = sectionPushes[sectionPushes.length - 1].params
            check('pushed sections carry ranges',
                Array.isArray(last.sectionRanges),
                (last.sectionRanges || []).length + ' ranges for ' + (last.uri || '?').split('/').pop())
        }

        // --- a client that accepts a tree gets one, with the name as the selection
        const hoverSmokeSymbol = (symbolResp.result || []).find(s => s.name === 'hoverSmoke')
        const selection = hoverSmokeSymbol && hoverSmokeSymbol.selectionRange
        check('documentSymbol returns a tree with the name as the selection',
            hoverSmokeSymbol !== undefined && hoverSmokeSymbol.location === undefined && selection !== undefined &&
            selection.start.line === 0 && selection.start.character === 13 && selection.end.character === 23,
            JSON.stringify(hoverSmokeSymbol))

        // --- with MATLAB connected, folding still comes from the document
        const connectedFolds = foldsOf(await request('textDocument/foldingRange', { textDocument: { uri: FOLD_URI } }))
        check('folding ranges come with kinds once MATLAB is connected', connectedFolds === expectedFolds, connectedFolds)

        // --- workspace symbols (Ctrl+T) over the index the open document built
        const wsResp = await request('workspace/symbol', { query: 'hoverSmoke' })
        const ws = wsResp.result || []
        check('workspace/symbol finds a function from the open document',
            ws.some(s => s.name === 'hoverSmoke'),
            ws.length + ' symbols: ' + ws.map(s => s.name).join(', '))

        const localResp = await request('workspace/symbol', { query: 'localHelper' })
        const locals = localResp.result || []
        check('workspace/symbol finds a local function',
            locals.some(s => s.name === 'localHelper'),
            locals.map(s => s.name).join(', '))

        const subseqResp = await request('workspace/symbol', { query: 'hS' })
        const subseq = subseqResp.result || []
        check('workspace/symbol matches a subsequence',
            subseq.some(s => s.name === 'hoverSmoke'),
            'query "hS" -> ' + subseq.map(s => s.name).join(', '))

        // --- completions and signature help, which exercise the MVM wire
        // --- format including the `shared` block that was being filtered out.
        const COMP_URI = 'file:///tmp/completionSmoke.m'
        const COMP_TEXT = 'y = zeros(3,\nz = plot(1,2,\n'
        notify('textDocument/didOpen', {
            textDocument: { uri: COMP_URI, languageId: 'matlab', version: 1, text: COMP_TEXT }
        })
        await sleep(500)

        const sigResp = await request('textDocument/signatureHelp', {
            textDocument: { uri: COMP_URI },
            position: { line: 1, character: 12 }
        })
        const sig = sigResp.result
        check('signatureHelp returns overloads', sig != null && sig.signatures.length > 0,
            sig ? sig.signatures.length + ' signatures' : '(null)')
        if (sig != null && sig.signatures.length > 0) {
            const perSignature = sig.signatures.map(s => s.activeParameter)
            check('every signature carries its own activeParameter',
                perSignature.every(v => typeof v === 'number'),
                JSON.stringify(perSignature))
            const offsets = sig.signatures[0].parameters.map(p => p.label)
            check('parameter labels are offset pairs, not strings',
                offsets.length === 0 || Array.isArray(offsets[0]),
                JSON.stringify(offsets.slice(0, 4)))
            if (offsets.length > 0 && Array.isArray(offsets[0])) {
                const label = sig.signatures[0].label
                const addressed = offsets.map(([a, b]) => label.slice(a, b))
                check('offsets address real parameter text',
                    addressed.every(t => /^[A-Za-z][A-Za-z0-9_]*$/.test(t)),
                    label + ' -> ' + JSON.stringify(addressed))
            }
            check('activeSignature is within range',
                sig.activeSignature >= 0 && sig.activeSignature < sig.signatures.length,
                'activeSignature=' + sig.activeSignature)
        }

        const builtin = await hoverAt(8, 5)
        check('hover on fft returns a MATLAB-backed card', builtin != null, firstLine(builtin))
        if (builtin != null) {
            const value = builtin.contents.value
            check('fft card contains help prose', value.includes('Fourier'), firstLine(builtin))
            check('fft card contains signatures', value.includes('fft(X'), 'signatures present')
            check('fft card links mathworks.com docs', value.includes('https://www.mathworks.com/'),
                value.includes('[Documentation]') ? 'link present' : 'no link')
            console.log('\n--- fft card as rendered ---\n' + value + '\n---------------------------\n')
        }

        const timedStart = Date.now()
        await hoverAt(8, 5)
        const cachedMs = Date.now() - timedStart
        check('second hover on fft is served from cache', cachedMs < 100, cachedMs + ' ms')

        // --- a large document parses on MATLAB's background pool, so a MATLAB-backed
        // --- request made meanwhile is not held up. On the MATLAB thread this file takes
        // --- about 1.6 s to parse and under 100 ms to lint (R2026a).
        const BIG_URI = 'file:///tmp/bigParseSmoke.m'
        const BIG_TEXT = require('fs').readFileSync(
            path.join(MATLAB_INSTALL_PATH, 'toolbox', 'matlab', 'uitools', 'uitools', 'uitoolfactory.m'), 'utf8')
        const timedCompletion = async () => {
            const started = Date.now()
            await request('textDocument/completion', {
                textDocument: { uri: COMP_URI },
                position: { line: 0, character: 5 }
            })
            return Date.now() - started
        }
        await timedCompletion()
        notify('textDocument/didOpen', {
            textDocument: { uri: BIG_URI, languageId: 'matlab', version: 1, text: BIG_TEXT }
        })
        const latencies = []
        const probeUntil = Date.now() + 4000
        while (Date.now() < probeUntil) {
            latencies.push(await timedCompletion())
        }
        const worstMs = Math.max(...latencies)
        check('completion is not held up while a large document parses', worstMs < 600,
            'worst ' + worstMs + ' ms over ' + latencies.length + ' requests')

        let indexed = []
        const indexDeadline = Date.now() + 20000
        while (Date.now() < indexDeadline) {
            const found = await request('workspace/symbol', { query: 'localPrettyPrint' })
            indexed = (found.result || []).filter(s => s.location && s.location.uri === BIG_URI)
            if (indexed.length > 0) break
            await sleep(250)
        }
        check('the large document is indexed', indexed.length > 0,
            indexed.map(s => s.name).join(', ') || '(not found)')

        // --- a stack frame from the terminal resolves to its file over the real MVM
        // --- wire, the way the client asks, without changing MATLAB's current folder
        const fevalOverWire = async (functionName, nargout, fevalArgs) => {
            const requestId = 'smoke-feval-' + (nextId++)
            notify('fevalRequest', { requestId, functionName, nargout, args: fevalArgs, isUserEval: false })
            const deadline = Date.now() + 20000
            for (;;) {
                const reply = notifications.find(n => n.method === 'fevalResponse' && n.params.requestId === requestId)
                if (reply !== undefined) return reply.params.result
                if (Date.now() > deadline) return undefined
                await sleep(50)
            }
        }
        const fs = require('fs')
        const frameDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'stackFrameSmoke-'))
        try {
            fs.mkdirSync(path.join(frameDir, '+sfsmoke'))
            fs.writeFileSync(path.join(frameDir, '+sfsmoke', 'sfSmokeFn.m'),
                "function sfSmokeFn\n    host();\nend\n\nfunction host\n    error('sf:smoke', 'smoke');\nend\n")
            await fevalOverWire('addpath', 0, [frameDir])
            const before = await fevalOverWire('pwd', 1, [])
            const resolved = await fevalOverWire('matlabls.handlers.terminal.resolveStackFrame', 1,
                ['sfsmoke.sfSmokeFn>host', 'sfsmoke.sfSmokeFn'])
            const after = await fevalOverWire('pwd', 1, [])
            await fevalOverWire('rmpath', 0, [frameDir])

            const resolvedPath = resolved && Array.isArray(resolved.result) ? resolved.result[0] : undefined
            check('a stack frame resolves to its file over the MVM wire',
                typeof resolvedPath === 'string' && resolvedPath.endsWith(path.join('+sfsmoke', 'sfSmokeFn.m')),
                JSON.stringify(resolved))
            // Each reply carries its own requestID, so compare only the folder
            const folderOf = reply => reply && Array.isArray(reply.result) ? reply.result[0] : undefined
            check('resolving a stack frame leaves the current folder alone',
                typeof folderOf(before) === 'string' && folderOf(before) === folderOf(after),
                folderOf(before) + ' -> ' + folderOf(after))
        } finally {
            fs.rmSync(frameDir, { recursive: true, force: true })
        }
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
