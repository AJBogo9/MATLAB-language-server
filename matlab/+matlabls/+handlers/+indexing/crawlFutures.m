function out = crawlFutures (action, responseChannel, future)
    % CRAWLFUTURES Keeps the future of each workspace crawl under its response
    % channel, so that a crawl the language server gave up can be cancelled.
    %
    % crawlFutures('add', responseChannel, future) records the future, after
    % forgetting every recorded future that is no longer queued or running, so the
    % record holds little more than the crawls under way and cannot grow.
    %
    % future = crawlFutures('take', responseChannel) forgets the future recorded
    % under the channel and returns it, or [] if there is none.
    %
    % channels = crawlFutures('channels') lists the channels recorded.
    %
    % Only the MATLAB thread calls it. It is locked, so that clear all does not
    % lose the record.

    % Copyright 2026 Andreas Bogossian

    mlock
    persistent futures
    if ~isa(futures, 'containers.Map')
        futures = containers.Map('KeyType', 'char', 'ValueType', 'any');
    end

    switch action
        case 'add'
            for channel = futures.keys()
                recorded = futures(channel{1});
                if ~ismember(recorded.State, {'queued', 'running'})
                    futures.remove(channel{1});
                end
            end
            futures(char(responseChannel)) = future;
        case 'take'
            out = [];
            channel = char(responseChannel);
            if futures.isKey(channel)
                out = futures(channel);
                futures.remove(channel);
            end
        case 'channels'
            out = futures.keys();
    end
end
