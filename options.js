const modelEl = document.getElementById('model');
const msgEl = document.getElementById('msg');

async function load() {
	const data = await chrome.storage.local.get(["model"]);
	modelEl.value = data.model || "gpt-4o-mini";
}

document.getElementById('save').addEventListener('click', async () => {
	await chrome.storage.local.set({ model: modelEl.value.trim() || "gpt-4o-mini" });
	msgEl.textContent = "Saved!";
	setTimeout(()=> msgEl.textContent = "", 1500);
});

load();


