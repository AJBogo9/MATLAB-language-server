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

        function testReportsAFileWhoseDataCannotBePublishedAndCarriesOn (testCase)
            sampleClass = fullfile(pwd, 'testData', 'SampleClass.m');
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            folderClass = fullfile(pwd, 'testData', '@FolderClass', 'FolderClass.m');
            writeRules([testCase.RecordFile '.refuse'], {['codeData ' sampleClass], ['codeData ' folderClass]});

            matlabls.handlers.indexing.publishParsedFiles([string(sampleClass), string(sampleFunction), string(folderClass)], 0, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 4);
            if numel(records) == 4
                first = records{2}.msg;
                testCase.verifyEqual(first.filePath, sampleClass);
                testCase.verifyFalse(isfield(first, 'codeData'));
                testCase.verifyTrue(isfield(first, 'error'));
                if isfield(first, 'error')
                    testCase.verifySubstring(first.error, 'Refused a message');
                end
                testCase.verifyEqual(first.isDone, false);

                testCase.verifyEqual(records{3}.msg.filePath, sampleFunction);
                testCase.verifyTrue(isfield(records{3}.msg, 'codeData'));
                testCase.verifyEqual(records{3}.msg.isDone, false);

                % The last file is still reported as the last
                last = records{4}.msg;
                testCase.verifyEqual(last.filePath, folderClass);
                testCase.verifyFalse(isfield(last, 'codeData'));
                testCase.verifyTrue(isfield(last, 'error'));
                testCase.verifyEqual(last.isDone, true);
            end
        end

        function testEndsTheCrawlFromTheWorkerWhenAnErrorStopsIt (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            try
                char({1});
            catch expected
            end

            % A number is no path, so it ends the crawl after the file before it
            matlabls.handlers.indexing.publishParsedFiles({sampleFunction, 1, sampleFunction}, 0, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 3);
            if numel(records) == 3
                testCase.verifyEqual(records{2}.msg.filePath, sampleFunction);
                testCase.verifyEqual(records{2}.msg.isDone, false);
                testCase.verifyEqual(records{3}.msg, struct('isFailed', true, 'error', expected.message));
            end
        end

        function testEndsTheCrawlFromTheWorkerWhenAFileCannotBeReported (testCase)
            sampleClass = fullfile(pwd, 'testData', 'SampleClass.m');
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            % Neither the file's data nor the report of its error can be published
            writeRules([testCase.RecordFile '.refuse'], {['codeData ' sampleClass], ['error ' sampleClass]});

            matlabls.handlers.indexing.publishParsedFiles([string(sampleClass), string(sampleFunction)], 0, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 2);
            if numel(records) == 2
                testCase.verifyEqual(records{1}.msg, struct('isStarted', true));
                testCase.verifyEqual(records{2}.msg.isFailed, true);
                testCase.verifySubstring(records{2}.msg.error, 'filePath, error, isDone');
            end
        end

        function testRethrowsAnErrorWhoseFailureCannotBeReported (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            writeRules([testCase.RecordFile '.refuse'], {'isStarted', 'isFailed'});

            thrown = [];
            try
                matlabls.handlers.indexing.publishParsedFiles(string(sampleFunction), 0, testCase.RecordFile);
            catch thrown
            end

            % Left to the afterAll callback, which runs on the MATLAB thread
            testCase.assertNotEmpty(thrown, 'The future must fail, so that the afterAll callback reports it');
            testCase.verifyEqual(thrown.identifier, 'matlabls:test:refused');
            % The error that ended the crawl, not the one that stopped its report
            testCase.verifySubstring(thrown.message, 'isStarted');
            testCase.verifyFalse(isfile(testCase.RecordFile));
        end

        function testReportsFromTheWorkerAStartThatCannotBePublished (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            writeRules([testCase.RecordFile '.refuse'], {'isStarted'});

            matlabls.handlers.indexing.publishParsedFiles(string(sampleFunction), 0, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 1);
            if numel(records) == 1
                testCase.verifyEqual(records{1}.msg.isFailed, true);
                testCase.verifySubstring(records{1}.msg.error, 'isStarted');
            end
        end

        function testLocksTheRecordOfCrawls (testCase)
            % A locked function keeps its persistent record when the user runs clear all
            matlabls.handlers.indexing.crawlFutures('channels');
            testCase.verifyTrue(mislocked('matlabls.handlers.indexing.crawlFutures'));
        end

        function testReportsAFailureFromTheWorkerWhileTheMatlabThreadIsBusy (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');

            matlabls.handlers.indexing.parseInfoFromFiles({sampleFunction, 1}, 0, testCase.RecordFile);

            % Without a pause the MATLAB thread runs no callback, so a failure seen here
            % was published by the worker
            busy = tic;
            records = readRecords(testCase.RecordFile);
            while numel(records) < 3 && toc(busy) < 30
                x = sum(rand(100)); %#ok<NASGU>
                records = readRecords(testCase.RecordFile);
            end
            testCase.verifyNumElements(records, 3);
            if numel(records) == 3
                testCase.verifyEqual(records{2}.msg.filePath, sampleFunction);
                testCase.verifyEqual(records{3}.msg.isFailed, true);
            end

            % Once the MATLAB thread is free, the callback finds a future that did not fail
            pause(1);
            testCase.verifyNumElements(readRecords(testCase.RecordFile), 3);
        end

        function testStillCrawlsWhenAfterAllRejectsPassFuture (testCase)
            import matlab.unittest.fixtures.PathFixture

            testCase.applyFixture(PathFixture(fullfile(pwd, 'testData', 'afterAllWithoutPassFuture')));
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');

            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile);

            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 2);
            if numel(records) == 2
                testCase.verifyEqual(records{2}.msg.isDone, true);
            end
            % Recorded all the same, so the crawl can still be cancelled
            testCase.verifyClass(matlabls.handlers.indexing.crawlFutures('take', testCase.RecordFile), 'FutureWithoutPassFuture');
        end

        function testCancelCrawlCancelsAQueuedCrawlAndForgetsIt (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            pool = backgroundPool;
            occupyWorkers(testCase, pool, pool.NumWorkers);

            testCase.addTeardown(@() cancel(pool.FevalQueue.QueuedFutures));
            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile);
            queued = waitForCrawl(pool, testCase.RecordFile, 'queued', 5);
            testCase.assertNotEmpty(queued, 'The crawl must wait for a worker');
            testCase.verifyTrue(ismember(testCase.RecordFile, matlabls.handlers.indexing.crawlFutures('channels')));

            matlabls.handlers.indexing.cancelCrawl(testCase.RecordFile);

            testCase.verifyEqual(queued.State, 'finished');
            testCase.verifyEqual(queued.Error.identifier, 'parallel:fevalqueue:ExecutionCancelled');
            testCase.verifyFalse(ismember(testCase.RecordFile, matlabls.handlers.indexing.crawlFutures('channels')));
            records = waitForRecords(testCase.RecordFile, 1, 20);
            testCase.verifyNumElements(records, 1);
            if numel(records) == 1
                testCase.verifyEqual(records{1}.msg.isFailed, true);
            end
        end

        function testCancelCrawlStopsARunningCrawl (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            pool = backgroundPool;
            % The worker waits in its first publish while this file exists
            holdFile = [testCase.RecordFile '.hold'];
            fclose(fopen(holdFile, 'w'));
            testCase.addTeardown(@() deleteIfPresent(holdFile));

            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile);
            running = waitForCrawl(pool, testCase.RecordFile, 'running', 30);
            testCase.assertNotEmpty(running, 'The crawl must be running');

            matlabls.handlers.indexing.cancelCrawl(testCase.RecordFile);

            testCase.verifyEqual(running.State, 'finished');
            testCase.verifyEqual(running.Error.identifier, 'parallel:fevalqueue:ExecutionCancelled');
            delete(holdFile);
            waitForRecords(testCase.RecordFile, 1, 20);
            % Time for the started message to follow, had the worker carried on
            pause(1);
            records = readRecords(testCase.RecordFile);
            testCase.verifyNumElements(records, 1);
            if numel(records) == 1
                testCase.verifyEqual(records{1}.msg, struct('isFailed', true, 'error', running.Error.message));
            end
        end

        function testCancelCrawlLeavesAnUnknownOrFinishedCrawlAlone (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');

            matlabls.handlers.indexing.cancelCrawl([testCase.RecordFile '.unknown']);

            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile);
            waitForRecords(testCase.RecordFile, 2, 30);
            waitForNoCrawl(backgroundPool, testCase.RecordFile, 30);
            matlabls.handlers.indexing.cancelCrawl(testCase.RecordFile);

            % Time for a failure report to follow, had the cancel reached the finished crawl
            pause(1);
            testCase.verifyNumElements(readRecords(testCase.RecordFile), 2);
            testCase.verifyFalse(ismember(testCase.RecordFile, matlabls.handlers.indexing.crawlFutures('channels')));
        end

        function testRecordingACrawlForgetsOnlyFinishedCrawls (testCase)
            sampleFunction = fullfile(pwd, 'testData', '+package', 'sampleFunction.m');
            pool = backgroundPool;
            finishedChannel = [testCase.RecordFile '.finished'];
            runningChannel = [testCase.RecordFile '.running'];
            queuedChannel = [testCase.RecordFile '.queued'];

            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, finishedChannel);
            waitForRecords(finishedChannel, 2, 30);
            waitForNoCrawl(pool, finishedChannel, 30);
            testCase.assertTrue(ismember(finishedChannel, matlabls.handlers.indexing.crawlFutures('channels')), ...
                'A finished crawl stays recorded until another crawl is recorded');

            % Every worker but one sleeps, the last one holds a crawl in its first
            % publish, and one more crawl waits for a worker
            occupyWorkers(testCase, pool, pool.NumWorkers - 1);
            holdFile = [runningChannel '.hold'];
            fclose(fopen(holdFile, 'w'));
            testCase.addTeardown(@() deleteIfPresent(holdFile));
            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, runningChannel);
            testCase.assertNotEmpty(waitForCrawl(pool, runningChannel, 'running', 30), 'One crawl must be running');
            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, queuedChannel);
            testCase.assertNotEmpty(waitForCrawl(pool, queuedChannel, 'queued', 5), 'One crawl must wait for a worker');

            matlabls.handlers.indexing.parseInfoFromFiles(string(sampleFunction), 0, testCase.RecordFile);

            channels = matlabls.handlers.indexing.crawlFutures('channels');
            testCase.verifyFalse(ismember(finishedChannel, channels));
            testCase.verifyTrue(ismember(runningChannel, channels));
            testCase.verifyTrue(ismember(queuedChannel, channels));
            testCase.verifyTrue(ismember(testCase.RecordFile, channels));

            delete(holdFile);
            cancelled = {runningChannel, queuedChannel, testCase.RecordFile};
            cellfun(@matlabls.handlers.indexing.cancelCrawl, cancelled);
            for k = 1:numel(cancelled)
                waitForRecords(cancelled{k}, 1, 20);
            end
        end
    end
