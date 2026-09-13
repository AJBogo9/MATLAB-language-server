function resolvedPath = resolveNameBeforeR2023b (name)
    % RESOLVENAMEBEFORER2023B Finds the file behind a stack frame name on R2023a and
    % earlier, for resolveStackFrame. Returns the path, or '' if there is none.
    %
    % Upstream always passes matlabls.internal.resolvePath the file being edited. A
    % stack frame has no such file, and given '' the P-code resolves '' as a name
    % first, which no upstream caller does. So when it fails or finds nothing,
    % which() answers instead, and only a real file is taken from it: which() also
    % returns "built-in (<path>)" and descriptions such as "x is a variable.".
    %
    % Kept separate from resolveStackFrame so that tests can run it on a later
    % release.

    % Copyright 2026 Andreas Bogossian

    try
        [isFound, resolvedPath] = matlabls.internal.resolvePath(name, '');
        if ~isFound
            resolvedPath = '';
        end
    catch
        resolvedPath = '';
    end

    if isempty(resolvedPath)
        resolvedPath = whichFile(name);
    end
end

function filePath = whichFile (varargin)
    % which() answers "variable" for a name that is a variable of the workspace it
    % is called from, so the name is not given one here.
    filePath = which(varargin{1});
    if ~isfile(filePath)
        filePath = '';
    end
end
