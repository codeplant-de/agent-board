import { useMemo } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { remarkLinkRules } from '../lib/linkRules';
import { useLinkRules } from '../lib/linkRulesContext';

/**
 * Agent notes are untrusted (they can quote a PR), so raw HTML is never rendered: react-markdown escapes it
 * unless rehype-raw is added, and it is not. The user's link rules turn matching text into links.
 */
export function Markdown({ children }: { children: string }) {
  const rules = useLinkRules();
  const remarkPlugins = useMemo<Options['remarkPlugins']>(() => [remarkGfm, [remarkLinkRules, { rules }]], [rules]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
