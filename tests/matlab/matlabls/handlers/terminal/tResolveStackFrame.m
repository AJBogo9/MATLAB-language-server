% Copyright 2026 Andreas Bogossian
classdef tResolveStackFrame < matlab.unittest.TestCase
    % Frame names are the ones MATLAB prints for these fixtures.

    properties
        DataFolder
    end

    methods (TestClassSetup)
        function setup (testCase)
            % Add function under test to path
            addpath("../../../../../matlab");
            testCase.DataFolder = fullfile(pwd, 'testData');
        end
    end

    methods (TestMethodSetup)
        function addDataToPath (testCase)
            testCase.applyFixture(matlab.unittest.fixtures.PathFixture(testCase.DataFolder));
        end
    end

    methods (Test)
        function testResolvesLocalNestedAndAnonymousFramesToTheirFile (testCase)
            testCase.verifyEqual(resolve('tsfpkg.tsfPkgFn>host/child', 'tsfpkg.tsfPkgFn'), ...
                fullfile(testCase.DataFolder, '+tsfpkg', 'tsfPkgFn.m'));
            testCase.verifyEqual(resolve('tsfAnon>@(z)z(5)', 'tsfAnon'), fullfile(testCase.DataFolder, 'tsfAnon.m'));
            testCase.verifyEqual(resolve('tsfNest/kid', 'tsfNest'), fullfile(testCase.DataFolder, 'tsfNest.m'));
        end

        function testTriesTheMostSpecificNameFirst (testCase)
            testCase.verifyEqual(resolve('TsfOld/tsfMeth', 'TsfOld'), fullfile(testCase.DataFolder, '@TsfOld', 'tsfMeth.m'));
        end

        function testReturnsEmptyCharForNamesThatAreNotFiles (testCase)
            testCase.verifyEqual(resolve('tsfNotAThing999'), '');
            % A package folder resolves as a name but is not a file to open
            testCase.verifyEqual(resolve('tsfpkg'), '');
            testCase.verifyEqual(resolve(''), '');
            testCase.verifyEqual(resolve(), '');
        end

        function testReturnsCharForAFoundFile (testCase)
            testCase.verifyClass(resolve('tsfNest'), 'char');
        end

        function testDoesNotChangeTheCurrentFolder (testCase)
            testCase.applyFixture(matlab.unittest.fixtures.WorkingFolderFixture);
            before = pwd;

            resolve('tsfNotAThing999', 'tsfAlsoMissing');
            resolve('tsfpkg.tsfPkgFn>host/child', 'tsfpkg.tsfPkgFn');

            testCase.verifyEqual(pwd, before);
        end
    end
end

function resolvedPath = resolve (varargin)
    resolvedPath = matlabls.handlers.terminal.resolveStackFrame(varargin{:});
end
