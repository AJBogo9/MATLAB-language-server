// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { URI } from 'vscode-uri'

import getMockConnection from '../mocks/Connection.mock'
import getMockMvm from '../mocks/Mvm.mock'

import ClientConnection from '../../src/ClientConnection'
import FileInfoIndex from '../../src/indexing/FileInfoIndex'
import Indexer, { CRAWL_SILENCE_WARNING_MS, CrawlOptions } from '../../src/indexing/Indexer'
import ConfigurationManager from '../../src/lifecycle/ConfigurationManager'
import MatlabLifecycleManager from '../../src/lifecycle/MatlabLifecycleManager'
import Logger from '../../src/logging/Logger'

/* eslint-disable @typescript-eslint/no-var-requires */
// Published codeData, as MATLAB sends it. F_1 declares 'fun', F_2 declares 'f1' and 'f2'.
const F_1 = require('./rawCodeDataResourceFiles/improvedCodeAnalysisSpecCases/functionCases/F_1.json')
const F_2 = require('./rawCodeDataResourceFiles/improvedCodeAnalysisSpecCases/functionCases/F_2.json')

const CRAWL_HANDLER = 'matlabls.handlers.indexing.parseInfoFromFiles'
const CANCEL_HANDLER = 'matlabls.handlers.indexing.cancelCrawl'
const uriOf = (filePath: string): string => URI.file(filePath).toString()

/** A MATLAB connection whose channel IDs count up, as the real one does, and which delivers by channel. */
function makeConnection (): { connection: any, deliver: (channel: string, message: any) => void } {
    let nextChannelId = 0
    const callbacks = new Map<string, (message: unknown) => void>()
    const connection = {
        getChannelId: () => String(nextChannelId++),
        subscribe: sinon.spy((channel: string, callback: (message: unknown) => void) => {
            callbacks.set(channel, callback)
            return { channel }
        }),
        unsubscribe: sinon.spy((subscription: { channel: string }) => {
            callbacks.delete(subscription.channel)
        })
    }
    return {
        connection,
        deliver: (channel: string, message: any) => {
            const callback = callbacks.get(channel)
            if (callback === undefined) {
                throw new Error(`nothing subscribed to ${channel}`)
            }
            callback(message)
        }
    }
}

async function settleWithin<T> (promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)
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

/** True if the promise has not settled once pending callbacks have run. */
async function isStillPending (promise: Promise<unknown>): Promise<boolean> {
    const marker = Symbol('pending')
    const winner = await Promise.race([
        promise.then(() => undefined, () => undefined),
        new Promise(resolve => setImmediate(() => resolve(marker)))
    ])
    return winner === marker
}

function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
}

