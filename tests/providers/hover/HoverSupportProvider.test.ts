// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import getMockConnection from '../../mocks/Connection.mock'
import getMockMvm from '../../mocks/Mvm.mock'

import HoverSupportProvider, { extractHelpSummary, stripLeadingSummaryLine } from '../../../src/providers/hover/HoverSupportProvider'
import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import FileInfoIndex from '../../../src/indexing/FileInfoIndex'
import ClientConnection from '../../../src/ClientConnection'
import { SymbolClassification } from '../../../src/indexing/SymbolSearchService'

import { TextDocument } from 'vscode-languageserver-textdocument'
import { Hover, HoverParams, MarkupContent, Range, TextDocuments } from 'vscode-languageserver'

/**
 * The MATLAB-facing method is stubbed throughout, following the pattern in
 * FormatSupportProvider.test.ts. These tests therefore need no MATLAB session
 * and no recorded fixtures, which matters because the MVM wire format is not
 * jsonencode: a scalar MATLAB string jsonencodes to "hello" but arrives as
 * ["hello"], so recorded fixtures would be green here and wrong in production.
 */
describe('HoverSupportProvider', () => {
    let provider: HoverSupportProvider
    let documentManager: TextDocuments<TextDocument>
    let mockMvm: any
    let mockDocument: TextDocument

    const URI = 'file:///test.m'

    const setup = (contents: string): void => {
        const matlabLifecycleManager = new MatlabLifecycleManager()
        mockMvm = getMockMvm()
        mockMvm.isReady.returns(true)
        mockMvm.getMatlabRelease.returns('R2026a')

        const fileInfoIndex = new FileInfoIndex()
        provider = new HoverSupportProvider(matlabLifecycleManager, mockMvm, fileInfoIndex)

        documentManager = new TextDocuments(TextDocument)
        mockDocument = TextDocument.create(URI, 'matlab', 1, contents)
        sinon.stub(documentManager, 'get').returns(mockDocument)
    }

    const paramsAt = (line: number, character: number): HoverParams => ({
        textDocument: { uri: URI },
        position: { line, character }
    })

    const valueOf = (hover: Hover | null): string => {
        assert.ok(hover != null, 'expected a hover')
        return (hover.contents as MarkupContent).value
    }

    /** Makes the index classify whatever is hovered as the given kind. */
    const classifyAs = (classification: SymbolClassification, name: string): void => {
        sinon.stub(provider as any, 'classify').returns({
            range: { name, range: Range.create(0, 0, 0, name.length) },
            classification,
            targetExpression: name
        })
    }

    const stubMatlab = (data: any): sinon.SinonStub =>
        sinon.stub(provider as any, 'retrieveHoverData').resolves(data)

    before(() => ClientConnection._setConnection(getMockConnection()))
    after(() => ClientConnection._clearConnection())
    afterEach(() => sinon.restore())

    describe('suppression', () => {
        it('should return null when there is no document', async () => {
            setup('y = plot(x);');
            (documentManager.get as sinon.SinonStub).returns(undefined)

            assert.equal(await provider.handleHoverRequest(paramsAt(0, 4), documentManager), null)
        })

        it('should not hover a function name inside a comment', async () => {
            setup('x = 1; % remember to plot this')
            const matlab = stubMatlab({ helpText: 'should never be reached' })

            const hover = await provider.handleHoverRequest(paramsAt(0, 21), documentManager)

            assert.equal(hover, null)
            assert.equal(matlab.called, false, 'MATLAB must not be consulted inside a comment')
        })

        it('should not hover a function name inside a char array', async () => {
            setup("name = 'plot';")
            const matlab = stubMatlab({ helpText: 'should never be reached' })

            const hover = await provider.handleHoverRequest(paramsAt(0, 9), documentManager)

            assert.equal(hover, null)
            assert.equal(matlab.called, false, 'MATLAB must not be consulted inside a string')
        })

        it('should still hover an identifier on a line that uses transpose', async () => {
            setup("y = A(1)' + fft(x);")
            classifyAs(SymbolClassification.FunctionOrUnbound, 'fft')
            stubMatlab({ helpText: ' fft - Fast Fourier transform', signatures: ['Y = fft(X)'] })

            const hover = await provider.handleHoverRequest(paramsAt(0, 12), documentManager)

            assert.ok(hover != null, "a transpose must not be mistaken for an unterminated string")
            assert.ok(valueOf(hover).includes('fft'))
        })

        it('should return null on whitespace', async () => {
            setup('y = 1;   ')
            assert.equal(await provider.handleHoverRequest(paramsAt(0, 7), documentManager), null)
        })
    })

    describe('operators and keywords', () => {
        it('should hover an operator without consulting MATLAB', async () => {
            setup('y = a .* b;')
            const matlab = stubMatlab({ helpText: 'should never be reached' })

            const hover = await provider.handleHoverRequest(paramsAt(0, 7), documentManager)

            assert.ok(hover != null)
            assert.ok(valueOf(hover).includes('.*'))
            assert.equal(matlab.called, false, 'the bundled table must serve operators offline')
        })

        it('should give an operator hover a range covering the operator', async () => {
            setup('y = a .^ b;')
            const hover = await provider.handleHoverRequest(paramsAt(0, 6), documentManager)

            assert.deepEqual(hover?.range, Range.create(0, 6, 0, 8))
        })

        it('should hover a keyword without consulting MATLAB', async () => {
            setup('for k = 1:10\nend')
            const matlab = stubMatlab({ helpText: 'should never be reached' })

            const hover = await provider.handleHoverRequest(paramsAt(0, 1), documentManager)

            assert.ok(hover != null)
            assert.ok(valueOf(hover).includes('for'))
            assert.equal(matlab.called, false)
        })

        it('should not give a variable named "properties" the block keyword card', async () => {
            // arguments, properties, methods, events, enumeration and import are
            // context-sensitive, not reserved, so they are all legal identifiers.
            setup('properties = struct();\ny = properties;')
            classifyAs(SymbolClassification.Variable, 'properties')
            const matlab = stubMatlab({ helpText: 'should never be reached' })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(1, 6), documentManager))

            assert.ok(text.includes('variable'), 'the index says it is a variable, so show the variable card')
            assert.ok(!text.includes('Class properties'), 'not the block keyword documentation')
            assert.equal(matlab.called, false)
        })

        it('should still answer a genuine block keyword from the table', async () => {
            setup('function y = f(x)\narguments\n    x double\nend\ny = x;\nend')
            sinon.stub(provider as any, 'classify').returns(null)
            const matlab = stubMatlab({ helpText: 'should never be reached' })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(1, 2), documentManager))

            assert.ok(text.includes('arguments'), 'a real block header still gets the bundled card')
            assert.equal(matlab.called, false)
        })

        it('should take the fast path for a genuinely reserved keyword', async () => {
            setup('for k = 1:10\nend')
            const classifySpy = sinon.stub(provider as any, 'classify').returns(null)

            await provider.handleHoverRequest(paramsAt(0, 1), documentManager)

            assert.equal(classifySpy.called, false,
                'a reserved word can never be a user symbol, so the index need not be consulted')
        })

        it('should hover operators even when MATLAB is not ready', async () => {
            setup('y = a ./ b;')
            mockMvm.isReady.returns(false)

            const hover = await provider.handleHoverRequest(paramsAt(0, 7), documentManager)

            assert.ok(hover != null, 'this is the path that works during the ~5.2s cold start')
        })
    })

    describe('variables', () => {
        it('should never call help() on something classified as a variable', async () => {
            // help('idx') resolves to `fix` and help('i') to the imaginary unit,
            // so a variable card must never be sourced from help.
            setup('idx = 1;\ny = idx + 2;')
            classifyAs(SymbolClassification.Variable, 'idx')
            const matlab = stubMatlab({ helpText: ' fix - Round toward zero' })

            const hover = await provider.handleHoverRequest(paramsAt(1, 5), documentManager)

            assert.ok(hover != null)
            assert.equal(matlab.called, false, 'this is the single most important rule in the provider')
            assert.ok(!valueOf(hover).includes('Round toward zero'))
            assert.ok(valueOf(hover).includes('variable'))
        })

        it('should read the arguments block of the ENCLOSING function, not the first in the file', async () => {
            // Two local functions each declaring a parameter called x with
            // different constraints. Hovering x in the second must not show the
            // first function's declaration.
            setup([
                'function y = first(x)',      // 0
                'arguments',                  // 1
                '    x (1,1) double = 111',   // 2
                'end',                        // 3
                'y = x;',                     // 4
                'end',                        // 5
                '',                           // 6
                'function z = second(x)',     // 7
                'arguments',                  // 8
                '    x (1,1) string = "SECOND"', // 9
                'end',                        // 10
                'z = x;',                     // 11
                'end'                         // 12
            ].join('\n'))
            classifyAs(SymbolClassification.Variable, 'x')

            const text = valueOf(await provider.handleHoverRequest(paramsAt(11, 4), documentManager))

            assert.ok(text.includes('SECOND'), 'should describe the enclosing function\'s parameter')
            assert.ok(!text.includes('111'), 'must not show the first function\'s declaration')
        })

        it('should show an arguments-block declaration for a validated parameter', async () => {
            setup([
                'function y = f(x)',
                'arguments',
                '    x (1,1) double {mustBePositive} = 1e-6',
                'end',
                'y = x;',
                'end'
            ].join('\n'))
            classifyAs(SymbolClassification.Variable, 'x')

            const hover = await provider.handleHoverRequest(paramsAt(4, 4), documentManager)
            const text = valueOf(hover)

            assert.ok(text.includes('(1,1) double'), 'the declared type should be shown')
            assert.ok(text.includes('mustBePositive'), 'the validator should be shown')
            assert.ok(text.includes('1e-6'), 'the default should be shown')
        })
    })

    describe('documentation cards', () => {
        it('should compose name, summary, signatures and body', async () => {
            setup('y = fft(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'fft')
            stubMatlab({
                helpText: ' fft - Fast Fourier transform\n    Input Arguments\n      X - Input array',
                signatures: ['Y = fft(X)', 'Y = fft(X,n)'],
                docUrl: 'https://www.mathworks.com/help/releases/R2026a/matlab/ref/fft.html'
            })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(0, 5), documentManager))

            assert.ok(text.includes('**fft**'), 'the name should be bold')
            assert.ok(text.includes('Y = fft(X,n)'), 'every overload signature should appear')
            assert.ok(text.includes('Input Arguments'), 'the help body should appear')
            assert.ok(text.includes('[Documentation](https://www.mathworks.com/'), 'the doc link should appear')
        })

        it('should strip the Syntax section already rendered as signatures', async () => {
            setup('y = fft(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'fft')
            stubMatlab({
                helpText: ' fft - Fast Fourier transform\n    Syntax\n      Y = fft(X)\n    Input Arguments\n      X - Input array',
                signatures: ['Y = fft(X)']
            })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(0, 5), documentManager))

            assert.ok(!text.includes('Syntax'), 'help repeats the signatures; do not show them twice')
            assert.ok(text.includes('Input Arguments'), 'the rest of the body must survive the strip')
        })

        it('should deduplicate repeated signatures', async () => {
            // getSignatures returns one entry per overload, and for some topics
            // those entries are identical: `end` came back as three copies of
            // "end" on R2026a.
            setup('y = someFn(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'someFn')
            stubMatlab({ helpText: 'body text', signatures: ['y = someFn(x)', 'y = someFn(x)', 'y = someFn(x)'] })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(0, 6), documentManager))
            const occurrences = text.split('\n').filter(l => l.trim() === 'y = someFn(x)').length

            assert.equal(occurrences, 1, 'identical overload signatures should collapse to one line')
        })

        it('should warn when a user file shadows a builtin', async () => {
            setup('y = plot(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'plot')
            stubMatlab({ helpText: ' plot - Plot', shadowedBy: '/home/me/proj/plot.m' })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(0, 5), documentManager))

            assert.ok(text.includes('Shadowed by'), 'help itself will never tell you this')
            assert.ok(text.includes('/home/me/proj/plot.m'))
        })

        it('should render a local function from the document when MATLAB has nothing', async () => {
            // help('localHelper') returns 0 chars: verified against R2026a.
            setup([
                'function main(x)',
                'z = localHelper(x);',
                'end',
                '',
                'function z = localHelper(a)',
                '%LOCALHELPER Does the real work.',
                'z = a;',
                'end'
            ].join('\n'))
            classifyAs(SymbolClassification.FunctionOrUnbound, 'localHelper')
            stubMatlab(null)

            const text = valueOf(await provider.handleHoverRequest(paramsAt(1, 6), documentManager))

            assert.ok(text.includes('Does the real work.'), 'the document is the only source here')
            assert.ok(text.includes('z = localHelper(a)'))
        })

        it('should include the arguments table, which no MATLAB API exposes', async () => {
            setup([
                'function y = argsRich(x, opts)',
                '%ARGSRICH Demonstrates arguments.',
                'arguments',
                '    x (:,1) double {mustBeFinite}',
                '    opts.Method (1,1) string = "lin"',
                'end',
                'y = x;',
                'end'
            ].join('\n'))
            classifyAs(SymbolClassification.FunctionOrUnbound, 'argsRich')
            stubMatlab({ helpText: ' argsRich - Demonstrates arguments.' })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(0, 15), documentManager))

            assert.ok(text.includes('**Arguments**'))
            assert.ok(text.includes('mustBeFinite'))
            assert.ok(text.includes('opts.Method'))
        })

        it('should return null rather than a card containing only a name', async () => {
            setup('y = nosuchthing(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'nosuchthing')
            stubMatlab({ helpText: '', signatures: [] })

            assert.equal(await provider.handleHoverRequest(paramsAt(0, 6), documentManager), null,
                'a bold name with no content is not worth a tooltip')
        })

        it('should not render a non-mathworks doc url', async () => {
            // getHelpPopupUrl returns a per-session 127.0.0.1 URL for user files
            // and for licensed-but-not-installed toolboxes. The .m handler filters
            // them, and nothing downstream should reintroduce one.
            setup('y = myFn(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'myFn')
            stubMatlab({ helpText: ' myFn - does a thing', docUrl: '' })

            const text = valueOf(await provider.handleHoverRequest(paramsAt(0, 5), documentManager))
            assert.ok(!text.includes('127.0.0.1'))
            assert.ok(!text.includes('[Documentation]'))
        })
    })

    describe('caching', () => {
        it('should not call MATLAB twice for the same topic', async () => {
            setup('y = fft(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'fft')
            const matlab = stubMatlab({ helpText: ' fft - Fast Fourier transform' })

            await provider.handleHoverRequest(paramsAt(0, 5), documentManager)
            await provider.handleHoverRequest(paramsAt(0, 5), documentManager)

            assert.equal(matlab.callCount, 1, 'hover fires on every mouse settle; the cache is load-bearing')
        })

        it('should not cache a card built without MATLAB', async () => {
            setup([
                'function main(x)',
                'z = localHelper(x);',
                'end',
                'function z = localHelper(a)',
                '%LOCALHELPER Does the real work.',
                'end'
            ].join('\n'))
            classifyAs(SymbolClassification.FunctionOrUnbound, 'localHelper')
            const matlab = stubMatlab(null)

            await provider.handleHoverRequest(paramsAt(1, 6), documentManager)
            await provider.handleHoverRequest(paramsAt(1, 6), documentManager)

            assert.equal(matlab.callCount, 2,
                'an offline card must not be pinned for the session and never upgraded once MATLAB connects')
        })

        it('should not serve one document\'s content as another document\'s card', async () => {
            // The cache key is topic + release, but the card embeds the hovered
            // document's own summary and arguments table. Caching the composed
            // card therefore leaked file A's content onto file B.
            setup([
                'function y = shared(x)',
                '%SHARED Summary from file A.',
                'y = x;',
                'end'
            ].join('\n'))
            classifyAs(SymbolClassification.FunctionOrUnbound, 'shared')
            stubMatlab({ helpText: ' shared - MATLAB help text' })

            const first = valueOf(await provider.handleHoverRequest(paramsAt(0, 14), documentManager))
            assert.ok(first.includes('Summary from file A.'))

            // Same symbol name, different document.
            ;(documentManager.get as sinon.SinonStub).returns(TextDocument.create(
                'file:///other.m', 'matlab', 1,
                ['function y = shared(x)', '%SHARED Summary from file B.', 'y = x;', 'end'].join('\n')
            ))

            const second = valueOf(await provider.handleHoverRequest(paramsAt(0, 14), documentManager))

            assert.ok(second.includes('Summary from file B.'),
                'the card must describe the document actually being hovered')
            assert.ok(!second.includes('Summary from file A.'),
                'file A content must not leak through the cache')
        })

        it('should reflect an edit to the hovered document even on a cache hit', async () => {
            setup(['function y = f(x)', '%F Before the edit.', 'y = x;', 'end'].join('\n'))
            classifyAs(SymbolClassification.FunctionOrUnbound, 'f')
            const matlab = stubMatlab({ helpText: ' f - MATLAB help text' })

            await provider.handleHoverRequest(paramsAt(0, 13), documentManager)

            ;(documentManager.get as sinon.SinonStub).returns(TextDocument.create(
                'file:///test.m', 'matlab', 2,
                ['function y = f(x)', '%F After the edit.', 'y = x;', 'end'].join('\n')
            ))

            const second = valueOf(await provider.handleHoverRequest(paramsAt(0, 13), documentManager))

            assert.ok(second.includes('After the edit.'), 'the document half must be recomposed')
            assert.equal(matlab.callCount, 1, 'while the MATLAB half stays cached')
        })

        it('should re-query MATLAB after the cache is cleared', async () => {
            setup('y = fft(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'fft')
            const matlab = stubMatlab({ helpText: ' fft - Fast Fourier transform' })

            await provider.handleHoverRequest(paramsAt(0, 5), documentManager)
            provider.clearCache()
            await provider.handleHoverRequest(paramsAt(0, 5), documentManager)

            assert.equal(matlab.callCount, 2)
        })
    })

    describe('cancellation', () => {
        it('should return null when cancelled before the MATLAB call', async () => {
            setup('y = fft(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'fft')
            const matlab = stubMatlab({ helpText: ' fft - Fast Fourier transform' })

            const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose () {} }) }
            const hover = await provider.handleHoverRequest(paramsAt(0, 5), documentManager, token as any)

            assert.equal(hover, null)
            assert.equal(matlab.called, false)
        })

        it('should return null when cancellation arrives while MATLAB is working', async () => {
            setup('y = fft(x);')
            classifyAs(SymbolClassification.FunctionOrUnbound, 'fft')

            const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose () {} }) }
            sinon.stub(provider as any, 'retrieveHoverData').callsFake(async () => {
                token.isCancellationRequested = true
                return { helpText: ' fft - Fast Fourier transform' }
            })

            const hover = await provider.handleHoverRequest(paramsAt(0, 5), documentManager, token as any)

            assert.equal(hover, null, 'a stale reply must be dropped rather than rendered')
        })
    })

    describe('degradation', () => {
        it('should still produce a card from the document when MATLAB is down', async () => {
            setup([
                'function y = myFn(x)',
                '%MYFN Adds one.',
                'y = x + 1;',
                'end'
            ].join('\n'))
            mockMvm.isReady.returns(false)
            classifyAs(SymbolClassification.FunctionOrUnbound, 'myFn')

            const hover = await provider.handleHoverRequest(paramsAt(0, 14), documentManager)

            assert.ok(hover != null, 'the offline builder is a source, not a consolation prize')
            assert.ok(valueOf(hover).includes('Adds one.'))
        })

        it('should not throw when the index is unavailable', async () => {
            setup('y = fft(x);')
            sinon.stub(provider as any, 'classify').returns(null)
            stubMatlab({ helpText: ' fft - Fast Fourier transform' })

            const hover = await provider.handleHoverRequest(paramsAt(0, 5), documentManager)

            assert.ok(hover != null, 'an unindexed file should degrade, not fail')
        })
    })
})

