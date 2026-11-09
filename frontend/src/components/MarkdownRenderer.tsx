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

// Custom code block renderer with language banner & copy button
markedInstance.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || 'code').trim();
      const encodedCode = encodeURIComponent(text);
      return `
        <div class="my-3 rounded-xl bg-[#0F172A] text-slate-100 overflow-hidden shadow-sm border border-slate-700/80">
          <div class="flex items-center justify-between px-3.5 py-1.5 bg-slate-900 border-b border-slate-700/80 text-[11px] text-slate-300 font-mono">
            <span class="uppercase font-semibold tracking-wider text-violet-400">${language}</span>
            <button
              type="button"
              data-copy-code="${encodedCode}"
              class="hover:text-white flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors text-slate-300 text-xs cursor-pointer"
              title="Copy snippet"
            >
              <span class="material-symbols-outlined text-[13px]">content_copy</span>
              <span>Copy</span>
            </button>
          </div>
          <pre class="p-3.5 text-xs font-mono overflow-x-auto text-slate-200 leading-relaxed whitespace-pre"><code>${escapeHtml(text)}</code></pre>
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
