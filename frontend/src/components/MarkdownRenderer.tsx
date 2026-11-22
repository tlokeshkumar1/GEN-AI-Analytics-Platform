import React, { useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  onCodeCopy?: (code: string) => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Create dedicated marked instance with custom extensions
const markedInstance = new Marked({
  gfm: true,
  breaks: true,
});

// Custom code block renderer with Astryx styling, language banner & copy button
markedInstance.use({
  renderer: {
    table(token) {
      const header = token.header.map(cell => `<th scope="col">${this.parser.parseInline(cell.tokens)}</th>`).join('');
      const rows = token.rows.map(row => `<tr>${row.map(cell => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`).join('');
      return `<div class="markdown-table-scroll" role="region" aria-label="Response table" tabindex="0"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
    code({ text, lang }) {
      const language = (lang || 'code').trim();
      const encodedCode = encodeURIComponent(text);
      return `
        <div class="my-2.5 rounded-[var(--radius-element)] bg-[#18181B] text-zinc-100 overflow-hidden shadow-[var(--shadow-xs)] border border-zinc-800">
          <div class="flex items-center justify-between px-3 py-1.5 bg-[#09090B] border-b border-zinc-800 text-[11px] text-zinc-400 font-mono">
            <span class="uppercase font-semibold tracking-wider text-[var(--color-ai)]">${escapeHtml(language)}</span>
            <button
              type="button"
              data-copy-code="${encodedCode}"
              class="hover:text-white flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-inner)] hover:bg-zinc-800 transition-colors text-zinc-300 text-xs cursor-pointer"
              title="Copy snippet"
            >
              <span class="material-symbols-outlined text-[13px]">content_copy</span>
              <span>Copy</span>
            </button>
          </div>
          <pre class="p-3 text-xs font-mono overflow-x-auto text-zinc-200 leading-relaxed whitespace-pre"><code>${escapeHtml(text)}</code></pre>
        </div>
      `;
    },
  },
});

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className = '',
  onCodeCopy,
}) => {
  const sanitizedHtml = useMemo(() => {
    if (!content) return '';
    try {
      const raw = markedInstance.parse(content, { async: false }) as string;
      // Allow tables, pre, code, and custom data attributes while sanitizing
      return DOMPurify.sanitize(raw, {
        ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ADD_ATTR: ['target', 'rel', 'data-copy-code'],
      });
    } catch (err) {
      console.warn('Markdown parsing error:', err);
      return escapeHtml(content);
    }
  }, [content]);

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest('button[data-copy-code]') as HTMLButtonElement | null;
    if (copyBtn) {
      e.stopPropagation();
      const rawEncoded = copyBtn.getAttribute('data-copy-code') || '';
      const code = decodeURIComponent(rawEncoded);
      if (code && navigator.clipboard) {
        navigator.clipboard.writeText(code);
        onCodeCopy?.(code);
        const originalContent = copyBtn.innerHTML;
        copyBtn.innerHTML = `
          <span class="material-symbols-outlined text-[13px] text-emerald-400">check</span>
          <span class="text-emerald-400 font-medium">Copied!</span>
        `;
        setTimeout(() => {
          copyBtn.innerHTML = originalContent;
        }, 2000);
      }
    }
  };

  return (
    <div
      onClick={handleContainerClick}
      className={`markdown-content ${className}`}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
};

export default MarkdownRenderer;
