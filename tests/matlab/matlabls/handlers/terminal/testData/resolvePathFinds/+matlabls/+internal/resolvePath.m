function [isFound, resolvedPath] = resolvePath (name, contextFile)
    % RESOLVEPATH Stands in for the shipped P-code and answers with a path no file
    % has, so a test can tell its answer from the one which() gives. It fails for
    % any call but a name with no context file.

    % Copyright 2026 Andreas Bogossian

    assert(ischar(name) && ~isempty(name) && ischar(contextFile) && isempty(contextFile), ...
        'tResolveStackFrame:unexpectedCall', 'resolvePath was called with a context file');
    isFound = true;
    resolvedPath = ['/resolvePathDouble/' name '.m'];
end
