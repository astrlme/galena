// Every `dialog.sheet`: a centred dialog from 640 px, a bottom sheet below. Without this script
// each is a plain section at the end of the page, which its link's #anchor reaches.

// Motion starts a frame after the dialogs exist, so a section turning into a closed dialog never
// fades.
document.documentElement.classList.add("js");
requestAnimationFrame(() => document.documentElement.classList.add("motion"));

for (const sheet of document.querySelectorAll<HTMLDialogElement>("dialog.sheet")) {
  const open = () => {
    if (!sheet.open) sheet.showModal();
  };
  for (const link of document.querySelectorAll(`[data-open="${sheet.id}"]`)) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
  }
  // Other pages link to /#<id>.
  if (location.hash === `#${sheet.id}`) open();
  // A click on the dialog itself, outside its content, is a click on the scrim.
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) sheet.close();
  });
  sheet.querySelector("[data-close]")?.addEventListener("click", () => sheet.close());

  // On phones the sheet follows a finger dragging its handle, and closes past 80 px.
  const grip = sheet.querySelector<HTMLElement>("[data-grip]");
  let start: number | undefined;
  let moved = 0;
  grip?.addEventListener("pointerdown", (event) => {
    if (!matchMedia("(max-width: 639px)").matches) return;
    start = event.clientY;
    moved = 0;
    grip.setPointerCapture(event.pointerId);
    sheet.style.transition = "none";
  });
  grip?.addEventListener("pointermove", (event) => {
    if (start === undefined) return;
    moved = Math.max(0, event.clientY - start);
    sheet.style.transform = `translateY(${moved}px)`;
  });
  const release = () => {
    if (start === undefined) return;
    start = undefined;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (moved > 80) sheet.close();
  };
  grip?.addEventListener("pointerup", release);
  grip?.addEventListener("pointercancel", release);
}
