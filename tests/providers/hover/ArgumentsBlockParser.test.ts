// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import { parseArgumentsBlocks, renderArgumentsTable } from '../../../src/providers/hover/ArgumentsBlockParser'

/**
 * `arguments` blocks are invisible to every MATLAB introspection API, verified
 * on R2026a: help('argsRich') returns only the H1 line and no argument detail at
 * all. So this parser is the sole source for the most useful part of a
 * user-function hover card, and it has to be right.
 */
describe('ArgumentsBlockParser', () => {
    const split = (text: string): string[] => text.split('\n')

    describe('#parseArgumentsBlocks', () => {
        it('should parse size, class, validators and defaults', () => {
            const src = split([
                'function [y, info] = argsRich(x, factor, opts)',
                'arguments',
                '    x (:,1) double {mustBeFinite, mustBeReal}',
                '    factor (1,1) double = 2',
                '    opts.Method (1,1) string = "lin"',
                'end',
                'y = x;',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations.length, 3)

            assert.equal(declarations[0].name, 'x')
            assert.equal(declarations[0].size, '(:,1)')
            assert.equal(declarations[0].className, 'double')
            assert.equal(declarations[0].validators, 'mustBeFinite, mustBeReal')
            assert.equal(declarations[0].defaultValue, undefined, 'x declares no default')
            assert.equal(declarations[0].kind, 'input')
            assert.equal(declarations[1].name, 'factor')
            assert.equal(declarations[1].defaultValue, '2')
            assert.equal(declarations[2].name, 'opts.Method', 'name-value pairs keep their struct field')
            assert.equal(declarations[2].defaultValue, '"lin"')
        })

        it('should record the declaration line', () => {
            const src = split('function f(x)\narguments\n    x double\nend\nend')
            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations[0].line, 2)
        })

        it('should not mistake a percent inside a string default for a comment', () => {
            const src = split([
                'function f(opts)',
                'arguments',
                '    opts.Label (1,1) string = "100% done"   % trailing note',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations.length, 1)
            assert.equal(declarations[0].defaultValue, '"100% done"',
                'the percent belongs to the string, and the real comment must still be stripped')
        })

        it('should not treat == inside a validator as a default assignment', () => {
            const src = split([
                'function f(x)',
                'arguments',
                '    x double {mustBeGreaterThanOrEqual(x, 0)}',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations[0].defaultValue, undefined)
            assert.equal(declarations[0].validators, 'mustBeGreaterThanOrEqual(x, 0)')
        })

        it('should handle a validator containing a comparison operator', () => {
            const src = split([
                'function f(x)',
                'arguments',
                '    x (1,1) double {mustBeMember(x, [1 2 3])} = 1',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations[0].validators, 'mustBeMember(x, [1 2 3])')
            assert.equal(declarations[0].defaultValue, '1')
        })

        it('should join line continuations into one declaration', () => {
            const src = split([
                'function f(x)',
                'arguments',
                '    x (1,1) double {mustBeFinite, ...',
                '        mustBeReal} = 3',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations.length, 1, 'a continued declaration is one argument, not two')
            assert.equal(declarations[0].name, 'x')
            assert.equal(declarations[0].defaultValue, '3')
            assert.ok((declarations[0].validators ?? '').includes('mustBeReal'))
        })

        it('should not let a transpose in a default swallow the trailing comment', () => {
            // `[1 2]'` is a transpose. Treating its quote as a string opener ate
            // the comment and, with an odd number of quotes, ran on into the
            // next declaration.
            const src = split([
                'function f(x, y)',
                'arguments',
                "    x double = [1 2]'   % a transposed default",
                '    y double = 3',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations.length, 2, 'the next declaration must survive')
            assert.equal(declarations[0].defaultValue, "[1 2]'")
            assert.equal(declarations[1].name, 'y')
        })

        it('should skip comment-only and blank lines inside the block', () => {
            const src = split([
                'function f(x)',
                'arguments',
                '    % explanatory comment',
                '',
                '    x double',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations.length, 1)
            assert.equal(declarations[0].name, 'x')
        })

        it('should classify arguments (Output) and (Repeating) blocks', () => {
            const src = split([
                'function y = f(x)',
                'arguments (Input)',
                '    x double',
                'end',
                'arguments (Output)',
                '    y double',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations.length, 2)
            assert.equal(declarations[0].kind, 'input')
            assert.equal(declarations[1].kind, 'output')
        })

        it('should close the block on "end;" and not parse the body as arguments', () => {
            // `end;` is legal MATLAB and Code Analyzer says nothing about it, so
            // a developer with that habit hit this on every function. The scan
            // ran past the block and reported body statements as declarations.
            const src = split([
                'function y = f(x)',
                'arguments',
                '    x (1,1) double',
                'end;',
                'y = x + 1;',
                'total = y * 2;',
                'result = total;',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, src.length)
            assert.equal(declarations.length, 1, 'only x is an argument')
            assert.equal(declarations[0].name, 'x')
        })

        it('should close the block on "end," and "end ;"', () => {
            for (const terminator of ['end,', 'end ;', 'end;  % close']) {
                const src = split([
                    'function y = f(x)', 'arguments', '    x double', terminator, 'y = x;', 'end'
                ].join('\n'))
                assert.equal(parseArgumentsBlocks(src, 0, src.length).length, 1,
                    `"${terminator}" should close the block`)
            }
        })

        it('should still reject things that merely start with end', () => {
            const src = split([
                'function y = f(x)',
                'arguments',
                '    x double',
                '    ending double',
                'end',
                'y = x;',
                'end'
            ].join('\n'))
            assert.equal(parseArgumentsBlocks(src, 0, src.length).length, 2,
                '"ending" is a declaration, not a block terminator')
        })

        it('should accept "arguments;" as a block opener', () => {
            const src = split('function y = f(x)\narguments;\n    x double\nend\ny = x;\nend')
            assert.equal(parseArgumentsBlocks(src, 0, src.length).length, 1)
        })

        it('should return an empty array for a function with no arguments block', () => {
            const src = split('function y = f(x)\ny = x;\nend')
            assert.deepEqual(parseArgumentsBlocks(src, 0, src.length), [])
        })

        it('should respect the end bound and not read into a later function', () => {
            const src = split([
                'function f(x)',
                'arguments',
                '    x double',
                'end',
                'end',
                'function g(z)',
                'arguments',
                '    z single',
                'end',
                'end'
            ].join('\n'))

            const declarations = parseArgumentsBlocks(src, 0, 5)
            assert.equal(declarations.length, 1, 'only the first function should be scanned')
            assert.equal(declarations[0].name, 'x')
        })
    })

    describe('#renderArgumentsTable', () => {
        it('should align names and include every declared part', () => {
            const src = split([
                'function f(x, opts)',
                'arguments',
                '    x (:,1) double {mustBeFinite}',
                '    opts.Method (1,1) string = "lin"',
                'end',
                'end'
            ].join('\n'))

            const rendered = renderArgumentsTable(parseArgumentsBlocks(src, 0, src.length))
            const lines = rendered.split('\n')

            assert.equal(lines.length, 2)
            assert.ok(lines[0].startsWith('x          '), 'names should be padded to a common width')
            assert.ok(lines[0].includes('(:,1) double'))
            assert.ok(lines[0].includes('{mustBeFinite}'))
            assert.ok(lines[1].includes('= "lin"'))
        })

        it('should return an empty string when there is nothing to render', () => {
            assert.equal(renderArgumentsTable([]), '')
        })
    })
})
