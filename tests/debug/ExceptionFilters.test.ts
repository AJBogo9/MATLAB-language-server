// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import { DebugProtocol } from '@vscode/debugprotocol'

import {
    EXCEPTION_FILTERS, parseExceptionArguments, planConditionCommands, describeStop, identifierFromLast,
    forgetClearedCondition, exceptionBreakpointId, changedFilterBreakpoints, AppliedConditions, DesiredConditions
} from '../../src/debug/exceptions/ExceptionFilters'
import { GlobalBreakpointType } from '../../src/debug/DebugServices'

const desired = (entries: Array<[string, string[]]>): DesiredConditions => new Map(entries)
const applied = (entries: Array<[string, string[] | null]>): AppliedConditions => new Map(entries)
const commandsOf = (previous: AppliedConditions, wanted: DesiredConditions): Array<[string, string[]]> =>
    planConditionCommands(previous, wanted).map(command => [command.fn, command.args])

describe('ExceptionFilters', () => {
    describe('EXCEPTION_FILTERS', () => {
        // VS Code keys a user's stored toggle on filter, label, description, supportsCondition and
        // conditionDescription, so changing any of these strings resets every user's choice
        it('offers the four MATLAB stop conditions with their exact stored strings', () => {
            assert.deepStrictEqual(EXCEPTION_FILTERS.map(f => f.filter), ['error', 'caught error', 'warning', 'naninf'])
            assert.deepStrictEqual(EXCEPTION_FILTERS.map(f => f.label), ['Errors', 'Caught Errors', 'Warnings', 'NaN or Inf'])
            assert.deepStrictEqual(EXCEPTION_FILTERS.map(f => f.supportsCondition === true), [true, true, true, false])
            assert.deepStrictEqual(EXCEPTION_FILTERS.map(f => f.description), [
                'Stop when an error is not caught (dbstop if error).',
                'Stop when an error is caught by try/catch (dbstop if caught error). Can also stop in MATLAB code that the extension runs in the background.',
                'Stop when a warning is issued (dbstop if warning). Can also stop in MATLAB code that the extension runs in the background.',
                'Stop when a calculation produces NaN or Inf (dbstop if naninf).'
            ])
            assert.deepStrictEqual(EXCEPTION_FILTERS.map(f => f.conditionDescription), [
                'Message identifiers separated by commas, for example MATLAB:badsubscript',
                'Message identifiers separated by commas, for example MATLAB:badsubscript',
                'Message identifiers separated by commas, for example MATLAB:singularMatrix',
                undefined
            ])
        })

        it('leaves every filter unchecked by default, as MATLAB does', () => {
            assert.deepStrictEqual(EXCEPTION_FILTERS.map(f => f.default === true), [false, false, false, false])
        })
    })

    describe('parseExceptionArguments', () => {
        it('reads plain filter ids as stopping for every identifier', () => {
            const parsed = parseExceptionArguments({ filters: ['warning'] })
            assert.deepStrictEqual([...parsed.desired], [['warning', []]])
            assert.deepStrictEqual(parsed.entries, [{ filterId: 'warning', known: true }])
        })

        it('reads filter options with and without a condition', () => {
            const parsed = parseExceptionArguments({
                filters: [],
                filterOptions: [{ filterId: 'error' }, { filterId: 'caught error', condition: ' MATLAB:badsubscript, my:id ' }]
            })
            assert.deepStrictEqual([...parsed.desired], [['error', []], ['caught error', ['MATLAB:badsubscript', 'my:id']]])
        })

        it('splits identifiers on spaces as well as commas, and treats a blank condition as every identifier', () => {
            const parsed = parseExceptionArguments({
                filters: [],
                filterOptions: [{ filterId: 'error', condition: 'a:b c:d,,e:f' }, { filterId: 'warning', condition: '  ' }]
            })
            assert.deepStrictEqual([...parsed.desired], [['error', ['a:b', 'c:d', 'e:f']], ['warning', []]])
        })

        it('ignores a condition on NaN or Inf, which takes no identifiers', () => {
            const parsed = parseExceptionArguments({ filters: [], filterOptions: [{ filterId: 'naninf', condition: 'x:y' }] })
            assert.deepStrictEqual([...parsed.desired], [['naninf', []]])
        })

        it('marks an unknown filter id and keeps it out of the conditions', () => {
            const parsed = parseExceptionArguments({ filters: ['bogus'], filterOptions: [{ filterId: 'error' }] })
            assert.deepStrictEqual(parsed.entries, [{ filterId: 'bogus', known: false }, { filterId: 'error', known: true }])
            assert.deepStrictEqual([...parsed.desired], [['error', []]])
        })

        it('lists filters before filter options, the order the response must follow', () => {
            const parsed = parseExceptionArguments({ filters: ['naninf'], filterOptions: [{ filterId: 'error' }] })
            assert.deepStrictEqual(parsed.entries.map(e => e.filterId), ['naninf', 'error'])
        })

        it('accepts arguments without filter options', () => {
            const parsed = parseExceptionArguments({ filters: [] })
            assert.deepStrictEqual(parsed.entries, [])
            assert.strictEqual(parsed.desired.size, 0)
        })
    })

    describe('planConditionCommands', () => {
        it('only adds conditions on the first request, one dbstop per identifier', () => {
            assert.deepStrictEqual(commandsOf(applied([]), desired([['error', []], ['warning', ['w:id', 'v:id']]])), [
                ['dbstop', ['if', 'error']],
                ['dbstop', ['if', 'warning', 'w:id']],
                ['dbstop', ['if', 'warning', 'v:id']]
            ])
        })

        it('never clears on the first request, so a condition typed in the terminal survives', () => {
            assert.deepStrictEqual(commandsOf(applied([]), desired([])), [])
        })

        it('clears a condition that was unchecked', () => {
            assert.deepStrictEqual(commandsOf(applied([['error', []]]), desired([])), [['dbclear', ['if', 'error']]])
        })

        it('does nothing for a condition that did not change', () => {
            assert.deepStrictEqual(commandsOf(applied([['error', []], ['warning', ['a:b']]]), desired([['error', []], ['warning', ['a:b']]])), [])
        })

        it('clears before narrowing to identifiers, which MATLAB refuses to do otherwise', () => {
            assert.deepStrictEqual(commandsOf(applied([['error', []]]), desired([['error', ['my:id']]])), [
                ['dbclear', ['if', 'error']],
                ['dbstop', ['if', 'error', 'my:id']]
            ])
        })

        it('clears before widening identifiers to all', () => {
            assert.deepStrictEqual(commandsOf(applied([['error', ['a:b']]]), desired([['error', []]])), [
                ['dbclear', ['if', 'error']],
                ['dbstop', ['if', 'error']]
            ])
        })

        it('clears and re-adds when the identifiers change but their count does not', () => {
            assert.deepStrictEqual(commandsOf(applied([['caught error', ['a:b']]]), desired([['caught error', ['c:d']]])), [
                ['dbclear', ['if', 'caught error']],
                ['dbstop', ['if', 'caught error', 'c:d']]
            ])
        })

        it('clears and retries a condition whose last attempt failed', () => {
            assert.deepStrictEqual(commandsOf(applied([['warning', null]]), desired([['warning', ['a:b']]])), [
                ['dbclear', ['if', 'warning']],
                ['dbstop', ['if', 'warning', 'a:b']]
            ])
            assert.deepStrictEqual(commandsOf(applied([['warning', null]]), desired([])), [['dbclear', ['if', 'warning']]])
        })

        it('adds a condition that was checked', () => {
            assert.deepStrictEqual(commandsOf(applied([]), desired([['naninf', []]])), [['dbstop', ['if', 'naninf']]])
        })

        it('names the condition each command belongs to', () => {
            const commands = planConditionCommands(applied([['error', []]]), desired([['warning', ['a:b']]]))
            assert.deepStrictEqual(commands.map(c => c.condition), ['error', 'warning'])
        })
    })

    describe('forgetClearedCondition', () => {
        const conditionOfType: Array<[GlobalBreakpointType, string]> = [
            [GlobalBreakpointType.ERROR, 'error'],
            [GlobalBreakpointType.CAUGHT_ERROR, 'caught error'],
            [GlobalBreakpointType.WARNING, 'warning'],
            [GlobalBreakpointType.NAN_INF, 'naninf']
        ]
        const allFour = (): AppliedConditions => applied([['error', []], ['caught error', ['a:b']], ['warning', null], ['naninf', []]])

        it('forgets the whole condition MATLAB reports cleared, so the next request sets it again', () => {
            for (const [type, condition] of conditionOfType) {
                const state = allFour()
                forgetClearedCondition(state, type, [])
                assert.deepStrictEqual([...state.keys()], ['error', 'caught error', 'warning', 'naninf'].filter(c => c !== condition), condition)
            }
        })

        it('marks a condition unknown when one of its identifiers is cleared, so the next request clears and sets it', () => {
            const state = applied([['caught error', ['a:b', 'c:d']]])
            forgetClearedCondition(state, GlobalBreakpointType.CAUGHT_ERROR, ['a:b'])
            assert.deepStrictEqual([...state], [['caught error', null]])
        })

        it('leaves conditions it never set, and removals of an unknown type, alone', () => {
            const state = applied([['error', []]])
            forgetClearedCondition(state, GlobalBreakpointType.WARNING, [])
            forgetClearedCondition(state, GlobalBreakpointType.WARNING, ['w:id'])
            forgetClearedCondition(state, undefined, [])
            assert.deepStrictEqual([...state], [['error', []]])
        })
    })

    describe('exceptionBreakpointId', () => {
        it('gives each filter an id of its own, and an unknown filter none', () => {
            assert.deepStrictEqual(['error', 'caught error', 'warning', 'naninf', 'bogus'].map(exceptionBreakpointId), [100001, 100002, 100003, 100004, undefined])
        })
    })

    describe('changedFilterBreakpoints', () => {
        const error = { filterId: 'error', known: true }

        it('returns the breakpoints whose verification or message changed since the last answer', () => {
            const reported = new Map<string, DebugProtocol.Breakpoint>([['error', { id: 100001, verified: false, message: 'MATLAB is not connected.' }]])
            assert.deepStrictEqual(changedFilterBreakpoints(reported, [error], [{ id: 100001, verified: true }]), [{ id: 100001, verified: true }])
            assert.deepStrictEqual(changedFilterBreakpoints(reported, [error], [{ id: 100001, verified: true }]), [])
            assert.deepStrictEqual(changedFilterBreakpoints(reported, [error], [{ id: 100001, verified: false, message: 'Unknown command option.' }]),
                [{ id: 100001, verified: false, message: 'Unknown command option.' }])
            assert.deepStrictEqual(changedFilterBreakpoints(reported, [error], [{ id: 100001, verified: false, message: 'Another message.' }]),
                [{ id: 100001, verified: false, message: 'Another message.' }])

            const withoutMessages = new Map<string, DebugProtocol.Breakpoint>([['error', { id: 100001, verified: false }]])
            assert.deepStrictEqual(changedFilterBreakpoints(withoutMessages, [error], [{ id: 100001, verified: true }]), [{ id: 100001, verified: true }])
        })

        it('returns nothing for a filter answered for the first time, or for one without an id', () => {
            const reported = new Map<string, DebugProtocol.Breakpoint>()
            const bogus = { filterId: 'bogus', known: false }
            assert.deepStrictEqual(changedFilterBreakpoints(reported, [error, bogus], [{ id: 100001, verified: true }, { verified: false, message: 'Unknown exception filter: bogus' }]), [])
            assert.deepStrictEqual(changedFilterBreakpoints(reported, [error, bogus], [{ id: 100001, verified: false, message: 'x' }, { verified: true }]),
                [{ id: 100001, verified: false, message: 'x' }])
        })
    })

    describe('describeStop', () => {
        it('reports an error stop as an exception with its message', () => {
            assert.deepStrictEqual(describeStop({ Condition: 'error', Message: 'Boom 1', Type: 'GlobalBreak' }),
                { reason: 'exception', description: 'Paused on error', text: 'Boom 1', condition: 'error' })
        })

        it('names caught errors and warnings apart', () => {
            assert.deepStrictEqual(describeStop({ Condition: 'caught error', Message: 'inner', Type: 'GlobalBreak' }),
                { reason: 'exception', description: 'Paused on caught error', text: 'inner', condition: 'caught error' })
            assert.deepStrictEqual(describeStop({ Condition: 'warning', Message: 'careful', Type: 'GlobalBreak' }),
                { reason: 'exception', description: 'Paused on warning', text: 'careful', condition: 'warning' })
        })

        it('supplies the text for NaN or Inf, which MATLAB sends without a message', () => {
            assert.deepStrictEqual(describeStop({ Condition: 'naninf', Type: 'GlobalBreak' }),
                { reason: 'exception', description: 'Paused on NaN or Inf', text: 'NaN or Inf', condition: 'naninf' })
        })

        it('falls back to a generic description for a condition it does not know', () => {
            assert.deepStrictEqual(describeStop({ Condition: 'something new', Message: 'm', Type: 'GlobalBreak' }),
                { reason: 'exception', description: 'Paused on exception', text: 'm', condition: 'something new' })
        })

        it('keeps line breakpoints, steps, keyboard and pause as breakpoint stops', () => {
            assert.deepStrictEqual(describeStop({ Filename: '/w/a.m', LineNumber: 2, Type: 'FileBreak' }), { reason: 'breakpoint' })
            assert.deepStrictEqual(describeStop({ Type: 'OtherBreak' }), { reason: 'breakpoint' })
            assert.deepStrictEqual(describeStop(undefined), { reason: 'breakpoint' })
        })
    })

    describe('identifierFromLast', () => {
        it('takes the identifier from lasterr when its message ends with the stop message', () => {
            assert.strictEqual(identifierFromLast('error', 'Boom 1', ['Error using errFn (line 3)\nBoom 1', 'harness:boom']), 'harness:boom')
        })

        it('rejects a stale lasterr whose message belongs to another error', () => {
            assert.strictEqual(identifierFromLast('error', 'inner', ['Debug commands only allowed when stopped in debug mode.', 'MATLAB:dbOnlyInDebugMode']), undefined)
        })

        it('takes the identifier from lastwarn only when the message is the same', () => {
            assert.strictEqual(identifierFromLast('warning', 'careful', ['careful', 'harness:warn']), 'harness:warn')
            assert.strictEqual(identifierFromLast('warning', 'careful', ['Xcareful', 'harness:warn']), undefined)
        })

        it('has no identifier for an error raised without one', () => {
            assert.strictEqual(identifierFromLast('error', 'plain', ['Error using f\nplain', '']), undefined)
        })

        it('does not match every lasterr against an empty message', () => {
            assert.strictEqual(identifierFromLast('error', '', ['Some older error', 'older:id']), undefined)
        })

        it('has no identifier without a message or a usable result', () => {
            assert.strictEqual(identifierFromLast('error', undefined, ['x', 'a:b']), undefined)
            assert.strictEqual(identifierFromLast('error', 'x', undefined), undefined)
            assert.strictEqual(identifierFromLast('caught error', 'x', ['x', 'a:b']), undefined)
        })
    })
})
