// Copyright 2026 Andreas Bogossian

/**
 * Matches the arguments MATLAB's completion engine reports to arguments block declarations.
 *
 * Verified on R2026a with matlabls.internal.getCompletionsData: no argument of a user function
 * carries a purpose. Every name-value struct arrives merged into one argument of kind 'name' called
 * options, whatever the struct is called, with the field names as its choices ("Method" quoted, or
 * Method while it is typed). After Method= the engine reports arguments named Method of kinds name
 * and value, and a repeating argument appears once per repetition. Two structs cannot declare the
 * same field (MATLAB:functionValidation:DuplicateNamedArguments), so a field name alone is enough.
 */

import { ArgumentDeclaration } from '../hover/ArgumentsBlockParser'
import { labelDescription, renderDescription } from './ArgumentDescriptionMarkdown'

/** An argument as the completion engine reports it. */
export interface ReportedArgument {
    name: string
    kind?: string
}

/**
 * Describes one parameter of a signature.
 *
 * @param declarations The declarations of the function the signature belongs to
 * @param argument The reported argument
 * @returns The markdown, or undefined when nothing describes it
 */
export function describeParameter (declarations: ArgumentDeclaration[], argument: ReportedArgument): string | undefined {
    if (argument.kind !== 'name' && argument.kind !== 'value') {
        return describe(declarations.find(d => d.kind !== 'output' && d.name === argument.name))
    }

    const field = findField(declarations, argument.name)
    if (field !== undefined) {
        return describe(field)
    }
    if (argument.kind === 'value') {
        return undefined
    }

    // The placeholder that stands for every name-value struct lists what each field is for
    const fields = declarations
        .filter(d => d.name.includes('.') && d.description != null)
        .map(d => labelDescription(d.name.slice(d.name.indexOf('.') + 1), renderDescription(d.description ?? [])))
        .join('\n\n')
    return fields !== '' ? fields : undefined
}

/**
 * Describes a name-value field offered as a completion.
 *
 * @param declarations The declarations of the function being called
 * @param completion The completion, the field name with or without quotes
 * @returns The markdown, or undefined when nothing describes it
 */
export function describeNameValueChoice (declarations: ArgumentDeclaration[], completion: string): string | undefined {
    return describe(findField(declarations, completion))
}

function findField (declarations: ArgumentDeclaration[], name: string): ArgumentDeclaration | undefined {
    const field = name.replace(/^["']|["']$/g, '')
    return declarations.find(d => d.name.endsWith('.' + field))
}

function describe (declaration: ArgumentDeclaration | undefined): string | undefined {
    return declaration?.description != null ? renderDescription(declaration.description) : undefined
}
