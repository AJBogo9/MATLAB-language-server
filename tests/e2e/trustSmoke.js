// Copyright 2026 Andreas Bogossian
/**
 * End-to-end check that MATLAB never starts or attaches in an untrusted workspace. Spawns
 * the real language server over stdio against a live MATLAB install, with a workspace
 * folder whose startup.m (and, in the first scenario, a fullfile.m that shadows MATLAB's)
 * writes a marker file when MATLAB runs it.
 *
 * Scenario A, onStart: the client says the workspace is untrusted. An open file is still
 * linted, and neither the onStart timing, a Connect action, a request for MATLAB nor a
 * formatting request starts a MATLAB process or runs the folder's code. Once the client
 * grants trust, MATLAB starts in that folder and runs its code, which shows the markers
 * would have caught a launch.
 *
 * Scenario B, onDemand: a request for MATLAB is refused while untrusted. After the grant
 * nothing starts by itself, and the next request for MATLAB connects. Before item 17 a
 * refused request left the server ignoring every later one.
 *
 * Before item 17 the server ignored the trust state, and MATLAB started in the folder as
 * soon as the extension activated.
 *
 * Usage: node trustSmoke.js [--matlabRoot=/path/to/MATLAB] [--server=/path/to/index.js]
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
const HARD_TIMEOUT_MS = 10 * 60 * 1000
// How long the untrusted phases watch for a launch. A launch spawns MATLAB within a second or two.
const UNTRUSTED_WATCH_MS = 25000

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trustSmoke-')))
const t0 = Date.now()
const seconds = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
function check (name, condition, detail) {
    results.push({ name, ok: Boolean(condition) })
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}

/** A workspace folder whose code writes a marker file for each file MATLAB runs */
function makeWorkspace (name, { shadowFullfile }) {
    const folder = path.join(scratch, name)
    fs.mkdirSync(folder)
    const markers = { startup: path.join(folder, 'startup.ran'), fullfile: path.join(folder, 'fullfile.ran') }
    fs.writeFileSync(path.join(folder, 'startup.m'), `fid = fopen('${markers.startup}', 'w'); fclose(fid);\n`)
    if (shadowFullfile) {
        fs.writeFileSync(path.join(folder, 'fullfile.m'), [
            'function f = fullfile(varargin)',
            `    fid = fopen('${markers.fullfile}', 'w'); fclose(fid);`,
            '    f = strjoin(cellfun(@char, varargin, \'UniformOutput\', false), filesep);',
            'end',
            ''
        ].join('\n'))
    }
    // A missing semicolon, which mlint reports without MATLAB
    const lintFile = path.join(folder, 'lintme.m')
    fs.writeFileSync(lintFile, 'function lintme\nx = 1\nend\n')
    return { folder, uri: pathToFileURL(folder).href, markers, lintFile, lintUri: pathToFileURL(lintFile).href }
}

const ranMarkers = workspace => Object.entries(workspace.markers).filter(([, file]) => fs.existsSync(file)).map(([name]) => name)

/** MATLAB processes started below the given process */
function matlabDescendants (rootPid) {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
        .trim().split('\n')
        .map(line => line.trim().split(/\s+/))
        .map(([pid, ppid, ...comm]) => ({ pid: Number(pid), ppid: Number(ppid), comm: comm.join(' ') }))
    const found = []
    let frontier = [rootPid]
    while (frontier.length > 0) {
        const children = rows.filter(row => frontier.includes(row.ppid))
        found.push(...children)
        frontier = children.map(row => row.pid)
    }
    return found
}

const matlabProcessesOf = pid => matlabDescendants(pid).filter(row => /matlab/i.test(row.comm))

function killTree (pid) {
    for (const row of matlabDescendants(pid).reverse()) {
        try { process.kill(row.pid, 'SIGKILL') } catch (err) { /* already gone */ }
    }
    try { process.kill(pid, 'SIGKILL') } catch (err) { /* already gone */ }
}

/** Spawns the language server and speaks LSP to it over stdio */
function startServer ({ timing, workspace }) {
    const child = spawn('node', [SERVER, '--stdio', `--matlabInstallPath=${MATLAB_INSTALL_PATH}`, `--matlabConnectionTiming=${timing}`], {
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
                            matlabConnectionTiming: timing,
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

    return {
        child,
        notifications,
        request: (method, params) => {
            const id = nextId++
            const promise = new Promise(resolve => pending.set(id, resolve))
            send({ jsonrpc: '2.0', id, method, params })
            return promise
        },
        notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
        connectionStatuses: () => notifications
            .filter(n => n.method === 'matlab/connection/update/server')
            .map(n => n.params.connectionStatus)
    }
}

async function initialize (server, workspace, trusted) {
    await server.request('initialize', {
        processId: process.pid,
        rootUri: workspace.uri,
        capabilities: {
            textDocument: { synchronization: { dynamicRegistration: false }, publishDiagnostics: {} },
            workspace: { configuration: true, workspaceFolders: true }
        },
        initializationOptions: { workspaceTrusted: trusted },
        workspaceFolders: [{ uri: workspace.uri, name: path.basename(workspace.folder) }]
    })
    server.notify('initialized', {})
}

async function stopServer (server) {
    const exited = new Promise(resolve => server.child.once('exit', resolve))
    await Promise.race([server.request('shutdown', null), sleep(5000)])
    server.notify('exit', null)
    await Promise.race([exited, sleep(5000)])
    killTree(server.child.pid)
}

/** Watches for a MATLAB process, a connection status or a marker; returns what it saw first */
async function watchForLaunch (server, workspace, durationMs) {
    const end = Date.now() + durationMs
    while (Date.now() < end) {
        const processes = matlabProcessesOf(server.child.pid)
        const statuses = server.connectionStatuses()
        const markers = ranMarkers(workspace)
        if (processes.length > 0 || statuses.length > 0 || markers.length > 0) {
            return `after ${seconds()}: processes ${JSON.stringify(processes.map(p => p.comm))}, statuses ${JSON.stringify(statuses)}, markers ${JSON.stringify(markers)}`
        }
        await sleep(1000)
    }
    return null
}

async function waitFor (predicate, timeoutMs) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        if (predicate()) return true
        await sleep(1000)
    }
    return predicate()
}

