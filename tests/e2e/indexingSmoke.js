// Copyright 2026 Andreas Bogossian
/**
 * End-to-end check of workspace indexing against a live MATLAB. Spawns the real
 * language server over stdio with workspace folders on a scratch tree that holds
 * symbolic link loops, a duplicated folder, a broken link, an unreadable file and
 * generated folders, then checks what workspace/symbol returns, for files and open
 * documents with a syntax error too, the progress the server reports, and what
 * happens when folders are added and removed. Then a
 * folder is added while every background pool worker is busy for longer than the
 * crawl's silence warning time, and its crawl must still finish. Last, a folder
 * whose only file parses for longer than the silence warning time is added, and a
 * folder added once that crawl has stalled must be crawled while it still parses.
 * The stalled crawl is then cancelled in MATLAB, which must end it at once.
 *
 * Before the Node walk, MATLAB's dir('**') listed each file under the looping link
 * up to 40 times over, and on the folder with two loops it did not return at all.
 *
 * Usage: node indexingSmoke.js [--matlabRoot=/path/to/MATLAB]
 */
'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const REPO = path.resolve(__dirname, '..', '..', '..')
const SERVER = path.join(REPO, 'server', 'out', 'index.js')
const rootArg = process.argv.find(a => a.startsWith('--matlabRoot='))
const MATLAB_INSTALL_PATH = rootArg ? rootArg.slice('--matlabRoot='.length) : '/usr/local/MATLAB/R2026a'
const HARD_TIMEOUT_MS = 10 * 60 * 1000
const PROGRESS_TITLE = 'Indexing MATLAB files'
// CRAWL_SILENCE_WARNING_MS in src/indexing/Indexer.ts, and how long the pool stays busy past it
const CRAWL_SILENCE_WARNING_MS = 60000
const POOL_BUSY_S = 80
// A generated function this long parses on a worker for longer than CRAWL_SILENCE_WARNING_MS
const SLOW_FILE_LINES = 16000

// VS Code's defaults for the two settings
const FILES_EXCLUDE_DEFAULTS = { '**/.git': true, '**/.svn': true, '**/.hg': true, '**/.DS_Store': true, '**/Thumbs.db': true }
const SEARCH_EXCLUDE_DEFAULTS = { '**/node_modules': true, '**/bower_components': true, '**/*.code-search': true }

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'indexingSmoke-')))
const t0 = Date.now()
const seconds = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s'

function writeFunction (relativePath, name) {
    const fullPath = path.join(scratch, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, `function r = ${name}(x)\nr = x;\nend\n`)
    return fullPath
}

// A classdef with one method, whose body holds the line given, and a local function after it
function writeClassdef (relativePath, name, methodName, localName, bodyLine) {
    const fullPath = path.join(scratch, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, [
        `classdef ${name} < handle`,
        '    methods',
        `        function r = ${methodName}(obj)`,
        `            ${bodyLine}`,
        '            r = obj;',
        '        end',
        '    end',
        'end',
        '',
        `function ${localName}`,
        'end',
        ''
    ].join('\n'))
}

const REAL_A = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 's1', 's2', 's3', 's4']
const EXCLUDED_A = ['vendorFn', 'slprjFn', 'coderFn', 'gitFn', 'genFn']

