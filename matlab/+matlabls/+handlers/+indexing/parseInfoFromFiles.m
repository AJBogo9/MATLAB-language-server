function parseInfoFromFiles (filePaths, analysisLimit, responseChannel)
    % PARSEINFOFROMFILES Parses the given MATLAB files on the background pool and
    % publishes one message per file over the response channel.
    %
    % The language server walks the workspace itself, without following symbolic
    % links, and sends the file list. All files are parsed in a single future, so
    % the MATLAB thread is free again as soon as it is queued. The future may wait
    % for a free worker, publishes that it started before its first file, and
    % reports its own errors. It is recorded under the channel, so that cancelCrawl
    % can cancel a crawl the language server gave up.
    %
    % publishCrawlFailure, an afterAll callback, reports a crawl that could not
    % report itself: one cancelled before or while it runs, or one whose worker
    % could not publish its failure. The callback runs on the MATLAB thread, after
    % the user's own code.

    % Copyright 2026 Andreas Bogossian

    future = parfeval(backgroundPool, @matlabls.handlers.indexing.publishParsedFiles, 0, filePaths, analysisLimit, responseChannel);
    matlabls.handlers.indexing.crawlFutures('add', responseChannel, future);
    try
        % With PassFuture the callback also runs for a future that failed or was cancelled
        afterAll(future, @(finished) matlabls.handlers.indexing.publishCrawlFailure(finished, responseChannel), 0, 'PassFuture', true);
    catch
        % A release whose afterAll has no PassFuture option rejects it. The crawl
        % still runs and reports its own errors. Only a crawl that is cancelled, or
        % that cannot publish its failure, goes unreported.
    end
end
