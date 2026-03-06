import { useRef, useLayoutEffect, useEffect } from 'react';

interface TokenEditorProps {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
}

function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toHTML(text: string): string {
  const parts = text.split(/(\$\{[^}]+\})/g);
  return parts.map(part => {
    const match = part.match(/^\$\{([^}]+)\}$/);
    if (match) {
      const name = escapeHTML(match[1]);
      return `<span class="te-token" data-token="${name}" contenteditable="false">\${${name}}</span>`;
    }
    return escapeHTML(part).replace(/\n/g, '<br>');
  }).join('');
}

function fromHTML(el: HTMLElement): string {
  let result = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent ?? '';
    } else if (node instanceof HTMLElement) {
      if (node.classList.contains('te-token')) {
        result += `\${${node.dataset.token}}`;
      } else if (node.tagName === 'BR') {
        result += '\n';
      } else if (node.tagName === 'DIV' || node.tagName === 'P') {
        result += fromHTML(node) + '\n';
      } else {
        result += fromHTML(node);
      }
    }
  }
  return result;
}

function getTextOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let current = walker.nextNode();

  while (current) {
    if (current === range.startContainer) {
      if (current.nodeType === Node.TEXT_NODE) {
        return offset + range.startOffset;
      }
      if (current instanceof HTMLElement && current.classList.contains('te-token')) {
        return offset + Math.min(range.startOffset, current.textContent?.length ?? 0);
      }
      return offset;
    }

    if (current.nodeType === Node.TEXT_NODE) {
      offset += current.textContent?.length ?? 0;
    } else if (current instanceof HTMLElement) {
      if (current.classList.contains('te-token')) {
        offset += current.textContent?.length ?? 0;
        walker.currentNode = current;
      } else if (current.tagName === 'BR') {
        offset += 1;
      }
    }

    current = walker.nextNode();
  }

  return offset;
}

function setTextOffset(root: HTMLElement, targetOffset: number | null): void {
  if (targetOffset === null) return;
  const selection = window.getSelection();
  if (!selection) return;

  let remaining = targetOffset;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let current = walker.nextNode();

  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const length = current.textContent?.length ?? 0;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStart(current, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= length;
    } else if (current instanceof HTMLElement) {
      if (current.classList.contains('te-token')) {
        const length = current.textContent?.length ?? 0;
        if (remaining <= length) {
          const parent = current.parentNode;
          if (!parent) return;
          const index = Array.from(parent.childNodes).indexOf(current);
          const range = document.createRange();
          range.setStart(parent, remaining === 0 ? index : index + 1);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        remaining -= length;
        walker.currentNode = current;
      } else if (current.tagName === 'BR') {
        if (remaining <= 1) {
          const parent = current.parentNode;
          if (!parent) return;
          const index = Array.from(parent.childNodes).indexOf(current);
          const range = document.createRange();
          range.setStart(parent, index + 1);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        remaining -= 1;
      }
    }

    current = walker.nextNode();
  }

  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function TokenEditor({ value, onChange, onBlur, placeholder, className, readOnly }: TokenEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastExternal = useRef(value);

  const renderValue = (nextValue: string, preserveSelection: boolean) => {
    if (!editorRef.current) return;
    const selectionOffset = preserveSelection ? getTextOffset(editorRef.current) : null;
    const html = toHTML(nextValue);
    if (editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html;
      if (preserveSelection) {
        setTextOffset(editorRef.current, selectionOffset);
      }
    }
  };

  useLayoutEffect(() => {
    renderValue(value, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (value !== lastExternal.current && editorRef.current) {
      lastExternal.current = value;
      renderValue(value, false);
    }
  }, [value]);

  const handleInput = () => {
    const text = fromHTML(editorRef.current!);
    renderValue(text, true);
    lastExternal.current = text;
    onChange(text);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
    }
  };

  return (
    <div
      ref={editorRef}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      className={className}
      data-placeholder={placeholder}
      onInput={handleInput}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onBlur={onBlur}
    />
  );
}

export default TokenEditor;
