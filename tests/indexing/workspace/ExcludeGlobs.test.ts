// Copyright 2026 Andreas Bogossian
import assert from 'assert'

import { BUILT_IN_INDEX_EXCLUDES, compileExcludes, mergeExcludeSettings } from '../../../src/indexing/workspace/ExcludeGlobs'

const excludedBy = (glob: string): ((relativePath: string, isDirectory: boolean) => boolean) =>
    compileExcludes([{ [glob]: true }])

/** The fastest of several runs, in ms, so that a moment the machine spends elsewhere does not count */
function fastestRun (run: () => void): number {
    let fastest = Infinity
    for (let i = 0; i < 3; i++) {
        const start = process.hrtime.bigint()
        run()
        fastest = Math.min(fastest, Number(process.hrtime.bigint() - start) / 1e6)
    }
    return fastest
}

/**
 * Fails when a shape takes much longer than a control of the same size. The margin is
 * generous, since a quadratic or combinatorial shape misses it by orders of magnitude.
 */
function assertAsFastAsControl (run: () => void, control: () => void, shape: string): void {
    const controlMs = fastestRun(control)
    const runMs = fastestRun(run)
    assert.ok(runMs <= 10 * controlMs + 2, `${shape}: ${runMs.toFixed(3)} ms, against ${controlMs.toFixed(3)} ms for the control`)
}

