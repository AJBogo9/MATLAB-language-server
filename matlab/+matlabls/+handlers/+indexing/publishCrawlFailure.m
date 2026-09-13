function publishCrawlFailure (future, responseChannel)
    % PUBLISHCRAWLFAILURE Publishes a failure message for a crawl whose future
    % failed or was cancelled, before or during the crawl, so that the language
    % server gives the crawl up at once. Runs once the future has finished, and
    % publishes nothing for a future that finished without an error.
    %
    % The worker reports its own errors, so this reports only a crawl that could not
    % report itself: one cancelled before or while it runs, or one whose worker could
    % not publish its failure. It runs on the MATLAB thread, after the user's own code.

    % Copyright 2026 Andreas Bogossian

    if isempty(future.Error)
        return
    end

    msg = struct('isFailed', true, 'error', future.Error.message);
    matlabls.internal.CommunicationManager.publish(responseChannel, msg);
end
