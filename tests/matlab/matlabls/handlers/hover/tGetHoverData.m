% Copyright 2026 Andreas Bogossian
classdef tGetHoverData < matlab.unittest.TestCase
    % The doubles in testData/oldIntrospection stand in for the introspection
    % functions MATLAB kept in matlab.internal.language.introspective before
    % R2024a. R2026a has no function by those names, so an answer from them can
    % only have come from a double.

    properties
        OldIntrospection
    end

    methods (TestClassSetup)
        function setup (testCase)
            % Add function under test to path
            addpath("../../../../../matlab");
            testCase.OldIntrospection = fullfile(pwd, 'testData', 'oldIntrospection');
        end
    end

    methods (TestMethodSetup)
        function addOldIntrospectionToPath (testCase)
            testCase.applyFixture(matlab.unittest.fixtures.PathFixture(testCase.OldIntrospection));
        end
    end

    methods (Test)
        function testReleasesBeforeR2024aCallTheOldNames (testCase)
            hoverData = matlabls.handlers.hover.getHoverData('tghdNotAThing999', 1);

            testCase.verifyEqual(hoverData.signatures, {'tghdOld(x)'; 'y = tghdOld(x, n)'});
            testCase.verifyEqual(hoverData.isResolved, 1);
            testCase.verifyEqual(hoverData.isBuiltin, 1);
        end

        function testLaterReleasesCallTheNewNames (testCase)
            hoverData = matlabls.handlers.hover.getHoverData('tghdNotAThing999', 0);

            testCase.verifyEqual(hoverData.signatures, {});
            testCase.verifyEqual(hoverData.isResolved, 0);
            testCase.verifyEqual(hoverData.isBuiltin, 0);
        end

        function testTheRunningReleaseChoosesTheNames (testCase)
            % Only R2026a was run. Before R2024a the doubles answer instead.
            hoverData = matlabls.handlers.hover.getHoverData('magic');

            if isMATLABReleaseOlderThan('R2024a')
                testCase.verifyEqual(hoverData.signatures, {'tghdOld(x)'; 'y = tghdOld(x, n)'});
                testCase.verifyEqual(hoverData.isBuiltin, 1);
            else
                testCase.verifyEqual(hoverData.signatures, {'M = magic(n)'});
                testCase.verifyEqual(hoverData.isBuiltin, 0);
            end
            testCase.verifyEqual(hoverData.isResolved, 1);
        end
    end
end
