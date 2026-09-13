classdef CommunicationManager
    % COMMUNICATIONMANAGER Stands in for the shipped publisher. Each published
    % message is appended as one line of JSON to the file named by the channel,
    % so a test can read what would have been sent. The MATLAB class of each
    % field is recorded alongside, since JSON cannot tell a char from a string.
    %
    % While a file named like the channel with .hold appended exists, a message
    % waits for it to go, for up to 20 s, so a test can look before anything is
    % published.

    % Copyright 2026 Andreas Bogossian

    methods (Static)
        function publish (channel, msg)
            held = tic;
            while isfile([channel '.hold']) && toc(held) < 20
                pause(0.05);
            end

            record.msg = msg;
            record.classes = structfun(@class, msg, 'UniformOutput', false);
            fid = fopen(channel, 'a');
            fprintf(fid, '%s\n', jsonencode(record));
            fclose(fid);
        end
    end
end
