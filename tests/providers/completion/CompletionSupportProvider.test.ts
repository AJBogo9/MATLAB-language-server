// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'

import getMockConnection from '../../mocks/Connection.mock'
import getMockMvm from '../../mocks/Mvm.mock'

import CompletionSupportProvider from '../../../src/providers/completion/CompletionSupportProvider'
import MatlabLifecycleManager from '../../../src/lifecycle/MatlabLifecycleManager'
import ClientConnection from '../../../src/ClientConnection'

import { TextDocument } from 'vscode-languageserver-textdocument'
import { SignatureHelpParams, CompletionParams, TextDocuments } from 'vscode-languageserver'

/**
 * The payload shapes below are transcribed from real
 * matlabls.internal.getCompletionsData output on MATLAB R2026a. Probed values:
 *
 *   plot(x,y,      7 signatures, per-signature presenting (1-based)
 *                  [3,4] [3] [3] [3,4,7] [3] [3,4] [3],
 *                  promotion secondary/secondary/primary/primary/secondary/
 *                  suggested/secondary, sig7 duplicated=true
 *   zeros(sz,      7 signatures, sig1 suggested
 *   tic(           1 signature, both duplicated=true and suggested
 *   noDocArgs(1,M  a `shared` block with 344 choices alongside 1 arg choice
 *
 * parseSignatureHelp is called directly rather than through a recorded MVM
 * fixture: the MVM wire format is not jsonencode (a scalar MATLAB string arrives
 * as ["hello"]), so a recorded fixture would be green here and wrong in
 * production.
 */