function buildTree () {
    // Folder A: one loop, a duplicate link, a broken link, an unreadable file, generated folders
    for (let i = 1; i <= 10; i++) writeFunction(`A/src/a${i}.m`, `a${i}`)
    for (let i = 1; i <= 4; i++) writeFunction(`A/src/sub/s${i}.m`, `s${i}`)
    fs.symlinkSync('..', path.join(scratch, 'A/src/sub/loopup'))
    fs.symlinkSync('src', path.join(scratch, 'A/dupsrc'))
    fs.symlinkSync('/nonexistent/target.m', path.join(scratch, 'A/aaa_broken.m'))
    const unreadable = writeFunction('A/src/zzUnreadable.m', 'zzUnreadable')
    fs.chmodSync(unreadable, 0o000)
    writeFunction('A/node_modules/pkg/v.m', 'vendorFn')
    writeFunction('A/slprj/_sfprj/g.m', 'slprjFn')
    writeFunction('A/codegen/mex/foo/c.m', 'coderFn')
    writeFunction('A/.git/hooks/h.m', 'gitFn')
    writeFunction('A/gen/genFn.m', 'genFn')
    writeFunction('A/build/buildFn.m', 'buildFn')

    // Folder C: two loops, which kept MATLAB's dir busy for over 90 s
    writeFunction('C/cfn.m', 'cfn')
    writeFunction('C/a/ca.m', 'ca')
    writeFunction('C/b/cb.m', 'cb')
    fs.symlinkSync('..', path.join(scratch, 'C/a/l1'))
    fs.symlinkSync('..', path.join(scratch, 'C/b/l2'))
    // A package holding a classdef that parses and one with a syntax error
    writeClassdef('C/+pk/PkGood.m', 'PkGood', 'pkGoodMethod', 'pkGoodLocal', 'x = 1;')
    writeClassdef('C/+pk/PkBroken.m', 'PkBroken', 'pkBrokenMethod', 'pkBrokenLocal', 'x = (;')

    // Folder D: removed later while one of its files is open. One file has a syntax error.
    writeFunction('D/dfn.m', 'dfn')
    writeFunction('D/dopen.m', 'dopen')
    fs.writeFileSync(path.join(scratch, 'D/dbroken.m'), 'function r = dbroken(x)\nr = (x;\nend\n\nfunction dbrokenLocal\nend\n')

    // Folder B: added later
    writeFunction('B/bfn.m', 'bfn')
    writeFunction('B/sub/bsub.m', 'bsub')

    // Folder E: added while every background pool worker is busy
    writeFunction('E/efn.m', 'efn')
    writeFunction('E/sub/esub.m', 'esub')

    // Folder S: one generated function that parses for longer than the silence warning time
    const lines = ['function out = slowGen(in1)', 't1 = in1(1).*in1(2);', 't2 = t1.^2+in1(3);']
    for (let k = 3; k <= SLOW_FILE_LINES; k++) {
        lines.push(`t${k} = t${k - 1}.*in1(2)+t${k - 2}.^2-in1(3)./t${k - 1};`)
    }
    lines.push(`out = t${SLOW_FILE_LINES};`, 'end', '')
    fs.mkdirSync(path.join(scratch, 'S'))
    fs.writeFileSync(path.join(scratch, 'S', 'slowGen.m'), lines.join('\n'))

    // Folder G: added once the crawl of S has stalled
    writeFunction('G/gfn.m', 'gfn')
}

const folderOf = name => ({ uri: pathToFileURL(path.join(scratch, name)).href, name })
const A = folderOf('A')
const B = folderOf('B')
const C = folderOf('C')
const E = folderOf('E')
const S = folderOf('S')
const G = folderOf('G')
// A folder URI that ends in a slash, as a drive root's always does: its files must still be stored and dropped
const D = { uri: `${folderOf('D').uri}/`, name: 'D' }
let workspaceFolders = [A, C, D]

let child
let buffer = Buffer.alloc(0)
const pending = new Map()
const progress = []
const configurationItems = []
const fevalResults = new Map()
let nextId = 1

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

const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function answerServerRequest (message) {
    if (message.method === 'workspace/configuration') {
        return message.params.items.map(item => {
            configurationItems.push(item)
            if (item.section === 'MATLAB') {
                return { installPath: MATLAB_INSTALL_PATH, matlabConnectionTiming: 'onStart', indexWorkspace: true, telemetry: false, maxFileSizeForAnalysis: 0, signIn: false, defaultEditor: false, prewarmGraphics: false }
            }
            if (item.section === 'files.exclude') {
                return item.scopeUri === A.uri ? { ...FILES_EXCLUDE_DEFAULTS, '**/gen': true } : FILES_EXCLUDE_DEFAULTS
            }
            if (item.section === 'search.exclude') {
                return SEARCH_EXCLUDE_DEFAULTS
            }
            return null
        })
    }
    if (message.method === 'workspace/workspaceFolders') {
        return workspaceFolders
    }
    return null
}

