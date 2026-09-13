// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import getMockConnection from '../../mocks/Connection.mock'
import getMockMvm from '../../mocks/Mvm.mock'

import HoverSupportProvider from '../../../src/providers/hover/HoverSupportProvider'
import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import FileInfoIndex from '../../../src/indexing/FileInfoIndex'
import ClientConnection from '../../../src/ClientConnection'
import { SymbolClassification } from '../../../src/indexing/SymbolSearchService'

import { TextDocument } from 'vscode-languageserver-textdocument'
import { Hover, HoverParams, MarkupContent, Range, TextDocuments } from 'vscode-languageserver'

/**
 * Where argument descriptions show in hover cards. The layout itself is pinned in
 * ArgumentDescriptionMarkdown.test.ts; these tests pin only that the text appears, and where.
 */
describe('hover argument descriptions', () => {
    let provider: HoverSupportProvider
    let documentManager: TextDocuments<TextDocument>
    let mockMvm: any

    const DOCDEMO_URI = 'file:///work/docdemo.m'
    const DOCDEMO = [
        'function y = docdemo(x, factor, opts)', // 0
        '    %DOCDEMO Scale a signal.', // 1
        '    %   Y = DOCDEMO(X, FACTOR) multiplies X by FACTOR.', // 2
        '    arguments', // 3
        '        x (:,1) double           % the input signal', // 4
        '        % the scale factor, applied to every sample', // 5
        '        factor (1,1) double = 2', // 6
        '        opts.Method (1,1) string = "lin"   % interpolation method', // 7
        '        opts.Tol (1,1) double = 1e-6', // 8
        '    end', // 9
        '    y = x * factor;', // 10
        '    m = opts.Method;', // 11
        'end' // 12
    ].join('\n')

    const setup = (contents: string, uri = DOCDEMO_URI): void => {
        mockMvm = getMockMvm()
        mockMvm.isReady.returns(true)
        mockMvm.getMatlabRelease.returns('R2026a')
        provider = new HoverSupportProvider(new MatlabLifecycleManager(), mockMvm, new FileInfoIndex())
        documentManager = new TextDocuments(TextDocument)
        sinon.stub(documentManager, 'get').returns(TextDocument.create(uri, 'matlab', 1, contents))
    }

    const hoverAt = async (line: number, character: number, uri = DOCDEMO_URI): Promise<string> => {
        const params: HoverParams = { textDocument: { uri }, position: { line, character } }
        const hover: Hover | null = await provider.handleHoverRequest(params, documentManager)
        assert.ok(hover != null, 'expected a hover')
        return (hover.contents as MarkupContent).value
    }

    const classify = (classification: SymbolClassification | null, name = '', targetExpression = name): void => {
        sinon.stub(provider as any, 'classify').returns(classification == null
            ? null
            : { range: { name, range: Range.create(0, 0, 0, name.length) }, classification, targetExpression })
    }

    const stubMatlab = (data: any): sinon.SinonStub => sinon.stub(provider as any, 'retrieveHoverData').resolves(data)

    /** Lines inside any code fence of a card. */
    const fencedLines = (text: string): string[] => {
        const inside: string[] = []
        let open = false
        for (const line of text.split('\n')) {
            if (line.startsWith('```')) {
                open = !open
            } else if (open) {
                inside.push(line)
            }
        }
        return inside
    }

    /** The prose between the last fence and the italic footer of a variable card. */
    const betweenTableAndFooter = (text: string): string =>
        text.slice(text.lastIndexOf('```'), text.lastIndexOf('\n_'))

    before(() => ClientConnection._setConnection(getMockConnection()))
    after(() => ClientConnection._clearConnection())
    afterEach(() => sinon.restore())

    describe('the card for a function declared here', () => {
        it('should describe each argument below the Arguments table, not in it', async () => {
            setup(DOCDEMO)
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab(null)

            const text = await hoverAt(0, 15)
            const tableEnd = text.lastIndexOf('```')

            assert.ok(text.indexOf('**Arguments**') < tableEnd, text)
            for (const description of ['the input signal', 'the scale factor, applied to every sample', 'interpolation method']) {
                assert.ok(text.indexOf(description) > tableEnd, description + ' should follow the table\n' + text)
            }
            assert.ok(fencedLines(text).every(line => !line.includes('%') && !line.includes('the input signal')), text)
        })
    })

    describe('the card for an argument used in the body', () => {
        it('should describe it between its declaration and the footer', async () => {
            setup(DOCDEMO)
            classify(SymbolClassification.Variable, 'factor')

            const text = await hoverAt(10, 12)

            assert.ok(betweenTableAndFooter(text).includes('the scale factor, applied to every sample'), text)
            assert.ok(text.includes('_declared in an arguments block, line 7_'), text)
        })

        it('should describe only the fields that have a description', async () => {
            setup(DOCDEMO)
            classify(SymbolClassification.Variable, 'opts')

            const prose = betweenTableAndFooter(await hoverAt(11, 9))

            assert.ok(prose.includes('interpolation method'), prose)
            assert.ok(!prose.includes('Tol'), prose)
        })

        it('should describe a name-value field where it is used', async () => {
            setup(DOCDEMO)
            classify(SymbolClassification.Variable, 'Method', 'opts.Method')

            const text = await hoverAt(11, 15)

            assert.ok(text.includes('interpolation method'), text)
            assert.ok(fencedLines(text).some(line => line.startsWith('opts.Method')), text)
            assert.ok(!text.includes('no declaration found'), text)
        })

        it('should leave a card without comments as it was', async () => {
            setup(['function y = f(x)', 'arguments', '    x (1,1) double', 'end', 'y = x;', 'end'].join('\n'))
            classify(SymbolClassification.Variable, 'x')

            assert.strictEqual(await hoverAt(4, 4),
                '**x**  ·  variable\n\n```matlab\nx  (1,1) double\n```\n\n_declared in an arguments block, line 3_')
        })
    })

    describe('without an index', () => {
        it('should give a declared argument its variable card rather than help() for its name', async () => {
            // help('factor') describes the prime factorization function
            setup(DOCDEMO)
            classify(null)
            const matlab = stubMatlab({ helpText: ' factor - Prime factors' })

            const text = await hoverAt(10, 12)

            assert.ok(text.includes('variable'), text)
            assert.ok(text.includes('the scale factor, applied to every sample'), text)
            assert.strictEqual(matlab.called, false)
        })

        it('should give a name-value struct its variable card', async () => {
            setup(DOCDEMO)
            classify(null)
            stubMatlab(null)

            const text = await hoverAt(11, 9)

            assert.ok(text.includes('variable'), text)
            assert.ok(text.includes('interpolation method'), text)
        })

        it('should give a name-value field its variable card', async () => {
            setup(DOCDEMO)
            classify(null)
            stubMatlab(null)

            const text = await hoverAt(11, 15)

            assert.ok(fencedLines(text).some(line => line.startsWith('opts.Method')), text)
            assert.ok(text.includes('interpolation method'), text)
        })

        it('should still describe a call to a function that is not an argument', async () => {
            setup(['function y = f(x)', 'arguments', '    x double % in', 'end', 'y = fft(x);', 'end'].join('\n'))
            classify(null)
            stubMatlab({ helpText: ' fft - Fast Fourier transform' })

            const text = await hoverAt(4, 5)

            assert.ok(text.includes('Fast Fourier transform'), text)
            assert.ok(!text.includes('variable'), text)
        })
    })
})
