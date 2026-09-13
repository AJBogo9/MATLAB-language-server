% Copyright 2026 Andreas Bogossian
classdef tParseInfoFromDocumentAsync < matlab.unittest.TestCase
    % A published message cannot be observed from inside MATLAB, so these tests
    % check the message that would be published and the decision to queue.

    methods (TestClassSetup)
        function setup (~)
            % Add functions under test to path
            addpath("../../../../../matlab");
        end
    end

    methods (Test)
        function testWorkerResponseMatchesSynchronousParse (testCase)
            for name = ["SampleClass.m", fullfile("+package", "sampleFunction.m")]
                filePath = fullfile(pwd, 'testData', name);
                code = fileread(filePath);

                future = parfeval(backgroundPool, @matlabls.handlers.indexing.buildParseResponse, 1, code, filePath, 0, 7);
                msg = fetchOutputs(future);

                expected = matlabls.handlers.indexing.parseInfoFromDocument(code, filePath, 0);
                testCase.verifyEqual(msg.requestId, 7);
                % timeToIndex differs on every parse, even of the same code
                testCase.verifyEqual(rmfield(msg.codeData, 'timeToIndex'), rmfield(expected, 'timeToIndex'));
            end
        end

        function testParseErrorIsReportedNotThrown (testCase)
            msg = matlabls.handlers.indexing.buildParseResponse(42, 'x.m', 0, 3);

            testCase.verifyEqual(msg.requestId, 3);
            testCase.verifyTrue(isfield(msg, 'error'));
            testCase.verifyFalse(isfield(msg, 'codeData'));
        end

        function testQueuesWhenThePoolIsFree (testCase)
            pool = backgroundPool;
            testCase.assumeGreaterThanOrEqual(pool.NumWorkers, 2);
            testCase.assumeEmpty(pool.FevalQueue.QueuedFutures);

            status = matlabls.handlers.indexing.parseInfoFromDocumentAsync('x = 1;', 'x.m', 0, '/matlabls/test/unused', 1);

            testCase.verifyClass(status, 'double');
            testCase.verifyEqual(status, 1);
        end

        function testDeclinesWhenBackgroundPoolIsUnavailable (testCase)
            import matlab.unittest.fixtures.PathFixture
            import matlab.unittest.fixtures.SuppressedWarningsFixture

            testCase.applyFixture(SuppressedWarningsFixture('MATLAB:dispatcher:nameConflict'));
            testCase.applyFixture(PathFixture(fullfile(pwd, 'testData', 'noBackgroundPool')));

            status = matlabls.handlers.indexing.parseInfoFromDocumentAsync('x = 1;', 'x.m', 0, '/matlabls/test/unused', 1);

            testCase.verifyEqual(status, 0);
        end

        function testDeclinesWithASingleWorker (testCase)
            import matlab.unittest.fixtures.PathFixture
            import matlab.unittest.fixtures.SuppressedWarningsFixture

            testCase.applyFixture(SuppressedWarningsFixture('MATLAB:dispatcher:nameConflict'));
            testCase.applyFixture(PathFixture(fullfile(pwd, 'testData', 'singleWorkerPool')));

            status = matlabls.handlers.indexing.parseInfoFromDocumentAsync('x = 1;', 'x.m', 0, '/matlabls/test/unused', 1);

            testCase.verifyEqual(status, 0);
        end

        function testQueuesWithAPoolThatHasNoFevalQueue (testCase)
            % R2021b's background pool has no FevalQueue, so its queue cannot be read.
            % The parse is queued anyway, rather than every parse falling back to the
            % MATLAB thread; a parse left waiting still falls back after its timeout.
            import matlab.unittest.fixtures.PathFixture
            import matlab.unittest.fixtures.SuppressedWarningsFixture

            testCase.applyFixture(SuppressedWarningsFixture('MATLAB:dispatcher:nameConflict'));
            testCase.applyFixture(PathFixture(fullfile(pwd, 'testData', 'noFevalQueuePool')));

            status = matlabls.handlers.indexing.parseInfoFromDocumentAsync('x = 1;', 'x.m', 0, '/matlabls/test/unused', 1);

            testCase.verifyEqual(status, 1);
        end

        function testDeclinesWhileThePoolIsBusy (testCase)
            pool = backgroundPool;
            futures = parallel.FevalFuture.empty;
            for n = 1:(pool.NumWorkers + 1)
                futures(end + 1) = parfeval(pool, @() pause(10), 0); %#ok<AGROW>
            end
            testCase.addTeardown(@() cancelAndWait(futures));
            testCase.assumeNotEmpty(pool.FevalQueue.QueuedFutures);

            status = matlabls.handlers.indexing.parseInfoFromDocumentAsync('x = 1;', 'x.m', 0, '/matlabls/test/unused', 1);

            testCase.verifyEqual(status, 2);
        end
    end
end

function cancelAndWait (futures)
    cancel(futures);
    wait(futures);
end
