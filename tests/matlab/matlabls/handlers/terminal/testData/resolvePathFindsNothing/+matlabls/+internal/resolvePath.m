function [isFound, resolvedPath] = resolvePath (~, ~)
    % RESOLVEPATH Stands in for the shipped P-code and finds nothing, as it may
    % for the empty context file that no upstream caller passes. It still returns
    % a path, which only isFound says to ignore.

    % Copyright 2026 Andreas Bogossian

    isFound = false;
    resolvedPath = '/resolvePathDouble/notFound.m';
end
