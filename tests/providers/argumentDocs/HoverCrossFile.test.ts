// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import getMockConnection from '../../mocks/Connection.mock'
import getMockMvm from '../../mocks/Mvm.mock'

import HoverSupportProvider from '../../../src/providers/hover/HoverSupportProvider'
import ArgumentDocSource, { FileAccess } from '../../../src/providers/argumentDocs/ArgumentDocSource'
import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import FileInfoIndex from '../../../src/indexing/FileInfoIndex'
import ClientConnection from '../../../src/ClientConnection'
import { SymbolClassification } from '../../../src/indexing/SymbolSearchService'

import { TextDocument } from 'vscode-languageserver-textdocument'
import { Hover, MarkupContent, Range, TextDocuments } from 'vscode-languageserver'

/**
 * Hover on a call into another file. The which() payloads follow R2026a
 * (.lane/exp/crit/probe4.log): a user file shadowing a MathWorks name still carries the mathworks.com
 * docUrl of the function it shadows, with shadowedBy equal to whichPath.
 */
describe('hover on a call into another file', () => {
    const docdemo = (description = 'interpolation method'): string => [
        'function y = docdemo(x, factor, opts)',
        '    %DOCDEMO Scale a signal.',
        '    arguments',
        '        x (:,1) double           % the input signal',
        `        opts.Method (1,1) string = "lin"   % ${description}`,
        '    end',
        '    y = x;',
        'end'
    ].join('\n')

    let provider: HoverSupportProvider
    let documentManager: TextDocuments<TextDocument>
    let files: { stat: sinon.SinonStub, readFile: sinon.SinonStub }
    let disk: Map<string, string>
    let open: TextDocument[]

    const setup = (callerText: string, callerUri = 'file:///work/caller.m'): void => {
        disk = new Map()
        open = []
        const text = (filePath: string): string => {
            const found = disk.get(filePath)
            if (found === undefined) {
                throw new Error('ENOENT: ' + filePath)
            }
            return found
        }
        files = {
            stat: sinon.stub().callsFake(async (filePath: string) => ({ mtimeMs: 1, size: text(filePath).length })),
            readFile: sinon.stub().callsFake(async (filePath: string) => text(filePath))
        }
        const mockMvm = getMockMvm()
        mockMvm.isReady.returns(true)
        mockMvm.getMatlabRelease.returns('R2026a')
        provider = new HoverSupportProvider(new MatlabLifecycleManager(), mockMvm, new FileInfoIndex(), new ArgumentDocSource(files as FileAccess))
        documentManager = new TextDocuments(TextDocument)
        sinon.stub(documentManager, 'get').returns(TextDocument.create(callerUri, 'matlab', 1, callerText))
        sinon.stub(documentManager, 'all').callsFake(() => open)
    }

    const buffer = (uri: string, text: string): TextDocument => TextDocument.create(uri, 'matlab', 1, text)

    const hover = async (line: number, character: number, token?: any, callerUri = 'file:///work/caller.m'): Promise<Hover | null> =>
        await provider.handleHoverRequest({ textDocument: { uri: callerUri }, position: { line, character } }, documentManager, token)

    const valueAt = async (line: number, character: number): Promise<string> => {
        const result = await hover(line, character)
        assert.ok(result != null, 'expected a hover')
        return (result.contents as MarkupContent).value
    }

    const classify = (classification: SymbolClassification | null, name = '', targetExpression = name): void => {
        sinon.stub(provider as any, 'classify').returns(classification == null
            ? null
            : { range: { name, range: Range.create(0, 0, 0, name.length) }, classification, targetExpression })
    }

    const stubMatlab = (data: any): sinon.SinonStub => sinon.stub(provider as any, 'retrieveHoverData').resolves(data)

    before(() => ClientConnection._setConnection(getMockConnection()))
    after(() => ClientConnection._clearConnection())
    afterEach(() => sinon.restore())

    describe('with MATLAB', () => {
        it('should describe the call from the file which() names', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: ' DOCDEMO Scale a signal.', whichPath: '/work/lib/docdemo.m', docUrl: '', shadowedBy: '' })
            disk.set('/work/lib/docdemo.m', docdemo())

            const text = await valueAt(0, 6)

            assert.ok(text.includes('Scale a signal.'), text)
            assert.ok(text.includes('y = docdemo(x, factor, opts)'), 'the declared signature: ' + text)
            assert.ok(text.includes('**Arguments**'), text)
            assert.ok(text.indexOf('interpolation method') > text.lastIndexOf('```'), text)
        })

        it('should read the open buffer of that file', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: ' DOCDEMO Scale a signal.', whichPath: '/work/lib/docdemo.m', docUrl: '', shadowedBy: '' })
            disk.set('/work/lib/docdemo.m', docdemo())
            open = [buffer('file:///work/lib/docdemo.m', docdemo('EDITED'))]

            assert.ok((await valueAt(0, 6)).includes('EDITED'))
            assert.strictEqual(files.readFile.called, false)
        })

        it('should let which() decide over an open file of the same name', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: ' DOCDEMO Scale a signal.', whichPath: '/work/lib/docdemo.m', docUrl: '', shadowedBy: '' })
            disk.set('/work/lib/docdemo.m', docdemo('DISK'))
            open = [buffer('file:///other/docdemo.m', docdemo('BUFFER'))]

            const text = await valueAt(0, 6)

            assert.ok(text.includes('DISK'), text)
            assert.ok(!text.includes('BUFFER'), text)
        })

        it('should not read a MathWorks function', async () => {
            setup('y = normalize(1);')
            classify(SymbolClassification.FunctionOrUnbound, 'normalize')
            stubMatlab({
                helpText: ' normalize - Normalize data',
                whichPath: '/usr/local/MATLAB/R2026a/toolbox/matlab/datafun/normalize.m',
                docUrl: 'https://www.mathworks.com/help/matlab/ref/normalize.html',
                shadowedBy: ''
            })

            const text = await valueAt(0, 6)

            assert.ok(!text.includes('**Arguments**'), text)
            assert.strictEqual(files.stat.called, false)
        })

        it('should read a user file that shadows a MathWorks name', async () => {
            setup('y = normalize(1);')
            classify(SymbolClassification.FunctionOrUnbound, 'normalize')
            stubMatlab({
                helpText: ' NORMALIZE My own normalizer.',
                whichPath: '/work/shadow/normalize.m',
                docUrl: 'https://www.mathworks.com/help/releases/R2026a/matlab/ref/double.normalize.html?overload=normalize+false',
                shadowedBy: '/work/shadow/normalize.m'
            })
            disk.set('/work/shadow/normalize.m',
                ['function y = normalize(x)', '    %NORMALIZE My own normalizer.', '    arguments', '        x double % the data', '    end', '    y = x;', 'end'].join('\n'))

            const text = await valueAt(0, 6)

            assert.ok(text.includes('the data'), text)
            assert.ok(text.includes('Shadowed by'), 'the warning stays, now that the card describes that file: ' + text)
        })

        it('should not read what which() names that is not a file', async () => {
            setup('y = sin(1);')
            classify(SymbolClassification.FunctionOrUnbound, 'sin')
            stubMatlab({ helpText: ' sin - Sine', whichPath: 'built-in (/usr/local/MATLAB/R2026a/toolbox/matlab/elfun/sin)', docUrl: '', shadowedBy: '' })

            await valueAt(0, 5)

            assert.strictEqual(files.stat.called, false)
        })

        it('should not look elsewhere for a function declared in the hovered file', async () => {
            setup(docdemo(), 'file:///work/docdemo.m')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab(null)

            const result = await hover(0, 15, undefined, 'file:///work/docdemo.m')

            assert.ok(result != null)
            assert.strictEqual(files.stat.called, false)
        })

        // R2026a lists a private function of a folder on the path first, while a call from any other
        // folder runs the next file in the list (.lane/review/prec/run2.txt)
        it('should not describe a private function the call cannot reach', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: ' DOCDEMO Scale a signal.', whichPath: '/lib/private/docdemo.m', docUrl: '', shadowedBy: '' })
            disk.set('/lib/private/docdemo.m', docdemo('PRIVATE'))

            const text = await valueAt(0, 6)

            assert.ok(!text.includes('PRIVATE'), text)
        })

        it('should look beside the caller when which() names a private function it cannot reach', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: ' DOCDEMO Scale a signal.', whichPath: '/lib/private/docdemo.m', docUrl: '', shadowedBy: '' })
            disk.set('/lib/private/docdemo.m', docdemo('PRIVATE'))
            disk.set('/work/docdemo.m', docdemo('NEAR'))

            assert.ok((await valueAt(0, 6)).includes('NEAR'))
        })

        it('should describe a private function from the folder above it', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: ' DOCDEMO Scale a signal.', whichPath: '/work/private/docdemo.m', docUrl: '', shadowedBy: '' })
            disk.set('/work/private/docdemo.m', docdemo('PRIVATE'))

            assert.ok((await valueAt(0, 6)).includes('PRIVATE'))
        })

        it('should describe a private function from another file in its folder', async () => {
            setup('y = docdemo(1, 2);', 'file:///work/private/other.m')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: ' DOCDEMO Scale a signal.', whichPath: '/work/private/docdemo.m', docUrl: '', shadowedBy: '' })
            disk.set('/work/private/docdemo.m', docdemo('PRIVATE'))

            const result = await hover(0, 6, undefined, 'file:///work/private/other.m')

            assert.ok(result != null && (result.contents as MarkupContent).value.includes('PRIVATE'))
        })
    })

    describe('without an answer from which()', () => {
        it('should describe the call from an open file in the same folder', async () => {
            setup('y = docdemo(1, 2);')
            classify(null)
            stubMatlab(null)
            open = [buffer('file:///work/docdemo.m', docdemo())]

            assert.ok((await valueAt(0, 6)).includes('interpolation method'))
        })

        it('should describe the call from a saved file in the same folder', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
            stubMatlab({ helpText: '', whichPath: '', docUrl: '', shadowedBy: '' })
            disk.set('/work/docdemo.m', docdemo())

            assert.ok((await valueAt(0, 6)).includes('interpolation method'))
        })

        it('should prefer the private folder, as MATLAB does', async () => {
            setup('y = docdemo(1, 2);')
            classify(null)
            stubMatlab(null)
            disk.set('/work/private/docdemo.m', docdemo('PRIVATE'))
            disk.set('/work/docdemo.m', docdemo('NEAR'))

            assert.ok((await valueAt(0, 6)).includes('PRIVATE'))
        })

        it('should prefer the same folder over an open file elsewhere', async () => {
            setup('y = docdemo(1, 2);')
            classify(null)
            stubMatlab(null)
            disk.set('/work/docdemo.m', docdemo('NEAR'))
            open = [buffer('file:///elsewhere/docdemo.m', docdemo('FAR'))]

            assert.ok((await valueAt(0, 6)).includes('NEAR'))
        })

        it('should not use an open file of that name in another folder', async () => {
            // Nothing says the call reaches it: offline, plot in one course folder would get the
            // card of a plot.m exercise open from another
            setup('y = docdemo(1, 2);')
            classify(null)
            stubMatlab(null)
            open = [buffer('file:///elsewhere/docdemo.m', docdemo('FAR'))]

            assert.strictEqual(await hover(0, 6), null)
        })

        it('should find a package function under its + folder', async () => {
            setup('y = pk.pkfn(1);')
            classify(SymbolClassification.FunctionOrUnbound, 'pkfn', 'pk.pkfn')
            stubMatlab(null)
            open = [
                buffer('file:///work/+pk/pkfn.m', 'function y = pkfn(x)\n    arguments\n        x double % PACKAGE\n    end\nend'),
                buffer('file:///work/pkfn.m', 'function y = pkfn(x)\n    arguments\n        x double % PLAIN\n    end\nend')
            ]

            const text = await valueAt(0, 8)

            assert.ok(text.includes('PACKAGE'), text)
            assert.ok(!text.includes('PLAIN'), text)
        })

        it('should not describe a class from a call to its constructor', async () => {
            setup('g = Gadget(1);')
            classify(SymbolClassification.FunctionOrUnbound, 'Gadget')
            stubMatlab(null)
            disk.set('/work/Gadget.m', [
                'classdef Gadget', '    %GADGET A thing.', '    methods', '        function obj = Gadget(n)',
                '            arguments', '                n double % count', '            end', '        end', '    end', 'end'
            ].join('\n'))

            assert.strictEqual(await hover(0, 6), null)
        })

        it('should not look for a file when the index says the name is something else', async () => {
            setup('y = docdemo(1, 2);')
            classify(SymbolClassification.ClassReference, 'docdemo')
            stubMatlab(null)
            disk.set('/work/docdemo.m', docdemo())

            await hover(0, 6)

            assert.strictEqual(files.stat.called, false)
        })

        it('should not give a local variable the card of a file with its name', async () => {
            setup('model = 3;\ndisp(model)', 'file:///work/script.m')
            classify(null)
            stubMatlab(null)
            open = [buffer('file:///work/model.m', 'function m = model(x)\n%MODEL Fits a model.\nm = x;\nend')]

            assert.strictEqual(await hover(1, 7, undefined, 'file:///work/script.m'), null)
        })

        it('should not give an anonymous function parameter the card of a file with its name', async () => {
            setup('g = @(model) model + 1;', 'file:///work/script.m')
            classify(null)
            stubMatlab(null)
            open = [buffer('file:///work/model.m', 'function m = model(x)\n%MODEL Fits a model.\nm = x;\nend')]

            assert.strictEqual(await hover(0, 14, undefined, 'file:///work/script.m'), null)
        })

        it('should not take a method call on a local variable for a package function', async () => {
            setup('g = 3;\ny = g.spin(1);')
            classify(null)
            stubMatlab(null)
            open = [buffer('file:///work/+g/spin.m', 'function r = spin(x)\n%SPIN Turns.\nr = x;\nend')]

            assert.strictEqual(await hover(1, 7), null)
        })
    })

    it('should drop the card when the request is cancelled during the lookup', async () => {
        setup('y = docdemo(1, 2);')
        classify(SymbolClassification.FunctionOrUnbound, 'docdemo')
        stubMatlab(null)
        disk.set('/work/docdemo.m', docdemo())
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose () {} }) }
        const findDefinition = ArgumentDocSource.prototype.findDefinition
        sinon.stub(ArgumentDocSource.prototype, 'findDefinition').callsFake(async function (this: ArgumentDocSource, ...args: any[]) {
            const found = await (findDefinition as any).apply(this, args)
            token.isCancellationRequested = true
            return found
        })

        assert.strictEqual(await hover(0, 6, token), null)
    })
})
