function publishParsedFiles (filePaths, analysisLimit, responseChannel)
    % PUBLISHPARSEDFILES Publishes that the crawl started, then parses each file and
    % publishes its data, or the error that stopped it, together with its path. The
    % message for the last file sets isDone.
    %
    % The started message lets the language server time the crawl from when a worker
    % picked it up rather than from when it was queued. A file that cannot be read,
    % parsed or published is reported with its error and skipped, so it does not end
    % the crawl for the files after it. Any other error ends the crawl, including a
    % report that cannot be published, since the language server waits for every file.
    % That error is published as a failure from here, because the afterAll callback
    % runs on the MATLAB thread, behind the user's own code. Only if the failure cannot
    % be published either is the error rethrown, for the callback to try. Cancelling
    % the future runs no catch block, so a cancelled crawl is left to the callback.
    % Kept separate from parseInfoFromFiles so that tests can run it without a pool.

    % Copyright 2026 Andreas Bogossian

    try
        matlabls.internal.CommunicationManager.publish(responseChannel, struct('isStarted', true));

        for n = 1:numel(filePaths)
            filePath = char(filePaths(n));
            isDone = (n == numel(filePaths));

            msg = struct('filePath', filePath);
            try
                msg.codeData = matlabls.handlers.indexing.parseInfoFromDocument(fileread(filePath), filePath, analysisLimit);
                msg.isDone = isDone;
                % A message the publisher cannot encode fails here
                matlabls.internal.CommunicationManager.publish(responseChannel, msg);
            catch ME
                matlabls.internal.CommunicationManager.publish(responseChannel, struct('filePath', filePath, 'error', ME.message, 'isDone', isDone));
            end
        end
    catch ME
        try
            matlabls.internal.CommunicationManager.publish(responseChannel, struct('isFailed', true, 'error', ME.message));
        catch
            rethrow(ME);
        end
    end
end
