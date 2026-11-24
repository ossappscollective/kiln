// A "Copy" button on every code block.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function initCopy() {
  for (const block of document.querySelectorAll('.code-block')) {
    const code = block.querySelector('code');
    if (!code || block.querySelector('.copy-btn')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    let timer;
    button.addEventListener('click', async () => {
      const ok = await copyText(code.textContent ?? '');
      button.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      button.dataset.state = ok ? 'done' : '';
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = 'Copy';
        button.dataset.state = '';
      }, 1800);
    });
    block.append(button);
  }
}
