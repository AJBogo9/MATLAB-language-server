// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import getMockConnection from '../mocks/Connection.mock'
import DocumentIndexer from '../../src/indexing/DocumentIndexer'
import FileInfoIndex from '../../src/indexing/FileInfoIndex'
import ClientConnection from '../../src/ClientConnection'

import { TextDocument } from 'vscode-languageserver-textdocument'

/**
 * Guards the three behaviours the indexing fixes depend on. Without these the
 * whole commit reverts silently: nothing else in either suite exercises this
 * class, and every defect it fixes is invisible to a type checker.
 */
describe('DocumentIndexer', () => {
    let indexer: any
    let fileInfoIndex: FileInfoIndex
    let documentIndexer: DocumentIndexer
    let indexCalls: number

    const makeDocument = (version = 1, uri = 'file:///test.m'): TextDocument =>
        TextDocument.create(uri, 'matlab', version, 'function y = f(x)\ny = x;\nend')

    /**
     * Stands in for the real Indexer, which populates codeInfoCache as a side
     * effect. Without that, ensureDocumentIndexIsUpdated takes its "not cached"
     * branch and re-parses for a reason unrelated to what is being tested.
     */
    const cachingIndexer = async (doc: TextDocument): Promise<void> => {
        indexCalls++
        fileInfoIndex.codeInfoCache.set(doc.uri, {} as any)
    }

    /** Defers only the FIRST parse; later ones complete immediately. */
    const deferFirstParse = (): { resolve: () => void } => {
        let release: () => void = () => {}
        let deferred = false
        indexer.indexDocument = async (doc: TextDocument) => {
            indexCalls++
            fileInfoIndex.codeInfoCache.set(doc.uri, {} as any)
            if (!deferred) {
                deferred = true
                await new Promise<void>(resolve => { release = resolve })
            }
        }
        return { resolve: () => release() }
    }

    beforeEach(() => {
        indexCalls = 0
        fileInfoIndex = new FileInfoIndex()
        indexer = { indexDocument: cachingIndexer }
        documentIndexer = new DocumentIndexer(indexer, fileInfoIndex)
    })

    before(() => ClientConnection._setConnection(getMockConnection()))
    after(() => ClientConnection._clearConnection())
    afterEach(() => sinon.restore())

    describe('#indexDocument', () => {
        it('should clear its own debounce entry so the document is not parsed twice', async () => {
            const document = makeDocument()

            documentIndexer.queueIndexingForDocument(document)
            await documentIndexer.indexDocument(document)

            // Before the fix the pending entry survived, so this saw the
            // document as still pending and parsed the whole file again.
            await documentIndexer.ensureDocumentIndexIsUpdated(document)

            assert.equal(indexCalls, 1, 'one edit-then-navigate cycle is one MATLAB parse')
        })

        it('should await the parse before announcing it', async () => {
            const announced: string[] = []
            documentIndexer.setOnIndexed(uri => announced.push(uri))
            const deferred = deferFirstParse()

            const pending = documentIndexer.indexDocument(makeDocument())
            await Promise.resolve()

            assert.deepEqual(announced, [],
                'announcing mid-parse made semantic highlighting render one edit behind')

            deferred.resolve()
            await pending

            assert.deepEqual(announced, ['file:///test.m'])
        })
    })

    describe('#ensureDocumentIndexIsUpdated', () => {
        it('should wait for a parse that is already in flight', async () => {
            const document = makeDocument()
            const deferred = deferFirstParse()

            const parsing = documentIndexer.indexDocument(document)
            await Promise.resolve()

            let settled = false
            const ensuring = documentIndexer.ensureDocumentIndexIsUpdated(document).then(() => { settled = true })
            await Promise.resolve()

            assert.equal(settled, false,
                'returning here would hand the caller a pre-edit index, which is how Run Section ran the wrong lines')

            deferred.resolve()
            await parsing
            await ensuring

            assert.equal(settled, true)
        })

        it('should re-parse when the document changed during the in-flight parse', async () => {
            const deferred = deferFirstParse()

            const parsing = documentIndexer.indexDocument(makeDocument(1))
            await Promise.resolve()

            // The in-flight parse captured version 1's text before the round trip.
            const ensuring = documentIndexer.ensureDocumentIndexIsUpdated(makeDocument(2))
            deferred.resolve()
            await parsing

            await ensuring

            assert.ok(indexCalls >= 2, 'a newer version must not be served from the older parse')
        })

        it('should not announce when no index actually happened', async () => {
            const document = makeDocument()
            const announced: string[] = []

            await documentIndexer.indexDocument(document)

            documentIndexer.setOnIndexed(uri => announced.push(uri))
            await documentIndexer.ensureDocumentIndexIsUpdated(document)

            assert.deepEqual(announced, [],
                'this runs on every caret move, and announcing schedules a workspace-wide token refresh')
        })

        it('should announce when it did index', async () => {
            const announced: string[] = []
            documentIndexer.setOnIndexed(uri => announced.push(uri))

            await documentIndexer.ensureDocumentIndexIsUpdated(makeDocument())

            assert.deepEqual(announced, ['file:///test.m'])
        })
    })
})
