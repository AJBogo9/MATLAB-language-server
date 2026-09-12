function genOperatorHelp(outFile)
    % GENOPERATORHELP Dumps MATLAB's keyword and operator help as JSON.
    %
    % Feeds build/genOperatorHelp.js, which turns the JSON into
    % src/providers/hover/OperatorHelp.ts. Regenerate when targeting a new
    % MATLAB release.

    % iskeyword() returns only reserved words. The block keywords below are
    % context-sensitive and are absent from it, yet they are among the most
    % common things a MATLAB author hovers, so add them explicitly.
    contextKeywords = {'arguments', 'properties', 'methods', 'events', ...
                       'enumeration', 'import'};

    operators = {'+','-','*','/','\','^','.*','./','.\','.^','''','.''', ...
                 '==','~=','<','>','<=','>=','&&','||','&','|','~', ...
                 ':','...','@','=','[]','{}','()','.'};

    keywords = [iskeyword(); contextKeywords(:)];

    entries = struct('topic', {}, 'isKeyword', {}, 'text', {});
    n = 0;
    seen = containers.Map();

    for k = 1:numel(keywords)
        [n, entries, seen] = addTopic(keywords{k}, 1, n, entries, seen);
    end
    for k = 1:numel(operators)
        [n, entries, seen] = addTopic(operators{k}, 0, n, entries, seen);
    end

    fprintf('COUNT=%d\n', n);
    fid = fopen(outFile, 'w');
    fwrite(fid, jsonencode(entries));
    fclose(fid);
end

function [n, entries, seen] = addTopic(topic, isKeyword, n, entries, seen)
    if isKey(seen, topic)
        return;
    end
    try
        h = help(topic);
    catch
        h = '';
    end
    if isempty(strtrim(h))
        return;
    end
    seen(topic) = true; %#ok<NASGU>
    n = n + 1;
    entries(n).topic = topic;
    entries(n).isKeyword = double(isKeyword);
    entries(n).text = strtrim(h);
end
