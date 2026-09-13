function hoverData = getHoverData(topic, useOldNamespace)
    % GETHOVERDATA Retrieves documentation for a topic, for display in an editor hover.
    %
    % The returned struct deliberately contains no logical values: the language
    % server's MDA parser handles int8..uint64, single, double, string, char,
    % cell and struct, and logs "Unexpected mwtype encountered" for anything
    % else. Flags are therefore doubles.
    %
    % help() is the backbone and is documented and stable. Everything else is an
    % undocumented internal and is individually guarded, so a missing API
    % degrades the card rather than failing the request.
    %
    % useOldNamespace selects the introspection functions MATLAB kept in
    % matlab.internal.language.introspective before R2024a. It defaults to the
    % running release; tests pass it to run that branch on a newer MATLAB.

    % Copyright 2026 Andreas Bogossian

    MAX_LINES = 40;

    hoverData = struct( ...
        'topic', topic, ...
        'helpText', '', ...
        'signatures', {{}}, ...
        'isResolved', 0, ...
        'isBuiltin', 0, ...
        'whichPath', '', ...
        'docUrl', '', ...
        'shadowedBy', '', ...
        'truncated', 0);

    if isempty(topic) || ~ischar(topic) && ~isstring(topic)
        return;
    end
    topic = char(topic);

    if nargin < 2
        useOldNamespace = isMATLABReleaseOlderThan('R2024a');
    end

    % --- help text (always assign the output; a bare help(topic) prints into
    % --- the user's command window)
    try
        rawHelp = help(topic);
    catch
        rawHelp = '';
    end

    % help() does not fail on an unknown name, it fuzzy-matches and prefixes the
    % result with "--- NAME not found. Showing help for OTHER instead. ---".
    % Rendering that verbatim attributes another function's reference page to the
    % hovered symbol, so treat it as no content at all and let the caller fall
    % back to the document.
    isNotFoundBanner = false;
    if ~isempty(rawHelp)
        firstLine = strtrim(strtok(rawHelp, newline));
        isNotFoundBanner = ~isempty(regexp(firstLine, '^---\s+\S+\s+not found\.', 'once'));
    end

    if ~isempty(rawHelp) && ~isNotFoundBanner
        [hoverData.helpText, hoverData.truncated] = truncateHelp(rawHelp, MAX_LINES);
    end

    % --- which(): overload path and shadowing
    try
        allPaths = which(topic, '-all');
        if ~isempty(allPaths)
            if ischar(allPaths)
                allPaths = {allPaths};
            end

            % Drop this language server's own shadow stubs (edit, input, clc,
            % restoredefaultpath). They are on the path by design, so leaving
            % them in made the card show the stub's comment as the function's
            % documentation and accuse the user of shadowing a builtin with a
            % file the extension installed.
            [allPaths, droppedOwnShadow] = filterServerShadows(allPaths);

            if ~isempty(allPaths)
                hoverData.whichPath = allPaths{1};
                hoverData.shadowedBy = detectShadowing(allPaths);

                % The help text came from the stub, so redo it against the real
                % implementation.
                if droppedOwnShadow && ~isNotFoundBanner
                    try
                        realHelp = help(allPaths{1});
                        if ~isempty(strtrim(realHelp))
                            [hoverData.helpText, hoverData.truncated] = truncateHelp(realHelp, MAX_LINES);
                        end
                    catch
                    end
                end
            end
        end
    catch
    end

    % --- signature lines. Preferred over matlab.internal.help.HelpSections,
    % --- whose Syntax and Usages sections come back 1x0 with 8 Invalid entries.
    % --- R2024a moved these functions to matlab.lang.internal, as in
    % --- resolveNameToPath. R2026a's getSignatures is dated 2024, where the
    % --- renamed functions keep older years, so the old name may not exist.
    try
        if useOldNamespace
            sigs = matlab.internal.language.introspective.getSignatures(topic);
        else
            sigs = matlab.lang.internal.introspective.getSignatures(topic);
        end
        if ~isempty(sigs)
            hoverData.signatures = cellstr(sigs(:));
        end
    catch
    end

    % --- existence and builtin-ness
    try
        if useOldNamespace
            resolved = matlab.internal.language.introspective.resolveName(topic);
        else
            resolved = matlab.lang.internal.introspective.resolveName(topic);
        end
        hoverData.isResolved = double(resolved.isResolved);
        if isprop(resolved, 'isBuiltin') || isfield(resolved, 'isBuiltin')
            hoverData.isBuiltin = double(resolved.isBuiltin);
        end
    catch
    end

    % --- documentation URL. getHelpPopupUrl never fails, even for a nonexistent
    % --- name, and returns a per-session https://127.0.0.1:<rotating port>/ URL
    % --- for user files and for licensed-but-not-installed toolboxes. Only a
    % --- real mathworks.com URL is useful in a hover card, so allowlist it.
    try
        url = matlab.internal.doc.reference.getHelpPopupUrl(topic);
        url = char(url);
        if startsWith(url, 'https://www.mathworks.com/') && ~isNotFoundBanner
            hoverData.docUrl = url;
        end
    catch
    end
