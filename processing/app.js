'use strict';

(() => {
  const data = window.READING_CASE;
  const reader = document.getElementById('reader');
  const content = document.getElementById('content');
  const sourceButton = document.getElementById('source-button');
  const announcement = document.getElementById('announcement');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const words = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  // Torph 0.1.4 groups multiline Chinese into long whitespace-delimited tokens.
  // Explicit word separators keep matching inside Torph; CSS hides the separators.
  const input = text => Array.from(words.segment(text), part => part.segment === ' ' ? '\u2009' : part.segment).join(' ');
  let mode = 'brief';
  let readableMode = 'brief';
  let morph = null;
  let textHost;
  let motionReduced;

  function render() {
    reader.dataset.mode = mode;
    sourceButton.textContent = mode === 'original' ? '返回' : '原文';
    sourceButton.setAttribute('aria-pressed', String(mode === 'original'));
    sourceButton.setAttribute('aria-label', mode === 'original' ? '返回阅读内容' : '查看原文');
    if (mode === 'original') {
      morph?.destroy();
      morph = null;
      content.replaceChildren();
      content.removeAttribute('role');
      content.removeAttribute('tabindex');
      content.removeAttribute('aria-expanded');
      content.removeAttribute('aria-label');
      for (const text of data.original.split(/\n\s*\n/)) {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        content.append(paragraph);
      }
      return;
    }
    content.setAttribute('role', 'button');
    content.tabIndex = 0;
    content.setAttribute('aria-expanded', String(mode === 'interpretation'));
    content.setAttribute('aria-label', mode === 'brief' ? '点击展开解读' : '点击切换简洁版');
    if (morph && motionReduced !== reducedMotion.matches) {
      morph.destroy();
      morph = null;
    }
    if (!morph) {
      textHost = document.createElement('div');
      textHost.className = 'reading-text';
      content.replaceChildren(textHost);
      motionReduced = reducedMotion.matches;
      morph = new Torph.TextMorph({
        element: textHost,
        duration: 620,
        ease: 'cubic-bezier(0.32, 0, 0.18, 1)',
        locale: 'zh-CN',
        numbers: false,
        scale: false,
        respectReducedMotion: true,
      });
    }
    const text = mode === 'brief' ? data.brief : data.interpretation.join('\n\n');
    morph.update(reducedMotion.matches ? text : input(text));
    const accessible = textHost.querySelector('[torph-sr]');
    if (accessible) accessible.textContent = text;
    for (const token of textHost.querySelectorAll('[torph-item]')) {
      if (token.getAttribute('torph-id')?.startsWith('\u2009')) token.textContent = ' ';
    }
  }

  function change(next) {
    mode = next;
    if (mode !== 'original') readableMode = mode;
    render();
    announcement.textContent = mode === 'original' ? '已显示原文' : mode === 'brief' ? '已切换简洁版' : '已展开解读';
  }

  content.addEventListener('click', event => {
    if (event.target.closest('button,a') || mode === 'original' || getSelection()?.toString().trim()) return;
    change(mode === 'brief' ? 'interpretation' : 'brief');
  });
  content.addEventListener('keydown', event => {
    if (event.target !== content || mode === 'original' || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    change(mode === 'brief' ? 'interpretation' : 'brief');
  });
  sourceButton.addEventListener('click', event => {
    event.stopPropagation();
    change(mode === 'original' ? readableMode : 'original');
    sourceButton.focus({ preventScroll: true });
  });
  reducedMotion.addEventListener('change', render);
  render();
})();
