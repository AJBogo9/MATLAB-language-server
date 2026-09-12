function hoverData = getHoverData(topic)
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

    % --- help text (always assign the output; a bare help(topic) prints into
    % --- the user's command window)
    try
        rawHelp = help(topic);
    catch
        rawHelp = '';
    end

    if ~isempty(rawHelp)
        [hoverData.helpText, hoverData.truncated] = truncateHelp(rawHelp, MAX_LINES);
    end

    % --- which(): overload path and shadowing
    try
        allPaths = which(topic, '-all');
        if ~isempty(allPaths)
            if ischar(allPaths)
                allPaths = {allPaths};
            end
            hoverData.whichPath = allPaths{1};
            hoverData.shadowedBy = detectShadowing(allPaths);
        end
    catch
    end

    % --- signature lines. Preferred over matlab.internal.help.HelpSections,
    % --- whose Syntax and Usages sections come back 1x0 with 8 Invalid entries.
    try
        sigs = matlab.lang.internal.introspective.getSignatures(topic);
        if ~isempty(sigs)
            hoverData.signatures = cellstr(sigs(:));
        end
    catch
    end

    % --- existence and builtin-ness
    try
        resolved = matlab.lang.internal.introspective.resolveName(topic);
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
        if startsWith(url, 'https://www.mathworks.com/')
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
    shadowedBy = '';
    if numel(allPaths) < 2
        return;
    end

    root = matlabroot;
    firstIsUserFile = ~startsWith(allPaths{1}, root);
    if ~firstIsUserFile
        return;
    end

    for k = 2:numel(allPaths)
        if startsWith(allPaths{k}, root)
            shadowedBy = allPaths{1};
            return;
        end
    end
end