describe('CompletionSupportProvider', () => {
    let provider: CompletionSupportProvider
    let documentManager: TextDocuments<TextDocument>
    let mockMvm: any

    const URI = 'file:///test.m'

    const arg = (name: string, presenting = false): any => ({
        name,
        widgetType: 'completion',
        ...(presenting ? { status: 'presenting' } : {})
    })

    /** plot(x,y, as MATLAB actually returns it. */
    const PLOT_PAYLOAD = {
        signatures: [
            { functionName: 'plot', promotion: 'secondary', inputArguments: [arg('X'), arg('Y'), arg('LineSpec', true), arg('Name', true)] },
            { functionName: 'plot', promotion: 'secondary', inputArguments: [arg('X'), arg('Y'), arg('LineSpec', true)] },
            { functionName: 'plot', promotion: 'primary', inputArguments: [arg('X'), arg('Y'), arg('LineSpec', true)] },
            { functionName: 'plot', promotion: 'primary', inputArguments: [arg('X1'), arg('Y1'), arg('LineSpec1', true), arg('X2', true), arg('Y2'), arg('LineSpec2'), arg('Name', true)] },
            { functionName: 'plot', promotion: 'secondary', inputArguments: [arg('X'), arg('Y'), arg('Name', true)] },
            { functionName: 'plot', promotion: 'suggested', inputArguments: [arg('X'), arg('Y'), arg('LineSpec', true), arg('Name', true)] },
            { functionName: 'plot', promotion: 'secondary', duplicated: true, inputArguments: [arg('ax'), arg('X'), arg('Y', true)] }
        ]
    }

    const setup = (): void => {
        const matlabLifecycleManager = new MatlabLifecycleManager()
        mockMvm = getMockMvm()
        mockMvm.isReady.returns(true)
        provider = new CompletionSupportProvider(matlabLifecycleManager, mockMvm)
        documentManager = new TextDocuments(TextDocument)
        sinon.stub(documentManager, 'get').returns(TextDocument.create(URI, 'matlab', 1, 'plot(x,y,'))
    }

    const signatureHelpFor = async (payload: any): Promise<any> => {
        sinon.stub(provider as any, 'retrieveCompletionDataForDocument').resolves(payload)
        return await provider.handleSignatureHelpRequest(
            { textDocument: { uri: URI }, position: { line: 0, character: 9 } } as SignatureHelpParams,
            documentManager
        )
    }

    const completionsFor = async (payload: any): Promise<any> => {
        sinon.stub(provider as any, 'retrieveCompletionDataForDocument').resolves(payload)
        return await provider.handleCompletionRequest(
            { textDocument: { uri: URI }, position: { line: 0, character: 9 } } as CompletionParams,
            documentManager
        )
    }

    before(() => ClientConnection._setConnection(getMockConnection()))
    after(() => ClientConnection._clearConnection())
    beforeEach(() => setup())
    afterEach(() => sinon.restore())

    describe('#parseSignatureHelp active parameter', () => {
        it('should give every overload its own active parameter', async () => {
            // Overloads that disagree, which is the case the old shared value got
            // wrong: it wrote one number from inside the per-signature loop, so
            // the last overload silently overwrote all the others.
            const help = await signatureHelpFor({
                signatures: [
                    { functionName: 'f', promotion: 'primary', inputArguments: [arg('a', true), arg('b'), arg('c')] },
                    { functionName: 'f', promotion: 'secondary', inputArguments: [arg('a'), arg('b', true), arg('c')] },
                    { functionName: 'f', promotion: 'secondary', inputArguments: [arg('a'), arg('b'), arg('c', true)] }
                ]
            })

            assert.deepEqual(
                help.signatures.map((s: any) => s.activeParameter),
                [0, 1, 2],
                'each signature must keep its own index rather than the last one written')
        })

        it('should set an active parameter on every plot overload', async () => {
            const help = await signatureHelpFor(PLOT_PAYLOAD)

            for (const signature of help.signatures) {
                assert.equal(typeof signature.activeParameter, 'number',
                    'every overload of a real payload should carry its own value')
            }
        })

        it('should pick the first presenting argument, not the last', async () => {
            // Signature 4 marks arguments 3, 4 and 7 as presenting. The cursor is
            // in the third, so 2 is correct and 6 is not.
            const help = await signatureHelpFor(PLOT_PAYLOAD)
            assert.equal(help.signatures[3].activeParameter, 2,
                'a variadic overload marks several arguments presenting; the first is the live one')
        })

        it('should keep a top-level activeParameter for pre-3.16 clients', async () => {
            const help = await signatureHelpFor(PLOT_PAYLOAD)
            assert.equal(typeof help.activeParameter, 'number')
        })
    })

    describe('#parseSignatureHelp active signature', () => {
        it('should select the signature MATLAB marked suggested', async () => {
            const help = await signatureHelpFor(PLOT_PAYLOAD)
            assert.equal(help.activeSignature, 5, 'signature 6 of 7 carries promotion=suggested')
        })

        it('should fall back to the first signature when nothing is suggested', async () => {
            const help = await signatureHelpFor({
                signatures: [
                    { functionName: 'f', promotion: 'primary', inputArguments: [arg('a', true)] },
                    { functionName: 'f', promotion: 'secondary', inputArguments: [arg('a', true)] }
                ]
            })
            assert.equal(help.activeSignature, 0)
        })

        it('should keep a signature that is both duplicated and suggested', async () => {
            // For `tic(` the only signature carries duplicated=true. Dropping
            // duplicates would leave no signature help at all.
            const help = await signatureHelpFor({
                signatures: [{ functionName: 'tic', promotion: 'suggested', duplicated: true, inputArguments: [arg('a')] }]
            })
            assert.equal(help.signatures.length, 1)
            assert.equal(help.activeSignature, 0)
        })
    })

    describe('#parseSignatureHelp parameter labels', () => {
        it('should address parameters by offset, not by name', async () => {
            const help = await signatureHelpFor({
                signatures: [{ functionName: 'zeros', promotion: 'suggested', inputArguments: [arg('sz'), arg('sz'), arg('typename', true)] }]
            })

            const signature = help.signatures[0]
            assert.equal(signature.label, 'zeros(sz, sz, typename)')

            // Two parameters share the name "sz"; string labels would collapse
            // both onto the first occurrence.
            const labels = signature.parameters.map((p: any) => p.label)
            assert.deepEqual(labels[0], [6, 8], 'first sz')
            assert.deepEqual(labels[1], [10, 12], 'second sz, a distinct range')
            assert.deepEqual(labels[2], [14, 22], 'typename')
        })

        it('should offset correctly past an output prefix', async () => {
            const help = await signatureHelpFor({
                signatures: [{
                    functionName: 'size',
                    promotion: 'suggested',
                    outputArguments: [{ name: 'sz', widgetType: 'completion' }],
                    inputArguments: [arg('A', true)]
                }]
            })

            const signature = help.signatures[0]
            assert.equal(signature.label, 'sz = size(A)')
            assert.deepEqual(signature.parameters[0].label, [10, 11],
                'the output prefix shifts every parameter offset')
        })

        it('should offset correctly past a bracketed output list', async () => {
            const help = await signatureHelpFor({
                signatures: [{
                    functionName: 'max',
                    promotion: 'suggested',
                    outputArguments: [{ name: 'M', widgetType: 'completion' }, { name: 'I', widgetType: 'completion' }],
                    inputArguments: [arg('A', true)]
                }]
            })

            const signature = help.signatures[0]
            assert.equal(signature.label, '[M, I] = max(A)')
            const [start, end] = signature.parameters[0].label
            assert.equal(signature.label.slice(start, end), 'A',
                'the offset must actually address the parameter text')
        })

        it('should produce offsets that address the right text for every plot overload', async () => {
            const help = await signatureHelpFor(PLOT_PAYLOAD)

            for (const signature of help.signatures) {
                for (const parameter of signature.parameters) {
                    const [start, end] = parameter.label
                    const slice = signature.label.slice(start, end)
                    assert.ok(/^[A-Za-z][A-Za-z0-9_]*$/.test(slice),
                        `offset [${start},${end}] addressed "${slice}" in "${signature.label}"`)
                }
            }
        })
    })

    describe('#parseSignatureHelp edge cases', () => {
        it('should return null when there are no signatures', async () => {
            assert.equal(await signatureHelpFor({ widgetType: 'completion' }), null)
        })

        it('should accept a single signature sent as a bare object', async () => {
            const help = await signatureHelpFor({
                signatures: { functionName: 'f', promotion: 'suggested', inputArguments: [arg('a', true)] }
            })
            assert.equal(help.signatures.length, 1)
        })

        it('should render a zero-argument overload rather than dropping it', async () => {
            // MATLAB sends inputArguments: [] here, so the guard never fires and
            // tic() renders today. Locked in so a "fix" does not break it.
            const help = await signatureHelpFor({
                signatures: [{ functionName: 'tic', promotion: 'suggested', inputArguments: [] }]
            })
            assert.equal(help.signatures.length, 1)
            assert.equal(help.signatures[0].label, 'tic()')
        })
    })

    describe('#parseCompletionItems shared block', () => {
        it('should include the shared global completions', async () => {
            // Typing noDocArgs(1,M previously offered only "Method": the 344
            // shared choices were filtered out MATLAB-side before reaching here.
            const list = await completionsFor({
                signatures: [{
                    functionName: 'noDocArgs',
                    promotion: 'suggested',
                    inputArguments: [
                        arg('x'),
                        { name: 'opts', widgetType: 'completion', status: 'presenting', widgetData: { choices: [{ completion: 'Method', matchType: 'fieldname', purpose: 'name-value key' }] } }
                    ]
                }],
                shared: {
                    status: 'presenting',
                    value: 'M',
                    widgetType: 'completion',
                    widgetData: {
                        choices: [
                            { completion: 'magic', matchType: 'mFile', purpose: 'Magic square' },
                            { completion: 'makima', matchType: 'mFile', purpose: 'Modified Akima interpolation' },
                            { completion: 'mapreduce', matchType: 'mFile', purpose: 'Programming technique' }
                        ]
                    }
                }
            })

            const labels = list.items.map((i: any) => i.label)
            assert.ok(labels.includes('Method'), 'the name-value key must still be offered')
            assert.ok(labels.includes('magic'), 'and so must the shared global completions')
            assert.ok(labels.includes('makima'))
            assert.ok(labels.includes('mapreduce'))
        })

        it('should not break when there is no shared block', async () => {
            const list = await completionsFor({
                widgetData: { choices: [{ completion: 'zeros', matchType: 'mFile', purpose: 'Create array of all zeros' }] }
            })
            assert.deepEqual(list.items.map((i: any) => i.label), ['zeros'])
        })

        it('should tolerate a choice with no purpose, as user-defined symbols have', async () => {
            // MATLAB omits the key entirely rather than sending an empty string.
            const list = await completionsFor({
                widgetData: { choices: [{ completion: 'myUserFn', matchType: 'mFile' }] }
            })
            assert.equal(list.items.length, 1)
            assert.equal(list.items[0].detail, '', 'detail must not be the string "undefined"')
        })
    })
})
