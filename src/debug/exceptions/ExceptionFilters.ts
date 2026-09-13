// Copyright 2026 Andreas Bogossian

import { DebugProtocol } from '@vscode/debugprotocol'

import { GlobalBreakpointType } from '../DebugServices'

const IDENTIFIER_HINT = 'Message identifiers separated by commas, for example '
const BACKGROUND_NOTE = ' Can also stop in MATLAB code that the extension runs in the background.'

/**
 * MATLAB's program-wide stop conditions, offered as DAP exception filters. Each filter id is the
 * condition name dbstatus reports, so it goes to dbstop and dbclear unchanged.
 *
 * VS Code keys a user's stored toggle on the filter, label, description, supportsCondition and
 * conditionDescription, so rewording any of them resets that user's choice.
 */
export const EXCEPTION_FILTERS: DebugProtocol.ExceptionBreakpointsFilter[] = [
    {
        filter: 'error',
        label: 'Errors',
        description: 'Stop when an error is not caught (dbstop if error).',
        supportsCondition: true,
        conditionDescription: IDENTIFIER_HINT + 'MATLAB:badsubscript'
    },
    {
        filter: 'caught error',
        label: 'Caught Errors',
        description: 'Stop when an error is caught by try/catch (dbstop if caught error).' + BACKGROUND_NOTE,
        supportsCondition: true,
        conditionDescription: IDENTIFIER_HINT + 'MATLAB:badsubscript'
    },
    {
        filter: 'warning',
        label: 'Warnings',
        description: 'Stop when a warning is issued (dbstop if warning).' + BACKGROUND_NOTE,
        supportsCondition: true,
        conditionDescription: IDENTIFIER_HINT + 'MATLAB:singularMatrix'
    },
    {
        filter: 'naninf',
        label: 'NaN or Inf',
        description: 'Stop when a calculation produces NaN or Inf (dbstop if naninf).',
        supportsCondition: false
    }
]

const CONDITIONS = EXCEPTION_FILTERS.map(filter => filter.filter)

const CONDITION_OF_TYPE: Record<string, string> = {
    [GlobalBreakpointType.ERROR]: 'error',
    [GlobalBreakpointType.CAUGHT_ERROR]: 'caught error',
    [GlobalBreakpointType.WARNING]: 'warning',
    [GlobalBreakpointType.NAN_INF]: 'naninf'
}

const STOP_DESCRIPTIONS: Record<string, string> = {
    error: 'Paused on error',
    'caught error': 'Paused on caught error',
    warning: 'Paused on warning',
    naninf: 'Paused on NaN or Inf'
}

/** The MATLAB function that returns the message and identifier of the latest error or warning. */
export const LAST_MESSAGE_FUNCTIONS: Record<string, string> = {
    error: 'lasterr',
    warning: 'lastwarn'
}

/** The identifiers each checked condition stops for. An empty list means every identifier. */
export type DesiredConditions = Map<string, string[]>

/** What was applied in MATLAB. null marks a condition whose last command failed, so its state is unknown. */
export type AppliedConditions = Map<string, string[] | null>

export interface ExceptionFilterEntry {
    filterId: string
    known: boolean
}

export interface ConditionCommand {
    fn: 'dbstop' | 'dbclear'
    args: string[]
    condition: string
}

export interface StopDescription {
    reason: string
    description?: string
    text?: string
    condition?: string
}

/**
 * Reads a setExceptionBreakpoints request. The entries follow the order the response must use:
 * plain filters first, then filter options.
 */
export function parseExceptionArguments (args: DebugProtocol.SetExceptionBreakpointsArguments): { entries: ExceptionFilterEntry[], desired: DesiredConditions } {
    const requested: DebugProtocol.ExceptionFilterOptions[] = [
        ...(args.filters ?? []).map(filterId => ({ filterId })),
        ...(args.filterOptions ?? [])
    ]

    const entries: ExceptionFilterEntry[] = []
    const desired: DesiredConditions = new Map()
    for (const option of requested) {
        const filter = EXCEPTION_FILTERS.find(candidate => candidate.filter === option.filterId)
        entries.push({ filterId: option.filterId, known: filter !== undefined })
        if (filter !== undefined) {
            desired.set(filter.filter, filter.supportsCondition === true ? splitIdentifiers(option.condition) : [])
        }
    }

    return { entries, desired }
}

/**
 * Plans the dbstop and dbclear calls that take MATLAB from the previously applied conditions to the
 * desired ones. Only changes issue commands, so a condition set in the terminal is left alone until
 * its checkbox changes. A condition whose identifiers change is cleared first, because MATLAB will
 * not narrow a condition set for every identifier.
 */
