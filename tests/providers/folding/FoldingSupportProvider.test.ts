// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import sinon from 'sinon'

import { FoldingRange, FoldingRangeKind, FoldingRangeParams, TextDocuments } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'

import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import FoldingSupportProvider from '../../../src/providers/folding/FoldingSupportProvider'
import getMockMvm from '../../mocks/Mvm.mock'

interface FoldingCase {
    label: string
    code: string
    expected: Array<[number, number, FoldingRangeKind?]>
}

const CASES: FoldingCase[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'foldingCases.json'), 'utf8'))
const caseNamed = (prefix: string): FoldingCase => {
    const found = CASES.find(c => c.label.startsWith(prefix))
    if (found === undefined) {
        throw new Error(`no folding case starting with "${prefix}"`)
    }
    return found
}
const toRanges = (expected: FoldingCase['expected']): FoldingRange[] =>
    expected.map(([start, end, kind]) => FoldingRange.create(start, end, undefined, undefined, kind))

describe('FoldingSupportProvider', () => {
    const DOC_URI = 'file:///fold.m'
    const sections = caseNamed('sections skip')
    const unfinished = caseNamed('sections still fold while a block has no end yet')

    let mockMvm: any
    let provider: FoldingSupportProvider
    let documents: TextDocuments<TextDocument>

    const fold = async (text: string): Promise<FoldingRange[] | null> => {
        sinon.stub(documents, 'get').returns(TextDocument.create(DOC_URI, 'matlab', 1, text))
        return await provider.handleFoldingRangeRequest({ textDocument: { uri: DOC_URI } } as FoldingRangeParams, documents)
    }

    beforeEach(() => {
        mockMvm = getMockMvm()
        const lifecycle = new MatlabLifecycleManager()
        sinon.stub(lifecycle, 'getMatlabRelease').returns('R2026a')
        provider = new FoldingSupportProvider(lifecycle, mockMvm)
        documents = new TextDocuments(TextDocument)
    })

    afterEach(() => {
        sinon.restore()
    })

    it('folds, with kinds, before MATLAB is ready', async () => {
        mockMvm.isReady.returns(false)

        assert.deepStrictEqual(await fold(sections.code), toRanges(sections.expected))
    })

    it('folds without asking MATLAB once it is ready', async () => {
        mockMvm.isReady.returns(true)

        assert.deepStrictEqual(await fold(sections.code), toRanges(sections.expected))
        sinon.assert.notCalled(mockMvm.feval)
    })

    it('keeps folding a file with a syntax error, for which MATLAB returns nothing', async () => {
        mockMvm.isReady.returns(true)
        mockMvm.feval.resolves({ result: [[]] })

        assert.deepStrictEqual(await fold(unfinished.code), toRanges(unfinished.expected))
    })

    it('returns null when there is nothing to fold, so VS Code folds by indentation', async () => {
        mockMvm.isReady.returns(true)
        mockMvm.feval.resolves({ result: [[]] })

        assert.strictEqual(await fold('x = 1;\ny = 2;'), null)
    })
})
