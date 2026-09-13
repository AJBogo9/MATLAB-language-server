classdef CommunicationManager
    % COMMUNICATIONMANAGER Stands in for the shipped publisher. Each published
    % message is appended as one line of JSON to the file named by the channel,
    % so a test can read what would have been sent. The MATLAB class of each
    % field is recorded alongside, since JSON cannot tell a char from a string.
    %
    % While a file named like the channel with .hold appended exists, a message
    % waits for it to go, for up to 20 s, so a test can look before anything is
    % published.
    %
    % While a file named like the channel with .refuse appended exists, a message is
    % refused with an error, as the shipped publisher refuses one it cannot encode.
    % Each line of the file names a field, optionally followed by a space and a file
    % path: a message with that field, and for that path if one is given, is refused.

    % Copyright 2026 Andreas Bogossian

    methods (Static)
        function publish (channel, msg)
            held = tic;
            while isfile([channel '.hold']) && toc(held) < 20
                pause(0.05);
            end

            refuseFile = [channel '.refuse'];
            if isfile(refuseFile)
                rules = splitlines(strtrim(fileread(refuseFile)));
                for k = 1:numel(rules)
                    [field, filePath] = strtok(rules{k}, ' ');
                    filePath = strtrim(filePath);
                    if isfield(msg, field) && (isempty(filePath) || (isfield(msg, 'filePath') && strcmp(msg.filePath, filePath)))
                        error('matlabls:test:refused', 'Refused a message with the fields %s.', strjoin(fieldnames(msg), ', '));
                    end
                end
            end

            record.msg = msg;
            record.classes = structfun(@class, msg, 'UniformOutput', false);
            fid = fopen(channel, 'a');
            fprintf(fid, '%s\n', jsonencode(record));
            fclose(fid);
        end
    end
end