export function planConditionCommands (previous: AppliedConditions, desired: DesiredConditions): ConditionCommand[] {
    const commands: ConditionCommand[] = []

    for (const condition of CONDITIONS) {
        const had = previous.get(condition)
        const wanted = desired.get(condition)

        if (had != null && wanted !== undefined && sameIdentifiers(had, wanted)) {
            continue
        }
        if (had !== undefined) {
            commands.push({ fn: 'dbclear', args: ['if', condition], condition })
        }
        if (wanted !== undefined) {
            commands.push(...stopCommands(condition, wanted))
        }
    }

    return commands
}

/**
 * Updates the applied conditions after MATLAB reports a condition cleared, by dbclear typed in the
 * terminal for example. A cleared condition is no longer applied, so the next request sets it again
 * while its filter is checked. A cleared identifier leaves the condition unknown, so the next request
 * clears and sets it. Conditions this adaptor did not set are left alone.
 */
export function forgetClearedCondition (applied: AppliedConditions, type: GlobalBreakpointType | undefined, identifiers: string[]): void {
    const condition = type === undefined ? undefined : CONDITION_OF_TYPE[type]
    if (condition === undefined || !applied.has(condition)) {
        return
    }
    if (identifiers.length === 0) {
        applied.delete(condition)
    } else {
        applied.set(condition, null)
    }
}

const FIRST_EXCEPTION_BREAKPOINT_ID = 100001

/** The id of a filter's breakpoint, by which a later breakpoint event updates the row VS Code shows for that filter. */
export function exceptionBreakpointId (filterId: string): number | undefined {
    const index = CONDITIONS.indexOf(filterId)
    return index === -1 ? undefined : FIRST_EXCEPTION_BREAKPOINT_ID + index
}

/**
 * Records each filter's latest answer and returns the answers that differ from the one before, to be sent as
 * breakpoint changed events. A filter answered for the first time, or one without an id, is not returned.
 */
export function changedFilterBreakpoints (reported: Map<string, DebugProtocol.Breakpoint>, entries: ExceptionFilterEntry[], breakpoints: DebugProtocol.Breakpoint[]): DebugProtocol.Breakpoint[] {
    const changed: DebugProtocol.Breakpoint[] = []
    entries.forEach((entry, index) => {
        const breakpoint = breakpoints[index]
        const previous = reported.get(entry.filterId)
        reported.set(entry.filterId, breakpoint)
        if (breakpoint.id !== undefined && previous !== undefined && (previous.verified !== breakpoint.verified || previous.message !== breakpoint.message)) {
            changed.push(breakpoint)
        }
    })
    return changed
}

/**
 * Describes a stop from the Source field of MATLAB's EnterDebuggerEvent. Only a program-wide
 * condition is an exception; line breakpoints, steps, keyboard and pause stay breakpoint stops.
 */
export function describeStop (source: unknown): StopDescription {
    const stop = source as { Type?: unknown, Condition?: unknown, Message?: unknown } | undefined
    if (stop?.Type !== 'GlobalBreak' || typeof stop.Condition !== 'string') {
        return { reason: 'breakpoint' }
    }

    const condition = stop.Condition
    const description: StopDescription = {
        reason: 'exception',
        description: STOP_DESCRIPTIONS[condition] ?? 'Paused on exception',
        condition
    }
    const text = condition === 'naninf' ? 'NaN or Inf' : stop.Message
    if (typeof text === 'string') {
        description.text = text
    }
    return description
}

/**
 * Picks the identifier out of a lasterr or lastwarn result, but only when its message belongs to the
 * stop: at a caught error stop lasterr still holds an older error.
 */
export function identifierFromLast (condition: string, message: string | undefined, last: unknown): string | undefined {
    if (message === undefined || message === '' || !Array.isArray(last)) {
        return undefined
    }

    const [lastMessage, identifier] = last
    if (typeof lastMessage !== 'string' || typeof identifier !== 'string' || identifier === '') {
        return undefined
    }

    if (condition === 'error' && lastMessage.endsWith(message)) {
        return identifier
    }
    if (condition === 'warning' && lastMessage === message) {
        return identifier
    }
    return undefined
}

function splitIdentifiers (condition: string | undefined): string[] {
    return (condition ?? '').split(/[\s,]+/).filter(identifier => identifier !== '')
}

function sameIdentifiers (a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((identifier, index) => identifier === b[index])
}

function stopCommands (condition: string, identifiers: string[]): ConditionCommand[] {
    if (identifiers.length === 0) {
        return [{ fn: 'dbstop', args: ['if', condition], condition }]
    }
    return identifiers.map(identifier => ({ fn: 'dbstop', args: ['if', condition, identifier], condition }))
}
