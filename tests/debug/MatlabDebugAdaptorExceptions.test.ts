// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'
import { EventEmitter } from 'events'
import { DebugProtocol } from '@vscode/debugprotocol'

import MatlabDebugAdaptor from '../../src/debug/MatlabDebugAdaptor'
import { DebugServices } from '../../src/debug/DebugServices'
import { EXCEPTION_FILTERS } from '../../src/debug/exceptions/ExceptionFilters'
import { IMVM, MatlabMVMConnectionState } from '../../src/mvm/impl/MVM'

import captured from './capturedDebugEvents'

type FevalHandler = (functionName: string, args: unknown[]) => Promise<unknown>

/**
 * A real EventEmitter stands in for the MVM (the shared Mvm.mock keeps one callback per event,
 * and the adaptor and DebugServices both listen), with fevals routed through a handler each test
 * can replace. Event payloads and feval results are the ones captured from MATLAB R2026a.
 */
class FakeMvm extends EventEmitter {
    feval = sinon.stub()
    eval = sinon.stub().resolves()
    interrupt = sinon.stub()
    pauseInDebugger = sinon.stub()
    unpause = sinon.stub()
    setBreakpoint = sinon.stub().resolves()
    clearBreakpoint = sinon.stub().resolves()

    getMatlabRelease (): string {
        return 'R2026a'
    }
}

class RecordingAdaptor extends MatlabDebugAdaptor {
    responses: DebugProtocol.Response[] = []
    events: DebugProtocol.Event[] = []

    sendResponse (response: DebugProtocol.Response): void {
        this.responses.push(response)
    }

    sendEvent (event: DebugProtocol.Event): void {
        this.events.push(event)
    }
}

const defaultFeval: FevalHandler = async (functionName) => {
    if (functionName === 'dbstack') {
        return { result: [[], 1] }
    }
    return captured.dbstopResult
}

// The ids the adaptor gives each filter's breakpoint
const ids = { error: 100001, caughtError: 100002, warning: 100003, naninf: 100004 }

const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setImmediate(resolve))
    }
}