function startServer () {
    child = spawn('node', [SERVER, '--stdio', `--matlabInstallPath=${MATLAB_INSTALL_PATH}`, '--matlabConnectionTiming=onStart', '--indexWorkspace'], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.on('data', () => {})
    child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
            const headerEnd = buffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            const lengthMatch = /Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd).toString('ascii'))
            if (lengthMatch === null) return
            const length = parseInt(lengthMatch[1], 10)
            if (buffer.length < headerEnd + 4 + length) return
            const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8'))
            buffer = buffer.slice(headerEnd + 4 + length)

            if (message.id !== undefined && message.method === undefined && pending.has(message.id)) {
                pending.get(message.id)(message)
                pending.delete(message.id)
            } else if (message.id === undefined && message.method === 'fevalResponse') {
                fevalResults.set(message.params.requestId, message.params.result)
            } else if (message.id === undefined && message.method === '$/progress') {
                progress.push({ at: Date.now() - t0, token: message.params.token, value: message.params.value })
            } else if (message.id !== undefined && message.method !== undefined) {
                send({ jsonrpc: '2.0', id: message.id, result: answerServerRequest(message) })
            }
        }
    })
}

/** Every process below the server, found while the server is still alive. */
function descendantsOf (pid) {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=']).toString().trim().split('\n')
        .map(row => row.trim().split(/\s+/)).map(([p, pp, comm]) => ({ pid: Number(p), ppid: Number(pp), comm }))
    const found = []
    const queue = [pid]
    while (queue.length > 0) {
        const parent = queue.shift()
        for (const row of rows.filter(r => r.ppid === parent)) {
            found.push(row)
            queue.push(row.pid)
        }
    }
    return found
}

const results = []
function check (name, condition, detail) {
    results.push({ name, ok: Boolean(condition) })
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

/** Runs a MATLAB function in the server's MATLAB session, the way the client does. */
async function fevalOverWire (functionName, nargout, args) {
    const requestId = `indexingSmoke-feval-${nextId++}`
    notify('fevalRequest', { requestId, functionName, nargout, args, isUserEval: false })
    await waitFor(() => fevalResults.has(requestId), 20 * 1000)
    return fevalResults.get(requestId)
}

async function symbolUris (name) {
    const response = await request('workspace/symbol', { query: name })
    return [...new Set((response.result || []).filter(s => s.name === name).map(s => s.location.uri))]
}

async function symbolsNamed (name) {
    const response = await request('workspace/symbol', { query: name })
    return (response.result || []).filter(s => s.name === name)
}

const tokens = () => [...new Set(progress.map(p => p.token))]
const eventsOf = token => progress.filter(p => p.token === token).map(p => p.value)

async function waitFor (condition, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await condition()) return true
        await sleep(250)
    }
    return false
}

function checkProgress (label, token, expectedTotal) {
    const events = eventsOf(token)
    const begin = events[0]
    check(`${label}: progress begins with the title, 0 % and a file count`,
        begin !== undefined && begin.kind === 'begin' && begin.title === PROGRESS_TITLE && begin.percentage === 0 && begin.message === `0/${expectedTotal} files`,
        JSON.stringify(begin))
    const reports = events.filter(e => e.kind === 'report')
    const percentages = reports.map(r => r.percentage)
    check(`${label}: reported percentages rise to 100`,
        percentages.length > 0 && percentages.every((p, i) => i === 0 || p > percentages[i - 1]) && percentages[percentages.length - 1] === 100,
        JSON.stringify(percentages))
    const last = reports[reports.length - 1]
    check(`${label}: the last report counts every file`, last !== undefined && last.message === `${expectedTotal}/${expectedTotal} files`, JSON.stringify(last))
    check(`${label}: progress ends once, after the last report`,
        events.filter(e => e.kind === 'end').length === 1 && events[events.length - 1].kind === 'end', events.map(e => e.kind).join(','))
}