end

function writeRules (file, rules)
    fid = fopen(file, 'w');
    fprintf(fid, '%s\n', rules{:});
    fclose(fid);
end

function occupyWorkers (testCase, pool, count)
    busy = parallel.FevalFuture.empty;
    for k = 1:count
        busy(k) = parfeval(pool, @pause, 0, 120);
    end
    % Cancelling a running pause frees its worker at once
    testCase.addTeardown(@() cancel(busy));
    started = tic;
    while ~all(strcmp({busy.State}, 'running')) && toc(started) < 30
        pause(0.05);
    end
    testCase.assertTrue(all(strcmp({busy.State}, 'running')), 'The workers must be busy');
end

function future = crawlOn (pool, channel)
    % The queued or running crawl that publishes over the channel, if any
    future = [];
    futures = [pool.FevalQueue.QueuedFutures(:); pool.FevalQueue.RunningFutures(:)];
    for k = 1:numel(futures)
        if strcmp(func2str(futures(k).Function), 'matlabls.handlers.indexing.publishParsedFiles') && ...
                isequal(futures(k).InputArguments{3}, channel)
            future = futures(k);
        end
    end
end

function future = waitForCrawl (pool, channel, state, timeout)
    waited = tic;
    future = crawlOn(pool, channel);
    while (isempty(future) || ~strcmp(future.State, state)) && toc(waited) < timeout
        pause(0.05);
        future = crawlOn(pool, channel);
    end
    if ~isempty(future) && ~strcmp(future.State, state)
        future = [];
    end
end

function waitForNoCrawl (pool, channel, timeout)
    waited = tic;
    while ~isempty(crawlOn(pool, channel)) && toc(waited) < timeout
        pause(0.05);
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
