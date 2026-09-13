// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import {
    buildOfflineSymbolInfo, extractDocComment, extractSignature, findDeclarationLine
} from '../../../src/providers/hover/OfflineHoverBuilder'

/**
 * Verified against MATLAB R2026a before this was written:
 *
 *   help('afterStyle')            94 chars   comment block AFTER the declaration
 *   help('beforeStyle')           91 chars   comment block BEFORE the declaration
 *   help('localHelper')            0 chars   local functions are invisible
 *   help('argsRich>localHelper')  77 chars   unless addressed through the file
 *   help('argsRich')              47 chars   H1 only, no argument detail at all
 *
 * So both comment placements are real, local functions genuinely need this
 * builder, and the arguments table can only come from here.
 */
describe('OfflineHoverBuilder', () => {
    const AFTER_STYLE = [
        'function y = afterStyle(x)',
        '%AFTERSTYLE Summary written after the declaration.',
        '%   Detailed explanation on a second line.',
        'y = x;',
        'end'
    ].join('\n')

    const BEFORE_STYLE = [
        '%BEFORESTYLE Summary written before the declaration.',
        '%   Second line of the leading block.',
        'function y = beforeStyle(x)',
        'y = x;',
        'end'
    ].join('\n')

    describe('#findDeclarationLine', () => {
        it('should find a function declaration with a single output', () => {
            assert.deepEqual(findDeclarationLine(AFTER_STYLE.split('\n'), 'afterStyle'), { line: 0, kind: 'function' })
        })

        it('should find a function with a bracketed output list', () => {
            const lines = ['function [a, b] = multi(x)', 'end'].join('\n').split('\n')
            assert.deepEqual(findDeclarationLine(lines, 'multi'), { line: 0, kind: 'function' })
        })

        it('should find a function with no outputs', () => {
            const lines = ['function noOut(x)', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'noOut'), { line: 0, kind: 'function' })
        })

        it('should find a classdef', () => {
            const lines = ['classdef MyClass < handle', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'MyClass'), { line: 0, kind: 'classdef' })
        })

        it('should find a classdef with attributes', () => {
            const lines = ['classdef (Abstract) Shape', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'Shape'), { line: 0, kind: 'classdef' })
        })

        it('should find a local function further down the file', () => {
            const lines = ['function main(x)', 'end', '', 'function z = localHelper(a)', 'end']
            assert.deepEqual(findDeclarationLine(lines, 'localHelper'), { line: 3, kind: 'function' })
        })

        it('should return null for a symbol not declared here', () => {
            assert.equal(findDeclarationLine(AFTER_STYLE.split('\n'), 'notPresent'), null)
        })

        it('should not match a name that is merely a prefix', () => {
            const lines = ['function afterStyleExtra(x)', 'end']
            assert.equal(findDeclarationLine(lines, 'afterStyle'), null)
        })
    })

    describe('#extractDocComment', () => {
        it('should read the block after the declaration, which is MATLAB\'s convention', () => {
            const comment = extractDocComment(AFTER_STYLE.split('\n'), 0)
            assert.equal(comment.length, 2)
            assert.equal(comment[0], 'AFTERSTYLE Summary written after the declaration.')
        })

        it('should fall back to a block before the declaration', () => {
            const comment = extractDocComment(BEFORE_STYLE.split('\n'), 2)
            assert.equal(comment.length, 2)
            assert.equal(comment[0], 'BEFORESTYLE Summary written before the declaration.')
        })

        it('should stop at a blank line, as MATLAB does', () => {
            const lines = [
                'function f(x)',
                '%First line.',
                '',
                '% Not part of the help block.',
                'end'
            ]
            const comment = extractDocComment(lines, 0)
            assert.equal(comment.length, 1)
        })

        it('should return an empty array when there is no comment', () => {
            assert.deepEqual(extractDocComment(['function f(x)', 'y = 1;', 'end'], 0), [])
        })
    })

    describe('#extractSignature', () => {
        it('should drop the function keyword', () => {
            assert.equal(extractSignature(['function y = afterStyle(x)'], 0), 'y = afterStyle(x)')
        })

        it('should join line continuations', () => {
            const lines = ['function [a, b] = f(x, ...', '        y)']
            assert.equal(extractSignature(lines, 0), '[a, b] = f(x, y)')
        })

        it('should drop a trailing comment', () => {
            assert.equal(extractSignature(['function f(x) % does a thing'], 0), 'f(x)')
        })
    })

    describe('#buildOfflineSymbolInfo', () => {
        it('should strip the repeated name from the H1 summary', () => {
            const info = buildOfflineSymbolInfo(AFTER_STYLE, 'afterStyle')
            assert.ok(info != null)
            assert.equal(info.summary, 'Summary written after the declaration.',
                'the conventional ALL-CAPS name repeat should not appear twice in the card')
        })

        it('should separate the summary from the body', () => {
            const info = buildOfflineSymbolInfo(AFTER_STYLE, 'afterStyle')
            assert.equal(info?.body, '  Detailed explanation on a second line.')
            assert.equal(info?.bodyMarkdown, 'Detailed explanation on a second line.')
        })

        it('should keep a wrapped first sentence out of the summary', () => {
            const src = [
                'function strip_timestamps(file)',
                '    % drop the export time that exportgraphics writes into the PNG (its tIME',
                '    % chunk and "Creation Time" text chunk), so rerunning the script leaves an',
                '    % unchanged figure byte-identical and git does not report it as modified',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'strip_timestamps')

            assert.equal(info?.summary, undefined, 'half a sentence is not a summary')
            assert.equal(info?.hasDocComment, true)
            assert.equal(info?.bodyMarkdown,
                'drop the export time that exportgraphics writes into the PNG (its tIME chunk and "Creation Time" ' +
                'text chunk), so rerunning the script leaves an unchanged figure byte-identical and git does not ' +
                'report it as modified')
        })

        it('should take a first line followed by a blank comment line as the summary', () => {
            const src = ['function f(x)', '%F Does things.', '%', '%   More detail', '%   continues here.', 'end'].join('\n')

            const info = buildOfflineSymbolInfo(src, 'f')

            assert.equal(info?.summary, 'Does things.')
            assert.equal(info?.bodyMarkdown, 'More detail continues here.')
        })

        it('should keep a block comment preformatted and out of the summary', () => {
            const src = ['function f(x)', '%{', 'Usage:', '   f(1)', '%}', 'end'].join('\n')

            const info = buildOfflineSymbolInfo(src, 'f')

            assert.equal(info?.summary, undefined)
            assert.equal(info?.bodyMarkdown, '```text\nUsage:\n   f(1)\n```')
        })

        it('should take a complete first sentence as the summary even when the next line is at the same depth', () => {
            const src = [
                'function path = resolveStackFrame(names)',
                '    % RESOLVESTACKFRAME Finds the file that defines a frame of a MATLAB stack trace.',
                '    % Takes candidate names from the most to the least specific.',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'resolveStackFrame')

            assert.equal(info?.summary, 'Finds the file that defines a frame of a MATLAB stack trace.')
            assert.equal(info?.bodyMarkdown, 'Takes candidate names from the most to the least specific.')
        })

        it('should drop the capitalised name from a wrapped first line that is not a summary', () => {
            const src = [
                'function result = parseInfoFromDocument(code)',
                '    % PARSEINFOFROMDOCUMENT Parses the given MATLAB code and extracts information about',
                '    % variables, functions, etc.',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'parseInfoFromDocument')

            assert.equal(info?.summary, undefined)
            assert.equal(info?.bodyMarkdown, 'Parses the given MATLAB code and extracts information about variables, functions, etc.')
        })

        it('should read %NAME followed by % text as a summary and a body', () => {
            const info = buildOfflineSymbolInfo(['function out = foo(in)', '%FOO Does stuff', '% More details here', 'end'].join('\n'), 'foo')

            assert.equal(info?.summary, 'Does stuff')
            assert.equal(info?.bodyMarkdown, 'More details here')
        })

        it('should count a tab after % as indentation', () => {
            const info = buildOfflineSymbolInfo(['function y = f(x)', '%F Summary line', '%\tY = F(X) does something', 'end'].join('\n'), 'f')

            assert.equal(info?.summary, 'Summary line')
            assert.equal(info?.bodyMarkdown, 'Y = F(X) does something')
        })

        it('should keep an argument list preformatted', () => {
            const src = [
                'function runTests(testFiles, testNames, responseChannel)',
                '%RUNTESTS Run MATLAB unit tests with streaming results.',
                '%   testFiles       - cell array of absolute file paths',
                '%   testNames       - cell array of specific test names (empty = run all)',
                '%   responseChannel - Faye channel for publishing per-test events',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'runTests')

            assert.equal(info?.summary, 'Run MATLAB unit tests with streaming results.')
            assert.equal(info?.bodyMarkdown,
                '```text\ntestFiles       - cell array of absolute file paths\n' +
                'testNames       - cell array of specific test names (empty = run all)\n' +
                'responseChannel - Faye channel for publishing per-test events\n```')
        })

        it('should report a declaration without a doc comment', () => {
            const info = buildOfflineSymbolInfo('function f(x)\ny = x;\nend', 'f')

            assert.equal(info?.hasDocComment, false)
            assert.equal(info?.bodyMarkdown, undefined)
        })

        it('should parse the arguments block, which no MATLAB API exposes', () => {
            const src = [
                'function [y, info] = argsRich(x, factor, opts)',
                '%ARGSRICH Demonstrates a full arguments block.',
                'arguments',
                '    x (:,1) double {mustBeFinite, mustBeReal}',
                '    factor (1,1) double = 2',
                '    opts.Method (1,1) string = "lin"',
                'end',
                'y = x * factor;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'argsRich')
            assert.equal(info?.argumentDeclarations.length, 3)
            assert.equal(info?.argumentDeclarations[0].name, 'x')
            assert.equal(info?.argumentDeclarations[2].name, 'opts.Method')
        })

        it('should describe a local function, which help() returns nothing for', () => {
            const src = [
                'function main(x)',
                '%MAIN Entry point.',
                'z = localHelper(x);',
                'end',
                '',
                'function z = localHelper(a)',
                '%LOCALHELPER Does the real work.',
                'z = a;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'localHelper')
            assert.ok(info != null, 'local functions are exactly the case MATLAB cannot serve')
            assert.equal(info.summary, 'Does the real work.')
            assert.equal(info.signature, 'z = localHelper(a)')
        })

        it('should not attribute a later function\'s arguments block to an earlier function', () => {
            const src = [
                'function first(x)',
                'y = 1;',
                'end',
                'function second(z)',
                'arguments',
                '    z single',
                'end',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'first')
            assert.deepEqual(info?.argumentDeclarations, [],
                'the scope scan must stop at the next function declaration')
        })

        it('should not claim a later function\'s arguments when a declaration spans lines', () => {
            // `function [a, ...` does not match the single-line declaration
            // regex, so a strict scope scan walked straight past it and gave the
            // first function the second one's arguments block.
            const src = [
                'function first(x)',
                'y = 1;',
                'end',
                'function [a, ...',
                '         b] = second(z)',
                'arguments',
                '    z single {mustBeReal}',
                'end',
                'a = z; b = z;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'first')
            assert.deepEqual(info?.argumentDeclarations, [],
                'the scope must end at the continued declaration, not run through it')
        })

        it('should ignore a declaration commented out in a %{ %} block', () => {
            const src = [
                '%{',
                'function y = myFn(x)',
                'arguments',
                '    x double {mustBeNonempty}',
                'end',
                'end',
                '%}',
                'function y = myFn(x)',
                '%MYFN The live one.',
                'arguments',
                '    x string',
                'end',
                'y = x;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'myFn')
            assert.equal(info?.summary, 'The live one.',
                'the commented-out declaration must not hijack the card')
            assert.equal(info?.argumentDeclarations.length, 1)
            assert.equal(info?.argumentDeclarations[0].className, 'string',
                'and must not contribute its arguments')
        })

        it('should handle a classdef', () => {
            const src = [
                'classdef MyClass < handle',
                '%MYCLASS Summary line for the class.',
                '    properties',
                '        Count',
                '    end',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'MyClass')
            assert.equal(info?.kind, 'classdef')
            assert.equal(info?.summary, 'Summary line for the class.')
        })

        it('should describe a function whose declaration wraps onto a second line', () => {
            // `function [a, ...` does not match the single-line declaration form,
            // so this function previously got no hover card at all.
            const src = [
                'function [a, ...',
                '         b] = wrapped(z)',
                '%WRAPPED Returns z twice.',
                'a = z; b = z;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'wrapped')
            assert.ok(info != null, 'a continued declaration must still produce a card')
            assert.equal(info.summary, 'Returns z twice.')
        })

        it('should not read an arguments block that is inside a block comment', () => {
            const src = [
                'function y = f(x)',
                '%F Live function.',
                '%{',
                'arguments',
                '    x double {mustBeCommentedOut}',
                'end',
                '%}',
                'y = x;',
                'end'
            ].join('\n')

            const info = buildOfflineSymbolInfo(src, 'f')
            assert.deepEqual(info?.argumentDeclarations, [],
                'commented-out declarations must not reach the Arguments table')
        })

        it('should stay linear on a large document', () => {
            // The %{ %} guard originally rescanned from the top of the file for
            // every line, which is quadratic: measured at 3.4 s of synchronous
            // event-loop blocking per hover on a real 9371-line MATLAB file.
            const build = (n: number): string => {
                const body = ['function y = target(x)', '%TARGET The one we look up.', 'y = x;', 'end', '']
                while (body.length < n) {
                    body.push(`function z = filler${body.length}(a)`, 'z = a;', 'end', '')
                }
                return body.join('\n')
            }

            const small = build(500)
            const large = build(8000)

            const timeIt = (src: string): number => {
                const started = process.hrtime.bigint()
                buildOfflineSymbolInfo(src, 'target')
                return Number(process.hrtime.bigint() - started) / 1e6
            }

            timeIt(small)  // warm up
            const smallMs = timeIt(small)
            const largeMs = timeIt(large)

            // 16x the lines. Quadratic would be ~256x; linear is ~16x. Allow
            // generous headroom for a loaded machine and still catch O(n^2).
            assert.ok(largeMs < 400,
                `hover on an 8000-line file took ${largeMs.toFixed(0)} ms, which blocks the event loop`)
            assert.ok(largeMs < Math.max(smallMs, 1) * 80,
                `scaling looks quadratic: ${smallMs.toFixed(2)} ms -> ${largeMs.toFixed(2)} ms`)
        })

        it('should return null for a symbol not in the document', () => {
            assert.equal(buildOfflineSymbolInfo(AFTER_STYLE, 'somethingElse'), null)
        })
    })
})
