// Copy buttons in the feeds dialog. Where the clipboard is unavailable, the address is selected
// so a reader can copy it themselves.
const said = document.querySelector<HTMLElement>("[data-copied]");

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  button.addEventListener("click", async () => {
    const field = document.getElementById(button.dataset.copy ?? "");
    if (!(field instanceof HTMLInputElement) || !said) return;
    try {
      await navigator.clipboard.writeText(field.value);
      said.textContent = `Copied the ${button.dataset.name} address.`;
    } catch {
      field.select();
      said.textContent = "Selected. Copy it with Ctrl+C, or Cmd+C on a Mac.";
    }
  });
}
