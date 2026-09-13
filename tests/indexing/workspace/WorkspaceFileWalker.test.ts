// Copyright 2026 Andreas Bogossian
import assert from 'assert'
import sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { compileExcludes } from '../../../src/indexing/workspace/ExcludeGlobs'
import { findMatlabFiles, WalkerFileSystem } from '../../../src/indexing/workspace/WorkspaceFileWalker'
import Logger from '../../../src/logging/Logger'

const noExclusions = (): boolean => false

async function settleWithin<T> (promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}

const sorted = (paths: string[]): string[] => [...paths].sort()

describe('Workspace file walker', () => {
    let warn: sinon.SinonStub

    beforeEach(() => {
        warn = sinon.stub(Logger, 'warn')
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('on a real folder tree', function () {
        let root = ''
        let locked = ''

        before(function () {
            // POSIX symbolic links and permissions; root reads a folder without permission
            if (process.platform === 'win32' || process.getuid?.() === 0) {
                this.skip()
            }
            root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walker-')))
            const write = (relativePath: string): void => {
                fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true })
                fs.writeFileSync(path.join(root, relativePath), 'x = 1;\n')
            }
            write('a.m')
            write('sub/b.m')
            write('sub/notes.txt')
            write('sub/data.mat')
            write('node_modules/v.m')
            write('x.m/y.m')
            write('locked/hidden.m')
            // Exactly one loop, so that a walker which follows links still terminates
            fs.symlinkSync('.', path.join(root, 'loop'))
            fs.symlinkSync('sub', path.join(root, 'dup'))
            fs.symlinkSync('a.m', path.join(root, 'link.m'))
            fs.symlinkSync('/nonexistent/target.m', path.join(root, 'broken.m'))
            locked = path.join(root, 'locked')
            fs.chmodSync(locked, 0o000)
        })

        after(() => {
            if (root !== '') {
                fs.chmodSync(locked, 0o755)
                fs.rmSync(root, { recursive: true, force: true })
            }
        })

        it('lists only real .m files, pruning excluded folders', async () => {
            const files = await settleWithin(findMatlabFiles(root, compileExcludes([{ '**/node_modules': true }])), 2000)
            assert.deepStrictEqual(sorted(files), sorted([
                path.join(root, 'a.m'),
                path.join(root, 'sub', 'b.m'),
                path.join(root, 'x.m', 'y.m')
            ]))
        })

        it('lists every real .m file when nothing is excluded', async () => {
            const files = await findMatlabFiles(root, noExclusions)
            assert.deepStrictEqual(sorted(files), sorted([
                path.join(root, 'a.m'),
                path.join(root, 'node_modules', 'v.m'),
                path.join(root, 'sub', 'b.m'),
                path.join(root, 'x.m', 'y.m')
            ]))
        })

        it('follows no symbolic link, to a folder or to a file', async () => {
            const files = await findMatlabFiles(root, noExclusions)
            for (const file of files) {
                const relativePath = path.relative(root, file)
                assert.ok(!/^(loop|dup)\//.test(relativePath), relativePath)
                assert.ok(relativePath !== 'link.m' && relativePath !== 'broken.m', relativePath)
            }
        })

        it('descends into a folder named like a .m file and never lists the folder', async () => {
            const files = await findMatlabFiles(root, noExclusions)
            assert.ok(files.includes(path.join(root, 'x.m', 'y.m')))
            assert.ok(!files.includes(path.join(root, 'x.m')))
        })

        it('skips a folder it cannot read and says so once', async () => {
            const files = await findMatlabFiles(root, noExclusions)
            assert.ok(!files.some(file => file.startsWith(locked)))
            sinon.assert.calledOnce(warn)
            assert.ok(String(warn.firstCall.args[0]).includes(locked), String(warn.firstCall.args[0]))
        })

        it('asks about each folder and .m file by its path relative to the walked folder', async () => {
            const asked: Array<[string, boolean]> = []
            await findMatlabFiles(root, (relativePath, isDirectory) => {
                asked.push([relativePath, isDirectory])
                return relativePath === 'node_modules'
            })
            const has = (relativePath: string, isDirectory: boolean): boolean =>
                asked.some(([p, d]) => p === relativePath && d === isDirectory)
            assert.ok(has('sub', true) && has('node_modules', true) && has('x.m', true) && has('locked', true), JSON.stringify(asked))
            assert.ok(has('a.m', false) && has('sub/b.m', false) && has('x.m/y.m', false), JSON.stringify(asked))
            assert.ok(!asked.some(([p]) => p.startsWith('/') || p.startsWith('node_modules/') || p.includes(path.sep === '/' ? '\\' : path.sep)), JSON.stringify(asked))
        })

        it('returns nothing for a folder that does not exist', async () => {
            const files = await findMatlabFiles(path.join(root, 'missing'), noExclusions)
            assert.deepStrictEqual(files, [])
        })
    })

    describe('on entries typed as links', () => {
        // On Windows every reparse point is typed as a link, including cloud file
        // placeholders, which are ordinary files once looked at with lstat
        const entry = (name: string, kind: 'file' | 'directory' | 'link'): any => ({
            name,
            isFile: () => kind === 'file',
            isDirectory: () => kind === 'directory',
            isSymbolicLink: () => kind === 'link'
        })
        const stats = (kind: 'file' | 'directory' | 'link'): any => ({
            isFile: () => kind === 'file',
            isDirectory: () => kind === 'directory',
            isSymbolicLink: () => kind === 'link'
        })

        it('keeps a link-typed entry that lstat reports as a file or folder, and skips a real or vanished link', async () => {
            const root = path.join(path.sep, 'ws')
            const listings = new Map<string, any[]>([
                [root, [entry('placeholder.m', 'link'), entry('vanished.m', 'link'), entry('cloudDir', 'link'), entry('junction', 'link'), entry('plain.m', 'file')]],
                [path.join(root, 'cloudDir'), [entry('inCloud.m', 'file')]],
                [path.join(root, 'junction'), [entry('behindJunction.m', 'file')]]
            ])
            const lstatKinds = new Map<string, 'file' | 'directory' | 'link'>([
                [path.join(root, 'placeholder.m'), 'file'],
                [path.join(root, 'cloudDir'), 'directory'],
                [path.join(root, 'junction'), 'link']
            ])
            const fileSystem: WalkerFileSystem = {
                readdir: sinon.spy(async (dirPath: string) => listings.get(dirPath) ?? []),
                lstat: async (entryPath: string) => {
                    if (entryPath === path.join(root, 'vanished.m')) {
                        throw new Error('ENOENT: gone since the folder was read')
                    }
                    return stats(lstatKinds.get(entryPath) ?? 'link')
                }
            }

            const files = await findMatlabFiles(root, noExclusions, fileSystem)

            assert.deepStrictEqual(sorted(files), sorted([
                path.join(root, 'placeholder.m'),
                path.join(root, 'plain.m'),
                path.join(root, 'cloudDir', 'inCloud.m')
            ]))
            sinon.assert.neverCalledWith(fileSystem.readdir as sinon.SinonSpy, path.join(root, 'junction'))
        })
    })
})
