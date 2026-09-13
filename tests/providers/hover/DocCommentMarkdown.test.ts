// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import {
    DocCommentLine, escapeMarkdown, firstLineIsOwnParagraph, firstLineIsSummary, indentColumns, renderDocComment
} from '../../../src/providers/hover/DocCommentMarkdown'

const prose = (...texts: string[]): DocCommentLine[] => texts.map(text => ({ text, preformatted: false }))
const block = (...texts: string[]): DocCommentLine[] => texts.map(text => ({ text, preformatted: true }))

describe('DocCommentMarkdown', () => {
    describe('#renderDocComment', () => {
        it('joins the lines of a hard-wrapped paragraph so the hover can reflow them', () => {
            assert.strictEqual(
                renderDocComment(prose(
                    'drop the export time that exportgraphics writes into the PNG (its tIME',
                    'chunk and "Creation Time" text chunk), so rerunning the script leaves an',
                    'unchanged figure byte-identical and git does not report it as modified')),
                'drop the export time that exportgraphics writes into the PNG (its tIME chunk and "Creation Time" ' +
                'text chunk), so rerunning the script leaves an unchanged figure byte-identical and git does not ' +
                'report it as modified')
        })

        it('starts a new paragraph after a blank comment line', () => {
            assert.strictEqual(renderDocComment(prose('First paragraph', 'continues.', '', 'Second.')),
                'First paragraph continues.\n\nSecond.')
        })

        it('reads a body indented as a whole, as in MATLAB help, as prose', () => {
            assert.strictEqual(renderDocComment(prose('   Y = F(X) returns X', '   plus one.')), 'Y = F(X) returns X plus one.')
        })

        it('keeps lines indented deeper than their paragraph preformatted, across blank lines', () => {
            assert.strictEqual(
                renderDocComment(prose('Example:', '    x = f(3);', '', '    y = f(4);', 'Returns the result.')),
                'Example:\n\n```text\nx = f(3);\n\ny = f(4);\n```\n\nReturns the result.')
        })

        it('ends a preformatted run at a blank line followed by a line back at paragraph depth', () => {
            assert.strictEqual(renderDocComment(prose('Example:', '    x = f(3);', '', 'Done.')),
                'Example:\n\n```text\nx = f(3);\n```\n\nDone.')
        })

        it('keeps example code after a blank comment line preformatted', () => {
            assert.strictEqual(
                renderDocComment(prose('Usage:', '', '    r = foo(1, 2)', '    r = foo(3, 4)', '', 'Returns r.')),
                'Usage:\n\n```text\nr = foo(1, 2)\nr = foo(3, 4)\n```\n\nReturns r.')
        })

        it('joins a deeper line that only continues the sentence', () => {
            assert.strictEqual(
                renderDocComment(prose('PLAYBLOCKING(OBJ) plays from beginning; does not return until', '   playback completes.')),
                'PLAYBLOCKING(OBJ) plays from beginning; does not return until playback completes.')
        })

        it('keeps lists and argument tables line by line', () => {
            assert.strictEqual(
                renderDocComment(prose(
                    'Inputs:',
                    'testFiles       - cell array of absolute file paths',
                    'responseChannel - Faye channel for publishing per-test events',
                    'Key behaviors:',
                    '- Supports external manipulation',
                    '  of app options.',
                    '- Ensures a single instance.',
                    'That is all.')),
                'Inputs:\n\n```text\ntestFiles       - cell array of absolute file paths\n' +
                'responseChannel - Faye channel for publishing per-test events\n```\n\n' +
                'Key behaviors:\n\n```text\n- Supports external manipulation\n  of app options.\n- Ensures a single instance.\n```\n\n' +
                'That is all.')
        })

        it('keeps a rule line and aligned columns out of prose', () => {
            assert.strictEqual(renderDocComment(prose('Formats:', '----------', 'Wave   .wav', 'MP4    .m4a')),
                'Formats:\n\n```text\n----------\nWave   .wav\nMP4    .m4a\n```')
        })

        it('keeps numbered items after a paragraph line by line', () => {
            assert.strictEqual(renderDocComment(prose('Steps:', '1) load the data', '2) fit the model')),
                'Steps:\n\n```text\n1) load the data\n2) fit the model\n```')
        })

        it('keeps prompt lines after a paragraph line by line', () => {
            assert.strictEqual(renderDocComment(prose('Example:', '>> x = 1', '>> y = 2')),
                'Example:\n\n```text\n>> x = 1\n>> y = 2\n```')
        })

        it('keeps table rows after a paragraph line by line', () => {
            assert.strictEqual(renderDocComment(prose('Modes:', '| a | b |', '| 1 | 2 |')),
                'Modes:\n\n```text\n| a | b |\n| 1 | 2 |\n```')
        })

        it('keeps a deeper line preformatted after a line that ends a clause', () => {
            assert.strictEqual(renderDocComment(prose('Options:', '    verbose prints progress')),
                'Options:\n\n```text\nverbose prints progress\n```')
        })

        it('keeps a deeper line of code preformatted, even after half a sentence', () => {
            assert.strictEqual(renderDocComment(prose('Scales the input, for example', '    y = f(3);')),
                'Scales the input, for example\n\n```text\ny = f(3);\n```')
        })

        it('keeps a deeper capitalised line preformatted, even after half a sentence', () => {
            assert.strictEqual(renderDocComment(prose('Scales the input, see', '    Notes on scaling')),
                'Scales the input, see\n\n```text\nNotes on scaling\n```')
        })

        it('counts a tab as indentation to the next multiple of 4', () => {
            assert.strictEqual(renderDocComment(prose('  Example:', '\ty = f(3);')), 'Example:\n\n```text\ny = f(3);\n```')
        })

        it('measures depth from the comment marker when a line gives it', () => {
            const lines: DocCommentLine[] = [
                { text: 'Example:', preformatted: false, indent: 0 },
                { text: 'y = f(3);', preformatted: false, indent: 4 }
            ]
            assert.strictEqual(renderDocComment(lines), 'Example:\n\n```text\ny = f(3);\n```')
        })

        it('keeps block comment contents preformatted, blank lines included', () => {
            assert.strictEqual(renderDocComment(block('Usage:', '', '   f(1)')), '```text\nUsage:\n\n   f(1)\n```')
        })

        it('renders a block comment of 200000 lines without running out of stack', () => {
            const lines: DocCommentLine[] = Array.from({ length: 200000 }, (_, i) => ({ text: `row ${i}`, preformatted: true }))
            assert.doesNotThrow(() => renderDocComment(lines))
        })

        it('escapes markdown in prose', () => {
            assert.strictEqual(renderDocComment(prose('Scales A*B by *k*; see [notes](x) and <b>.')),
                'Scales A\\*B by \\*k\\*; see \\[notes\\](x) and \\<b\\>.')
        })

        it('uses a fence longer than any backtick run inside a preformatted block', () => {
            assert.strictEqual(renderDocComment(block('md = "```";')), '````text\nmd = "```";\n````')
        })
    })

    describe('#indentColumns', () => {
        it('counts a space as one column and a tab to the next multiple of 4', () => {
            assert.deepStrictEqual(['   x', '\tx', '  \tx', '    \tx', ' \t \tx'].map(text => indentColumns(text)), [3, 4, 4, 8, 8])
        })
    })

    describe('#escapeMarkdown', () => {
        it('escapes inline markdown', () => {
            assert.strictEqual(escapeMarkdown('a *b* _c_ [d](e) <f> `g` h|i ~j~ k\\l m&n'),
                'a \\*b\\* \\_c\\_ \\[d\\](e) \\<f\\> \\`g\\` h\\|i \\~j\\~ k\\\\l m\\&n')
        })

        it('escapes what would start a heading, list, quote or rule', () => {
            assert.deepStrictEqual(
                ['# h', '- item', '+ item', '1. item', '12) item', '> q', '=====', '---'].map(text => escapeMarkdown(text)),
                ['\\# h', '\\- item', '\\+ item', '1\\. item', '12\\) item', '\\> q', '\\=====', '\\---'])
        })

        it('leaves ordinary prose alone', () => {
            assert.strictEqual(escapeMarkdown('Returns X plus one (see f). 3.5 - 1 = 2.5, "quoted" text.'),
                'Returns X plus one (see f). 3.5 - 1 = 2.5, "quoted" text.')
            assert.strictEqual(escapeMarkdown('2.5 times the step, or 10) at most'), '2.5 times the step, or 10) at most')
        })

        it('leaves web and email addresses as they are', () => {
            assert.strictEqual(
                escapeMarkdown('See https://example.com/a_b?x=1&y=2 or www.example.com/c_d, mail first_last@example.com *now*'),
                'See https://example.com/a_b?x=1&y=2 or www.example.com/c_d, mail first_last@example.com \\*now\\*')
        })
    })

    describe('#firstLineIsOwnParagraph', () => {
        it('is true for a lone line, and for a line before a blank line', () => {
            assert.strictEqual(firstLineIsOwnParagraph(prose('F Summary.')), true)
            assert.strictEqual(firstLineIsOwnParagraph(prose('F Summary.', '', 'Body.')), true)
        })

        it('is true when the next line is indented deeper, as in the MATLAB H1 convention', () => {
            assert.strictEqual(firstLineIsOwnParagraph(prose('F Summary.', '   Body.')), true)
        })

        it('is false when the next line continues the sentence', () => {
            assert.strictEqual(firstLineIsOwnParagraph(prose('drop the export time that', 'exportgraphics writes')), false)
        })

        it('is false for a block comment line', () => {
            assert.strictEqual(firstLineIsOwnParagraph(block('Usage:')), false)
        })
    })

    describe('#firstLineIsSummary', () => {
        it('is true for a first line that is a paragraph of its own', () => {
            assert.strictEqual(firstLineIsSummary(prose('F Summary', '   Body')), true)
        })

        it('is true for a complete sentence, even when the next line is at the same depth', () => {
            assert.strictEqual(
                firstLineIsSummary(prose('RESOLVESTACKFRAME Finds the file of a stack frame.', 'Takes candidate names, for example')), true)
        })

        it('is false for half of a wrapped sentence', () => {
            assert.strictEqual(
                firstLineIsSummary(prose('PARSEINFO Parses the given MATLAB code and extracts information about', 'variables, functions, etc.')), false)
        })

        it('is false for a block comment line, even a complete sentence', () => {
            assert.strictEqual(firstLineIsSummary(block('Usage is simple.')), false)
        })
    })
})
