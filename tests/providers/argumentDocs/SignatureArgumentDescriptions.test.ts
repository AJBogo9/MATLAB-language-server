// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import getMockConnection from '../../mocks/Connection.mock'
import getMockMvm from '../../mocks/Mvm.mock'

import CompletionSupportProvider from '../../../src/providers/completion/CompletionSupportProvider'
import ArgumentDocSource, { FileAccess } from '../../../src/providers/argumentDocs/ArgumentDocSource'
import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import ClientConnection from '../../../src/ClientConnection'

import { TextDocument } from 'vscode-languageserver-textdocument'
import { CompletionParams, SignatureHelpParams, TextDocuments } from 'vscode-languageserver'

/**
 * Payload shapes transcribed from matlabls.internal.getCompletionsData on R2026a
 * (.lane/exp/probe.log, probe2.log, probe3.log, crit/probe4.log): user functions report
 * signatureSource as their .m path and no purpose, and every name-value struct is one argument of
 * kind 'name' called options.
 */
describe('signature help and completion argument descriptions', () => {
    const DOCDEMO = [
        'function y = docdemo(x, factor, opts)',
        '    arguments',
        '        x (:,1) double           % the input signal',
        '        % the scale factor, applied to every sample',
        '        factor (1,1) double = 2',
        '        opts.Method (1,1) string = "lin"   % interpolation method',
        '        opts.Tol (1,1) double = 1e-6',
        '    end',
        'end'
    ].join('\n')
    const GADGET = [
        'classdef Gadget',
        '    methods',
        '        function r = spin(obj, speed, opts)',
        '            arguments',
        '                obj',
        '                speed (1,1) double   % revolutions per second',
        '                opts.Dir string = "cw" % direction',
        '            end',
        '            r = speed;',
        '        end',
        '    end',
        'end'
    ].join('\n')
    const GADGET2 = [
        'classdef Gadget2',
        '    methods',
        '        function obj = Gadget2(n, opts)',
        '            arguments',
        '                n double              % count',
        '                opts.Mode string = "a" % mode',
        '            end',
        '        end',
        '    end',
        'end'
    ].join('\n')
    const NVDEMO = [
        'function varargout = nvdemo(a, b)',
        '    arguments',
        '        a double            % first',
        '    end',
        '    arguments (Repeating)',
        '        b double            % repeated thing',
        '    end',
        'end'
    ].join('\n')
    const INPLACE = [
        'function x = inplace(x)',
        '    arguments (Output)',
        '        x double % result',
        '    end',
        'end'
    ].join('\n')
    const UNDESCRIBED_FIELDS = ['function f(opts)', '    arguments', '        opts.A double = 1', '    end', 'end'].join('\n')

    let provider: CompletionSupportProvider
    let documentManager: TextDocuments<TextDocument>
    let files: { stat: sinon.SinonStub, readFile: sinon.SinonStub }
    let open: TextDocument[]

    const disk = new Map([
        ['/work/docdemo.m', DOCDEMO], ['/work/Gadget.m', GADGET], ['/work/Gadget2.m', GADGET2],
        ['/work/nvdemo.m', NVDEMO], ['/work/inplace.m', INPLACE], ['/work/fields.m', UNDESCRIBED_FIELDS]
    ])

    const arg = (name: string, kind: string, extra: object = {}): any => ({ name, kind, widgetType: 'none', ...extra })
    const signature = (functionName: string, signatureSource: string, inputArguments: any[]): any =>
        ({ functionName, signatureSource, promotion: 'suggested', inputArguments })

    beforeEach(() => {
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
        open = []
        const mockMvm = getMockMvm()
        mockMvm.isReady.returns(true)
        provider = new CompletionSupportProvider(new MatlabLifecycleManager(), mockMvm, new ArgumentDocSource(files as FileAccess))
        documentManager = new TextDocuments(TextDocument)
        sinon.stub(documentManager, 'get').returns(TextDocument.create('file:///work/caller.m', 'matlab', 1, 'y = docdemo(1, '))
        sinon.stub(documentManager, 'all').callsFake(() => open)
    })

    before(() => ClientConnection._setConnection(getMockConnection()))
    after(() => ClientConnection._clearConnection())
    afterEach(() => sinon.restore())

    const parametersFor = async (sig: any): Promise<any[]> => {
        sinon.stub(provider as any, 'retrieveCompletionDataForDocument').resolves({ signatures: [sig] })
        const help = await provider.handleSignatureHelpRequest(
            { textDocument: { uri: 'file:///work/caller.m' }, position: { line: 0, character: 15 } } as SignatureHelpParams,
            documentManager)
        assert.ok(help != null)
        return help.signatures[0].parameters ?? []
    }

    const itemsFor = async (sig: any): Promise<any[]> => {
        sinon.stub(provider as any, 'retrieveCompletionDataForDocument').resolves({ signatures: [sig] })
        const list = await provider.handleCompletionRequest(
            { textDocument: { uri: 'file:///work/caller.m' }, position: { line: 0, character: 15 } } as CompletionParams,
            documentManager)
        return list.items
    }

    const markdown = (value: string): any => ({ kind: 'markdown', value })

    describe('signature help', () => {
        it('should document each parameter of a user function from its comment', async () => {
            const parameters = await parametersFor(signature('docdemo', '/work/docdemo.m',
                [arg('x', 'required'), arg('factor', 'positional', { status: 'presenting' }), arg('options', 'name')]))

            assert.deepStrictEqual(parameters[0].documentation, markdown('the input signal'))
            assert.deepStrictEqual(parameters[1].documentation, markdown('the scale factor, applied to every sample'))
        })

        it('should read a signature MATLAB sends on its own rather than in an array', async () => {
            // The usual shape for a user function, which has one signature
            sinon.stub(provider as any, 'retrieveCompletionDataForDocument').resolves({ signatures: signature('docdemo', '/work/docdemo.m', [arg('x', 'required')]) })
            const help = await provider.handleSignatureHelpRequest(
                { textDocument: { uri: 'file:///work/caller.m' }, position: { line: 0, character: 15 } } as SignatureHelpParams,
                documentManager)

            assert.deepStrictEqual(help?.signatures[0].parameters?.[0].documentation, markdown('the input signal'))
        })

        it("should keep MATLAB's purpose where it gives one", async () => {
            const parameters = await parametersFor(signature('docdemo', '/work/docdemo.m', [arg('x', 'required', { purpose: 'MATLAB says' })]))
            assert.strictEqual(parameters[0].documentation, 'MATLAB says')
        })

        it('should keep the value summary under a description', async () => {
            const parameters = await parametersFor(signature('docdemo', '/work/docdemo.m', [arg('x', 'required', { valueSummary: '[3x1 double]' })]))
            assert.deepStrictEqual(parameters[0].documentation, markdown('the input signal\n\n\\[3x1 double\\]'))
        })

        it('should list the described fields on the options placeholder', async () => {
            const parameters = await parametersFor(signature('docdemo', '/work/docdemo.m', [arg('x', 'required'), arg('options', 'name')]))
            const value: string = parameters[1].documentation.value

            assert.strictEqual(parameters[1].documentation.kind, 'markdown')
            assert.ok(value.includes('Method') && value.includes('interpolation method'), value)
            assert.ok(!value.includes('Tol'), 'an undescribed field is left out: ' + value)
            assert.ok(!value.includes('opts.'), 'the field name is what gets typed: ' + value)
            assert.ok(!value.includes('the input signal'), 'positional arguments are not fields: ' + value)
        })

        it('should leave the options placeholder alone when no field is described', async () => {
            const parameters = await parametersFor(signature('f', '/work/fields.m', [arg('options', 'name')]))
            assert.strictEqual(parameters[0].documentation, undefined)
        })

        it('should describe a field once its name is typed', async () => {
            const parameters = await parametersFor(signature('docdemo', '/work/docdemo.m', [
                arg('x', 'required'), arg('Method', 'name'), arg('Method', 'value', { status: 'presenting' }),
                arg('"Method"', 'name'), arg('Unknown', 'value')
            ]))

            assert.deepStrictEqual(parameters[1].documentation, markdown('interpolation method'))
            assert.deepStrictEqual(parameters[2].documentation, markdown('interpolation method'))
            assert.deepStrictEqual(parameters[3].documentation, markdown('interpolation method'), 'quoted')
            assert.strictEqual(parameters[4].documentation, undefined, 'a value of no known field')
        })

        it('should describe a method from the last part of the reported name', async () => {
            const parameters = await parametersFor(signature('g.spin', '/work/Gadget.m', [arg('obj', 'required'), arg('speed', 'required')]))
            assert.deepStrictEqual(parameters[1].documentation, markdown('revolutions per second'))
        })

        it('should describe a constructor call', async () => {
            const parameters = await parametersFor(signature('Gadget2', '/work/Gadget2.m', [arg('n', 'required'), arg('options', 'name')]))
            assert.deepStrictEqual(parameters[0].documentation, markdown('count'))
            assert.ok(parameters[1].documentation.value.includes('mode'))
        })

        it('should describe every repetition of a repeating argument', async () => {
            const parameters = await parametersFor(signature('nvdemo', '/work/nvdemo.m',
                [arg('a', 'required'), arg('b', 'required'), arg('b', 'required'), arg('b', 'optional')]))
            assert.deepStrictEqual(parameters.slice(1).map(p => p.documentation), [1, 2, 3].map(() => markdown('repeated thing')))
        })

        it('should not describe an input with the comment of an output of the same name', async () => {
            const parameters = await parametersFor(signature('inplace', '/work/inplace.m', [arg('x', 'required')]))
            assert.strictEqual(parameters[0].documentation, undefined)
        })

        it('should not read a source that is not a file', async () => {
            const parameters = await parametersFor(signature('dupnv', "matlab.lang.internal.introspective.getUsage('dupnv')", [arg('p', 'required')]))
            assert.strictEqual(parameters[0].documentation, undefined)
            assert.strictEqual(files.stat.called, false)
        })

        it('should read the open buffer of the defining file', async () => {
            open = [TextDocument.create('file:///work/docdemo.m', 'matlab', 2, DOCDEMO.replace('the input signal', 'EDITED signal'))]
            const parameters = await parametersFor(signature('docdemo', '/work/docdemo.m', [arg('x', 'required')]))

            assert.deepStrictEqual(parameters[0].documentation, markdown('EDITED signal'))
            assert.strictEqual(files.readFile.called, false)
        })
    })

    describe('completion', () => {
        const options = (choices: any[]): any => arg('options', 'name', { status: 'presenting', widgetType: 'completion', widgetData: { choices } })

        it('should document a name-value field offered for the options placeholder', async () => {
            const items = await itemsFor(signature('docdemo', '/work/docdemo.m', [
                arg('x', 'required'),
                options([{ completion: '"Method"', matchType: 'literal' }, { completion: '"Tol"', matchType: 'literal' }])
            ]))

            assert.deepStrictEqual(items.find(i => i.label === '"Method"').documentation, markdown('interpolation method'))
            assert.strictEqual(items.find(i => i.label === '"Tol"').documentation, undefined)
        })

        it('should document the field while its name is typed', async () => {
            const items = await itemsFor(signature('docdemo', '/work/docdemo.m', [options([{ completion: 'Method', matchType: 'literal' }])]))
            assert.deepStrictEqual(items.find(i => i.label === 'Method').documentation, markdown('interpolation method'))
        })

        it('should not document a choice of a positional argument', async () => {
            const items = await itemsFor(signature('docdemo', '/work/docdemo.m', [
                arg('factor', 'positional', { status: 'presenting', widgetType: 'completion', widgetData: { choices: [{ completion: 'Method', matchType: 'literal' }] } })
            ]))
            assert.strictEqual(items.find(i => i.label === 'Method').documentation, undefined)
        })

        it("should keep MATLAB's purpose where it gives one", async () => {
            const items = await itemsFor(signature('docdemo', '/work/docdemo.m', [options([{ completion: '"Method"', matchType: 'literal', purpose: 'MATLAB says' }])]))
            const method = items.find(i => i.label === '"Method"')

            assert.strictEqual(method.detail, 'MATLAB says')
            assert.strictEqual(method.documentation, undefined)
        })
    })
})
