// Copyright 2026 Andreas Bogossian

/**
 * Renders argument descriptions as markdown for hover cards and signature help.
 *
 * A code fence cannot hold markdown, so in a hover card the descriptions sit below the fenced
 * Arguments table as prose, one paragraph per described argument, labelled with its name the way
 * the card's title labels its summary.
 */

import { ArgumentDeclaration } from '../hover/ArgumentsBlockParser'
import { DocCommentLine, escapeMarkdown, renderDocComment } from '../hover/DocCommentMarkdown'

/**
 * Renders one argument's description.
 *
 * A single line stays one line of prose, since renderDocComment fences a line that reads like a
 * list, such as "x - the input". A longer description follows the doc comment rules, so an
 * example in it stays preformatted.
 *
 * @param lines The description lines
 * @returns The markdown
 */
export function renderDescription (lines: DocCommentLine[]): string {
    return lines.length === 1 ? escapeMarkdown(lines[0].text.trim()) : renderDocComment(lines)
}

/**
 * Labels a rendered description with a name. A fence cannot share a line with the label.
 *
 * @param name The argument or field name
 * @param rendered The rendered description
 * @returns The labelled markdown
 */
export function labelDescription (name: string, rendered: string): string {
    const label = '`' + name + '`'
    return rendered.startsWith('```') ? label + '\n\n' + rendered : label + '  ·  ' + rendered
}

/**
 * Renders the descriptions of every described declaration, in source order.
 *
 * @param declarations The declarations
 * @returns The markdown, or an empty string when none is described
 */
export function renderArgumentDescriptions (declarations: ArgumentDeclaration[]): string {
    return declarations
        .filter(declaration => declaration.description != null)
        .map(declaration => labelDescription(declaration.name, renderDescription(declaration.description ?? [])))
        .join('\n\n')
}
