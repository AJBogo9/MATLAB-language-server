/**
 * Turns the JSON dumped by build/genOperatorHelp.m into
 * src/providers/hover/OperatorHelp.ts.
 *
 * Usage:
 *   matlab -batch "addpath('<repo>/server/build'); genOperatorHelp('/tmp/ops.json')"
 *   node build/genOperatorHelp.js /tmp/ops.json
 */
'use strict'

const fs = require('fs')
const path = require('path')

const inputPath = process.argv[2]
if (!inputPath) {
    console.error('usage: node build/genOperatorHelp.js <ops.json>')
    process.exit(1)
}

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'))

/**
 * Strips MATLAB's own banner and the openExample lines, which are dead links in
 * an editor tooltip, then caps the length so the bundled table stays small.
 */
function clean (text) {
    let lines = text.split('\n')

    if (lines.length > 0 && lines[0].trimStart().startsWith('--- help for')) {
        lines = lines.slice(1)
    }

    lines = lines.filter(line => !line.includes('openExample('))

    // Cut at the Examples heading once its body has been stripped.
    const examplesIndex = lines.findIndex(line => line.trim() === 'Examples')
    if (examplesIndex !== -1) {
        lines = lines.slice(0, examplesIndex)
    }

    if (lines.length > 30) {
        lines = lines.slice(0, 30)
    }

    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()

    return lines.join('\n').trimEnd()
}

const entries = []
const seen = new Set()

for (const entry of raw) {
    if (seen.has(entry.topic)) continue
    const text = clean(entry.text)
    if (text === '') continue
    seen.add(entry.topic)
    entries.push({ topic: entry.topic, isKeyword: entry.isKeyword === 1, text })
}

// Longest topic first keeps the generated table's own ordering stable and makes
// the operator scan's longest-match behaviour obvious when reading the file.
entries.sort((a, b) => b.topic.length - a.topic.length || a.topic.localeCompare(b.topic))

const header = `/* eslint-disable */
// Generated file. Do not edit by hand.
//
// Regenerate with:
//   matlab -batch "addpath('<repo>/server/build'); genOperatorHelp('/tmp/ops.json')"
//   node build/genOperatorHelp.js /tmp/ops.json
//
// MATLAB's \`help\` works on keywords and operators, not just functions. Measured
// on R2026a: help('end') 611 chars, help('.*') 880, help('\\\\') 918,
// help('~=') 1069, help('parfor') 1089, help('arguments') 921.
//
// Baking that into the server buys hover for every keyword and operator with no
// symbol resolution, no index, no variable-vs-function classification and no
// MATLAB round trip. It is therefore the one part of hover that works during the
// measured ~5.2 s cold start and while MATLAB is down entirely.
//
// Note that iskeyword() omits the context-sensitive block keywords (arguments,
// properties, methods, events, enumeration, import), which are among the most
// common things a MATLAB author hovers, so the generator adds them explicitly.
//
// Captured from MATLAB R2026a Update 5.

export interface OperatorHelpEntry {
    /** The operator or keyword itself, e.g. ".*" or "parfor". */
    topic: string
    /** True for language keywords, false for operators and punctuation. */
    isKeyword: boolean
    /** MATLAB's own help text, banner and openExample lines stripped. */
    text: string
}

const ENTRIES: OperatorHelpEntry[] = [
`

const body = entries
    .map(e => `    { topic: ${JSON.stringify(e.topic)}, isKeyword: ${e.isKeyword}, text: ${JSON.stringify(e.text)} }`)
    .join(',\n')

const footer = `
]

const BY_TOPIC = new Map<string, OperatorHelpEntry>(ENTRIES.map(e => [e.topic, e]))

/**
 * Operators sorted longest-first, so a scan finds ".*" before "*" and "..."
 * before ".".
 */
const OPERATORS_LONGEST_FIRST: string[] = ENTRIES
    .filter(e => !e.isKeyword)
    .map(e => e.topic)
    .sort((a, b) => b.length - a.length)

/**
 * Looks up help for an exact keyword or operator.
 *
 * @param topic The keyword or operator
 * @returns The entry, or null if the topic is not a known keyword or operator
 */
export function getOperatorHelp (topic: string): OperatorHelpEntry | null {
    return BY_TOPIC.get(topic) ?? null
}

/**
 * Finds the operator token straddling a character position in a line.
 *
 * Only punctuation operators are considered; keywords are words and are found by
 * the identifier scan instead. Longest match wins, so \`a .* b\` with the cursor
 * on the \`*\` resolves to ".*" rather than "*".
 *
 * @param lineText The full text of the line
 * @param character The 0-based character offset in that line
 * @returns The matched operator and its half-open [start, end) range, or null
 */
export function findOperatorAtPosition (
    lineText: string, character: number
): { topic: string, start: number, end: number } | null {
    for (const op of OPERATORS_LONGEST_FIRST) {
        // A cursor at index i should match an operator occupying
        // [i - len + 1, i + len].
        const searchStart = Math.max(0, character - op.length + 1)
        const searchEnd = Math.min(lineText.length, character + op.length)
        const window = lineText.slice(searchStart, searchEnd)
        let idx = window.indexOf(op)
        while (idx !== -1) {
            const start = searchStart + idx
            const end = start + op.length
            if (start <= character && character < end) {
                return { topic: op, start, end }
            }
            idx = window.indexOf(op, idx + 1)
        }
    }
    return null
}

/** Every keyword and operator with bundled help. Exposed for tests. */
export function getAllTopics (): string[] {
    return ENTRIES.map(e => e.topic)
}
`

const outPath = path.join(__dirname, '..', 'src', 'providers', 'hover', 'OperatorHelp.ts')
fs.writeFileSync(outPath, header + body + footer)
console.log(`wrote ${outPath} with ${entries.length} topics`)