async function scenarioOnStart () {
    console.log(`\n== Scenario A: onStart, untrusted, then trusted (${seconds()})`)
    const workspace = makeWorkspace('onStart', { shadowFullfile: true })
    const server = startServer({ timing: 'onStart', workspace })
    try {
        await initialize(server, workspace, false)
        server.notify('textDocument/didOpen', {
            textDocument: { uri: workspace.lintUri, languageId: 'matlab', version: 1, text: fs.readFileSync(workspace.lintFile, 'utf8') }
        })
        const linted = await waitFor(() => server.notifications.some(n =>
            n.method === 'textDocument/publishDiagnostics' && n.params.uri === workspace.lintUri && n.params.diagnostics.length > 0), 30000)
        check('an open file is linted in an untrusted workspace', linted)

        server.notify('matlab/connection/update/client', { connectionAction: 'connect' })
        server.notify('matlab/request', {})
        const formatting = await Promise.race([
            server.request('textDocument/formatting', { textDocument: { uri: workspace.lintUri }, options: { tabSize: 4, insertSpaces: true } }),
            sleep(20000).then(() => 'timeout')
        ])
        check('a formatting request is answered without MATLAB in an untrusted workspace', formatting !== 'timeout', JSON.stringify(formatting).slice(0, 120))

        const launch = await watchForLaunch(server, workspace, UNTRUSTED_WATCH_MS)
        check('no MATLAB starts and no workspace code runs for the onStart timing, Connect, a request for MATLAB or formatting', launch === null, launch ?? '')
        check('a request for MATLAB reports that MATLAB is not available', server.notifications.some(n => n.method.startsWith('feature/needsmatlab')))
        // An untrusted workspace is a designed state, so the onStart timing skips it quietly
        const onStartErrors = server.notifications.filter(n => n.method === 'window/logMessage' && n.params.type === 1 && /onStart/.test(n.params.message))
        check('the untrusted start logs no onStart connection error', onStartErrors.length === 0, onStartErrors.map(n => n.params.message).join(' | '))

        server.notify('matlab/workspaceTrust/granted', null)
        const started = await waitFor(() => matlabProcessesOf(server.child.pid).length > 0, 30000)
        check('MATLAB starts once the client grants trust, as the onStart timing asks', started, `after ${seconds()}`)
        const ran = await waitFor(() => ranMarkers(workspace).length > 0, 150000)
        check('MATLAB then runs the trusted folder\'s code, so the markers do catch a launch', ran, `markers ${JSON.stringify(ranMarkers(workspace))} after ${seconds()}`)
    } finally {
        await stopServer(server)
    }
}

async function scenarioOnDemand () {
    console.log(`\n== Scenario B: onDemand, a refused request, a grant, then a request (${seconds()})`)
    const workspace = makeWorkspace('onDemand', { shadowFullfile: false })
    const server = startServer({ timing: 'onDemand', workspace })
    try {
        await initialize(server, workspace, false)

        server.notify('matlab/request', {})
        const refused = await watchForLaunch(server, workspace, 15000)
        check('a request for MATLAB starts nothing in an untrusted workspace', refused === null, refused ?? '')

        server.notify('matlab/workspaceTrust/granted', null)
        const unprompted = await watchForLaunch(server, workspace, 15000)
        check('granting trust starts nothing by itself with the onDemand timing', unprompted === null, unprompted ?? '')

        server.notify('matlab/request', {})
        const connected = await waitFor(() => server.connectionStatuses().includes('connected'), 180000)
        check('the next request for MATLAB, after the grant, connects', connected, `statuses ${JSON.stringify(server.connectionStatuses())} after ${seconds()}`)
        check('MATLAB ran the trusted folder\'s startup.m', ranMarkers(workspace).includes('startup'), JSON.stringify(ranMarkers(workspace)))
    } finally {
        await stopServer(server)
    }
}

async function main () {
    console.log(`server ${SERVER}\nscratch ${scratch}`)
    const hardTimeout = setTimeout(() => {
        console.log('HARD TIMEOUT')
        process.exit(3)
    }, HARD_TIMEOUT_MS)

    await scenarioOnStart()
    await scenarioOnDemand()

    clearTimeout(hardTimeout)
    const failed = results.filter(r => !r.ok)
    console.log(`\nTRUST SMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed (${seconds()})`)
    if (failed.length > 0) {
        console.log('FAILED: ' + failed.map(f => f.name).join('; '))
    }
    fs.rmSync(scratch, { recursive: true, force: true })
    process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(err => {
    console.error('TRUST SMOKE ERROR:', err)
    process.exit(2)
})