describe('Workspace index exclusion globs', () => {
    it('matches **/name at any depth, and only a whole path segment', () => {
        const isExcluded = excludedBy('**/node_modules')
        assert.strictEqual(isExcluded('node_modules', true), true)
        assert.strictEqual(isExcluded('a/b/node_modules', true), true)
        assert.strictEqual(isExcluded('node_modules_extra', true), false)
        assert.strictEqual(isExcluded('mynode_modules', true), false)
        assert.strictEqual(isExcluded('a/mynode_modules', true), false)
    })

    it('matches a pattern without **/ from the folder root only', () => {
        const isExcluded = excludedBy('build')
        assert.strictEqual(isExcluded('build', true), true)
        assert.strictEqual(isExcluded('src/build', true), false)
    })

    it('matches ** between named segments across any number of segments, including none', () => {
        const isExcluded = excludedBy('src/**/gen')
        assert.strictEqual(isExcluded('src/gen', true), true)
        assert.strictEqual(isExcluded('src/a/b/gen', true), true)
        assert.strictEqual(isExcluded('gen', true), false)
        assert.strictEqual(isExcluded('lib/src/gen', true), false)
        assert.strictEqual(isExcluded('src/a/gen2', true), false)
    })

    it('keeps * inside one path segment', () => {
        const isExcluded = excludedBy('src/*.asv')
        assert.strictEqual(isExcluded('src/a.asv', false), true)
        assert.strictEqual(isExcluded('src/sub/a.asv', false), false)
    })

    it('treats every other character literally, including MATLAB folder prefixes', () => {
        assert.strictEqual(excludedBy('**/.git')('x/agit', true), false)
        assert.strictEqual(excludedBy('**/.git')('x/.git', true), true)
        assert.strictEqual(excludedBy('**/+pkg')('+pkg', true), true)
        assert.strictEqual(excludedBy('**/+pkg')('xpkg', true), false)
        assert.strictEqual(excludedBy('**/a(1)')('a(1)', true), true)
        assert.strictEqual(excludedBy('**/a(1)')('a1', true), false)
    })

    it('expands {a,b} alternatives', () => {
        const isExcluded = excludedBy('**/codegen/{mex,lib,dll,exe}')
        assert.strictEqual(isExcluded('codegen/mex', true), true)
        assert.strictEqual(isExcluded('p/codegen/lib', true), true)
        assert.strictEqual(isExcluded('codegen', true), false)
        assert.strictEqual(isExcluded('codegen/mysrc', true), false)
        assert.strictEqual(isExcluded('codegen/mexx', true), false)
    })

    it('translates wildcards and literal characters inside alternatives', () => {
        const isExcluded = excludedBy('**/{*.asv,a.b}')
        assert.strictEqual(isExcluded('x/f.asv', false), true)
        assert.strictEqual(isExcluded('a.b', false), true)
        assert.strictEqual(isExcluded('axb', false), false)
        assert.strictEqual(isExcluded('x/f.m', false), false)
    })

    it('prunes the folder whose contents a trailing /** pattern excludes', () => {
        const isExcluded = excludedBy('**/.git/objects/**')
        assert.strictEqual(isExcluded('.git/objects', true), true)
        assert.strictEqual(isExcluded('.git/objects/ab/c.m', false), true)
        assert.strictEqual(isExcluded('.git/objects', false), false)
        assert.strictEqual(isExcluded('.git', true), false)
    })

    it('ignores keys whose value is not exactly true', () => {
        const isExcluded = compileExcludes([{ '**/keep': false, '**/cond': { when: '$(basename).ts' } }])
        assert.strictEqual(isExcluded('keep', true), false)
        assert.strictEqual(isExcluded('cond', true), false)
    })

    it('merges several maps', () => {
        const isExcluded = compileExcludes([{ '**/gen': true }, { '**/vendor': true }])
        assert.strictEqual(isExcluded('a/gen', true), true)
        assert.strictEqual(isExcluded('vendor', true), true)
        assert.strictEqual(isExcluded('src', true), false)
    })

    it('ignores answers that are not glob maps without throwing', () => {
        // lspSmoke.js answers every configuration item with the MATLAB settings object
        const matlabSettings = { installPath: '', matlabConnectionTiming: 'never', indexWorkspace: false, telemetry: false, maxFileSizeForAnalysis: 0 }
        const isExcluded = compileExcludes([null, undefined, 'x', 42, [true], matlabSettings])
        for (const name of ['x', '0', '42', 'installPath', 'indexWorkspace', 'telemetry', 'src']) {
            assert.strictEqual(isExcluded(name, true), false, name)
        }
    })

    it('treats a pattern with a trailing slash like the same pattern without it', () => {
        assert.strictEqual(excludedBy('build/')('build', true), true)
        assert.strictEqual(excludedBy('build/')('src/build', true), false)
        assert.strictEqual(excludedBy('**/gen/')('a/gen', true), true)
        assert.strictEqual(excludedBy('**/gen/')('a/gen2', true), false)
        assert.strictEqual(excludedBy('**/+pkg/')('+pkg', true), true)
        assert.strictEqual(excludedBy('{build/,out/}')('out', true), true)
        // A trailing /**/ still prunes the folder it empties
        assert.strictEqual(excludedBy('a/**/')('a', true), true)
        assert.strictEqual(excludedBy('a/**/')('a/b/x.m', false), true)
        assert.strictEqual(excludedBy('a/**/')('b/x.m', false), false)
    })

    it('ignores whitespace at the end of a pattern, as both VS Code engines do, but not at its start, as Quick Open does', () => {
        for (const glob of ['**/gen ', '**/gen\t', '**/gen \t ', '**/gen/ ']) {
            const isExcluded = excludedBy(glob)
            assert.strictEqual(isExcluded('gen', true), true, JSON.stringify(glob))
            assert.strictEqual(isExcluded('x/gen', true), true, JSON.stringify(glob))
            assert.strictEqual(isExcluded('gen ', true), false, JSON.stringify(glob))
        }
        assert.strictEqual(excludedBy(' **/gen')('gen', true), false)
        assert.strictEqual(excludedBy(' **/gen')('x/gen', true), false)
        assert.strictEqual(excludedBy(' gen')(' gen', true), true)
        assert.strictEqual(excludedBy(' gen')('gen', true), false)
    })

    it('matches alternatives that contain a slash', () => {
        const either = excludedBy('{build,out/gen}')
        assert.strictEqual(either('build', true), true)
        assert.strictEqual(either('out/gen', true), true)
        assert.strictEqual(either('out', true), false)
        assert.strictEqual(either('x/out/gen', true), false)

        const anyDepth = excludedBy('**/{gen,vendor/lib}')
        assert.strictEqual(anyDepth('x/gen', true), true)
        assert.strictEqual(anyDepth('vendor/lib', true), true)
        assert.strictEqual(anyDepth('x/vendor/lib', true), true)
        assert.strictEqual(anyDepth('x/vendor', true), false)
        assert.strictEqual(anyDepth('x/lib', true), false)

        const globstars = excludedBy('{**/gen,**/tmp}')
        assert.strictEqual(globstars('gen', true), true)
        assert.strictEqual(globstars('x/y/tmp', true), true)
        assert.strictEqual(globstars('x/src', true), false)

        assert.strictEqual(excludedBy('a{b/c,d}e')('ab/ce', false), true)
        assert.strictEqual(excludedBy('a{b/c,d}e')('ade', false), true)
        assert.strictEqual(excludedBy('a{b/c,d}e')('abe', false), false)
        assert.strictEqual(excludedBy('x/{a/**,b}')('x/a/y.m', false), true)
        assert.strictEqual(excludedBy('x/{a/**,b}')('x/c', true), false)
        // A ** alternative followed by /gen needs a folder before gen, as in VS Code
        assert.strictEqual(excludedBy('{**,x}/gen')('a/gen', true), true)
        assert.strictEqual(excludedBy('{**,x}/gen')('gen', true), false)
    })

    it('excludes nothing for nested braces, without throwing, and keeps the other keys', () => {
        for (const glob of ['{a,{b,c}}', '**/{gen,{x,y}/lib}', '{{a}}', '{a,{b}']) {
            const isExcluded = excludedBy(glob)
            for (const relativePath of ['a', 'b', 'c', 'gen', 'x/lib', 'a}', '{b}', '{b', 'gen/lib}', '{a}}']) {
                assert.strictEqual(isExcluded(relativePath, true), false, `${glob} ~ ${relativePath}`)
            }
        }
        assert.strictEqual(compileExcludes([{ '{a,{b,c}}': true, '**/gen': true }])('x/gen', true), true)
    })

    it('excludes nothing for unbalanced braces, neither the literal name nor what VS Code\'s glob makes of it', () => {
        // Quick Open's ripgrep rejects these keys, and glob.parse drops an unclosed group and reads a stray } as an empty one
        const cases: Array<[string, string[]]> = [
            ['a{b', ['a{b', 'a', 'ab']],
            ['a}b', ['a}b', 'ab']],
            ['}x', ['}x', 'x']],
            ['{a,b}}', ['{a,b}}', 'a', 'b', 'a}', 'b}']],
            ['{a,b', ['{a,b', 'a', 'b']],
            ['x/a{b', ['x/a{b', 'x/a']]
        ]
        for (const [glob, relativePaths] of cases) {
            const isExcluded = excludedBy(glob)
            for (const relativePath of relativePaths) {
                assert.strictEqual(isExcluded(relativePath, true), false, `${glob} ~ ${relativePath}`)
            }
        }
        assert.strictEqual(compileExcludes([{ 'a{b': true, '}x': true, '**/gen': true }])('x/gen', true), true)
        // Groups side by side are neither nested nor unbalanced
        assert.strictEqual(excludedBy('{a}{b}')('ab', true), true)
    })

    it('drops an empty last alternative, as VS Code\'s glob does, and keeps an empty first or middle one', () => {
        // Expected values from VS Code 1.137's glob.parse. Kept, the empty last alternative would
        // match the bare prefix, so '**/*{.asv,}' would leave every file out. Groups in the middle of
        // a segment or of the key count too.
        const cases: Array<[string, string, boolean]> = [
            ['**/*{.asv,}', 'a.asv', true], ['**/*{.asv,}', 'src/a.asv', true], ['**/*{.asv,}', 'solver.m', false], ['**/*{.asv,}', 'src/solver.m', false], ['**/*{.asv,}', 'src', false],
            ['**/test{s,}', 'tests', true], ['**/test{s,}', 'x/tests', true], ['**/test{s,}', 'test', false], ['**/test{s,}', 'x/test', false],
            ['**/*{_old,}.m', 'solver_old.m', true], ['**/*{_old,}.m', 'src/solver_old.m', true], ['**/*{_old,}.m', 'solver.m', false], ['**/*{_old,}.m', 'src/solver.m', false],
            ['**/test{s,}/**', 'tests/tAll.m', true], ['**/test{s,}/**', 'test/tSolver.m', false],
            ['{a,}', 'a', true], ['{a,}', 'b', false],
            ['**/gen{,2}', 'gen', true], ['**/gen{,2}', 'gen2', true], ['**/gen{,2}', 'gen3', false],
            ['x{a,,b}', 'x', true], ['x{a,,b}', 'xa', true], ['x{a,,b}', 'xb', true], ['x{a,,b}', 'xc', false]
        ]
        for (const [glob, relativePath, expected] of cases) {
            assert.strictEqual(excludedBy(glob)(relativePath, !relativePath.includes('.')), expected, `${glob} ~ ${relativePath}`)
        }
    })

    it('excludes nothing for ? and [...], neither the literal name nor what VS Code\'s glob makes of it', () => {
        // VS Code reads ? as any one character and [...] as a class, which this matcher does not support
        const cases: Array<[string, string[]]> = [
            ['**/gen?', ['gen?', 'gen1', 'x/gen2']],
            ['**/gen[12]', ['gen[12]', 'gen1', 'gen2']],
            ['a?b', ['a?b', 'axb']],
            ['[ab]', ['[ab]', 'a', 'b']]
        ]
        for (const [glob, relativePaths] of cases) {
            const isExcluded = excludedBy(glob)
            for (const relativePath of relativePaths) {
                assert.strictEqual(isExcluded(relativePath, true), false, `${glob} ~ ${relativePath}`)
            }
        }
        assert.strictEqual(compileExcludes([{ '**/gen?': true, '[ab]': true, '**/gen': true }])('x/gen', true), true)
    })

    it('compiles a key of many unclosed braces in linear time', () => {
        assertAsFastAsControl(
            () => compileExcludes([{ ['{'.repeat(3000)]: true }]),
            () => compileExcludes([{ ['{a}'.repeat(1000)]: true }]),
            "3000 unclosed '{'")
    })

    it('matches the same paths with runs of globstars and stars collapsed', () => {
        // Expected values from the translation before runs were collapsed. A name can hold a
        // line break, which a trailing .* alone does not match.
        const table: Array<[string, string, boolean]> = [
            ['x/**/**', 'x', false], ['x/**/**', 'x/a', true], ['x/**/**', 'x/a/b.m', true], ['x/**/**', 'y/a', false], ['x/**/**', 'x/a\nb/c', true],
            ['**/**', 'a', true], ['**/**', 'a/b/c.m', true], ['**/**', 'a\nb/c', true],
            ['**/**/gen', 'gen', true], ['**/**/gen', 'a/gen', true], ['**/**/gen', 'a/b/gen', true], ['**/**/gen', 'gen2', false], ['**/**/gen', 'a/gen/b', false], ['**/**/gen', 'a\nb/gen', true],
            ['{**/**/gen,x}', 'gen', true], ['{**/**/gen,x}', 'a/b/gen', true], ['{**/**/gen,x}', 'x', true], ['{**/**/gen,x}', 'x/y', false], ['{**/**/gen,x}', 'y', false],
            ['x/**/**/z', 'x/z', true], ['x/**/**/z', 'x/a/z', true], ['x/**/**/z', 'x/a/b/z', true], ['x/**/**/z', 'x/a/b', false], ['x/**/**/z', 'z', false],
            ['**/**/**', 'a', true], ['**/**/**', 'a/b', true],
            ['**/a/**/b', 'a/b', true], ['**/a/**/b', 'x/a/y/b', true], ['**/a/**/b', 'a', false], ['**/a/**/b', 'b', false], ['**/a/**/b', 'x/b', false],
            ['**/*/**', 'a', true], ['**/*/**', 'a/b', true], ['**/*/**', 'a/b/c', true],
            ['**/**/*.m', 'a.m', true], ['**/**/*.m', 'x/a.m', true], ['**/**/*.m', 'x/y/a.m', true], ['**/**/*.m', 'x/a.txt', false],
            ['a***b', 'ab', true], ['a***b', 'axyb', true], ['a***b', 'a/b', false], ['a***b', 'axb/c', false],
            ['gen**', 'gen', true], ['gen**', 'gen2', true], ['gen**', 'x/gen', false], ['gen**', 'gen/a', false],
            ['***', 'a', true], ['***', 'a/b', false],
            ['*a**b*', 'ab', true], ['*a**b*', 'xaybz', true], ['*a**b*', 'a/b', false], ['*a**b*', 'b', false]
        ]
        for (const [glob, relativePath, expected] of table) {
            assert.strictEqual(excludedBy(glob)(relativePath, !relativePath.endsWith('.m')), expected, `${glob} ~ ${JSON.stringify(relativePath)}`)
        }
    })

    it('matches consecutive globstars in linear time', () => {
        const deepPath = 'a/'.repeat(29) + 'y'
        const globstars = excludedBy('**/'.repeat(8) + 'zz')
        const control = excludedBy('**/' + 'aa/'.repeat(7) + 'zz')
        assertAsFastAsControl(() => globstars(deepPath, true), () => control(deepPath, true), '8 globstars before zz, on a path 30 deep')
        assert.strictEqual(globstars(deepPath, true), false)
    })

    it('matches a run of stars in linear time', () => {
        const name = 'x' + 'a'.repeat(30) + 'y'
        const stars = excludedBy('x' + '*'.repeat(8) + 'zz')
        const control = excludedBy('x*' + 'a'.repeat(7) + 'zz')
        assertAsFastAsControl(() => stars(name, true), () => control(name, true), '8 stars before zz, on a 32 character name')
        assert.strictEqual(stars(name, true), false)
    })

    it('merges files.exclude and search.exclude as VS Code does, search.exclude winning for the same key', () => {
        const excludedByBoth = (filesExclude: unknown, searchExclude: unknown): ((relativePath: string, isDirectory: boolean) => boolean) =>
            compileExcludes([mergeExcludeSettings(filesExclude, searchExclude)])

        assert.strictEqual(excludedByBoth({ '**/gen': true }, { '**/gen': false })('x/gen', true), false)
        assert.strictEqual(excludedByBoth({ '**/gen': false }, { '**/gen': true })('x/gen', true), true)
        assert.strictEqual(excludedByBoth({ '**/gen': true }, { '**/gen': { when: '$(basename).ts' } })('x/gen', true), false)
        // Only the same key overrides, however alike two keys match
        assert.strictEqual(excludedByBoth({ '**/gen': true }, { 'gen/**': false })('x/gen', true), true)
        assert.strictEqual(excludedByBoth({ '**/gen/': true }, { '**/gen': false })('x/gen', true), true)

        const both = excludedByBoth({ '**/gen': true }, { '**/vendor': true })
        assert.strictEqual(both('gen', true), true)
        assert.strictEqual(both('vendor', true), true)
        assert.strictEqual(both('src', true), false)
    })

    it('merges only settings that are glob maps', () => {
        const excludedByBoth = (filesExclude: unknown, searchExclude: unknown): ((relativePath: string, isDirectory: boolean) => boolean) =>
            compileExcludes([mergeExcludeSettings(filesExclude, searchExclude)])

        for (const [filesExclude, searchExclude] of [[{ '**/gen': true }, null], [null, { '**/gen': true }], [{ '**/gen': true }, [true]], ['xy', { '**/gen': true }], [{ '**/gen': true }, 42], [[true], { '**/gen': true }]]) {
            const isExcluded = excludedByBoth(filesExclude, searchExclude)
            assert.strictEqual(isExcluded('gen', true), true, JSON.stringify([filesExclude, searchExclude]))
            for (const name of ['0', '1', 'x', 'src']) {
                assert.strictEqual(isExcluded(name, true), false, `${JSON.stringify([filesExclude, searchExclude])} ~ ${name}`)
            }
        }
    })

    it('excludes version control, packages and generated MATLAB folders, but no user folders', () => {
        const isExcluded = compileExcludes([BUILT_IN_INDEX_EXCLUDES])
        for (const excluded of ['.git', '.svn', '.hg', 'node_modules', 'a/node_modules', 'slprj', 'm/slprj', 'codegen/mex', 'codegen/lib', 'codegen/dll', 'codegen/exe', 'resources/project']) {
            assert.strictEqual(isExcluded(excluded, true), true, excluded)
        }
        for (const kept of ['src', 'build', 'out', 'dist', 'codegen', 'codegen/src', 'resources', 'project', '+pkg', '@Cls', 'private']) {
            assert.strictEqual(isExcluded(kept, true), false, kept)
        }
    })
})