describe('help summary extraction', () => {
    it('should promote MATLAB\'s summary line to the title', () => {
        assert.equal(
            extractHelpSummary('fft', ' fft - Fast Fourier transform\n    Input Arguments'),
            'Fast Fourier transform')
    })

    it('should match a dotted topic on its last component', () => {
        assert.equal(
            extractHelpSummary('MyClass.increment', ' increment - Increase Count by BY'),
            'Increase Count by BY')
    })

    it('should return null for a user file with a raw comment block', () => {
        // help() on a user function returns its leading comment verbatim, with
        // no " name - summary" line to promote.
        assert.equal(extractHelpSummary('myAdder', 'MYADDER Add and subtract two numbers.\n  More text.'), null)
    })

    it('should return null when the name does not match the topic', () => {
        assert.equal(extractHelpSummary('plot', ' surf - Surface plot'), null,
            'a mismatched name means help resolved to something else')
    })

    it('should return null for empty help', () => {
        assert.equal(extractHelpSummary('fft', ''), null)
        assert.equal(extractHelpSummary('fft', undefined), null)
    })

    it('should strip the promoted line from the body', () => {
        assert.equal(
            stripLeadingSummaryLine(' fft - Fast Fourier transform\n\n    Input Arguments', 'fft'),
            '    Input Arguments')
    })

    it('should leave a body alone when it does not open with a summary', () => {
        const body = '    Input Arguments\n      X - Input array'
        assert.equal(stripLeadingSummaryLine(body, 'fft'), body)
    })
})
