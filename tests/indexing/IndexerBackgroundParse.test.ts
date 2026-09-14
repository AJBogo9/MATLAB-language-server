// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import { TextDocument } from 'vscode-languageserver-textdocument'

import getMockConnection from '../mocks/Connection.mock'
import getMockMvm from '../mocks/Mvm.mock'

import ClientConnection from '../../src/ClientConnection'
import FileInfoIndex from '../../src/indexing/FileInfoIndex'
import Indexer, { BACKGROUND_PARSE_TIMEOUT_MS } from '../../src/indexing/Indexer'
import ConfigurationManager from '../../src/lifecycle/ConfigurationManager'
import MatlabLifecycleManager from '../../src/lifecycle/MatlabLifecycleManager'
import Logger from '../../src/logging/Logger'

/* eslint-disable @typescript-eslint/no-var-requires */
// Published codeData, as MATLAB sends it. F_1 declares 'fun', F_2 declares 'f1' and 'f2'.
const F_1 = require('./rawCodeDataResourceFiles/improvedCodeAnalysisSpecCases/functionCases/F_1.json')
const F_2 = require('./rawCodeDataResourceFiles/improvedCodeAnalysisSpecCases/functionCases/F_2.json')

const ASYNC_HANDLER = 'matlabls.handlers.indexing.parseInfoFromDocumentAsync'
const SYNC_HANDLER = 'matlabls.handlers.indexing.parseInfoFromDocument'
const DOC_URI = 'file:///test.m'

/**
 * codeData for the synchronous path. That path runs MdaParser, which cannot take a
 * one-element array, so every array here is empty.
 */
function syncCodeData (pkg: string): any {
    return {
        package: pkg,
        hasClassInfo: false,
        sections: [],
        classReferences: [],
        globalScope: {
            variableDefinitions: [],
            variableReferences: [],
            globals: [],
            functionOrUnboundReferences: [],
            functionScopes: []
        },
        timeToIndex: 0
    }
}

