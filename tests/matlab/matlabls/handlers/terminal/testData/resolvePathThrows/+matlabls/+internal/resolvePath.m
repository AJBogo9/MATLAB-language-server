function [isFound, resolvedPath] = resolvePath (~, ~) %#ok<STOUT>
    % RESOLVEPATH Stands in for the shipped P-code and fails, as it may for the
    % empty context file that no upstream caller passes.

    % Copyright 2026 Andreas Bogossian

    error('tResolveStackFrame:resolvePathFailed', 'resolvePath failed');
end
