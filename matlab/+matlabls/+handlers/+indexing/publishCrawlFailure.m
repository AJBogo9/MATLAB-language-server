function publishCrawlFailure (future, responseChannel)
    % PUBLISHCRAWLFAILURE Publishes a failure message for a crawl whose future
    % failed or was cancelled, before or during the crawl, so that the language
    % server gives the crawl up at once. Runs once the future has finished, and
    % publishes nothing for a future that finished without an error.

    % Copyright 2026 Andreas Bogossian

    if isempty(future.Error)
        return
    end

    msg = struct('isFailed', true, 'error', future.Error.message);
    matlabls.internal.CommunicationManager.publish(responseChannel, msg);
end
