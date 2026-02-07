(async () => {
  const mdEl = document.getElementById('md');
  const titleEl = document.getElementById('title');
  const metaEl = document.getElementById('meta');
  const linkEl = document.getElementById('videolink');
  const copiedEl = document.getElementById('copied');

  const data = (await chrome.storage.local.get(['lastResult']))?.lastResult;
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
    try {
      await navigator.clipboard.writeText(mdEl.value);
      copiedEl.style.display = 'block';
      setTimeout(() => (copiedEl.style.display = 'none'), 2000);
    } catch (e) {
      alert("Failed to copy automatically. You can select all (Ctrl/Cmd+A) and copy manually.");
    }
  });
})();