describe('MatlabDebugAdaptor exception filters', () => {
    let mvm: FakeMvm
    let adaptor: RecordingAdaptor
    let fevalHandler: FevalHandler
    let seq: number

    const request = (command: string, args?: unknown): DebugProtocol.Response => {
        seq++
        const response = { seq: 0, type: 'response', success: true, command, request_seq: seq } as DebugProtocol.Response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adaptor.handleRequest({ seq, type: 'request', command, arguments: args }, response as any)
        return response
    }
    const settle = async (command: string, args?: unknown): Promise<DebugProtocol.Response> => {
        const response = request(command, args)
        await flush()
        assert.ok(adaptor.responses.includes(response), `no response to ${command}`)
        return response
    }
    const setFilters = async (filterOptions: DebugProtocol.ExceptionFilterOptions[], filters: string[] = []): Promise<DebugProtocol.SetExceptionBreakpointsResponse> =>
        await settle('setExceptionBreakpoints', { filters, filterOptions }) as DebugProtocol.SetExceptionBreakpointsResponse
    const conditionCalls = (): Array<[string, unknown]> => mvm.feval.getCalls()
        .filter(call => call.args[0] === 'dbstop' || call.args[0] === 'dbclear')
        .map(call => [call.args[0], call.args[2]])
    const callsTo = (functionName: string): sinon.SinonSpyCall[] => mvm.feval.getCalls().filter(call => call.args[0] === functionName)
    const stoppedBodies = (): unknown[] => adaptor.events.filter(e => e.event === 'stopped').map(e => e.body)
    const emitAll = (eventName: string, payloads: unknown[]): void => {
        payloads.forEach(payload => mvm.emit(eventName, payload))
    }
    const stopOn = async (payloads: unknown[]): Promise<void> => {
        emitAll('EnterDebuggerEvent', payloads)
        await flush()
    }

    beforeEach(() => {
        seq = 0
        fevalHandler = defaultFeval
        mvm = new FakeMvm()
        mvm.feval.callsFake(async (functionName: string, nargout: number, args: unknown[]) => await fevalHandler(functionName, args))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imvm = mvm as any
        adaptor = new RecordingAdaptor(imvm, new DebugServices(imvm))
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('initialize', () => {
        it('advertises the filters, filter options and exception info', async () => {
            const response = await settle('initialize', {}) as DebugProtocol.InitializeResponse
            assert.deepStrictEqual(response.body?.exceptionBreakpointFilters, EXCEPTION_FILTERS)
            assert.deepStrictEqual(response.body?.exceptionBreakpointFilters?.map(f => f.filter), ['error', 'caught error', 'warning', 'naninf'])
            assert.strictEqual(response.body?.supportsExceptionFilterOptions, true)
            assert.strictEqual(response.body?.supportsExceptionInfoRequest, true)
        })
    })

    describe('setExceptionBreakpoints', () => {
        it('sets each checked condition in MATLAB and verifies it', async () => {
            const response = await setFilters([{ filterId: 'error' }, { filterId: 'warning', condition: 'w:id' }])
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'error']], ['dbstop', ['if', 'warning', 'w:id']]])
            assert.deepStrictEqual(mvm.feval.getCalls().filter(c => c.args[0] === 'dbstop').map(c => c.args[1]), [0, 0])
            assert.deepStrictEqual(response.body, { breakpoints: [{ id: ids.error, verified: true }, { id: ids.warning, verified: true }] })
        })

        it('clears the conditions that were unchecked', async () => {
            await setFilters([{ filterId: 'error' }, { filterId: 'warning', condition: 'w:id' }])
            const response = await setFilters([])
            assert.deepStrictEqual(conditionCalls().slice(2), [['dbclear', ['if', 'error']], ['dbclear', ['if', 'warning']]])
            assert.deepStrictEqual(response.body, { breakpoints: [] })
        })

        it('clears nothing on the first request, so conditions typed in the terminal survive a session start', async () => {
            await setFilters([], [])
            await setFilters([{ filterId: 'warning' }])
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'warning']]])
        })

        it('reports a condition MATLAB rejects as unverified with its message', async () => {
            fevalHandler = async (functionName, args) => args[2] === 'notAnId' ? captured.badIdentifier : await defaultFeval(functionName, args)
            const response = await setFilters([{ filterId: 'error' }, { filterId: 'warning', condition: 'notAnId' }])
            assert.deepStrictEqual(response.body, { breakpoints: [{ id: ids.error, verified: true }, { id: ids.warning, verified: false, message: 'Unknown command option.' }] })
        })

        it('keeps reporting a rejected condition when the same filters are sent again', async () => {
            fevalHandler = async (functionName, args) => args[2] === 'notAnId' ? captured.badIdentifier : await defaultFeval(functionName, args)
            await setFilters([{ filterId: 'error' }, { filterId: 'warning', condition: 'notAnId' }])
            const again = await setFilters([{ filterId: 'error' }, { filterId: 'warning', condition: 'notAnId' }])
            assert.deepStrictEqual(again.body, { breakpoints: [{ id: ids.error, verified: true }, { id: ids.warning, verified: false, message: 'Unknown command option.' }] })
            assert.deepStrictEqual(conditionCalls().slice(2), [['dbclear', ['if', 'warning']], ['dbstop', ['if', 'warning', 'notAnId']]])
        })

        it('clears a partly applied condition when it is unchecked', async () => {
            fevalHandler = async (functionName, args) => args[2] === 'notAnId' ? captured.badIdentifier : await defaultFeval(functionName, args)
            await setFilters([{ filterId: 'warning', condition: 'good:id notAnId' }])
            await setFilters([])
            assert.deepStrictEqual(conditionCalls().slice(2), [['dbclear', ['if', 'warning']]])
        })

        it('reports a condition as unverified while MATLAB is not connected', async () => {
            fevalHandler = async () => await Promise.reject(new Error('not connected'))
            const response = await setFilters([{ filterId: 'error' }])
            assert.deepStrictEqual(response.body, { breakpoints: [{ id: ids.error, verified: false, message: 'MATLAB is not connected. The setting applies when it connects.' }] })
        })

        it('updates filters answered while MATLAB was not connected once the filters sent on connect set them', async () => {
            const filters = [{ filterId: 'error' }, { filterId: 'warning', condition: 'w:id' }]
            fevalHandler = async () => await Promise.reject(new Error('not connected'))
            await setFilters(filters)
            assert.deepStrictEqual(adaptor.events.filter(e => e.event === 'breakpoint'), [])

            // The client sends the filters again when MATLAB connects
            fevalHandler = defaultFeval
            mvm.emit(IMVM.Events.stateChange, MatlabMVMConnectionState.CONNECTED)
            await setFilters(filters)
            assert.deepStrictEqual(adaptor.events.filter(e => e.event === 'breakpoint').map(e => e.body), [
                { reason: 'changed', breakpoint: { id: ids.error, verified: true } },
                { reason: 'changed', breakpoint: { id: ids.warning, verified: true } }
            ])
        })

        it('sends no breakpoint events while the answer for each filter stays the same', async () => {
            await setFilters([{ filterId: 'error' }])
            await setFilters([{ filterId: 'error' }, { filterId: 'naninf' }])
            await setFilters([{ filterId: 'naninf' }], ['bogus'])
            await setFilters([{ filterId: 'naninf' }], ['bogus'])
            assert.deepStrictEqual(adaptor.events.filter(e => e.event === 'breakpoint'), [])
        })

        it('marks an unknown filter unverified at its own position', async () => {
            const response = await setFilters([{ filterId: 'error' }], ['bogus'])
            assert.deepStrictEqual(response.body, { breakpoints: [{ verified: false, message: 'Unknown exception filter: bogus' }, { id: ids.error, verified: true }] })
        })

        it('handles one request at a time, so a quick second toggle plans against the first', async () => {
            let release: () => void = () => {}
            fevalHandler = async (functionName, args) => {
                if (functionName === 'dbstop') {
                    return await new Promise(resolve => { release = () => resolve(captured.dbstopResult) })
                }
                return await defaultFeval(functionName, args)
            }
            const first = request('setExceptionBreakpoints', { filters: [], filterOptions: [{ filterId: 'error' }] })
            await flush()
            const second = request('setExceptionBreakpoints', { filters: [], filterOptions: [] })
            await flush()
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'error']]])
            assert.deepStrictEqual(adaptor.responses, [])

            release()
            await flush()
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'error']], ['dbclear', ['if', 'error']]])
            assert.deepStrictEqual(adaptor.responses, [first, second])
        })

        it('forgets what it applied when MATLAB disconnects, so the same filters are set again in the new MATLAB', async () => {
            await setFilters([{ filterId: 'error' }])
            mvm.emit(IMVM.Events.stateChange, MatlabMVMConnectionState.DISCONNECTED)
            mvm.emit(IMVM.Events.stateChange, MatlabMVMConnectionState.CONNECTED)
            await setFilters([{ filterId: 'error' }])
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'error']], ['dbstop', ['if', 'error']]])
        })

        it('sets a condition again when the same filters arrive after dbclear all in the terminal', async () => {
            await setFilters([{ filterId: 'error' }])
            emitAll('DeleteProgramWideBreakpointEvent', captured.dbclearAll)
            const response = await setFilters([{ filterId: 'error' }])
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'error']], ['dbstop', ['if', 'error']]])
            assert.deepStrictEqual(response.body, { breakpoints: [{ id: ids.error, verified: true }] })
        })

        it('clears and sets the identifiers again after one of them was cleared in the terminal', async () => {
            await setFilters([{ filterId: 'error', condition: 'other:id harness:boom' }])
            mvm.emit('DeleteProgramWideBreakpointEvent', captured.dbclearIdentifier)
            await setFilters([{ filterId: 'error', condition: 'other:id harness:boom' }])
            assert.deepStrictEqual(conditionCalls().slice(2), [
                ['dbclear', ['if', 'error']],
                ['dbstop', ['if', 'error', 'other:id']],
                ['dbstop', ['if', 'error', 'harness:boom']]
            ])
        })

        it('leaves a condition it never set alone when the terminal clears part of it', async () => {
            await setFilters([])
            mvm.emit('DeleteProgramWideBreakpointEvent', captured.dbclearIdentifier)
            emitAll('DeleteProgramWideBreakpointEvent', captured.dbclearAll)
            await setFilters([])
            assert.deepStrictEqual(conditionCalls(), [])
        })

        it('is not misled by the removal events its own dbclear causes', async () => {
            // MATLAB sends the removal event before it answers the dbclear
            fevalHandler = async (functionName, args) => {
                if (functionName === 'dbclear') {
                    emitAll('DeleteProgramWideBreakpointEvent', [captured.dbclearAll[2]])
                }
                return await defaultFeval(functionName, args)
            }
            await setFilters([{ filterId: 'error' }])
            await setFilters([{ filterId: 'error', condition: 'my:id' }])
            const response = await setFilters([{ filterId: 'error', condition: 'my:id' }])
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'error']], ['dbclear', ['if', 'error']], ['dbstop', ['if', 'error', 'my:id']]])
            assert.deepStrictEqual(response.body, { breakpoints: [{ id: ids.error, verified: true }] })
        })

        it('is not blocked by a request whose feval was lost when MATLAB disconnected', async () => {
            // The MVM drops pending requests on disconnect without settling them
            fevalHandler = async (functionName, args) => functionName === 'dbstop' ? await new Promise(() => {}) : await defaultFeval(functionName, args)
            request('setExceptionBreakpoints', { filters: [], filterOptions: [{ filterId: 'error' }] })
            await flush()
            mvm.emit(IMVM.Events.stateChange, MatlabMVMConnectionState.DISCONNECTED)
            mvm.emit(IMVM.Events.stateChange, MatlabMVMConnectionState.CONNECTED)

            fevalHandler = defaultFeval
            const response = await setFilters([{ filterId: 'warning' }])
            assert.deepStrictEqual(conditionCalls(), [['dbstop', ['if', 'error']], ['dbstop', ['if', 'warning']]])
            assert.deepStrictEqual(response.body, { breakpoints: [{ id: ids.warning, verified: true }] })
        })
    })

    describe('stopped events', () => {
        it('reports an error stop as an exception with the message, on both stopped events', async () => {
            await stopOn(captured.stops.error)
            const expected = { reason: 'exception', threadId: 0, text: 'Boom 1', description: 'Paused on error' }
            assert.deepStrictEqual(stoppedBodies(), [expected, expected])
        })

        it('reports NaN or Inf with a text of its own', async () => {
            await stopOn(captured.stops.naninf)
            const expected = { reason: 'exception', threadId: 0, text: 'NaN or Inf', description: 'Paused on NaN or Inf' }
            assert.deepStrictEqual(stoppedBodies(), [expected, expected])
        })

        it('keeps a line breakpoint stop a breakpoint stop', async () => {
            await stopOn(captured.stops.fileBreak)
            const expected = { reason: 'breakpoint', threadId: 0 }
            assert.deepStrictEqual(stoppedBodies(), [expected, expected])
        })

        it('does not keep the exception label for the step after an error stop', async () => {
            await stopOn(captured.stops.error)
            await stopOn(captured.stops.step)
            const bodies = stoppedBodies()
            assert.strictEqual(bodies.length, 4)
            assert.deepStrictEqual(bodies.slice(2), [{ reason: 'breakpoint', threadId: 0 }, { reason: 'breakpoint', threadId: 0 }])
        })

        it('keeps the stop sent when a session level exit leaves the debugger active a breakpoint stop', async () => {
            await stopOn(captured.stops.error)
            mvm.emit('ExitDebuggerEvent', captured.exitSessionStillActive)
            await flush()
            const bodies = stoppedBodies()
            assert.strictEqual(bodies.length, 3)
            assert.deepStrictEqual(bodies[2], { reason: 'breakpoint', threadId: 0 })
        })

        it('replays the exception stop to a session that starts while MATLAB is stopped', async () => {
            await stopOn(captured.stops.error)
            adaptor.events = []
            await settle('initialize', {})
            assert.deepStrictEqual(stoppedBodies(), [{ reason: 'exception', threadId: 0, text: 'Boom 1', description: 'Paused on error' }])
        })

        it('does not replay an exception stop after MATLAB leaves debug mode', async () => {
            await stopOn(captured.stops.error)
            mvm.emit('ExitDebuggerEvent', captured.exitSession)
            await flush()
            adaptor.events = []
            await settle('initialize', {})
            // The adaptor still replays a stop after dbquit (a separate, older bug), but no longer as the exception
            assert.deepStrictEqual(stoppedBodies(), [{ reason: 'breakpoint', threadId: 0 }])
        })

        it('does not replay an exception stop after MATLAB disconnects', async () => {
            await stopOn(captured.stops.error)
            mvm.emit(IMVM.Events.stateChange, MatlabMVMConnectionState.DISCONNECTED)
            mvm.emit(IMVM.Events.stateChange, MatlabMVMConnectionState.CONNECTED)
            await flush()
            adaptor.events = []
            await settle('initialize', {})
            // The same older bug replays a stop here, but the new MATLAB is not stopped on an error
            assert.deepStrictEqual(stoppedBodies(), [{ reason: 'breakpoint', threadId: 0 }])
        })
    })

    describe('exceptionInfo', () => {
        it('reports the identifier lasterr gives for the error MATLAB stopped on', async () => {
            fevalHandler = async (functionName, args) => functionName === 'lasterr' ? captured.lasterrAtError : await defaultFeval(functionName, args)
            await stopOn(captured.stops.error)
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'harness:boom', description: 'Boom 1', breakMode: 'unhandled' })
            assert.deepStrictEqual(callsTo('lasterr').map(c => [c.args[1], c.args[2]]), [[2, []]])
        })

        it('falls back to the condition name when lasterr belongs to another error', async () => {
            fevalHandler = async (functionName, args) => functionName === 'lasterr' ? captured.lasterrAtCaughtError : await defaultFeval(functionName, args)
            await stopOn(captured.stops.error)
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'error', description: 'Boom 1', breakMode: 'unhandled' })
        })

        it('falls back to the condition name when lasterr fails', async () => {
            fevalHandler = async (functionName, args) => functionName === 'lasterr' ? await Promise.reject(new Error('gone')) : await defaultFeval(functionName, args)
            await stopOn(captured.stops.error)
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'error', description: 'Boom 1', breakMode: 'unhandled' })
        })

        it('does not trust lasterr at a caught error stop', async () => {
            fevalHandler = async (functionName, args) => functionName === 'lasterr' ? captured.lasterrAtCaughtError : await defaultFeval(functionName, args)
            await stopOn(captured.stops.caughtError)
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'caught error', description: 'inner', breakMode: 'always' })
            assert.strictEqual(callsTo('lasterr').length, 0)
        })

        it('reports the identifier lastwarn gives at a warning stop', async () => {
            fevalHandler = async (functionName, args) => functionName === 'lastwarn' ? captured.lastwarnAtWarning : await defaultFeval(functionName, args)
            await stopOn(captured.stops.warning)
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'harness:warn', description: 'careful', breakMode: 'always' })
            assert.deepStrictEqual(callsTo('lastwarn').map(c => [c.args[1], c.args[2]]), [[2, []]])
            assert.strictEqual(callsTo('lasterr').length, 0)
        })

        it('reports NaN or Inf without asking MATLAB for a last message', async () => {
            await stopOn(captured.stops.naninf)
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'naninf', description: 'NaN or Inf', breakMode: 'always' })
            assert.strictEqual(callsTo('lasterr').length + callsTo('lastwarn').length, 0)
        })

        it('answers with a body when the latest stop is not an exception', async () => {
            await stopOn(captured.stops.error)
            await stopOn(captured.stops.step)
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'exception', breakMode: 'always' })
            assert.strictEqual(callsTo('lasterr').length, 0)
        })

        it('forgets the exception once MATLAB continues', async () => {
            await stopOn(captured.stops.error)
            mvm.emit('ContinueExecutionEvent', captured.continueExecution)
            await flush()
            const response = await settle('exceptionInfo', { threadId: 0 })
            assert.deepStrictEqual(response.body, { exceptionId: 'exception', breakMode: 'always' })
            assert.strictEqual(callsTo('lasterr').length, 0)
        })
    })

    describe('evaluate', () => {
        // Watch, hover and Debug Console expressions run inside evalc's try/catch. With Caught Errors (or
        // Warnings, or NaN or Inf) checked MATLAB would stop inside the expression, and the request would
        // never answer. Without the Debugging capability MATLAB still evaluates in the stopped frame.
        for (const context of ['watch', 'hover', 'repl']) {
            it(`evaluates a ${context} expression without the Debugging capability`, async () => {
                fevalHandler = async (functionName, args) => functionName === 'evalc' ? { result: ['1'] } : await defaultFeval(functionName, args)
                await stopOn(captured.stops.fileBreak)
                const response = await settle('evaluate', { expression: 'userThrows()', context }) as DebugProtocol.EvaluateResponse
                const evalc = callsTo('evalc')
                assert.strictEqual(evalc.length, 1)
                assert.notStrictEqual(evalc[0].args[3], true)
                assert.deepStrictEqual(evalc[0].args[4], ['Debugging'])
                assert.strictEqual(response.body?.result, '1')
            })
        }
    })

    describe('variables', () => {
        it('reads the workspace without the Debugging capability, so a caught error inside it cannot halt MATLAB', async () => {
            // Probe: with Caught Errors on, a variable whose class size method throws stopped MATLAB inside getWorkspaceDisplay
            const workspaceDisplay = 'matlab.internal.datatoolsservices.getWorkspaceDisplay'
            fevalHandler = async (functionName, args) => functionName === workspaceDisplay ? { result: [[]] } : await defaultFeval(functionName, args)
            await stopOn(captured.stops.fileBreak)
            const response = await settle('variables', { variablesReference: 2 }) as DebugProtocol.VariablesResponse
            const calls = callsTo(workspaceDisplay)
            assert.strictEqual(calls.length, 1)
            assert.deepStrictEqual(calls[0].args.slice(2), [['caller'], false, ['Debugging']])
            assert.deepStrictEqual(response.body, { variables: [] })
        })
    })

    describe('DebugServices', () => {
        it('passes the reason MATLAB gives for a stop to DBStop listeners', () => {
            const mvmForServices = new FakeMvm()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const services = new DebugServices(mvmForServices as any)
            const received: unknown[][] = []
            services.on(DebugServices.Events.DBStop, (...args: unknown[]) => received.push(args))
            mvmForServices.emit('EnterDebuggerEvent', captured.stops.error[1])
            assert.strictEqual(received.length, 1)
            assert.deepStrictEqual(received[0][3], { Condition: 'error', Message: 'Boom 1', Type: 'GlobalBreak' })
        })
    })
})
