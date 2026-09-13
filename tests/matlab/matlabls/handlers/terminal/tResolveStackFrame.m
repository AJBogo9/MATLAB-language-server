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

        % R2023a and earlier resolve with the shipped resolvePath P-code, which
        % no test can run on R2026a, so doubles in testData/resolvePath* stand in.

        function testBeforeR2023bUsesWhichWhenResolvePathFails (testCase)
            testCase.useResolvePathDouble('resolvePathThrows');

            testCase.verifyEqual(resolveBeforeR2023b('tsfNest'), fullfile(testCase.DataFolder, 'tsfNest.m'));
            testCase.verifyEqual(resolveBeforeR2023b('tsfpkg.tsfPkgFn'), fullfile(testCase.DataFolder, '+tsfpkg', 'tsfPkgFn.m'));
        end

        function testBeforeR2023bUsesWhichWhenResolvePathFindsNothing (testCase)
            testCase.useResolvePathDouble('resolvePathFindsNothing');

            testCase.verifyEqual(resolveBeforeR2023b('tsfNest'), fullfile(testCase.DataFolder, 'tsfNest.m'));
            testCase.verifyEqual(resolveBeforeR2023b('tsfpkg.tsfPkgFn'), fullfile(testCase.DataFolder, '+tsfpkg', 'tsfPkgFn.m'));
        end

        function testBeforeR2023bTakesOnlyAFileFromWhich (testCase)
            testCase.useResolvePathDouble('resolvePathThrows');

            % which() answers "built-in (<path>)" here, which is not a file
            testCase.verifyEqual(resolveBeforeR2023b('disp'), '');
            testCase.verifyEqual(resolveBeforeR2023b('tsfpkg'), '');
            testCase.verifyEqual(resolveBeforeR2023b('tsfNotAThing999'), '');
        end

        function testBeforeR2023bFindsAFileNamedLikeAVariable (testCase)
            testCase.useResolvePathDouble('resolvePathThrows');
            folder = fullfile(testCase.DataFolder, 'variableNamed');
            testCase.applyFixture(matlab.unittest.fixtures.PathFixture(folder));

            % which() answers "variable" for a variable of the workspace it runs in
            testCase.verifyEqual(resolveBeforeR2023b('name'), fullfile(folder, 'name.m'));
        end

        function testBeforeR2023bPrefersTheAnswerOfResolvePath (testCase)
            testCase.useResolvePathDouble('resolvePathFinds');

            testCase.verifyEqual(resolveBeforeR2023b('tsfNest'), '/resolvePathDouble/tsfNest.m');
        end

        function testTheRunningReleaseChoosesTheResolver (testCase)
            % Only R2026a was run. Before R2023b the double answers instead.
            testCase.useResolvePathDouble('resolvePathFinds');

            if isMATLABReleaseOlderThan('R2023b')
                expected = '/resolvePathDouble/tsfNest.m';
            else
                expected = fullfile(testCase.DataFolder, 'tsfNest.m');
            end
            testCase.verifyEqual(resolve('tsfNest'), expected);
        end
    end

    methods
        function useResolvePathDouble (testCase, name)
            testCase.applyFixture(matlab.unittest.fixtures.SuppressedWarningsFixture('MATLAB:dispatcher:nameConflict'));
            testCase.applyFixture(matlab.unittest.fixtures.PathFixture(fullfile(testCase.DataFolder, name)));
        end
    end
end

function resolvedPath = resolve (varargin)
    resolvedPath = matlabls.handlers.terminal.resolveStackFrame(varargin{:});
end

function resolvedPath = resolveBeforeR2023b (name)
    resolvedPath = matlabls.handlers.terminal.resolveNameBeforeR2023b(name);
end
