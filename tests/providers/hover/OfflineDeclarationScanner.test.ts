// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import { Range } from 'vscode-languageserver'

import { scanDeclarations } from '../../../src/providers/hover/OfflineHoverBuilder'

/**
 * MATLAB's parser returns no symbols at all for a file with a syntax error, so a scan of
 * the text is all workspace symbols can list for such a file. Every document here has a
 * syntax error.
 */
describe('OfflineHoverBuilder #scanDeclarations', () => {
    const scan = (lines: string[]): ReturnType<typeof scanDeclarations> => scanDeclarations(lines.join('\n'))
    const names = (lines: string[]): string[] => scan(lines).functions.map(declaration => declaration.name)

    it('should find the main and local functions, with the range of each name', () => {
        const result = scan([
            'function y = main(x)',
            'y = helper(x) +;',
            'end',
            '',
            'function [a, b] = helper(x)',
            'a = x; b = x;',
            'end',
            '',
            'function noOutputs',
            'end'
        ])

        assert.strictEqual(result.classdef, undefined)
        assert.deepStrictEqual(result.functions, [
            { name: 'main', range: Range.create(0, 13, 0, 17), isMethod: false },
            { name: 'helper', range: Range.create(4, 18, 4, 24), isMethod: false },
            { name: 'noOutputs', range: Range.create(8, 9, 8, 18), isMethod: false }
        ])
    })

    it('should find a declaration continued across lines, on the line that holds the name', () => {
        const result = scan([
            'function [first, ...',
            '          second] = continued(x)',
            'first = x; second = ;',
            'end',
            'function r = longArgs(a, ...',
            '                      b)',
            'r = a;',
            'end'
        ])

        assert.deepStrictEqual(result.functions, [
            { name: 'continued', range: Range.create(1, 20, 1, 29), isMethod: false },
            { name: 'longArgs', range: Range.create(4, 13, 4, 21), isMethod: false }
        ])
    })

    it('should find nested functions', () => {
        assert.deepStrictEqual(names([
            'function outer',
            '    x = 1 +;',
            '    function inner',
            '        function innermost',
            '        end',
            '    end',
            'end'
        ]), ['outer', 'inner', 'innermost'])
    })

    it('should find the functions of a file that does not end them', () => {
        assert.deepStrictEqual(names([
            'function a',
            'x = 1 +;',
            'function b',
            'y = 2;'
        ]), ['a', 'b'])
    })

    it('should ignore declarations in block comments, after a percent sign and in strings', () => {
        assert.deepStrictEqual(names([
            'function real',
            '%{',
            'function inBlockComment',
            '%}',
            '% function afterPercent',
            'x = 1; % function afterCode',
            "s = 'function inChars';",
            'msg = ["abc", ...',
            '    "function inStrings"];',
            'y = (;',
            'end'
        ]), ['real'])
    })

    it('should find the classdef, and ignore one that is commented out', () => {
        const result = scan([
            '%{',
            'classdef Commented',
            '%}',
            '% classdef AlsoCommented',
            'classdef Real',
            '    properties',
            '        X = ;',
            '    end',
            'end'
        ])

        assert.deepStrictEqual(result.classdef, { name: 'Real', range: Range.create(4, 9, 4, 13) })
        assert.deepStrictEqual(result.functions, [])
    })

    it('should find the methods of a classdef, and tell them from nested and local functions', () => {
        const result = scan([
            'classdef (Sealed) Account < handle',
            '    properties (Access = private)',
            '        Balance (1,1) double = 0',
            '        History = zeros(1, 3)',
            '    end',
            '    events',
            '        Changed',
            '    end',
            '    methods',
            '        function obj = Account(balance)',
            '            arguments',
            '                balance (1,1) double',
            '            end',
            '            obj.Balance = balance;',
            '        end',
            '        function deposit(obj, amount)',
            "            if amount < 0, error('end'); end",
            '            obj.History(end + 1) = amount; % end',
            '            obj.Balance = obj.Balance + ;',
            '            function checked = check(value)',
            '                checked = value;',
            '            end',
            '        end',
            '        function value = get.Balance(obj)',
            '            value = obj.Balance;',
            '        end',
            '    end',
            '    methods (Static)',
            '        function r = create()',
            "            r = Account(0)'; s = {'if', \"for\"};",
            '        end',
            '    end',
            'end',
            '',
            'function helper',
            'end'
        ])

        assert.deepStrictEqual(result.classdef, { name: 'Account', range: Range.create(0, 18, 0, 25) })
        assert.deepStrictEqual(result.functions, [
            { name: 'Account', range: Range.create(9, 23, 9, 30), isMethod: true },
            { name: 'deposit', range: Range.create(15, 17, 15, 24), isMethod: true },
            { name: 'check', range: Range.create(19, 31, 19, 36), isMethod: false },
            { name: 'get.Balance', range: Range.create(23, 25, 23, 36), isMethod: true },
            { name: 'create', range: Range.create(28, 21, 28, 27), isMethod: true },
            { name: 'helper', range: Range.create(34, 9, 34, 15), isMethod: false }
        ])
    })

    it('should close a parenthesis left open by a syntax error at the end of its line', () => {
        const kinds = scan([
            'classdef Parens',
            '    methods',
            '        function before(obj)',
            '        end',
            '        function r = broken(obj, x)',
            '            r = (x;',
            '        end',
            '        function after(obj)',
            '        end',
            '    end',
            'end',
            '',
            'function helper',
            'end'
        ]).functions.map(declaration => [declaration.name, declaration.isMethod])

        assert.deepStrictEqual(kinds, [['before', true], ['broken', true], ['after', true], ['helper', false]])
    })

    it('should take methods or properties called alone in a method body for a call, not a block', () => {
        const kinds = scan([
            'classdef Listing',
            '    methods',
            '        function list(obj)',
            '            properties(obj)',
            '        end',
            '        function other(obj)',
            '            x = ;',
            '        end',
            '    end',
            'end'
        ]).functions.map(declaration => [declaration.name, declaration.isMethod])

        assert.deepStrictEqual(kinds, [['list', true], ['other', true]])
    })

    it('should not take end called after a dot for the end of a block', () => {
        // MATLAB's parser accepts a keyword after a dot, as in a call to the end method of a Java Matcher
        const kinds = scan([
            'classdef Finder',
            '    methods',
            '        function r = stop(obj, text)',
            "            matcher = java.util.regex.Pattern.compile('b').matcher(text);",
            '            matcher.find();',
            '            r = matcher.end();',
            '        end',
            '        function other(obj)',
            '            x = ;',
            '        end',
            '    end',
            'end'
        ]).functions.map(declaration => [declaration.name, declaration.isMethod])

        assert.deepStrictEqual(kinds, [['stop', true], ['other', true]])
    })

    it('should not take the name of a method that overloads end for the end of a block', () => {
        const result = scan([
            'classdef Seq',
            '    properties',
            '        Data',
            '    end',
            '    methods',
            '        function varargout = end(obj, k, n)',
            "            varargout{1} = builtin('end', obj.Data, k, n);",
            '        end',
            '        function r = first(obj)',
            '            r = obj.Data(1) +;',
            '        end',
            '    end',
            'end',
            '',
            'function helper',
            'end'
        ])

        assert.deepStrictEqual(result.functions, [
            { name: 'end', range: Range.create(5, 29, 5, 32), isMethod: true },
            { name: 'first', range: Range.create(8, 21, 8, 26), isMethod: true },
            { name: 'helper', range: Range.create(14, 9, 14, 15), isMethod: false }
        ])
    })
})