function makeConnection (): { connection: any, deliver: (message: any) => void } {
    let callback: ((message: unknown) => void) | undefined
    const connection = {
        getChannelId: () => '7',
        subscribe: sinon.spy((_channel: string, cb: (message: unknown) => void) => {
            callback = cb
            return {}
        }),
        unsubscribe: sinon.spy()
    }
    return {
        connection,
        deliver: (message: any) => {
            if (callback === undefined) {
                throw new Error('nothing subscribed')
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

/** True if the promise has not settled once pending microtasks have run. */
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

describe('Indexer background parsing', () => {
    let lifecycle: MatlabLifecycleManager
    let mockMvm: any
    let fileInfoIndex: FileInfoIndex
    let indexer: Indexer
    let fake: { connection: any, deliver: (message: any) => void }
    let getConnectionStub: sinon.SinonStub
    let asyncStatus: number
    let syncReplies: Map<string, Promise<any>>

    const doc = (text: string, version = 1): TextDocument => TextDocument.create(DOC_URI, 'matlab', version, text)
    const asyncCalls = (): sinon.SinonSpyCall[] => mockMvm.feval.getCalls().filter((call: sinon.SinonSpyCall) => call.args[0] === ASYNC_HANDLER)
    const syncCalls = (): sinon.SinonSpyCall[] => mockMvm.feval.getCalls().filter((call: sinon.SinonSpyCall) => call.args[0] === SYNC_HANDLER)
    const requestIdFor = (text: string): number => {
        const call = asyncCalls().find(c => c.args[2][0] === text)
        if (call === undefined) {
            throw new Error(`no background parse requested for ${text}`)
        }
        return call.args[2][4]
    }
    const storedFunctions = (): string[] =>
        [...(fileInfoIndex.codeInfoCache.get(DOC_URI)?.globalScopeInfo.functionScopes.keys() ?? [])].sort()

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
        getConnectionStub = sinon.stub(lifecycle, 'getMatlabConnection').resolves(fake.connection)

        asyncStatus = 1
        syncReplies = new Map()
        mockMvm.feval.callsFake(async (name: string, _nargout: number, args: any[]) => {
            if (name === ASYNC_HANDLER) {
                return { result: [asyncStatus] }
            }
            if (name === SYNC_HANDLER) {
                const reply = syncReplies.get(args[0]) ?? Promise.resolve(syncCodeData('sync'))
                return { result: [await reply] }
            }
            throw new Error(`unexpected feval ${name}`)
        })
    })

    afterEach(() => {
        sinon.restore()
        ClientConnection._clearConnection()
    })

    it('keeps the newer result when parses on the MATLAB thread finish out of order', async () => {
        asyncStatus = 2 // pool busy
        const older = deferred<any>()
        const newer = deferred<any>()
        syncReplies.set('v1', older.promise)
        syncReplies.set('v2', newer.promise)

        const first = indexer.indexDocument(doc('v1', 1))
        const second = indexer.indexDocument(doc('v2', 2))
        await waitUntil(() => syncCalls().length === 2)

        newer.resolve(syncCodeData('pkgNew'))
        await settleWithin(second, 1000)
        older.resolve(syncCodeData('pkgOld'))
        await settleWithin(first, 1000)

        assert.strictEqual(fileInfoIndex.codeInfoCache.get(DOC_URI)?.package, 'pkgNew')
    })

    it('drops a background result that arrives after a newer one', async () => {
        const first = indexer.indexDocument(doc('v1', 1))
        const second = indexer.indexDocument(doc('v2', 2))
        await waitUntil(() => asyncCalls().length === 2)

        fake.deliver({ requestId: requestIdFor('v2'), codeData: F_2 })
        await settleWithin(second, 1000)
        fake.deliver({ requestId: requestIdFor('v1'), codeData: F_1 })
        await settleWithin(first, 1000)

        assert.deepStrictEqual(storedFunctions(), ['f1', 'f2'])
    })

    it('stores published data as delivered, without MdaParser', async () => {
        const indexing = indexer.indexDocument(doc('v1'))
        await waitUntil(() => asyncCalls().length === 1)

        fake.deliver({ requestId: requestIdFor('v1'), codeData: F_1 })
        await settleWithin(indexing, 1000)

        assert.strictEqual(fileInfoIndex.codeInfoCache.get(DOC_URI)?.sections[0].name, 'Section1')
        assert.strictEqual(syncCalls().length, 0)
    })

    it('parses on the MATLAB thread when the pool is unavailable, and stops asking on that connection', async () => {
        asyncStatus = 0

        await settleWithin(indexer.indexDocument(doc('v1', 1)), 1000)
        assert.strictEqual(syncCalls().length, 1)
        assert.deepStrictEqual(syncCalls()[0].args, [SYNC_HANDLER, 1, ['v1', '/test.m', 0]])
        assert.ok(fileInfoIndex.codeInfoCache.has(DOC_URI))

        await settleWithin(indexer.indexDocument(doc('v2', 2)), 1000)
        assert.strictEqual(asyncCalls().length, 1)
        assert.strictEqual(syncCalls().length, 2)
    })

    it('parses on the MATLAB thread when the background parse fails', async () => {
        const indexing = indexer.indexDocument(doc('v1'))
        await waitUntil(() => asyncCalls().length === 1)
        assert.ok(await isStillPending(indexing), 'precondition: waiting for the published result')
        assert.strictEqual(syncCalls().length, 0)

        fake.deliver({ requestId: requestIdFor('v1'), error: 'boom' })
        await settleWithin(indexing, 1000)

        assert.strictEqual(syncCalls().length, 1)
        assert.ok(fileInfoIndex.codeInfoCache.has(DOC_URI))
    })

    it('stops waiting for a background result when MATLAB disconnects', async () => {
        const indexing = indexer.indexDocument(doc('v1'))
        await waitUntil(() => asyncCalls().length === 1)
        assert.ok(await isStillPending(indexing), 'precondition: waiting for the published result')

        lifecycle.eventEmitter.emit('disconnected')
        await settleWithin(indexing, 1000)

        assert.strictEqual(syncCalls().length, 0)
        assert.ok(!fileInfoIndex.codeInfoCache.has(DOC_URI))
    })

    it('subscribes once per MATLAB connection, before asking for a parse', async () => {
        for (const text of ['v1', 'v2']) {
            const indexing = indexer.indexDocument(doc(text))
            await waitUntil(() => asyncCalls().some(call => call.args[2][0] === text))
            fake.deliver({ requestId: requestIdFor(text), codeData: F_1 })
            await settleWithin(indexing, 1000)
        }
        sinon.assert.calledOnce(fake.connection.subscribe)
        sinon.assert.callOrder(fake.connection.subscribe, mockMvm.feval)

        const other = makeConnection()
        getConnectionStub.resolves(other.connection)
        const third = indexer.indexDocument(doc('v3'))
        await waitUntil(() => asyncCalls().length === 3)
        sinon.assert.calledOnce(other.connection.subscribe)

        other.deliver({ requestId: requestIdFor('v3'), codeData: F_2 })
        await settleWithin(third, 1000)
        assert.deepStrictEqual(storedFunctions(), ['f1', 'f2'])
    })

    it('ignores a result nobody is waiting for', async () => {
        const indexing = indexer.indexDocument(doc('v1'))
        await waitUntil(() => asyncCalls().length === 1)

        fake.deliver({ requestId: 999, codeData: F_2 })
        assert.ok(await isStillPending(indexing), 'an unrelated result must not settle this parse')

        fake.deliver({ requestId: requestIdFor('v1'), codeData: F_1 })
        await settleWithin(indexing, 1000)
        assert.deepStrictEqual(storedFunctions(), ['fun'])
    })

    it('parses on the MATLAB thread when no result arrives in time, and stops asking on that connection', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let indexing: Promise<void> | undefined
        try {
            indexing = indexer.indexDocument(doc('v1', 1))
            await waitUntil(() => asyncCalls().length === 1)
            await waitUntil(() => (indexer as any).pendingParses.get(requestIdFor('v1'))?.timer !== undefined)
            assert.strictEqual(syncCalls().length, 0)
            clock.tick(BACKGROUND_PARSE_TIMEOUT_MS + 1)
        } finally {
            clock.restore()
        }

        await settleWithin(indexing as Promise<void>, 1000)
        assert.strictEqual(syncCalls().length, 1)
        assert.ok(fileInfoIndex.codeInfoCache.has(DOC_URI))

        await settleWithin(indexer.indexDocument(doc('v2', 2)), 1000)
        assert.strictEqual(asyncCalls().length, 1)
    })

    it('accepts a result published before the request to parse returns', async () => {
        mockMvm.feval.callsFake(async (name: string, _nargout: number, args: any[]) => {
            if (name === ASYNC_HANDLER) {
                fake.deliver({ requestId: args[4], codeData: F_1 })
                return { result: [1] }
            }
            throw new Error(`unexpected feval ${name}`)
        })

        await settleWithin(indexer.indexDocument(doc('v1')), 1000)

        assert.deepStrictEqual(storedFunctions(), ['fun'])
    })

    it('does not store a document that MATLAB could not parse', async () => {
        const indexing = indexer.indexDocument(doc('v1'))
        await waitUntil(() => asyncCalls().length === 1)

        fake.deliver({ requestId: requestIdFor('v1'), codeData: { ...F_1, errorInfo: { message: 'Parse error' } } })
        await settleWithin(indexing, 1000)

        assert.ok(!fileInfoIndex.codeInfoCache.has(DOC_URI))
        assert.strictEqual(syncCalls().length, 0)
    })

    describe('of a document MATLAB could not parse', () => {
        const PARSE_ERROR = 'L 2 (C 6): SYNER: Parse error at \'(\': usage might be invalid MATLAB syntax.'
        const fallbackFunctions = (): string[] | undefined =>
            fileInfoIndex.fallbackDeclarations.get(DOC_URI)?.functions.map(declaration => declaration.name)

        /** Indexes the document, with MATLAB publishing the codeData given for it. */
        const indexWith = async (document: TextDocument, codeData: any): Promise<void> => {
            const text = document.getText()
            const indexing = indexer.indexDocument(document)
            await waitUntil(() => asyncCalls().some(call => call.args[2][0] === text))
            fake.deliver({ requestId: requestIdFor(text), codeData })
            await settleWithin(indexing, 1000)
        }

        it('keeps the last good parse while the document does not parse', async () => {
            await indexWith(doc('function fun\nend', 1), F_1)

            await indexWith(doc('function fun\nx = (;\nend\nfunction typedIn\nend', 2), { ...F_1, errorInfo: PARSE_ERROR })

            assert.deepStrictEqual(storedFunctions(), ['fun'])
            assert.strictEqual(fallbackFunctions(), undefined)
        })

        it('stores the declarations in the text of a document that never parsed', async () => {
            await indexWith(doc('function typedIn\nx = (;\nend'), { ...F_1, errorInfo: PARSE_ERROR })

            assert.ok(!fileInfoIndex.codeInfoCache.has(DOC_URI))
            assert.deepStrictEqual(fallbackFunctions(), ['typedIn'])
            assert.strictEqual(syncCalls().length, 0)
        })

        it('scans the text MATLAB parsed, not the text the document has once the result arrives', async () => {
            const document = doc('function typedIn\nx = (;\nend', 1)
            const indexing = indexer.indexDocument(document)
            await waitUntil(() => asyncCalls().length === 1)
            TextDocument.update(document, [{ text: 'function typedLater\nx = (;\nend' }], 2)

            fake.deliver({ requestId: asyncCalls()[0].args[2][4], codeData: { ...F_1, errorInfo: PARSE_ERROR } })
            await settleWithin(indexing, 1000)

            assert.deepStrictEqual(fallbackFunctions(), ['typedIn'])
        })

        it('stores the declarations of a document that did not parse on the MATLAB thread', async () => {
            asyncStatus = 0
            const text = 'function onThread\nx = (;\nend'
            syncReplies.set(text, Promise.resolve({ ...syncCodeData('sync'), errorInfo: PARSE_ERROR }))

            await settleWithin(indexer.indexDocument(doc(text)), 1000)

            assert.strictEqual(syncCalls().length, 1)
            assert.ok(!fileInfoIndex.codeInfoCache.has(DOC_URI))
            assert.deepStrictEqual(fallbackFunctions(), ['onThread'])
        })

        it('drops the declarations once the document parses', async () => {
            await indexWith(doc('function typedIn\nx = (;\nend', 1), { ...F_1, errorInfo: PARSE_ERROR })
            assert.deepStrictEqual(fallbackFunctions(), ['typedIn'])

            await indexWith(doc('function f1\nend\nfunction f2\nend', 2), F_2)

            assert.strictEqual(fallbackFunctions(), undefined)
            assert.deepStrictEqual(storedFunctions(), ['f1', 'f2'])
        })
    })

    it('does not count time spent waiting for the MATLAB thread against the timeout', async () => {
        const accepted = deferred<any>()
        mockMvm.feval.callsFake(async (name: string) => {
            if (name === ASYNC_HANDLER) {
                return await accepted.promise
            }
            if (name === SYNC_HANDLER) {
                return { result: [syncCodeData('sync')] }
            }
            throw new Error(`unexpected feval ${name}`)
        })

        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        let indexing: Promise<void> | undefined
        try {
            indexing = indexer.indexDocument(doc('v1'))
            await waitUntil(() => asyncCalls().length === 1)
            clock.tick(BACKGROUND_PARSE_TIMEOUT_MS + 1)
            accepted.resolve({ result: [1] })
            await waitUntil(() => (indexer as any).pendingParses.get(requestIdFor('v1'))?.timer !== undefined)
        } finally {
            clock.restore()
        }

        fake.deliver({ requestId: requestIdFor('v1'), codeData: F_1 })
        await settleWithin(indexing as Promise<void>, 1000)

        assert.strictEqual(syncCalls().length, 0)
        assert.deepStrictEqual(storedFunctions(), ['fun'])
    })
})
