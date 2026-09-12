function completionsData = getCompletions(code, fileName, cursorPosition)
    % GETCOMPLETIONS Retrieves the data for the possible completions at the cursor position in the given code.

    % Copyright 2025 The MathWorks, Inc.
    [~, ~, ext] = fileparts(fileName);
    if ~isempty(fileName) && ~strcmpi(ext, '.m')
        % Expected .m file extension
        error('MATLAB:vscode:invalidFileExtension', 'The provided file must have a .m extension to process completions.');
    end

    completionResultsStr = matlabls.internal.getCompletionsData(code, fileName, cursorPosition);
    completionsData = filterCompletionResults(completionResultsStr);
end

function compResultsStruct = filterCompletionResults (completionResultsStr)
    completionResults = jsondecode(completionResultsStr);

    compResultsStruct = struct;
    % "shared" carries the global completion list that applies regardless of
    % which argument the cursor is in. Dropping it loses real completions:
    % typing noDocArgs(1,M offers only "Method", because the 344 shared choices
    % (magic, makehgtform, makima, mapreduce, ...) never reach the client.
    propsToKeep = ["widgetData", "widgetType", "signatures", "shared"];

    for prop = propsToKeep
        if isfield(completionResults, prop)
            compResultsStruct.(prop) = completionResults.(prop);
        end
    end
end
