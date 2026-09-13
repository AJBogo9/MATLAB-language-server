function runTests(testFiles, testNames, responseChannel)
    %RUNTESTS Run MATLAB unit tests with streaming results.
    %   testFiles       - cell array of absolute file paths
    %   testNames       - cell array of specific test names (empty = run all);
    %                     each name is a test in the file at its index in testFiles
    %   responseChannel - Faye channel for publishing per-test events

    % Copyright 2026 The MathWorks, Inc.

    try
        % Tests in two files can share a name, so each name selects only from
        % the file sent at its index
        [files, ~, fileOfName] = unique(testFiles, 'stable');
        suites = cell(1, numel(files));
        for i = 1:numel(files)
            try
                suites{i} = matlab.unittest.TestSuite.fromFile(files{i});
            catch
                % Unlike TestSuite.empty, Test.empty has a Name to filter by and
                % concatenates with the tests of the files after it
                suites{i} = matlab.unittest.Test.empty;
            end

            % Filter to specific test names if provided
            if ~isempty(testNames)
                mask = ismember({suites{i}.Name}, testNames(fileOfName == i));
                suites{i} = suites{i}(mask);
            end
        end
        suite = [suites{:}];

        if isempty(suite)
            completeEvent.type = 'complete';
            matlabls.internal.CommunicationManager.publish(responseChannel, completeEvent);
            return;
        end

        % Create runner with diagnostics recording and streaming plugin
        runner = matlab.unittest.TestRunner.withNoPlugins();
        runner.addPlugin(matlab.unittest.plugins.DiagnosticsRecordingPlugin);
        runner.addPlugin(matlabls.handlers.testing.TestStreamingPlugin(responseChannel));
        outputStream = matlabls.handlers.testing.TextOutputStream(responseChannel);
        runner.addPlugin(matlab.unittest.plugins.TestRunProgressPlugin.withVerbosity(2, outputStream));
        runner.addPlugin(matlab.unittest.plugins.DiagnosticsOutputPlugin(outputStream));

        runner.run(suite);
    catch
        % Interrupted or unexpected error — fall through to complete event
    end

    completeEvent.type = 'complete';
    matlabls.internal.CommunicationManager.publish(responseChannel, completeEvent);
end
