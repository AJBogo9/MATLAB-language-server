% Copyright 2026 Andreas Bogossian
classdef tParseInfoFromFiles < matlab.unittest.TestCase
    % Published messages are recorded by the shadow publisher in
    % testData/recordingPublisher, which appends each one, with the MATLAB class
    % of each field, as a line of JSON to the file named by the channel.

    properties
        RecordFile
    end

    methods (TestClassSetup)
        function setup (~)
            % Add functions under test to path
            addpath("../../../../../matlab");
        end
    end

    methods (TestMethodSetup)
        function useRecordingPublisher (testCase)
            import matlab.unittest.fixtures.PathFixture
            import matlab.unittest.fixtures.SuppressedWarningsFixture
            import matlab.unittest.fixtures.TemporaryFolderFixture

            testCase.applyFixture(SuppressedWarningsFixture('MATLAB:dispatcher:nameConflict'));
            testCase.applyFixture(PathFixture(fullfile(pwd, 'testData', 'recordingPublisher')));
            folder = testCase.applyFixture(TemporaryFolderFixture);
            testCase.RecordFile = fullfile(folder.Folder, 'published.jsonl');
        end
    end

    methods (Test)
        function testPublishesThatTheCrawlStartedBeforeTheFirstFile (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');

            matlabls.handlers.indexing.publishParsedFiles(string(sampleFunction), 0, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 2);
            if numel(records) == 2
                testCase.verifyEqual(records{1}.msg, struct('isStarted', true));
                testCase.verifyEqual(records{2}.msg.filePath, sampleFunction);
            end
        end

        function testPublishesEveryFileAndCarriesOnPastAnUnreadableOne (testCase)
            sampleClass = fullfile(pwd, 'testData', 'SampleClass.m');
            missing = fullfile(tempdir, 'tParseInfoFromFiles_missing.m');
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');

            matlabls.handlers.indexing.publishParsedFiles([string(sampleClass), string(missing), string(sampleFunction)], 0, testCase.RecordFile);

            % The first record says that the crawl started
            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 4);

            first = records{2}.msg;
            testCase.verifyEqual(first.filePath, sampleClass);
            % A string would not arrive as the plain path the language server expects
            testCase.verifyEqual(records{2}.classes.filePath, 'char');
            testCase.verifyEqual(first.isDone, false);
            testCase.verifyFalse(isfield(first, 'error'));
            expected = matlabls.handlers.indexing.parseInfoFromDocument(fileread(sampleClass), sampleClass, 0);
            % timeToIndex differs on every parse, even of the same code
            testCase.verifyEqual(rmfield(first.codeData, 'timeToIndex'), ...
                rmfield(jsondecode(jsonencode(expected)), 'timeToIndex'));

            second = records{3}.msg;
            testCase.verifyEqual(second.filePath, missing);
            testCase.verifyEqual(second.isDone, false);
            testCase.verifyFalse(isfield(second, 'codeData'));
            testCase.verifyTrue(isfield(second, 'error'));
            if isfield(second, 'error')
                testCase.verifySubstring(second.error, 'tParseInfoFromFiles_missing.m');
            end

            third = records{4}.msg;
            testCase.verifyEqual(third.filePath, sampleFunction);
            testCase.verifyEqual(third.isDone, true);
            testCase.verifyTrue(isfield(third, 'codeData'));
        end

        function testASingleFileIsAlsoTheLast (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');

            matlabls.handlers.indexing.publishParsedFiles(string(sampleFunction), 0, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 2);
            testCase.verifyEqual(records{end}.msg.filePath, sampleFunction);
            testCase.verifyEqual(records{end}.msg.isDone, true);
        end

        function testQueuesTheParseOnTheBackgroundPool (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            % The recording publisher holds every message while this file exists
            holdFile = [testCase.RecordFile '.hold'];
            fclose(fopen(holdFile, 'w'));
            testCase.addTeardown(@() deleteIfPresent(holdFile));

            called = tic;
            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile);
            elapsed = toc(called);

            % Had the call waited for the parse, it would have sat out the publisher's hold
            testCase.verifyLessThan(elapsed, 10);
            testCase.verifyFalse(isfile(testCase.RecordFile));

            delete(holdFile);
            records = waitForRecords(testCase.RecordFile, 2, 30);
            testCase.verifyNumElements(records, 2);
            if numel(records) == 2
                testCase.verifyEqual(records{1}.msg, struct('isStarted', true));
                testCase.verifyEqual(records{2}.msg.isDone, true);
            end
        end

        function testReportsACrawlWhoseFutureFails (testCase)
            % The future cannot read a list of numbers, so it fails once it started
            matlabls.handlers.indexing.parseInfoFromFiles({1}, 0, testCase.RecordFile);

            records = waitForRecords(testCase.RecordFile, 2, 30);
            testCase.verifyNumElements(records, 2);
            if numel(records) == 2
                testCase.verifyEqual(records{1}.msg, struct('isStarted', true));
                testCase.verifyEqual(records{2}.msg.isFailed, true);
            end
        end

        function testReportsACrawlCancelledWhileItWaitsForAWorker (testCase)
            % A crawl cancelled in the queue never runs its worker function, so only a
            % callback outside that function can report it
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            pool = backgroundPool;
            busy = parallel.FevalFuture.empty;
            for k = 1:pool.NumWorkers
                busy(k) = parfeval(pool, @pause, 0, 120);
            end
            % Cancelling a running pause frees its worker at once
            testCase.addTeardown(@() cancel(busy));
            started = tic;
            while ~all(strcmp({busy.State}, 'running')) && toc(started) < 30
                pause(0.05);
            end
            testCase.assertTrue(all(strcmp({busy.State}, 'running')), 'Every worker must be busy before the crawl is queued');

            testCase.addTeardown(@() cancel(pool.FevalQueue.QueuedFutures));
            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile);

            queued = pool.FevalQueue.QueuedFutures;
            testCase.assertNumElements(queued, 1);
            testCase.assertEqual(func2str(queued.Function), 'matlabls.handlers.indexing.publishParsedFiles');
            testCase.assertEqual(queued.State, 'queued');
            cancel(queued);
            testCase.verifyEqual(queued.Error.identifier, 'parallel:fevalqueue:ExecutionCancelled');

            waitForRecords(testCase.RecordFile, 1, 20);
            % Time for a started record to follow, had the crawl run after all
            pause(1);
            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 1);
            if numel(records) == 1
                testCase.verifyEqual(records{1}.msg, struct('isFailed', true, 'error', queued.Error.message));
            end
        end

        function testPublishesTheErrorOfAFailedFuture (testCase)
            future = struct('Error', MException('matlabls:test:cancelled', 'Execution of the future was cancelled.'));

            matlabls.handlers.indexing.publishCrawlFailure(future, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 1);
            if numel(records) == 1
                testCase.verifyEqual(records{1}.msg, struct('isFailed', true, 'error', 'Execution of the future was cancelled.'));
            end
        end

        function testPublishesNothingForAFutureWithoutAnError (testCase)
            future = struct('Error', []);

            matlabls.handlers.indexing.publishCrawlFailure(future, testCase.RecordFile);

            testCase.verifyFalse(isfile(testCase.RecordFile));
        end

        function testFailsWithoutABackgroundPool (testCase)
            import matlab.unittest.fixtures.PathFixture

            testCase.applyFixture(PathFixture(fullfile(pwd, 'testData', 'noBackgroundPool')));
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');

            testCase.verifyError(@() matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile), ...
                'matlabls:test:noBackgroundPool');
            testCase.verifyFalse(isfile(testCase.RecordFile));
        end
    end
end

function records = readRecords (recordFile)
    records = {};
    if ~isfile(recordFile)
        return
    end
    % Only whole lines count, since the publisher creates the file before it writes
    lines = splitlines(fileread(recordFile));
    lines = lines(1:end - 1);
    lines = lines(~cellfun(@isempty, lines));
    records = cellfun(@jsondecode, lines, 'UniformOutput', false);
end

function records = waitForRecords (recordFile, count, timeout)
    waited = tic;
    records = readRecords(recordFile);
    while numel(records) < count && toc(waited) < timeout
        pause(0.1);
        records = readRecords(recordFile);
    end
end

function deleteIfPresent (file)
    if isfile(file)
        delete(file);
    end
end