describe('Indexer workspace crawl', () => {
    let lifecycle: MatlabLifecycleManager
    let mockMvm: any
    let fileInfoIndex: FileInfoIndex
    let indexer: Indexer
    let fake: { connection: any, deliver: (channel: string, message: any) => void }
    let fevalReply: () => Promise<any>
    let cancelReply: () => Promise<any>

    const crawlCalls = (): sinon.SinonSpyCall[] => mockMvm.feval.getCalls().filter((call: sinon.SinonSpyCall) => call.args[0] === CRAWL_HANDLER)
    const cancelCalls = (): sinon.SinonSpyCall[] => mockMvm.feval.getCalls().filter((call: sinon.SinonSpyCall) => call.args[0] === CANCEL_HANDLER)
    const warnings = (): string[] => (Logger.warn as sinon.SinonStub).getCalls().map(call => String(call.args[0]))
    const channelOf = (call: sinon.SinonSpyCall): string => call.args[2][2]
    const pathsOf = (call: sinon.SinonSpyCall): string[] => call.args[2][0].mwdata
    const storedFunctions = (filePath: string): string[] =>
        [...(fileInfoIndex.codeInfoCache.get(uriOf(filePath))?.globalScopeInfo.functionScopes.keys() ?? [])].sort()
    // Every warning except those for a file MATLAB could not read or parse
    const silenceWarnings = (): string[] => (Logger.warn as sinon.SinonStub).getCalls()
        .map(call => String(call.args[0]))
        .filter(message => !message.startsWith('Unable to index'))

    beforeEach(() => {
        ClientConnection._setConnection(getMockConnection())
        sinon.stub(ConfigurationManager, 'getConfiguration').resolves({ maxFileSizeForAnalysis: 0 } as any)
        sinon.stub(Logger, 'error')
        sinon.stub(Logger, 'warn')

        lifecycle = new MatlabLifecycleManager()
        mockMvm = getMockMvm()
        mockMvm.isReady.returns(true)
        fileInfoIndex = new FileInfoIndex()
        indexer = new Indexer(lifecycle, mockMvm, fileInfoIndex)

        fake = makeConnection()
        sinon.stub(lifecycle, 'getMatlabConnection').resolves(fake.connection)

        fevalReply = async () => ({ result: [] })
        cancelReply = async () => ({ result: [] })
        mockMvm.feval.callsFake(async (name: string) => {
            if (name === CRAWL_HANDLER) {
                return await fevalReply()
            }
            if (name === CANCEL_HANDLER) {
                return await cancelReply()
            }
            throw new Error(`unexpected feval ${name}`)
        })
    })

    afterEach(() => {
        sinon.restore()
        ClientConnection._clearConnection()
    })

    it('sends every file in one request, on a channel it subscribed to first', async () => {
        const crawl = indexer.indexFiles(['/w/a.m', '/w/b.m', '/w/c.m'])
        await waitUntil(() => crawlCalls().length === 1)

        const call = crawlCalls()[0]
        assert.deepStrictEqual(call.args[2][0], { mwtype: 'string', mwsize: [1, 3], mwdata: ['/w/a.m', '/w/b.m', '/w/c.m'] })
        assert.strictEqual(call.args[1], 0)
        assert.strictEqual(call.args[2][1], 0)
        sinon.assert.calledWith(fake.connection.subscribe, channelOf(call))
        sinon.assert.callOrder(fake.connection.subscribe, mockMvm.feval)

        fake.deliver(channelOf(call), { filePath: '/w/c.m', isDone: true, codeData: F_1 })
        assert.strictEqual(await settleWithin(crawl, 1000), 'done')
        assert.strictEqual(crawlCalls().length, 1)
    })

    it('stores parsed files, skips failures, and reports every file', async () => {
        const reported: string[] = []
        const crawl = indexer.indexFiles(['/w/a.m', '/w/b.m', '/w/c.m', '/w/d.m'], { onFileDone: uri => reported.push(uri) })
        await waitUntil(() => crawlCalls().length === 1)
        const channel = channelOf(crawlCalls()[0])

        fake.deliver(channel, { filePath: '/w/a.m', isDone: false, codeData: F_1 })
        fake.deliver(channel, { filePath: '/w/b.m', isDone: false, error: 'Could not open file /w/b.m' })
        fake.deliver(channel, { filePath: '/w/c.m', isDone: false, codeData: { ...F_1, errorInfo: { message: 'Parse error' } } })
        fake.deliver(channel, { filePath: '/w/d.m', isDone: true, codeData: F_2 })

        assert.strictEqual(await settleWithin(crawl, 1000), 'done')
        assert.deepStrictEqual(storedFunctions('/w/a.m'), ['fun'])
        assert.ok(!fileInfoIndex.codeInfoCache.has(uriOf('/w/b.m')))
        assert.ok(!fileInfoIndex.codeInfoCache.has(uriOf('/w/c.m')))
        assert.deepStrictEqual(storedFunctions('/w/d.m'), ['f1', 'f2'])
        assert.deepStrictEqual(reported, ['/w/a.m', '/w/b.m', '/w/c.m', '/w/d.m'].map(uriOf))
        sinon.assert.calledOnce(Logger.warn as sinon.SinonStub)
        const warning = String((Logger.warn as sinon.SinonStub).firstCall.args[0])
        assert.ok(warning.includes('/w/b.m') && warning.includes('Could not open file'), warning)
    })

    it('unsubscribes once, when the last file arrives', async () => {
        const crawl = indexer.indexFiles(['/w/a.m', '/w/b.m'])
        await waitUntil(() => crawlCalls().length === 1)
        const channel = channelOf(crawlCalls()[0])

        fake.deliver(channel, { filePath: '/w/a.m', isDone: false, codeData: F_1 })
        await new Promise(resolve => setImmediate(resolve))
        sinon.assert.notCalled(fake.connection.unsubscribe)

        fake.deliver(channel, { filePath: '/w/b.m', isDone: true, codeData: F_2 })
        await settleWithin(crawl, 1000)
        sinon.assert.calledOnce(fake.connection.unsubscribe)
        assert.strictEqual(fake.connection.unsubscribe.firstCall.args[0], fake.connection.subscribe.firstCall.returnValue)
        // A finished crawl leaves nothing for a later disconnect to abort
        assert.strictEqual((indexer as any).abortCrawls.size, 0)
    })

    it('gives up and unsubscribes when MATLAB reports an error for the request', async () => {
        fevalReply = async () => ({ error: { msg: 'Undefined function parseInfoFromFiles' } })

        assert.strictEqual(await settleWithin(indexer.indexFiles(['/w/a.m']), 100), 'aborted')
        sinon.assert.calledOnce(fake.connection.unsubscribe)
        assert.strictEqual(crawlCalls().length, 1)
    })

    it('gives up and unsubscribes when the request fails', async () => {
        fevalReply = async () => { throw new Error('MVM gone') }

        assert.strictEqual(await settleWithin(indexer.indexFiles(['/w/a.m']), 100), 'aborted')
        sinon.assert.calledOnce(fake.connection.unsubscribe)
    })

    it('keeps waiting for a file that parses for longer than the silence warning, and warns once, naming it', async () => {
        const reported: string[] = []
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let crawl: Promise<string> | undefined
        try {
            crawl = indexer.indexFiles(['/ws/S/slowGen.m', '/ws/F/fastOne.m', '/ws/F/fastTwo.m'], { onFileDone: uri => reported.push(uri) })
            await waitUntil(() => crawlCalls().length === 1)
            await new Promise(resolve => setImmediate(resolve))
            const channel = channelOf(crawlCalls()[0])

            fake.deliver(channel, { isStarted: true })
            clock.tick(CRAWL_SILENCE_WARNING_MS - 1)
            assert.deepStrictEqual(silenceWarnings(), [], 'no warning before the warning time')
            clock.tick(1001)
            assert.ok(await isStillPending(crawl), 'must not give up on a slow file')
            clock.tick(10 * 60 * 1000)
            assert.ok(await isStillPending(crawl), 'must not give up on a slow file, however long it takes')

            fake.deliver(channel, { filePath: '/ws/S/slowGen.m', isDone: false, codeData: F_1 })
            fake.deliver(channel, { filePath: '/ws/F/fastOne.m', isDone: false, codeData: F_2 })
            fake.deliver(channel, { filePath: '/ws/F/fastTwo.m', isDone: true, codeData: F_1 })
            assert.strictEqual(clock.countTimers(), 0, 'a finished crawl stops its silence timer')
        } finally {
            clock.restore()
        }

        assert.strictEqual(await settleWithin(crawl as Promise<string>, 1000), 'done')
        assert.deepStrictEqual(storedFunctions('/ws/S/slowGen.m'), ['fun'])
        assert.deepStrictEqual(storedFunctions('/ws/F/fastOne.m'), ['f1', 'f2'])
        assert.deepStrictEqual(storedFunctions('/ws/F/fastTwo.m'), ['fun'])
        assert.deepStrictEqual(reported, ['/ws/S/slowGen.m', '/ws/F/fastOne.m', '/ws/F/fastTwo.m'].map(uriOf))
        const warnings = silenceWarnings()
        assert.strictEqual(warnings.length, 1, JSON.stringify(warnings))
        assert.ok(warnings[0].includes('/ws/S/slowGen.m') && !warnings[0].includes('fastOne'), warnings[0])
        assert.ok(warnings[0].includes('Indexing continues'), warnings[0])
        sinon.assert.notCalled(Logger.error as sinon.SinonStub)
    })

    it('warns again for a later silent stretch, naming the file MATLAB is then on', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let crawl: Promise<string> | undefined
        try {
            crawl = indexer.indexFiles(['/w/a.m', '/w/b.m', '/w/c.m', '/w/d.m'])
            await waitUntil(() => crawlCalls().length === 1)
            await new Promise(resolve => setImmediate(resolve))
            const channel = channelOf(crawlCalls()[0])

            fake.deliver(channel, { isStarted: true })
            // A file that could not be read counts like any other
            fake.deliver(channel, { filePath: '/w/a.m', isDone: false, error: 'Could not open file /w/a.m' })
            clock.tick(CRAWL_SILENCE_WARNING_MS + 1000)
            fake.deliver(channel, { filePath: '/w/b.m', isDone: false, codeData: F_1 })
            clock.tick(4 * CRAWL_SILENCE_WARNING_MS)
            assert.ok(await isStillPending(crawl), 'must not give up on a second slow file')
            fake.deliver(channel, { filePath: '/w/c.m', isDone: false, codeData: F_1 })
            fake.deliver(channel, { filePath: '/w/d.m', isDone: true, codeData: F_2 })
        } finally {
            clock.restore()
        }

        assert.strictEqual(await settleWithin(crawl as Promise<string>, 1000), 'done')
        assert.deepStrictEqual(storedFunctions('/w/d.m'), ['f1', 'f2'])
        const warnings = silenceWarnings()
        assert.strictEqual(warnings.length, 2, JSON.stringify(warnings))
        assert.ok(warnings[0].includes('/w/b.m') && !warnings[0].includes('/w/a.m'), warnings[0])
        assert.ok(warnings[1].includes('/w/c.m') && !warnings[1].includes('/w/b.m'), warnings[1])
    })

    it('still gives up when MATLAB disconnects while the crawl waits for a slow file', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let crawl: Promise<string> | undefined
        try {
            crawl = indexer.indexFiles(['/w/a.m', '/w/b.m'])
            await waitUntil(() => crawlCalls().length === 1)
            await new Promise(resolve => setImmediate(resolve))
            fake.deliver(channelOf(crawlCalls()[0]), { isStarted: true })
            clock.tick(2 * CRAWL_SILENCE_WARNING_MS)
            assert.strictEqual(silenceWarnings().length, 1)

            lifecycle.eventEmitter.emit('disconnected')
            assert.strictEqual(clock.countTimers(), 0)
        } finally {
            clock.restore()
        }

        assert.strictEqual(await settleWithin(crawl as Promise<string>, 100), 'aborted')
        sinon.assert.calledOnce(fake.connection.unsubscribe)
    })

    it('restarts the silence warning on every file', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let crawl: Promise<string> | undefined
        try {
            crawl = indexer.indexFiles(['/w/a.m', '/w/b.m', '/w/c.m'])
            await waitUntil(() => crawlCalls().length === 1)
            await new Promise(resolve => setImmediate(resolve))
            const channel = channelOf(crawlCalls()[0])

            fake.deliver(channel, { isStarted: true })
            clock.tick(40000)
            fake.deliver(channel, { filePath: '/w/a.m', isDone: false, codeData: F_1 })
            clock.tick(40000)
            fake.deliver(channel, { filePath: '/w/b.m', isDone: false, codeData: F_1 })
            clock.tick(40000)
            fake.deliver(channel, { filePath: '/w/c.m', isDone: true, codeData: F_2 })
            assert.strictEqual(clock.countTimers(), 0, 'a finished crawl stops its silence timer')
        } finally {
            clock.restore()
        }

        assert.strictEqual(await settleWithin(crawl as Promise<string>, 1000), 'done')
        assert.deepStrictEqual(storedFunctions('/w/c.m'), ['f1', 'f2'])
        assert.deepStrictEqual(silenceWarnings(), [])
    })

    it('does not warn while the request waits for the MATLAB thread', async () => {
        const accepted = deferred<any>()
        fevalReply = async () => await accepted.promise

        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let crawl: Promise<string> | undefined
        try {
            crawl = indexer.indexFiles(['/w/a.m'])
            await waitUntil(() => crawlCalls().length === 1)
            clock.tick(2 * CRAWL_SILENCE_WARNING_MS)
            assert.deepStrictEqual(silenceWarnings(), [], 'must not warn while the request is still queued')
            accepted.resolve({ result: [] })
            await new Promise(resolve => setImmediate(resolve))
            fake.deliver(channelOf(crawlCalls()[0]), { isStarted: true })
            clock.tick(CRAWL_SILENCE_WARNING_MS / 2)
            fake.deliver(channelOf(crawlCalls()[0]), { filePath: '/w/a.m', isDone: true, codeData: F_1 })
        } finally {
            clock.restore()
        }

        assert.strictEqual(await settleWithin(crawl as Promise<string>, 1000), 'done')
        assert.deepStrictEqual(silenceWarnings(), [])
    })

    it('leaves no silence timer behind when the crawl finishes before its request returns', async () => {
        const accepted = deferred<any>()
        fevalReply = async () => await accepted.promise

        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            const crawl = indexer.indexFiles(['/w/a.m'])
            await waitUntil(() => crawlCalls().length === 1)
            fake.deliver(channelOf(crawlCalls()[0]), { isStarted: true })
            fake.deliver(channelOf(crawlCalls()[0]), { filePath: '/w/a.m', isDone: true, codeData: F_1 })
            accepted.resolve({ result: [] })
            await new Promise(resolve => setImmediate(resolve))
            await new Promise(resolve => setImmediate(resolve))
            assert.strictEqual(await crawl, 'done')
            assert.strictEqual(clock.countTimers(), 0)
        } finally {
            clock.restore()
        }
    })

    it('does not warn while the crawl waits for a free background pool worker', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let crawl: Promise<string> | undefined
        try {
            crawl = indexer.indexFiles(['/w/a.m'])
            await waitUntil(() => crawlCalls().length === 1)
            await new Promise(resolve => setImmediate(resolve))
            // MATLAB queued the crawl at once, but every worker stays busy for twice the warning time
            clock.tick(2 * CRAWL_SILENCE_WARNING_MS)
            assert.deepStrictEqual(silenceWarnings(), [], 'must not warn before the crawl started')

            const channel = channelOf(crawlCalls()[0])
            fake.deliver(channel, { isStarted: true })
            clock.tick(CRAWL_SILENCE_WARNING_MS - 1)
            fake.deliver(channel, { filePath: '/w/a.m', isDone: true, codeData: F_1 })
        } finally {
            clock.restore()
        }

        assert.strictEqual(await settleWithin(crawl as Promise<string>, 1000), 'done')
        assert.deepStrictEqual(storedFunctions('/w/a.m'), ['fun'])
        assert.deepStrictEqual(silenceWarnings(), [])
    })

    it('neither reports nor stores the message that the crawl started', async () => {
        const reported: string[] = []
        const shouldStore = sinon.spy((uri: string) => uri !== '')
        const crawl = indexer.indexFiles(['/w/a.m'], { onFileDone: uri => reported.push(uri), shouldStore })
        await waitUntil(() => crawlCalls().length === 1)
        const channel = channelOf(crawlCalls()[0])

        fake.deliver(channel, { isStarted: true })
        assert.ok(await isStillPending(crawl), 'the started message must not end the crawl')
        assert.deepStrictEqual(reported, [])
        sinon.assert.notCalled(shouldStore)
        sinon.assert.notCalled(Logger.warn as sinon.SinonStub)

        fake.deliver(channel, { filePath: '/w/a.m', isDone: true, codeData: F_1 })
        assert.strictEqual(await settleWithin(crawl, 1000), 'done')
        assert.deepStrictEqual(reported, [uriOf('/w/a.m')])
        assert.deepStrictEqual([...fileInfoIndex.codeInfoCache.keys()], [uriOf('/w/a.m')])
    })

    it('gives up at once, without reporting a file, when MATLAB reports that the crawl failed', async () => {
        const reported: string[] = []

        // Cancelled while it waited for a worker
        const queuedCrawl = indexer.indexFiles(['/w/a.m', '/w/b.m'], { onFileDone: uri => reported.push(uri) })
        await waitUntil(() => crawlCalls().length === 1)
        fake.deliver(channelOf(crawlCalls()[0]), { isFailed: true, error: 'Execution of the future was cancelled.' })
        assert.strictEqual(await settleWithin(queuedCrawl, 100), 'aborted')
        assert.strictEqual(reported.length, 0)
        sinon.assert.calledOnce(fake.connection.unsubscribe)
        const logged = (Logger.error as sinon.SinonStub).getCalls().map(call => String(call.args[0]))
        assert.ok(logged.some(message => message.includes('Execution of the future was cancelled.')), JSON.stringify(logged))

        // Failed after the first file
        const runningCrawl = indexer.indexFiles(['/w/a.m', '/w/b.m'], { onFileDone: uri => reported.push(uri) })
        await waitUntil(() => crawlCalls().length === 2)
        const channel = channelOf(crawlCalls()[1])
        fake.deliver(channel, { isStarted: true })
        fake.deliver(channel, { filePath: '/w/a.m', isDone: false, codeData: F_1 })
        fake.deliver(channel, { isFailed: true, error: 'Out of memory.' })
        assert.strictEqual(await settleWithin(runningCrawl, 100), 'aborted')
        assert.deepStrictEqual(reported, [uriOf('/w/a.m')])
        assert.deepStrictEqual(storedFunctions('/w/a.m'), ['fun'])
        sinon.assert.calledTwice(fake.connection.unsubscribe)
    })

    it('gives up promptly when MATLAB disconnects', async () => {
        const crawl = indexer.indexFiles(['/w/a.m', '/w/b.m'])
        await waitUntil(() => crawlCalls().length === 1)
        fake.deliver(channelOf(crawlCalls()[0]), { filePath: '/w/a.m', isDone: false, codeData: F_1 })
        assert.ok(await isStillPending(crawl), 'precondition: waiting for the last file')

        lifecycle.eventEmitter.emit('disconnected')

        assert.strictEqual(await settleWithin(crawl, 100), 'aborted')
        sinon.assert.calledOnce(fake.connection.unsubscribe)
    })

    it('reports but does not store a file the caller declines', async () => {
        const reported: string[] = []
        const crawl = indexer.indexFiles(['/w/a.m', '/w/b.m'], {
            onFileDone: uri => reported.push(uri),
            shouldStore: uri => uri !== uriOf('/w/a.m')
        })
        await waitUntil(() => crawlCalls().length === 1)
        const channel = channelOf(crawlCalls()[0])

        fake.deliver(channel, { filePath: '/w/a.m', isDone: false, codeData: F_1 })
        fake.deliver(channel, { filePath: '/w/b.m', isDone: true, codeData: F_2 })

        assert.strictEqual(await settleWithin(crawl, 1000), 'done')
        assert.ok(!fileInfoIndex.codeInfoCache.has(uriOf('/w/a.m')))
        assert.deepStrictEqual(storedFunctions('/w/b.m'), ['f1', 'f2'])
        assert.deepStrictEqual(reported, [uriOf('/w/a.m'), uriOf('/w/b.m')])
    })

    it('sends nothing and does not start for an empty list or without MATLAB', async () => {
        const onStart = sinon.spy(async () => {})

        assert.strictEqual(await indexer.indexFiles([], { onStart }), 'done')

        mockMvm.isReady.returns(false)
        assert.strictEqual(await indexer.indexFiles(['/w/a.m'], { onStart }), 'unavailable')

        mockMvm.isReady.returns(true);
        (lifecycle.getMatlabConnection as sinon.SinonStub).resolves(null)
        assert.strictEqual(await indexer.indexFiles(['/w/a.m'], { onStart }), 'unavailable')

        assert.strictEqual(crawlCalls().length, 0)
        sinon.assert.notCalled(onStart)
    })

    it('waits for the caller to start before sending the files', async () => {
        const started = deferred<void>()
        const crawl = indexer.indexFiles(['/w/a.m'], { onStart: async () => await started.promise })

        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
        assert.strictEqual(crawlCalls().length, 0)

        started.resolve()
        await waitUntil(() => crawlCalls().length === 1)
        fake.deliver(channelOf(crawlCalls()[0]), { filePath: '/w/a.m', isDone: true, codeData: F_1 })
        assert.strictEqual(await settleWithin(crawl, 1000), 'done')
    })

    it('keeps two concurrent crawls apart', async () => {
        const reportedA: string[] = []
        const reportedB: string[] = []
        const crawlA = indexer.indexFiles(['/a/1.m', '/a/2.m'], { onFileDone: uri => reportedA.push(uri) })
        await waitUntil(() => crawlCalls().length === 1)
        const crawlB = indexer.indexFiles(['/b/1.m'], { onFileDone: uri => reportedB.push(uri) })
        await waitUntil(() => crawlCalls().length === 2)
        const [channelA, channelB] = crawlCalls().map(channelOf)
        assert.notStrictEqual(channelA, channelB)

        fake.deliver(channelB, { filePath: '/b/1.m', isDone: true, codeData: F_2 })
        assert.strictEqual(await settleWithin(crawlB, 1000), 'done')
        assert.ok(await isStillPending(crawlA), 'the other crawl finishing must not finish this one')
        assert.deepStrictEqual(reportedA, [])

        fake.deliver(channelA, { filePath: '/a/1.m', isDone: false, codeData: F_1 })
        fake.deliver(channelA, { filePath: '/a/2.m', isDone: true, codeData: F_1 })
        assert.strictEqual(await settleWithin(crawlA, 1000), 'done')
        assert.deepStrictEqual(reportedA, [uriOf('/a/1.m'), uriOf('/a/2.m')])
        assert.deepStrictEqual(reportedB, [uriOf('/b/1.m')])
    })

    it('reports a stall once, when the first silence warning fires, and keeps the crawl going', async () => {
        const onStalled = sinon.spy()
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let crawl: Promise<string> | undefined
        try {
            crawl = indexer.indexFiles(['/w/a.m', '/w/b.m'], { onStalled })
            await waitUntil(() => crawlCalls().length === 1)
            await new Promise(resolve => setImmediate(resolve))
            const channel = channelOf(crawlCalls()[0])

            // Waiting for the MATLAB thread or for a free worker is no stall
            clock.tick(2 * CRAWL_SILENCE_WARNING_MS)
            sinon.assert.notCalled(onStalled)

            fake.deliver(channel, { isStarted: true })
            clock.tick(CRAWL_SILENCE_WARNING_MS - 1)
            sinon.assert.notCalled(onStalled)
            clock.tick(1)
            sinon.assert.calledOnce(onStalled)
            assert.strictEqual(silenceWarnings().length, 1)

            // A later silent stretch warns again, but the stall was already reported
            fake.deliver(channel, { filePath: '/w/a.m', isDone: false, codeData: F_1 })
            clock.tick(CRAWL_SILENCE_WARNING_MS)
            assert.strictEqual(silenceWarnings().length, 2)
            sinon.assert.calledOnce(onStalled)

            assert.ok(await isStillPending(crawl), 'a stall does not end the crawl')
            fake.deliver(channel, { filePath: '/w/b.m', isDone: true, codeData: F_2 })
        } finally {
            clock.restore()
        }

        assert.strictEqual(await settleWithin(crawl, 1000), 'done')
        assert.deepStrictEqual(storedFunctions('/w/a.m'), ['fun'])
        assert.deepStrictEqual(storedFunctions('/w/b.m'), ['f1', 'f2'])
        sinon.assert.calledOnce(onStalled)
    })

    it('asks MATLAB to cancel the crawl, without waiting for the answer, when MATLAB reports an error for the request', async () => {
        fevalReply = async () => ({ error: { msg: 'Undefined function afterAll' } })
        // MATLAB never answers the cancel
        cancelReply = async () => await new Promise(() => {})

        assert.strictEqual(await settleWithin(indexer.indexFiles(['/w/a.m']), 100), 'aborted')
        assert.strictEqual(cancelCalls().length, 1)
        assert.deepStrictEqual(cancelCalls()[0].args, [CANCEL_HANDLER, 0, [channelOf(crawlCalls()[0])]])
    })

    it('asks MATLAB to cancel the crawl when the request fails while MATLAB is still ready', async () => {
        fevalReply = async () => { throw new Error('request lost') }

        assert.strictEqual(await settleWithin(indexer.indexFiles(['/w/a.m']), 100), 'aborted')
        assert.strictEqual(cancelCalls().length, 1)
        assert.deepStrictEqual(cancelCalls()[0].args[2], [channelOf(crawlCalls()[0])])
    })

    it('does not ask MATLAB to cancel a crawl once MATLAB is not ready', async () => {
        fevalReply = async () => {
            mockMvm.isReady.returns(false)
            throw new Error('MVM gone')
        }

        assert.strictEqual(await settleWithin(indexer.indexFiles(['/w/a.m']), 100), 'aborted')
        assert.strictEqual(cancelCalls().length, 0)
    })

    it('does not ask MATLAB to cancel a crawl that had already ended when its request failed', async () => {
        const answers = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()]
        let rejectLast: (err: Error) => void = () => {}
        const lastAnswer = new Promise<unknown>((_resolve, reject) => { rejectLast = reject })
        let requests = 0
        fevalReply = async () => {
            const n = requests++
            return n < 2 ? await answers[n].promise : await lastAnswer
        }

        // Finished
        const done = indexer.indexFiles(['/w/a.m'])
        await waitUntil(() => crawlCalls().length === 1)
        fake.deliver(channelOf(crawlCalls()[0]), { filePath: '/w/a.m', isDone: true, codeData: F_1 })
        assert.strictEqual(await settleWithin(done, 1000), 'done')

        // Reported as failed by MATLAB
        const failed = indexer.indexFiles(['/w/a.m'])
        await waitUntil(() => crawlCalls().length === 2)
        fake.deliver(channelOf(crawlCalls()[1]), { isFailed: true, error: 'Out of memory.' })
        assert.strictEqual(await settleWithin(failed, 1000), 'aborted')

        // Given up for a disconnect, after which MATLAB may be ready again
        const disconnected = indexer.indexFiles(['/w/a.m'])
        await waitUntil(() => crawlCalls().length === 3)
        lifecycle.eventEmitter.emit('disconnected')
        assert.strictEqual(await settleWithin(disconnected, 1000), 'aborted')

        answers[0].resolve({ error: { msg: 'late error' } })
        answers[1].resolve({ error: { msg: 'late error' } })
        rejectLast(new Error('late rejection'))
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setImmediate(resolve))
        }
        assert.strictEqual(cancelCalls().length, 0)
    })

    it('logs a cancel MATLAB could not carry out, and still gives the crawl up', async () => {
        fevalReply = async () => ({ error: { msg: 'boom' } })

        cancelReply = async () => { throw new Error('cancel lost') }
        assert.strictEqual(await settleWithin(indexer.indexFiles(['/w/a.m']), 100), 'aborted')
        await waitUntil(() => warnings().some(message => message.includes('cancel lost')))

        cancelReply = async () => ({ error: { msg: 'Undefined function cancelCrawl' } })
        assert.strictEqual(await settleWithin(indexer.indexFiles(['/w/a.m']), 100), 'aborted')
        await waitUntil(() => warnings().some(message => message.includes('Undefined function cancelCrawl')))
    })

    describe('of a file MATLAB could not parse', () => {
        const PARSE_ERROR = 'L 2 (C 6): SYNER: Parse error at \'(\': usage might be invalid MATLAB syntax.'
        let root = ''
        let brokenPath = ''

        const fallbackFunctions = (filePath: string): string[] | undefined =>
            fileInfoIndex.fallbackDeclarations.get(uriOf(filePath))?.functions.map(declaration => declaration.name)

        /** Crawls the one file, with MATLAB reporting the message given for it. */
        const crawlOne = async (filePath: string, message: object, options: CrawlOptions = {}): Promise<void> => {
            const count = crawlCalls().length
            const crawl = indexer.indexFiles([filePath], options)
            await waitUntil(() => crawlCalls().length === count + 1)
            fake.deliver(channelOf(crawlCalls()[count]), { filePath, isDone: true, ...message })
            assert.strictEqual(await settleWithin(crawl, 1000), 'done')
        }

        before(() => {
            root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unparsable-')))
            brokenPath = path.join(root, 'broken.m')
            fs.writeFileSync(brokenPath, 'function broken\nx = (;\nend\n\nfunction brokenLocal\nend\n')
        })

        after(() => {
            if (root !== '') {
                fs.rmSync(root, { recursive: true, force: true })
            }
        })

        it('stores the declarations in the file, in place of the entry of an older parse', async () => {
            fileInfoIndex.parseAndStoreCodeInfo(uriOf(brokenPath), F_1)
            const reported: string[] = []

            await crawlOne(brokenPath, { codeData: { ...F_1, errorInfo: PARSE_ERROR } }, { onFileDone: uri => reported.push(uri) })

            assert.deepStrictEqual(fallbackFunctions(brokenPath), ['broken', 'brokenLocal'])
            assert.ok(!fileInfoIndex.codeInfoCache.has(uriOf(brokenPath)), 'the older parse no longer matches the file')
            assert.deepStrictEqual(reported, [uriOf(brokenPath)])
        })

        it('neither stores the declarations nor drops the entry of a file the caller declines', async () => {
            fileInfoIndex.parseAndStoreCodeInfo(uriOf(brokenPath), F_1)
            const shouldStore = sinon.spy((_uri: string) => false)

            await crawlOne(brokenPath, { codeData: { ...F_1, errorInfo: PARSE_ERROR } }, { shouldStore })

            sinon.assert.calledWith(shouldStore, uriOf(brokenPath))
            assert.strictEqual(fallbackFunctions(brokenPath), undefined)
            assert.deepStrictEqual(storedFunctions(brokenPath), ['fun'])
        })

        it('drops the declarations once the file parses', async () => {
            await crawlOne(brokenPath, { codeData: { ...F_1, errorInfo: PARSE_ERROR } })
            assert.deepStrictEqual(fallbackFunctions(brokenPath), ['broken', 'brokenLocal'])

            await crawlOne(brokenPath, { codeData: F_2 })

            assert.strictEqual(fallbackFunctions(brokenPath), undefined)
            assert.deepStrictEqual(storedFunctions(brokenPath), ['f1', 'f2'])
        })

        it('leaves the index as it is when the file cannot be read', async () => {
            const missingPath = path.join(root, 'missing.m')
            fileInfoIndex.parseAndStoreCodeInfo(uriOf(missingPath), F_1)
            sinon.stub(Logger, 'log')

            await crawlOne(missingPath, { codeData: { ...F_1, errorInfo: PARSE_ERROR } })

            assert.strictEqual(fallbackFunctions(missingPath), undefined)
            assert.deepStrictEqual(storedFunctions(missingPath), ['fun'])
        })
    })

    describe('of a class folder', function () {
        let root = ''

        before(function () {
            if (process.platform === 'win32') {
                this.skip()
            }
            root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'classFolder-')))
            fs.mkdirSync(path.join(root, '@Cls'))
            fs.writeFileSync(path.join(root, '@Cls', 'Cls.m'), 'classdef Cls\nend\n')
            fs.writeFileSync(path.join(root, '@Cls', 'm2.m'), 'function m2(obj)\nend\n')
            fs.writeFileSync(path.join(root, 'elsewhere.m'), 'function elsewhere\nend\n')
            fs.symlinkSync(path.join(root, 'elsewhere.m'), path.join(root, '@Cls', 'link.m'))
        })

        after(() => {
            if (root !== '') {
                fs.rmSync(root, { recursive: true, force: true })
            }
        })

        it('sends the real files of the folder and no link', async () => {
            const crawl = indexer.indexFolders([URI.file(path.join(root, '@Cls')).toString()])
            await waitUntil(() => crawlCalls().length === 1)

            assert.deepStrictEqual([...pathsOf(crawlCalls()[0])].sort(), [path.join(root, '@Cls', 'Cls.m'), path.join(root, '@Cls', 'm2.m')].sort())

            fake.deliver(channelOf(crawlCalls()[0]), { filePath: path.join(root, '@Cls', 'm2.m'), isDone: true, error: 'x' })
            await settleWithin(crawl, 1000)
        })
    })
})