async function main () {
    buildTree()
    startServer()

    await request('initialize', {
        processId: process.pid,
        rootUri: A.uri,
        capabilities: {
            workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: true } },
            window: { workDoneProgress: true }
        },
        workspaceFolders
    })
    notify('initialized', {})
    notify('textDocument/didOpen', {
        textDocument: { uri: pathToFileURL(path.join(scratch, 'D/dopen.m')).href, languageId: 'matlab', version: 1, text: 'function r = dopen(x)\nr = x;\nend\n' }
    })

    // --- the first crawl, over A, C and D
    const firstEnded = await waitFor(() => tokens().length >= 1 && eventsOf(tokens()[0]).some(e => e.kind === 'end'), 4 * 60 * 1000)
    check('the workspace crawl ends', firstEnded, firstEnded ? `begin at ${(progress[0].at / 1000).toFixed(1)} s, end at ${(eventsOf(tokens()[0]).length && progress.filter(p => p.token === tokens()[0]).pop().at / 1000).toFixed(1)} s` : `no end within 4 min (${progress.length} progress events)`)
    if (!firstEnded) return

    // A: 14 real functions, zzUnreadable and build/buildFn; C: 3 and two classdefs; D: 3
    checkProgress('first crawl', tokens()[0], 24)
    check('exclusion settings were read for each workspace folder',
        [A, C, D].every(folder => ['files.exclude', 'search.exclude'].every(section => configurationItems.some(i => i.scopeUri === folder.uri && i.section === section))),
        JSON.stringify(configurationItems.filter(i => i.section !== 'MATLAB')))

    const perName = {}
    for (const name of [...REAL_A, ...EXCLUDED_A, 'buildFn', 'zzUnreadable', 'cfn', 'ca', 'cb', 'dfn', 'dopen']) {
        perName[name] = await symbolUris(name)
    }
    const counts = Object.fromEntries(Object.entries(perName).map(([name, uris]) => [name, uris.length]))
    console.log('symbol URIs per name: ' + JSON.stringify(counts))

    check('each function under the looping and duplicated links is listed once', REAL_A.every(name => counts[name] === 1), JSON.stringify(REAL_A.map(n => counts[n])))
    const allUris = Object.values(perName).flat()
    check('no symbol comes from a path through a link', !allUris.some(uri => /\/(loopup|dupsrc|l1|l2)\//.test(uri)), allUris.filter(uri => /\/(loopup|dupsrc|l1|l2)\//.test(uri)).join(', ') || 'none')
    check('generated, vendored and files.exclude folders are not indexed', EXCLUDED_A.every(name => counts[name] === 0), JSON.stringify(EXCLUDED_A.map(n => counts[n])))
    check('a user build folder is indexed', counts.buildFn === 1, String(counts.buildFn))
    check('the unreadable file is skipped', counts.zzUnreadable === 0, String(counts.zzUnreadable))
    check('the folder with two loops is indexed', counts.cfn === 1 && counts.ca === 1 && counts.cb === 1, JSON.stringify([counts.cfn, counts.ca, counts.cb]))
    check('the other folders are indexed', counts.dfn === 1 && counts.dopen === 1, JSON.stringify([counts.dfn, counts.dopen]))

    // --- MATLAB parses a file with a syntax error to no symbols at all, so such a file is
    // --- listed from the declarations in its text
    const dbroken = await symbolsNamed('dbroken')
    const dbrokenLocal = await symbolsNamed('dbrokenLocal')
    // 12 is SymbolKind.Function, and the name starts at character 13 of the first line
    check('a function file with a syntax error is listed, local function included',
        dbroken.length === 1 && dbroken[0].location.uri.endsWith('/D/dbroken.m') && dbroken[0].kind === 12 &&
            dbroken[0].location.range.start.line === 0 && dbroken[0].location.range.start.character === 13 && dbrokenLocal.length === 1,
        JSON.stringify({ dbroken, dbrokenLocal }))
    const kindsAndContainers = async names => (await Promise.all(names.map(symbolsNamed))).map(symbols => symbols.map(s => [s.kind, s.containerName]))
    const parsedClass = await kindsAndContainers(['PkGood', 'pkGoodMethod', 'pkGoodLocal'])
    const unparsableClass = await kindsAndContainers(['PkBroken', 'pkBrokenMethod', 'pkBrokenLocal'])
    check('a classdef with a syntax error is listed with the kinds and containers of a classdef that parses',
        parsedClass.every(symbols => symbols.length === 1) && JSON.stringify(unparsableClass) === JSON.stringify(parsedClass).replace(/PkGood/g, 'PkBroken'),
        `parsed ${JSON.stringify(parsedClass)}, with a syntax error ${JSON.stringify(unparsableClass)}`)

    // --- an open document with a syntax error is listed too, and one typed into a syntax
    // --- error keeps the symbols of its last good parse
    notify('textDocument/didOpen', {
        textDocument: { uri: pathToFileURL(path.join(scratch, 'openBroken.m')).href, languageId: 'matlab', version: 1, text: 'function openBroken\nx = (;\nend\n' }
    })
    check('an open document with a syntax error is listed', await waitFor(async () => (await symbolUris('openBroken')).length === 1, 20 * 1000))
    const typedUri = pathToFileURL(path.join(scratch, 'typed.m')).href
    notify('textDocument/didOpen', { textDocument: { uri: typedUri, languageId: 'matlab', version: 1, text: 'function r = typedGood(x)\nr = x;\nend\n' } })
    const typedListed = await waitFor(async () => (await symbolUris('typedGood')).length === 1, 20 * 1000)
    notify('textDocument/didChange', {
        textDocument: { uri: typedUri, version: 2 },
        contentChanges: [{ text: 'function r = typedGood(x)\nr = (x;\nend\n\nfunction typedNew\nend\n' }]
    })
    // An edit is indexed 500 ms after it is made
    await sleep(5000)
    check('a document typed into a syntax error keeps the symbols of its last good parse',
        typedListed && (await symbolUris('typedGood')).length === 1 && (await symbolUris('typedNew')).length === 0)

    // --- adding B crawls B alone, with its own progress
    workspaceFolders = [A, C, D, B]
    notify('workspace/didChangeWorkspaceFolders', { event: { added: [B], removed: [] } })
    const secondEnded = await waitFor(() => tokens().length >= 2 && eventsOf(tokens()[1]).some(e => e.kind === 'end'), 60 * 1000)
    check('adding a folder crawls it with its own progress', secondEnded, `${tokens().length} progress tokens`)
    if (secondEnded) {
        checkProgress('added folder', tokens()[1], 2)
    }
    const bIndexed = await waitFor(async () => (await symbolUris('bfn')).length === 1 && (await symbolUris('bsub')).length === 1, 10 * 1000)
    check('the added folder is indexed', bIndexed)

    // --- removing D, which is not the first folder, drops it except the open file
    workspaceFolders = [A, C, B]
    notify('workspace/didChangeWorkspaceFolders', { event: { added: [], removed: [D] } })
    const dropped = await waitFor(async () => (await symbolUris('dfn')).length === 0, 5 * 1000)
    check('a removed folder leaves the index', dropped)
    check('the file with a syntax error of a removed folder leaves the index', (await symbolUris('dbroken')).length === 0 && (await symbolUris('dbrokenLocal')).length === 0)
    check('an open file of the removed folder stays indexed', (await symbolUris('dopen')).length === 1)
    check('the other folders stay indexed', (await symbolUris('a1')).length === 1 && (await symbolUris('bfn')).length === 1)

    // --- adding E while every background pool worker sleeps for longer than the silence
    // --- warning time: the crawl waits for a worker, then ends at 100 and indexes E
    const filled = await fevalOverWire('evalin', 0, ['base', `indexingSmokePool = backgroundPool; for k = 1:indexingSmokePool.NumWorkers, indexingSmokeBusy(k) = parfeval(indexingSmokePool, @() pause(${POOL_BUSY_S}), 0); end`])
    const pool = await fevalOverWire('evalin', 1, ['base', '[numel(indexingSmokePool.FevalQueue.RunningFutures) + numel(indexingSmokePool.FevalQueue.QueuedFutures), indexingSmokePool.NumWorkers]'])
    const addedAt = Date.now() - t0
    workspaceFolders = [A, C, B, E]
    notify('workspace/didChangeWorkspaceFolders', { event: { added: [E], removed: [] } })
    const busyEnded = await waitFor(() => tokens().length >= 3 && eventsOf(tokens()[2]).some(e => e.kind === 'end'), (POOL_BUSY_S + 60) * 1000)
    check('a folder added while the background pool is busy is crawled', busyEnded, `filling the pool: ${JSON.stringify(filled)}; futures queued or running, and workers: ${JSON.stringify(pool)}`)
    if (busyEnded) {
        const endedAt = progress.filter(p => p.token === tokens()[2]).pop().at
        check('that crawl waited for a worker for longer than the silence warning time', endedAt - addedAt > CRAWL_SILENCE_WARNING_MS,
            `ended ${((endedAt - addedAt) / 1000).toFixed(1)} s after the folder was added`)
        checkProgress('folder added while the pool is busy', tokens()[2], 2)
    }
    const eIndexed = await waitFor(async () => (await symbolUris('efn')).length === 1 && (await symbolUris('esub')).length === 1, 10 * 1000)
    check('the folder added while the pool was busy is indexed', eIndexed)

    // --- adding S, whose only file parses for longer than the silence warning time, and
    // --- then G once that crawl has stalled: G is crawled and indexed while S still parses
    workspaceFolders = [A, C, B, E, S]
    notify('workspace/didChangeWorkspaceFolders', { event: { added: [S], removed: [] } })
    const slowBegun = await waitFor(() => tokens().length >= 4, 60 * 1000)
    check('adding a folder with a slow file starts its crawl', slowBegun, `${tokens().length} progress tokens`)
    if (!slowBegun) return
    const slowToken = tokens()[3]
    const stallWarning = new RegExp(`No workspace indexing result for ${CRAWL_SILENCE_WARNING_MS} ms while MATLAB parses \\S*/S/slowGen\\.m`)
    const stalled = await waitFor(() => stallWarning.test(serverLog()), CRAWL_SILENCE_WARNING_MS + 60 * 1000)
    const stalledAt = Date.now() - t0
    check('the slow crawl warns that MATLAB still parses slowGen.m', stalled, `seen ${((stalledAt - timeOf(slowToken, 'begin')) / 1000).toFixed(1)} s after its progress began`)
    if (!stalled) return

    workspaceFolders = [A, C, B, E, S, G]
    notify('workspace/didChangeWorkspaceFolders', { event: { added: [G], removed: [] } })
    const gEnded = await waitFor(() => tokens().length >= 5 && eventsOf(tokens()[4]).some(e => e.kind === 'end'), 30 * 1000)
    const slowStillParsing = !eventsOf(slowToken).some(e => e.kind === 'end')
    check('a folder added once a crawl stalls is crawled while the stalled crawl still parses', gEnded && slowStillParsing,
        gEnded ? `ended ${((timeOf(tokens()[4], 'end') - stalledAt) / 1000).toFixed(1)} s after it was added; the slow crawl ${slowStillParsing ? 'had not ended' : 'had already ended'}` : `no end within 30 s (${tokens().length} progress tokens)`)
    if (gEnded) {
        checkProgress('folder added while a crawl stalls', tokens()[4], 1)
    }
    check('that folder is indexed and the slow file is not yet', (await symbolUris('gfn')).length === 1 && (await symbolUris('slowGen')).length === 0)

    // --- cancelling the stalled crawl in MATLAB, as the server does when it gives a crawl up
    // --- while MATLAB is ready, frees its worker, and the report of it ends the progress
    const cancelledAt = Date.now() - t0
    const cancelled = await fevalOverWire('evalin', 0, ['base', "indexingSmokeChannels = matlabls.handlers.indexing.crawlFutures('channels'); for k = 1:numel(indexingSmokeChannels), matlabls.handlers.indexing.cancelCrawl(indexingSmokeChannels{k}); end"])
    const slowEnded = await waitFor(() => eventsOf(slowToken).some(e => e.kind === 'end'), 20 * 1000)
    const slowPercentages = eventsOf(slowToken).filter(e => e.kind === 'report').map(e => e.percentage)
    check('cancelling the stalled crawl in MATLAB ends its progress without 100', slowEnded && !slowPercentages.includes(100),
        `${slowEnded ? `ended ${((timeOf(slowToken, 'end') - cancelledAt) / 1000).toFixed(1)} s after the cancel was sent` : 'no end within 20 s'}; percentages ${JSON.stringify(slowPercentages)}; cancel ${JSON.stringify(cancelled)}`)
    check('the server logs the cancellation MATLAB reported', /Workspace indexing failed in MATLAB: Execution of the future was cancelled/.test(serverLog()))
    // indexingSmokePool was set to backgroundPool when the pool was filled
    const futures = await fevalOverWire('evalin', 1, ['base', 'numel(indexingSmokePool.FevalQueue.RunningFutures) + numel(indexingSmokePool.FevalQueue.QueuedFutures)'])
    const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : [value]
    check('the cancelled crawl holds no worker', futures !== undefined && JSON.stringify(flatten(futures.result)) === '[0]', `futures queued or running: ${JSON.stringify(futures)}`)
}

/** The server's log so far. */
function serverLog () {
    const prefix = `matlabls_${child.pid}`
    return fs.readdirSync(os.tmpdir())
        .filter(name => name === prefix || name.startsWith(`${prefix}_`))
        .map(name => {
            try {
                return fs.readFileSync(path.join(os.tmpdir(), name, 'languageServerLog.txt'), 'utf8')
            } catch {
                return ''
            }
        })
        .join('\n')
}

/** When the progress of the token first reported an event of the kind. */
function timeOf (token, kind) {
    const event = progress.find(p => p.token === token && p.value.kind === kind)
    return event === undefined ? NaN : event.at
}

async function finish (code) {
    let leftovers = []
    if (child !== undefined && child.exitCode === null) {
        const descendants = descendantsOf(child.pid)
        child.kill('SIGTERM')
        await sleep(8000)
        const alive = new Set(execFileSync('ps', ['-eo', 'pid=']).toString().trim().split('\n').map(p => Number(p.trim())))
        leftovers = descendants.filter(d => alive.has(d.pid))
        for (const d of leftovers) {
            try { process.kill(d.pid, 'SIGKILL') } catch {}
        }
    }
    console.log(`processes left behind by the server and killed: ${leftovers.map(d => `${d.pid} ${d.comm}`).join(', ') || 'none'}`)
    try {
        fs.chmodSync(path.join(scratch, 'A/src/zzUnreadable.m'), 0o644)
    } catch {}
    fs.rmSync(scratch, { recursive: true, force: true })

    const failed = results.filter(r => !r.ok)
    console.log('')
    console.log(`INDEXING SMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed (${seconds()})`)
    if (failed.length > 0) {
        console.log('FAILED: ' + failed.map(f => f.name).join('; '))
    }
    process.exit(code !== 0 ? code : (failed.length === 0 ? 0 : 1))
}

const hardTimeout = setTimeout(() => {
    console.error(`SMOKE ERROR: no result within ${HARD_TIMEOUT_MS / 60000} min`)
    void finish(2)
}, HARD_TIMEOUT_MS)

main().then(() => {
    clearTimeout(hardTimeout)
    return finish(0)
}, err => {
    clearTimeout(hardTimeout)
    console.error('SMOKE ERROR:', err)
    return finish(2)
})
