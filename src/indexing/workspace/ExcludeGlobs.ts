// Copyright 2026 Andreas Bogossian

/**
 * Decides which paths the workspace index leaves out, from glob maps shaped like
 * VS Code's files.exclude and search.exclude settings.
 *
 * Supported syntax: `**` as a whole path segment matches any number of segments, `*`
 * matches within one segment, and `{a,b}` matches either alternative, even one that
 * spans segments. An empty last alternative, as in `{s,}`, is dropped, as VS Code's
 * glob drops it. Whitespace at the end of a pattern is ignored, as both VS Code
 * engines ignore it, and then one trailing `/`. Every other character is literal,
 * including whitespace at the start, as in Quick Open, which keeps MATLAB names such
 * as +pkg, @Cls and a(1) intact. A pattern that uses `?`, `[...]`, braces inside
 * braces or a brace without its partner excludes nothing, as does a `when` clause, so
 * an unsupported pattern indexes too much rather than hiding code.
 */

/** Whether a path, relative to its workspace folder and separated by '/', is left out */
export type ExcludeMatcher = (relativePath: string, isDirectory: boolean) => boolean

/**
 * Folders never worth indexing: version control data, installed packages, and the
 * folders Simulink, MATLAB Coder and MATLAB Projects generate. Build output folders
 * such as build, out and dist are left alone, since they can hold user code. These
 * are kept apart from the settings, so a false in files.exclude or search.exclude
 * does not bring them back.
 */
export const BUILT_IN_INDEX_EXCLUDES: Record<string, boolean> = {
    '**/.git': true,
    '**/.svn': true,
    '**/.hg': true,
    '**/node_modules': true,
    '**/slprj': true,
    '**/codegen/{mex,lib,dll,exe}': true,
    '**/resources/project': true
}

/**
 * Merges the files.exclude and search.exclude settings as VS Code does before it
 * matches them: for the same key, the value in search.exclude wins, so a false there
 * keeps what files.exclude would leave out. A setting that is not a map is ignored.
 */
export function mergeExcludeSettings (filesExclude: unknown, searchExclude: unknown): Record<string, unknown> {
    return {
        ...(isGlobMap(filesExclude) ? filesExclude : {}),
        ...(isGlobMap(searchExclude) ? searchExclude : {})
    }
}

/**
 * @param globMaps Maps from glob to whether it excludes. Only a value of exactly true
 * excludes, and anything that is not a map is ignored.
 * @returns A matcher that excludes a path when any glob of any map matches it
 */
export function compileExcludes (globMaps: unknown[]): ExcludeMatcher {
    const patterns: RegExp[] = []
    // Folders a trailing /** empties, so they need not be walked at all
    const emptiedFolderPatterns: RegExp[] = []

    for (const globMap of globMaps) {
        if (!isGlobMap(globMap)) {
            continue
        }
        for (const [key, value] of Object.entries(globMap)) {
            if (value !== true || hasUnsupportedSyntax(key)) {
                continue
            }
            const glob = withoutTrailingSlash(key.trimEnd())
            patterns.push(globToRegExp(glob))
            if (glob.endsWith('/**')) {
                emptiedFolderPatterns.push(globToRegExp(glob.slice(0, -'/**'.length)))
            }
        }
    }

    return (relativePath, isDirectory) =>
        patterns.some(pattern => pattern.test(relativePath)) ||
        (isDirectory && emptiedFolderPatterns.some(pattern => pattern.test(relativePath)))
}

function isGlobMap (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a glob uses syntax this matcher does not support: `?` or `[`, which VS Code reads
 * as any one character or the start of a class, or braces that are nested or unbalanced.
 */
function hasUnsupportedSyntax (glob: string): boolean {
    return glob.includes('?') || glob.includes('[') || hasNestedOrUnbalancedBraces(glob)
}

/**
 * Whether a glob has a {a,b} group inside another, or a brace without its partner.
 * Quick Open's ripgrep rejects an unbalanced brace, and it reads nested groups
 * differently from VS Code's glob.parse. One pass over the glob, so no key can make
 * it slow.
 */
function hasNestedOrUnbalancedBraces (glob: string): boolean {
    let isInGroup = false
    for (const char of glob) {
        if (char === '{') {
            if (isInGroup) {
                return true
            }
            isInGroup = true
        } else if (char === '}') {
            if (!isInGroup) {
                return true
            }
            isInGroup = false
        }
    }
    return isInGroup
}

function withoutTrailingSlash (glob: string): string {
    return glob.endsWith('/') ? glob.slice(0, -1) : glob
}

function globToRegExp (glob: string): RegExp {
    return new RegExp(`^${translateGlob(glob)}$`)
}

function translateGlob (glob: string): string {
    const segments = splitSegments(glob)
    return segments.map((segment, index) => {
        const isLast = index === segments.length - 1
        if (segment === '**') {
            if (isLast) {
                return '.*'
            }
            // A globstar after another adds nothing it can match, but a repeated group makes
            // a failing match try every way of sharing the segments out between the copies
            return segments[index - 1] === '**' ? '' : '(?:[^/]*/)*'
        }
        return translateSegment(segment) + (isLast ? '' : '/')
    }).join('')
}

/** Splits a glob at each '/' that is not inside a {a,b} group */
function splitSegments (glob: string): string[] {
    const segments: string[] = []
    let segmentStart = 0
    for (let i = 0; i < glob.length; i++) {
        const closingBrace = glob[i] === '{' ? glob.indexOf('}', i) : -1
        if (closingBrace !== -1) {
            i = closingBrace
        } else if (glob[i] === '/') {
            segments.push(glob.slice(segmentStart, i))
            segmentStart = i + 1
        }
    }
    segments.push(glob.slice(segmentStart))
    return segments
}

function translateSegment (segment: string): string {
    let source = ''
    for (let i = 0; i < segment.length; i++) {
        const char = segment[i]
        if (char === '*') {
            // A run of stars matches what one does, and is collapsed for the same reason
            if (segment[i - 1] !== '*') {
                source += '[^/]*'
            }
            continue
        }
        const closingBrace = char === '{' ? segment.indexOf('}', i) : -1
        if (closingBrace !== -1) {
            // Each alternative is a glob of its own, as in VS Code, so it can span segments.
            // VS Code's split drops an empty last alternative, which would match the bare prefix.
            const alternatives = segment.slice(i + 1, closingBrace).split(',')
            if (alternatives.length > 1 && alternatives[alternatives.length - 1] === '') {
                alternatives.pop()
            }
            source += `(?:${alternatives.map(alternative => translateGlob(withoutTrailingSlash(alternative))).join('|')})`
            i = closingBrace
            continue
        }
        source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    return source
}
