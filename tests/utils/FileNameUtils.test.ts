// Copyright 2025 The MathWorks, Inc.

import assert from 'assert'
import * as FileNameUtils from '../../src/utils/FileNameUtils'
import path from 'path'
import sinon from 'sinon'

describe('FileNameUtils', () => {
    describe('#isMFile', () => {
        it('should return true for .m files', () => {
            const uri = 'file:///path/to/file.m'
            assert.strictEqual(FileNameUtils.isMFile(uri), true)
        })

        it('should return false for non-.m files', () => {
            const uri = 'file:///path/to/file.txt'
            assert.strictEqual(FileNameUtils.isMFile(uri), false)
        })

        it('should return false for files without extensions', () => {
            const uri = 'file:///path/to/file'
            assert.strictEqual(FileNameUtils.isMFile(uri), false)
        })
    })
    
    describe('#getFilePathFromUri', () => {
        describe('when shouldCoerceToMExt is false', () => {
            it('should return correct path for .m file', () => {
                const uri = 'file:///path/to/file.m'
                const expected = path.join('/path', 'to', 'file.m')
                const actual = FileNameUtils.getFilePathFromUri(uri)
                assert.strictEqual(actual, expected)
            })

            it('should return correct path for .ipynb file', () => {
                const uri = 'file:///path/to/file.ipynb'
                const expected = path.join('/path', 'to', 'file.ipynb')
                const actual = FileNameUtils.getFilePathFromUri(uri)
                assert.strictEqual(actual, expected)
            })

            it('should return correct path for non-M file', () => {
                const uri = 'file:///path/to/file.txt'
                const expected = path.join('/path', 'to', 'file.txt')
                const actual = FileNameUtils.getFilePathFromUri(uri)
                assert.strictEqual(actual, expected)
            })

            it('should return correct path for file without extension', () => {
                const uri = 'file:///path/to/file'
                const expected = path.join('/path', 'to', 'file')
                const actual = FileNameUtils.getFilePathFromUri(uri)
                assert.strictEqual(actual, expected)
            })
        })

        describe('when shouldCoerceToMExt is true', () => {
            it('should return correct path with .m extension for .m file', () => {
                const uri = 'file:///path/to/file.m'
                const expected = path.join('/path', 'to', 'file.m')
                const actual = FileNameUtils.getFilePathFromUri(uri, true)
                assert.strictEqual(actual, expected)
            })

            it('should return "untitled.m" for .ipynb file', () => {
                const uri = 'file:///path/to/file.ipynb'
                const expected = 'untitled.m'
                const actual = FileNameUtils.getFilePathFromUri(uri, true)
                assert.strictEqual(actual, expected)
            })

            it('should return correct path with .m extension for non-M file', () => {
                const uri = 'file:///path/to/file.txt'
                const expected = path.join('/path', 'to', 'file.m')
                const actual = FileNameUtils.getFilePathFromUri(uri, true)
                assert.strictEqual(actual, expected)
            })

            it('should return correct path with .m extension for file without extension', () => {
                const uri = 'file:///path/to/file'
                const expected = path.join('/path', 'to', 'file.m')
                const actual = FileNameUtils.getFilePathFromUri(uri, true)
                assert.strictEqual(actual, expected)
            })
        })
    })

    // which() names a file as C:\Users\..., while VS Code gives the path of the same file as c:\Users\...
    describe('#isSameFilePath', () => {
        afterEach(() => sinon.restore())

        it('should match a drive letter in either case on Windows', () => {
            assert.strictEqual(FileNameUtils.isSameFilePath('C:\\Users\\me\\docdemo.m', 'c:\\Users\\me\\docdemo.m', 'win32'), true)
        })

        it('should match folders and names that differ only in case on Windows', () => {
            assert.strictEqual(FileNameUtils.isSameFilePath('C:\\Users\\Me\\Work\\docdemo.m', 'c:\\users\\me\\work\\DocDemo.m', 'win32'), true)
        })

        it('should match either separator and redundant segments on Windows', () => {
            assert.strictEqual(FileNameUtils.isSameFilePath('c:/Users/me/./lib/../docdemo.m', 'C:\\Users\\me\\docdemo.m', 'win32'), true)
        })

        it('should tell different files apart on Windows', () => {
            assert.strictEqual(FileNameUtils.isSameFilePath('C:\\Users\\me\\docdemo.m', 'C:\\Users\\me\\other.m', 'win32'), false)
            assert.strictEqual(FileNameUtils.isSameFilePath('C:\\Users\\me\\docdemo.m', 'D:\\Users\\me\\docdemo.m', 'win32'), false)
        })

        it('should compare case exactly on Linux', () => {
            assert.strictEqual(FileNameUtils.isSameFilePath('/work/docdemo.m', '/Work/docdemo.m', 'linux'), false)
        })

        it('should match redundant segments on Linux, but not a backslash, which is part of a name there', () => {
            assert.strictEqual(FileNameUtils.isSameFilePath('/work/lib/../docdemo.m', '/work/docdemo.m', 'linux'), true)
            assert.strictEqual(FileNameUtils.isSameFilePath('/work\\docdemo.m', '/work/docdemo.m', 'linux'), false)
        })

        it('should follow the platform it runs on by default', () => {
            sinon.stub(process, 'platform').value('win32')
            assert.strictEqual(FileNameUtils.isSameFilePath('C:\\work\\docdemo.m', 'c:\\work\\docdemo.m'), true)
            sinon.restore()

            sinon.stub(process, 'platform').value('linux')
            assert.strictEqual(FileNameUtils.isSameFilePath('/work/docdemo.m', '/Work/docdemo.m'), false)
        })
    })
})