end

function [text, wasTruncated] = truncateHelp(rawHelp, maxLines)
    % Truncating here rather than in TypeScript keeps the payload small.
    % Measured worst cases are timetable at 12000 chars / 253 lines and table at
    % 9517 / 209, and a multi-kilobyte char return is the least-exercised path
    % through the MVM transport.
    wasTruncated = 0;
    lines = strsplit(rawHelp, newline);

    % Drop the "--- help for MATLAB keyword X ---" banner if present.
    if ~isempty(lines) && startsWith(strtrim(lines{1}), '--- help for')
        lines = lines(2:end);
    end

    % Cut at the Examples heading: examples are long and are the least useful
    % part of a tooltip.
    for k = 1:numel(lines)
        if strcmp(strtrim(lines{k}), 'Examples')
            lines = lines(1:k-1);
            wasTruncated = 1;
            break;
        end
    end

    if numel(lines) > maxLines
        lines = lines(1:maxLines);
        wasTruncated = 1;
    end

    while ~isempty(lines) && isempty(strtrim(lines{end}))
        lines(end) = [];
    end

    text = strjoin(lines, newline);
end

function shadowedBy = detectShadowing(allPaths)
    % help() lists overloads itself ("Other uses of plot"), so the only
    % non-redundant thing which(-all) adds is detecting that a file on the user's
    % path shadows a toolbox function. help will never tell you that.
    %
    % Entries must be normalized first. which('-all') returns three shapes and
    % only one of them is a bare path, so comparing raw strings against
    % matlabroot inverts the test: a compiled builtin comes back as
    % "built-in (/usr/local/MATLAB/R2026a/toolbox/.../plot)", which does not
    % start with matlabroot, so it was read as a user file and nearly every
    % builtin with an overload reported itself as shadowed.
    shadowedBy = '';
    if numel(allPaths) < 2
        return;
    end

    root = matlabroot;
    first = normalizeWhichEntry(allPaths{1});

    % A built-in wrapper, a bare description, or anything under matlabroot is by
    % definition not a user file.
    if isempty(first) || startsWith(first, root)
        return;
    end

    for k = 2:numel(allPaths)
        entry = normalizeWhichEntry(allPaths{k});
        if ~isempty(entry) && startsWith(entry, root)
            shadowedBy = first;
            return;
        end
    end
end

function [kept, droppedOwnShadow] = filterServerShadows(allPaths)
    % This file lives at <root>/matlab/+matlabls/+handlers/+hover/getHoverData.m,
    % so four fileparts hops reach <root>/matlab, the folder added to the MATLAB
    % path by MatlabSession and the parent of the shadows/ stubs.
    serverMatlabRoot = fileparts(fileparts(fileparts(fileparts(mfilename('fullpath')))));

    keepMask = true(1, numel(allPaths));
    for k = 1:numel(allPaths)
        entry = normalizeWhichEntry(allPaths{k});
        if ~isempty(entry) && startsWith(entry, serverMatlabRoot)
            keepMask(k) = false;
        end
    end

    droppedOwnShadow = ~keepMask(1);
    kept = allPaths(keepMask);
end

function p = normalizeWhichEntry(entry)
    % which('-all') returns a plain path, a "built-in (<path>)" wrapper, or a
    % bare description such as "disp is a built-in method". Only the first two
    % carry a path; a description must never be mistaken for a user file.
    p = strtrim(char(entry));

    if startsWith(p, 'built-in (') && endsWith(p, ')')
        p = p(numel('built-in (') + 1:end - 1);
    elseif ~(startsWith(p, filesep) || ~isempty(regexp(p, '^[A-Za-z]:[\\/]', 'once')))
        p = '';
    end
end
