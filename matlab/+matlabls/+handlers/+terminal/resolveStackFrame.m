function resolvedPath = resolveStackFrame (varargin)
    % RESOLVESTACKFRAME Finds the file that defines a frame of a MATLAB stack trace.
    % Takes candidate names from the most to the least specific, for example
    % 'myFile>localFunction' and then 'myFile', and returns the path of the first
    % one that resolves to a file, or '' if none does.
    %
    % Unlike resolveNameToPath it never changes the current folder: there is no
    % context file to change to, and a changed folder would change what the user's
    % next command does.

    % Copyright 2026 Andreas Bogossian

    resolvedPath = '';
    for n = 1:numel(varargin)
        name = char(varargin{n});
        if isempty(name)
            continue
        end

        try
            candidate = resolveName(name);
        catch
            candidate = '';
        end

        if ~isempty(candidate)
            resolvedPath = char(candidate);
            return
        end
    end
end

function resolvedPath = resolveName (name)
    if isMATLABReleaseOlderThan('R2023b')
        % For usage in R2023a and earlier
        [isFound, resolvedPath] = matlabls.internal.resolvePath(name, '');
    elseif isMATLABReleaseOlderThan('R2024a')
        % For usage in R2023b only
        [isFound, resolvedPath] = matlab.internal.language.introspective.resolveFile(name, []);
    elseif isMATLABReleaseOlderThan('R2024b')
        % For usage in R2024a only
        ec = matlab.lang.internal.introspective.ExecutionContext;
        [isFound, resolvedPath] = matlab.lang.internal.introspective.resolveFile(name, ec);
    else
        % For usage in R2024b and later
        ic = matlab.lang.internal.introspective.IntrospectiveContext.caller;
        [isFound, resolvedPath] = matlab.lang.internal.introspective.resolveFile(name, ic);
    end

    if ~isFound
        resolvedPath = '';
    end
end
