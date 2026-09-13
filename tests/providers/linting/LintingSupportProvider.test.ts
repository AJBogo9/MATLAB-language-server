// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { CodeAction, CodeActionParams, Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'

import getMockConnection from '../../mocks/Connection.mock'
import getMockMvm from '../../mocks/Mvm.mock'

import ClientConnection from '../../../src/ClientConnection'
import ConfigurationManager from '../../../src/lifecycle/ConfigurationManager'
import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import Logger from '../../../src/logging/Logger'
import LintingSupportProvider from '../../../src/providers/linting/LintingSupportProvider'

// Stands in for the mlint executable. It records the path it was handed next to itself,
// and its own file name picks the behaviour: mlint-echo reports the linted name and the
// first line of its content, mlint-big writes more than 1 MB, mlint-fail exits non-zero.
const FAKE_MLINT = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const file = process.argv[2]
fs.writeFileSync(path.join(__dirname, 'last-linted.txt'), file)
const mode = path.basename(__filename)
if (mode === 'mlint-fail') {
    process.exit(3)
} else if (mode === 'mlint-big') {
    const lines = []
    for (let i = 1; i <= 15000; i++) {
        lines.push('L ' + i + ' (C 1): BIG: ML1: ' + 'x'.repeat(80))
    }
    process.stderr.write(lines.join('\\n'))
} else {
    const firstLine = fs.readFileSync(file, 'utf8').split('\\n')[0]
    process.stderr.write('L 1 (C 1): ECHO: ML1: ' + path.basename(file) + '|' + firstLine + '\\n')
}
`

const REAL_MLINT = '/usr/local/MATLAB/R2026a/bin/glnxa64/mlint'

const DOC_URI = 'file:///nonexistent-lint-dir/myFunc.m'
const DOC_TEXT = 'function y = myFunc(x)\ny = x + 1\nend\n'

// Unconfigured, mlint reports NASGU twice, NOPRT and AGROW for this function.
const CONFIGURED_BODY = [
    'function f()',
    'x = 1;',
    'y = 2',
    'q = [];',
    'for i = 1:3',
    '    q(end+1) = i;',
    'end',
    'disp(q)',
    'end',
    ''
].join('\n')

async function settleWithin<T> (promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`lintDocument did not settle within ${ms} ms`)), ms)
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}

async function waitUntil (condition: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('condition not met in time')
        }
        await new Promise(resolve => setImmediate(resolve))
    }
}

function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
}

describe('LintingSupportProvider', function () {
    this.timeout(15000)

    let fakeDir: string | undefined
    let provider: LintingSupportProvider
    let lifecycle: MatlabLifecycleManager
    let mockMvm: any
    let mockConnection: any
    let getConnectionStub: sinon.SinonStub
    let mlintPathStub: sinon.SinonStub

    const fakeMlint = (mode: 'echo' | 'big' | 'fail'): string => path.join(fakeDir as string, `mlint-${mode}`)
    const recordFile = (): string => path.join(fakeDir as string, 'last-linted.txt')
    const lastLintedPath = (): string => fs.readFileSync(recordFile(), 'utf8')

    const published = (): Array<{ uri: string, diagnostics: Diagnostic[] }> =>
        mockConnection.sendDiagnostics.getCalls().map((call: sinon.SinonSpyCall) => call.args[0])

    const allDiagnostics = (): Diagnostic[] =>
        published().reduce<Diagnostic[]>((acc, p) => acc.concat(p.diagnostics), [])

    const publishedCodes = (): string[][] =>
        published().map(p => p.diagnostics.map(d => String(d.code)))

    const newDoc = (): TextDocument => TextDocument.create(DOC_URI, 'matlab', 1, DOC_TEXT)

    before(function () {
        if (process.platform === 'win32') {
            this.skip()
        }
        fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-mlint-'))
        for (const mode of ['echo', 'big', 'fail'] as const) {
            fs.writeFileSync(fakeMlint(mode), FAKE_MLINT, { mode: 0o755 })
        }
    })

    after(() => {
        if (fakeDir !== undefined) {
            fs.rmSync(fakeDir, { recursive: true, force: true })
        }
        ClientConnection._clearConnection()
    })

    beforeEach(() => {
        fs.rmSync(recordFile(), { force: true })

        mockConnection = getMockConnection()
        ClientConnection._setConnection(mockConnection)

        lifecycle = new MatlabLifecycleManager()
        mockMvm = getMockMvm()
        mockMvm.isReady.returns(false)
        provider = new LintingSupportProvider(lifecycle, mockMvm)

        sinon.stub(ConfigurationManager, 'getConfiguration').resolves({ maxFileSizeForAnalysis: 0, installPath: '' } as any)
        sinon.stub(Logger, 'error')
        getConnectionStub = sinon.stub(lifecycle, 'getMatlabConnection').resolves(null)
        mlintPathStub = sinon.stub(provider as any, 'getMlintExecutable').resolves(fakeMlint('echo'))
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('without MATLAB', () => {
        it('lints the text of the open buffer, not the file saved on disk', async () => {
            await settleWithin(provider.lintDocument(newDoc()), 5000)

            const echo = allDiagnostics().find(d => d.code === 'ECHO')
            assert.ok(echo !== undefined, `expected a diagnostic from the buffer; published ${JSON.stringify(publishedCodes())}`)
            assert.strictEqual((echo as Diagnostic).message.split('|')[1], 'function y = myFunc(x)')
        })

        it('does not wait for a MATLAB launch that is still in progress', async () => {
            getConnectionStub.returns(new Promise(() => {}))
            sinon.stub(lifecycle, 'isMatlabConnected').returns(true)

            await settleWithin(provider.lintDocument(newDoc()), 2000)

            assert.ok(allDiagnostics().some(d => d.code === 'ECHO'), JSON.stringify(publishedCodes()))
        })

        it('uses mlint while a connection exists but the MVM is not ready yet', async () => {
            getConnectionStub.resolves({} as any)

            await settleWithin(provider.lintDocument(newDoc()), 5000)

            assert.ok(allDiagnostics().some(d => d.code === 'ECHO'), JSON.stringify(publishedCodes()))
        })

        it('lints under the document\'s own file name, in a fresh temporary folder', async () => {
            await settleWithin(provider.lintDocument(newDoc()), 5000)

            // mlint reports BDFIL for a mktemp-style name, and for a renamed but valid
            // name it offers an FNDEF fix that rewrites the function name to the temp name.
            const lintedPath = lastLintedPath()
            assert.strictEqual(path.basename(lintedPath), 'myFunc.m')
            assert.ok(path.dirname(lintedPath).startsWith(os.tmpdir()), `linted ${lintedPath}`)
            assert.notStrictEqual(path.dirname(lintedPath), os.tmpdir(), 'the copy must get its own folder')
        })

        it('removes the temporary folder after linting', async () => {
            await settleWithin(provider.lintDocument(newDoc()), 5000)

            const lintedDir = path.dirname(lastLintedPath())
            assert.ok(lintedDir.startsWith(os.tmpdir()), `linted in ${lintedDir}`)
            assert.ok(!fs.existsSync(lintedDir), `${lintedDir} was left behind`)
        })

        it('removes the temporary folder when mlint fails', async () => {
            mlintPathStub.resolves(fakeMlint('fail'))

            await settleWithin(provider.lintDocument(newDoc()), 5000)

            const lintedDir = path.dirname(lastLintedPath())
            assert.ok(lintedDir.startsWith(os.tmpdir()), `linted in ${lintedDir}`)
            assert.ok(!fs.existsSync(lintedDir), `${lintedDir} was left behind`)
        })

        it('keeps the diagnostics already shown when mlint fails', async () => {
            mlintPathStub.resolves(fakeMlint('fail'))

            await settleWithin(provider.lintDocument(newDoc()), 5000)

            assert.ok(fs.existsSync(recordFile()), 'precondition: the failing mlint actually ran')
            assert.deepStrictEqual(published(), [], 'an empty list after a failed lint reads as a clean file')
        })

        it('publishes every diagnostic when mlint writes more than 1 MB', async () => {
            mlintPathStub.resolves(fakeMlint('big'))

            await settleWithin(provider.lintDocument(newDoc()), 10000)

            assert.strictEqual(allDiagnostics().filter(d => d.code === 'BIG').length, 15000)
        })

        it('settles without publishing when mlint cannot be started', async () => {
            // A NUL byte makes execFile throw synchronously rather than call back.
            mlintPathStub.resolves(path.join(fakeDir as string, 'bad' + String.fromCharCode(0) + 'name'))

            await settleWithin(provider.lintDocument(newDoc()), 2000)

            assert.deepStrictEqual(published(), [])
        })
    })

    describe('with the real mlint executable', () => {
        let projectDir: string | undefined

        before(function () {
            if (!fs.existsSync(REAL_MLINT)) {
                this.skip()
            }
            projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-project-'))
            fs.mkdirSync(path.join(projectDir, 'resources'), { recursive: true })
            fs.mkdirSync(path.join(projectDir, 'sub', 'resources'), { recursive: true })
            fs.writeFileSync(path.join(projectDir, 'resources', 'codeAnalyzerConfiguration.json'), '{"checks":{"NASGU":{"enabled":false}}}\n')
            fs.writeFileSync(path.join(projectDir, 'sub', 'resources', 'codeAnalyzerConfiguration.json'), '{"checks":{"NOPRT":{"enabled":false}}}\n')
        })

        after(() => {
            if (projectDir !== undefined) {
                fs.rmSync(projectDir, { recursive: true, force: true })
            }
        })

        it('applies the project\'s Code Analyzer settings from every parent folder', async () => {
            mlintPathStub.resolves(REAL_MLINT)
            // f.m does not exist on disk: only the buffer and the project settings do.
            const uri = URI.file(path.join(projectDir as string, 'sub', 'f.m')).toString()

            await settleWithin(provider.lintDocument(TextDocument.create(uri, 'matlab', 1, CONFIGURED_BODY)), 10000)

            // The outer settings disable NASGU and the inner ones NOPRT. AGROW is enabled
            // in both, so it proves mlint ran.
            assert.deepStrictEqual(publishedCodes(), [['AGROW']])
        })
    })

    describe('with MATLAB', () => {
        it('lints through MATLAB and never runs mlint once the MVM is ready', async () => {
            mockMvm.isReady.returns(true)
            getConnectionStub.resolves({} as any)
            const viaMatlab = sinon.stub(provider as any, 'getLintResultsFromMatlab').resolves(['L 1 (C 1): VIAML: ML1: from MATLAB'])
            const viaMlint = sinon.stub(provider as any, 'getLintResultsFromExecutable').resolves(['L 1 (C 1): VIAMLINT: ML1: from mlint'])

            await settleWithin(provider.lintDocument(newDoc()), 2000)

            assert.strictEqual(viaMatlab.callCount, 1)
            assert.strictEqual(viaMlint.callCount, 0)
            assert.deepStrictEqual(publishedCodes(), [['VIAML']])
        })
    })

    describe('superseded results', () => {
        it('drops a result for a document edited while it was being linted', async () => {
            const pending = deferred<string[]>()
            sinon.stub(provider as any, 'getLintResultsFromExecutable').returns(pending.promise)
            const doc = newDoc()

            const lint = provider.lintDocument(doc)
            TextDocument.update(doc, [{ text: 'y = 2' }], 2)
            pending.resolve([
                'L 2 (C 3): STALE: ML0: describes version 1  (CAN FIX)',
                '----FIX MESSAGE<STALEf>  <Stale fix.>',
                '----CHANGE MESSAGE L 2 (C 9);  L 2 (C 8):   <;>'
            ])
            await settleWithin(lint, 2000)

            assert.ok(!allDiagnostics().some(d => d.code === 'STALE'), JSON.stringify(publishedCodes()))
            assert.deepStrictEqual((provider as any)._availableCodeActions.get(DOC_URI) ?? [], [])
        })

        it('drops an older result that arrives after a newer one for the same version', async () => {
            const older = deferred<string[]>()
            const newer = deferred<string[]>()
            const linter = sinon.stub(provider as any, 'getLintResultsFromExecutable')
            linter.onFirstCall().returns(older.promise)
            linter.onSecondCall().returns(newer.promise)
            const doc = newDoc()

            const first = provider.lintDocument(doc)
            await waitUntil(() => linter.callCount === 1)
            const second = provider.lintDocument(doc)
            await waitUntil(() => linter.callCount === 2)

            newer.resolve(['L 1 (C 1): NEWER: ML1: newer'])
            await settleWithin(second, 2000)
            older.resolve(['L 1 (C 1): OLDER: ML1: older'])
            await settleWithin(first, 2000)

            const last = published()[published().length - 1]
            assert.deepStrictEqual(last.diagnostics.map(d => d.code), ['NEWER'])
            assert.ok(!allDiagnostics().some(d => d.code === 'OLDER'), JSON.stringify(publishedCodes()))
        })
    })

    describe('closing a document', () => {
        it('cancels a lint still waiting for the typing pause', () => {
            const clock = sinon.useFakeTimers()
            try {
                const lint = sinon.stub(provider, 'lintDocument').resolves()
                const closed = newDoc()
                const stillOpen = TextDocument.create('file:///nonexistent-lint-dir/other.m', 'matlab', 1, DOC_TEXT)

                provider.queueLintingForDocument(closed)
                provider.queueLintingForDocument(stillOpen)
                provider.clearDiagnosticsForDocument(closed)
                clock.tick(5000)

                // The document left open proves the timers ran at all.
                assert.deepStrictEqual(lint.getCalls().map(call => (call.args[0] as TextDocument).uri), [stillOpen.uri])
            } finally {
                clock.restore()
            }
        })

        it('does not publish a lint that finishes after the document closed', async () => {
            const pending = deferred<string[]>()
            const linter = sinon.stub(provider as any, 'getLintResultsFromExecutable').returns(pending.promise)
            const doc = newDoc()

            const lint = provider.lintDocument(doc)
            await waitUntil(() => linter.callCount === 1)
            provider.clearDiagnosticsForDocument(doc)
            pending.resolve(['L 1 (C 1): LATE: ML1: finished after close'])
            await settleWithin(lint, 2000)

            assert.deepStrictEqual(publishedCodes(), [[]], 'only the clear sent on close')
        })
    })

    describe('code actions', () => {
        const warningParams = (): CodeActionParams => ({
            textDocument: { uri: DOC_URI },
            range: Range.create(1, 0, 1, 9),
            context: {
                diagnostics: [Diagnostic.create(Range.create(1, 0, 1, 9), 'Add a semicolon.', DiagnosticSeverity.Warning, 'NOPRT', 'MATLAB')]
            }
        })

        const suppressionTitles = (actions: CodeAction[]): string[] =>
            actions.map(action => action.title).filter(title => title.startsWith('Suppress'))

        it('offers no suppression while connected but before the MVM can run it', () => {
            sinon.stub(lifecycle, 'isMatlabConnected').returns(true)
            mockMvm.isReady.returns(false)

            assert.deepStrictEqual(suppressionTitles(provider.handleCodeActionRequest(warningParams())), [])
        })

        it('offers suppression once the MVM is ready', () => {
            sinon.stub(lifecycle, 'isMatlabConnected').returns(true)
            mockMvm.isReady.returns(true)

            assert.strictEqual(suppressionTitles(provider.handleCodeActionRequest(warningParams())).length, 2)
        })
    })
})
