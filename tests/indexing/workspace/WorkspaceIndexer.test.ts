// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'

import ClientConnection from '../../../src/ClientConnection'
import FileInfoIndex from '../../../src/indexing/FileInfoIndex'
import WorkspaceIndexer from '../../../src/indexing/WorkspaceIndexer'
import ClientCapabilitiesManager from '../../../src/lifecycle/ClientCapabilitiesManager'
import ConfigurationManager from '../../../src/lifecycle/ConfigurationManager'
import Logger from '../../../src/logging/Logger'

type CrawlResult = 'done' | 'aborted' | 'unavailable'

interface CrawlOptions {
    onStart?: () => Promise<void>
    onFileDone?: (uri: string) => void
    shouldStore?: (uri: string) => boolean
}

interface Crawl {
    filePaths: string[]
    options: CrawlOptions
    finish: (result: CrawlResult) => Promise<void>
    fail: (error: Error) => Promise<void>
}

function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: Error) => void } {
    let resolve: (value: T) => void = () => {}
    let reject: (error: Error) => void = () => {}
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
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

const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve))
    }
}

const sorted = (paths: string[]): string[] => [...paths].sort()

describe('WorkspaceIndexer', function () {
    let root = ''
    let folderChangeHandler: ((event: any) => void) | undefined
    let connection: any
    let reporters: any[]
    let crawls: Crawl[]
    let indexer: any
    let fileInfoIndex: FileInfoIndex
    let openDocuments: Set<string>
    let workspaceIndexer: WorkspaceIndexer
    let settings: { indexWorkspace: boolean, maxFileSizeForAnalysis: number }

    const folder = (name: string): { uri: string, name: string } => ({ uri: URI.file(path.join(root, name)).toString(), name })
    const write = (relativePath: string): string => {
        const fullPath = path.join(root, relativePath)
        fs.mkdirSync(path.dirname(fullPath), { recursive: true })
        fs.writeFileSync(fullPath, 'x = 1;\n')
        return fullPath
    }

    /** Starts the crawl the way Indexer.indexFiles does, then reports every file. */
    const startAndReportAll = async (crawl: Crawl, count = crawl.filePaths.length): Promise<void> => {
        await crawl.options.onStart?.()
        for (const filePath of crawl.filePaths.slice(0, count)) {
            crawl.options.onFileDone?.(URI.file(filePath).toString())
        }
    }

    before(function () {
        if (process.platform === 'win32') {
            this.skip()
        }
    })

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspaceIndexer-')))
        folderChangeHandler = undefined
        reporters = []
        crawls = []
        openDocuments = new Set()
        settings = { indexWorkspace: true, maxFileSizeForAnalysis: 0 }

        connection = {
            workspace: {
                getWorkspaceFolders: sinon.stub().resolves([]),
                getConfiguration: sinon.stub().resolves([null, null]),
                onDidChangeWorkspaceFolders: (handler: (event: any) => void) => { folderChangeHandler = handler }
            },
            window: {
                createWorkDoneProgress: sinon.spy(async () => {
                    const reporter = { begin: sinon.spy(), report: sinon.spy(), done: sinon.spy() }
                    reporters.push(reporter)
                    return reporter
                })
            }
        }
        ClientConnection._setConnection(connection)
        ClientCapabilitiesManager.initialize({ workspace: { workspaceFolders: true, configuration: true } })
        sinon.stub(ConfigurationManager, 'getConfiguration').callsFake(async () => settings as any)
        sinon.stub(Logger, 'error')
        sinon.stub(Logger, 'warn')

        indexer = {
            indexFiles: sinon.spy((filePaths: string[], options: CrawlOptions = {}) => {
                const result = deferred<CrawlResult>()
                const crawl: Crawl = {
                    filePaths,
                    options,
                    finish: async (value: CrawlResult) => { result.resolve(value); await flush() },
                    fail: async (error: Error) => { result.reject(error); await flush() }
                }
                crawls.push(crawl)
                return result.promise
            })
        }
        fileInfoIndex = new FileInfoIndex()
        workspaceIndexer = new WorkspaceIndexer(indexer, fileInfoIndex, (uri: string) => openDocuments.has(uri))
        workspaceIndexer.setupCallbacks()
    })

    afterEach(() => {
        sinon.restore()
        ClientConnection._clearConnection()
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('shows progress with a file count, reports 100 only once the crawl is done, and ends it once', async () => {
        for (let i = 1; i <= 250; i++) {
            write(`proj/f${i}.m`)
        }
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        const crawl = crawls[0]
        assert.strictEqual(crawl.filePaths.length, 250)
        await startAndReportAll(crawl)

        sinon.assert.calledOnce(connection.window.createWorkDoneProgress)
        const reporter = reporters[0]
        sinon.assert.calledOnceWithExactly(reporter.begin, 'Indexing MATLAB files', 0, '0/250 files', false)
        const percentages = reporter.report.getCalls().map((call: sinon.SinonSpyCall) => call.args[0])
        assert.ok(percentages.length > 0)
        assert.ok(percentages.every((p: number, i: number) => i === 0 || p > percentages[i - 1]), JSON.stringify(percentages))
        assert.ok(percentages.every((p: number) => p < 100), 'no 100 before the crawl finishes')
        sinon.assert.calledWithExactly(reporter.report, 40, '100/250 files')
        sinon.assert.notCalled(reporter.done)

        await crawl.finish('done')
        await indexing

        const last = reporter.report.lastCall
        assert.deepStrictEqual(last.args, [100, '250/250 files'])
        sinon.assert.calledOnce(reporter.done)
        assert.ok(reporter.done.firstCall.calledAfter(last))
        // A finished run is no longer tracked for folder removals
        assert.strictEqual((workspaceIndexer as any).runs.size, 0)
    })

    it('never reports 100 for a crawl that gave up, and still ends the progress once', async () => {
        for (let i = 1; i <= 10; i++) {
            write(`proj/f${i}.m`)
        }
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        await startAndReportAll(crawls[0], 10)
        await crawls[0].finish('aborted')
        await indexing

        const reporter = reporters[0]
        const percentages = reporter.report.getCalls().map((call: sinon.SinonSpyCall) => call.args[0])
        assert.ok(percentages.every((p: number) => p < 100), JSON.stringify(percentages))
        sinon.assert.calledOnce(reporter.done)
    })

    it('shows no progress when MATLAB is not there to crawl', async () => {
        write('proj/a.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        await crawls[0].finish('unavailable')
        await indexing

        sinon.assert.notCalled(connection.window.createWorkDoneProgress)
    })

    it('neither crawls nor shows progress for a workspace without .m files', async () => {
        fs.mkdirSync(path.join(root, 'empty'))
        write('empty/readme.txt')
        connection.workspace.getWorkspaceFolders.resolves([folder('empty')])

        await workspaceIndexer.indexWorkspace()

        sinon.assert.notCalled(indexer.indexFiles)
        sinon.assert.notCalled(connection.window.createWorkDoneProgress)
    })

    it('does nothing when workspace indexing is off', async () => {
        settings.indexWorkspace = false
        write('proj/a.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])

        await workspaceIndexer.indexWorkspace()
        folderChangeHandler?.({ added: [folder('proj')], removed: [] })
        await flush()
        // Waits out a crawl the added folder would have queued, walk included
        await (workspaceIndexer as any).lastRun

        sinon.assert.notCalled(connection.workspace.getWorkspaceFolders)
        sinon.assert.notCalled(indexer.indexFiles)
    })

    it('reads files.exclude and search.exclude for each folder and leaves out what they exclude', async () => {
        write('proj/src/z.m')
        write('proj/keep/k.m')
        write('proj/gen/g.m')
        write('proj/vendor/v.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])
        connection.workspace.getConfiguration.resolves([{ '**/gen': true }, { '**/vendor': true, '**/keep': false }])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)

        sinon.assert.calledOnceWithExactly(connection.workspace.getConfiguration, [
            { scopeUri: folder('proj').uri, section: 'files.exclude' },
            { scopeUri: folder('proj').uri, section: 'search.exclude' }
        ])
        assert.deepStrictEqual(sorted(crawls[0].filePaths), sorted([path.join(root, 'proj/src/z.m'), path.join(root, 'proj/keep/k.m')]))

        await crawls[0].finish('done')
        await indexing
    })

    it('walks each folder with its own files.exclude and search.exclude', async () => {
        for (const name of ['one', 'two']) {
            write(`${name}/a.m`)
            write(`${name}/gen/g.m`)
            write(`${name}/vendor/v.m`)
        }
        connection.workspace.getWorkspaceFolders.resolves([folder('one'), folder('two')])
        connection.workspace.getConfiguration.callsFake(async (items: Array<{ scopeUri: string }>) =>
            items[0].scopeUri === folder('one').uri ? [{ '**/gen': true }, null] : [null, { '**/vendor': true }])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)

        assert.deepStrictEqual(sorted(crawls[0].filePaths), sorted([
            path.join(root, 'one/a.m'),
            path.join(root, 'one/vendor/v.m'),
            path.join(root, 'two/a.m'),
            path.join(root, 'two/gen/g.m')
        ]))

        await crawls[0].finish('done')
        await indexing
    })

    it('lets search.exclude keep what files.exclude leaves out under the same key, but never a built-in folder', async () => {
        write('proj/src/z.m')
        write('proj/gen/g.m')
        write('proj/out/gen/o.m')
        write('proj/node_modules/n.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])
        connection.workspace.getConfiguration.resolves([{ '**/gen': true }, { '**/gen': false, '**/node_modules': false }])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)

        assert.deepStrictEqual(sorted(crawls[0].filePaths), sorted([
            path.join(root, 'proj/src/z.m'),
            path.join(root, 'proj/gen/g.m'),
            path.join(root, 'proj/out/gen/o.m')
        ]))

        await crawls[0].finish('done')
        await indexing
    })

    it('leaves out generated folders without asking a client that cannot answer', async () => {
        ClientCapabilitiesManager.initialize({ workspace: { workspaceFolders: true } })
        write('proj/src/z.m')
        write('proj/node_modules/x.m')
        write('proj/slprj/y.m')
        write('proj/codegen/mex/foo/c.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)

        sinon.assert.notCalled(connection.workspace.getConfiguration)
        assert.deepStrictEqual(crawls[0].filePaths, [path.join(root, 'proj/src/z.m')])

        await crawls[0].finish('done')
        await indexing
    })

    it('still crawls when the exclusion settings cannot be read', async () => {
        write('proj/src/z.m')
        write('proj/node_modules/x.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])
        connection.workspace.getConfiguration.rejects(new Error('no configuration'))

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)

        assert.deepStrictEqual(crawls[0].filePaths, [path.join(root, 'proj/src/z.m')])
        await crawls[0].finish('done')
        await indexing
    })

    it('still crawls when the client will not show progress', async () => {
        write('proj/a.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('proj')])
        connection.window.createWorkDoneProgress = sinon.stub().rejects(new Error('no progress'))

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        await startAndReportAll(crawls[0])
        await crawls[0].finish('done')
        await indexing

        sinon.assert.notCalled(Logger.error as sinon.SinonStub)
    })

    it('crawls an added folder after the running crawl, and only that folder', async () => {
        write('one/a.m')
        write('two/b.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('one')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        await startAndReportAll(crawls[0])

        folderChangeHandler?.({ added: [folder('two')], removed: [] })
        await flush()
        assert.strictEqual(crawls.length, 1, 'the second crawl must wait for the first')

        await crawls[0].finish('done')
        await indexing
        await waitUntil(() => crawls.length === 2)
        assert.deepStrictEqual(crawls[1].filePaths, [path.join(root, 'two/b.m')])
        await startAndReportAll(crawls[1])
        sinon.assert.calledTwice(connection.window.createWorkDoneProgress)
        await crawls[1].finish('done')
    })

    it('crawls each file of nested workspace folders once', async () => {
        write('ws/a.m')
        write('ws/sub/b.m')
        write('ws/sub/c.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('ws'), folder('ws/sub')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        assert.deepStrictEqual(sorted(crawls[0].filePaths), sorted([path.join(root, 'ws/a.m'), path.join(root, 'ws/sub/b.m'), path.join(root, 'ws/sub/c.m')]))
        await startAndReportAll(crawls[0])
        sinon.assert.calledWith(reporters[0].begin, 'Indexing MATLAB files', 0, '0/3 files', false)

        await crawls[0].finish('done')
        await indexing
    })

    it('skips a workspace folder that is not on disk', async () => {
        write('remote/a.m')
        const remote = { uri: URI.from({ scheme: 'vscode-vfs', authority: 'github', path: path.join(root, 'remote') }).toString(), name: 'remote' }
        connection.workspace.getWorkspaceFolders.resolves([remote])

        await workspaceIndexer.indexWorkspace()

        sinon.assert.notCalled(indexer.indexFiles)
    })

    it('drops a removed folder from the index, but not open documents or files of folders still in the workspace', async () => {
        const uris = {
            removed: URI.file(path.join(root, 'proj/a.m')).toString(),
            open: URI.file(path.join(root, 'proj/open.m')).toString(),
            sibling: URI.file(path.join(root, 'proj2/b.m')).toString(),
            nested: URI.file(path.join(root, 'proj/sub/c.m')).toString(),
            // Under the removed folder, beside a remaining folder whose name it starts with
            nestedNamePrefix: URI.file(path.join(root, 'proj/subway/e.m')).toString(),
            // Outside every workspace folder, as a file indexed for Go to Definition is
            sameNamePrefix: URI.file(path.join(root, 'project/d.m')).toString(),
            untitled: 'untitled:Untitled-1'
        }
        for (const uri of Object.values(uris)) {
            fileInfoIndex.codeInfoCache.set(uri, {} as any)
        }
        openDocuments.add(uris.open)
        connection.workspace.getWorkspaceFolders.resolves([folder('proj2'), folder('proj/sub')])

        folderChangeHandler?.({ added: [], removed: [folder('proj')] })
        await flush()

        assert.deepStrictEqual(sorted([...fileInfoIndex.codeInfoCache.keys()]), sorted([uris.open, uris.sibling, uris.nested, uris.sameNamePrefix, uris.untitled]))
    })

    it('stores and drops the files of a folder whose URI ends in a separator', async () => {
        write('proj/a.m')
        write('proj/sub/b.m')
        // A client may spell a folder URI this way, and a drive root's URI always ends in one
        const slashed = { uri: `${folder('proj').uri}/`, name: 'proj' }
        connection.workspace.getWorkspaceFolders.resolves([slashed])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        assert.deepStrictEqual(sorted(crawls[0].filePaths), sorted([path.join(root, 'proj/a.m'), path.join(root, 'proj/sub/b.m')]))
        const shouldStore = crawls[0].options.shouldStore as (uri: string) => boolean
        assert.strictEqual(shouldStore(URI.file(path.join(root, 'proj/sub/b.m')).toString()), true)
        assert.strictEqual(shouldStore(URI.file(path.join(root, 'project/c.m')).toString()), false)
        await crawls[0].finish('done')
        await indexing

        const removed = URI.file(path.join(root, 'proj/a.m')).toString()
        const outside = URI.file(path.join(root, 'project/c.m')).toString()
        fileInfoIndex.codeInfoCache.set(removed, {} as any)
        fileInfoIndex.codeInfoCache.set(outside, {} as any)
        connection.workspace.getWorkspaceFolders.resolves([])

        folderChangeHandler?.({ added: [], removed: [slashed] })
        await flush()

        assert.deepStrictEqual([...fileInfoIndex.codeInfoCache.keys()], [outside])
    })

    it('drops every file but open documents when the file system root is removed', async () => {
        const uris = {
            file: URI.file(path.join(root, 'proj/a.m')).toString(),
            open: URI.file(path.join(root, 'proj/open.m')).toString(),
            untitled: 'untitled:Untitled-1'
        }
        for (const uri of Object.values(uris)) {
            fileInfoIndex.codeInfoCache.set(uri, {} as any)
        }
        openDocuments.add(uris.open)
        connection.workspace.getWorkspaceFolders.resolves([])

        // Its path already ends in a separator, as a Windows drive root's does
        folderChangeHandler?.({ added: [], removed: [{ uri: URI.file(path.parse(root).root).toString(), name: 'root' }] })
        await flush()

        assert.deepStrictEqual(sorted([...fileInfoIndex.codeInfoCache.keys()]), sorted([uris.open, uris.untitled]))
    })

    it('drops a removed folder when the client reports no remaining folders', async () => {
        const removed = URI.file(path.join(root, 'proj/a.m')).toString()
        fileInfoIndex.codeInfoCache.set(removed, {} as any)
        connection.workspace.getWorkspaceFolders.resolves(null)

        folderChangeHandler?.({ added: [], removed: [folder('proj')] })
        await flush()

        assert.ok(!fileInfoIndex.codeInfoCache.has(removed))
        sinon.assert.notCalled(Logger.error as sinon.SinonStub)
    })

    it('logs instead of throwing when the remaining folders cannot be read', async () => {
        fileInfoIndex.codeInfoCache.set(URI.file(path.join(root, 'proj/a.m')).toString(), {} as any)
        connection.workspace.getWorkspaceFolders.rejects(new Error('client gone'))

        folderChangeHandler?.({ added: [], removed: [folder('proj')] })
        await flush()

        sinon.assert.calledOnce(Logger.error as sinon.SinonStub)
    })

    it('does not store files of a folder removed during the crawl, nor over an open document', async () => {
        write('one/a.m')
        write('one/open.m')
        write('two/b.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('one'), folder('two')])
        openDocuments.add(URI.file(path.join(root, 'one/open.m')).toString())

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        const shouldStore = crawls[0].options.shouldStore as (uri: string) => boolean
        assert.strictEqual(shouldStore(URI.file(path.join(root, 'two/b.m')).toString()), true)
        assert.strictEqual(shouldStore(URI.file(path.join(root, 'one/a.m')).toString()), true)
        assert.strictEqual(shouldStore(URI.file(path.join(root, 'one/open.m')).toString()), false)

        folderChangeHandler?.({ added: [], removed: [folder('two')] })
        await flush()
        assert.strictEqual(shouldStore(URI.file(path.join(root, 'two/b.m')).toString()), false)
        assert.strictEqual(shouldStore(URI.file(path.join(root, 'one/a.m')).toString()), true)

        await crawls[0].finish('done')
        await indexing
    })

    it('does not crawl a queued folder that is removed before its turn', async () => {
        write('one/a.m')
        write('two/b.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('one')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        folderChangeHandler?.({ added: [folder('two')], removed: [] })
        await flush()
        folderChangeHandler?.({ added: [], removed: [folder('two')] })
        await flush()

        await crawls[0].finish('done')
        await indexing
        await flush()
        assert.strictEqual(crawls.length, 1)
    })

    it('ends the progress and moves on to the next crawl when a crawl throws', async () => {
        write('one/a.m')
        write('two/b.m')
        connection.workspace.getWorkspaceFolders.resolves([folder('one')])

        const indexing = workspaceIndexer.indexWorkspace()
        await waitUntil(() => crawls.length === 1)
        await startAndReportAll(crawls[0], 0)
        folderChangeHandler?.({ added: [folder('two')], removed: [] })
        await flush()

        await crawls[0].fail(new Error('boom'))
        await indexing

        sinon.assert.calledOnce(reporters[0].done)
        sinon.assert.calledOnce(Logger.error as sinon.SinonStub)
        await waitUntil(() => crawls.length === 2)
        await crawls[1].finish('done')
    })
})
