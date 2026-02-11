(async () => {
  const mdEl = document.getElementById('md');
  const titleEl = document.getElementById('title');
  const metaEl = document.getElementById('meta');
  const linkEl = document.getElementById('videolink');
  const copiedEl = document.getElementById('copied');

  const data = (await chrome.storage.local.get(['lastResult']))?.lastResult;

  async function copyTextareaValue(textareaEl) {
    const text = textareaEl?.value || "";
    if (!text) return false;

    textareaEl.focus();
    textareaEl.select();
    textareaEl.setSelectionRange(0, text.length);

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      }
    }
  }

  if (!data) {
    titleEl.textContent = "No recent result found";
    mdEl.value = "Run the extension on a YouTube video to generate a note.";
    return;
  }

  titleEl.textContent = data.title ? `Note Ready: ${data.title}` : "Note Ready";
  metaEl.textContent = `${data.date} ${data.time}` + (data.channel ? `  •  ${data.channel}` : "");
  if (data.url) {
    const a = document.createElement('a');
    a.href = data.url; a.textContent = 'Open original video'; a.target = '_blank'; a.rel = 'noopener noreferrer';
    linkEl.innerHTML = '';
    linkEl.appendChild(a);
  }

  mdEl.value = data.markdown || "";

  document.getElementById('copy').addEventListener('click', async () => {
    const copied = await copyTextareaValue(mdEl);
    if (copied) {
      copiedEl.style.display = 'block';
      setTimeout(() => (copiedEl.style.display = 'none'), 2000);
    } else {
      alert("Failed to copy automatically. You can select all (Ctrl/Cmd+A) and copy manually.");
    }
  });
})();
