// The subscribe form works as a plain post. With this script it opens in a dialog (a bottom sheet
// on phones), stays on the page and says what happened in place; when the API can't be reached it
// says so instead of showing an error page.

const sheet = document.querySelector<HTMLDialogElement>("[data-subscribe-sheet]");
const form = document.querySelector<HTMLFormElement>("[data-subscribe]");
const status = form?.querySelector<HTMLElement>("[data-subscribe-status]");

if (sheet) {
  const open = () => {
    if (!sheet.open) sheet.showModal();
  };
  document.querySelector("[data-open-subscribe]")?.addEventListener("click", (event) => {
    event.preventDefault();
    open();
  });
  // Other pages link to /#subscribe.
  if (location.hash === "#subscribe") open();
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

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!status) return;
  const button = form.querySelector("button");
  button?.setAttribute("disabled", "");
  let message = "Couldn't subscribe right now. Try again in a few minutes.";
  try {
    const response = await fetch(form.action, {
      method: "POST",
      body: new URLSearchParams([...new FormData(form)] as [string, string][]),
      headers: { accept: "application/json" },
    });
    if (response.status === 202) {
      message = "Check your inbox for a link to confirm your subscription.";
      form.reset();
    } else if (response.status === 400) {
      message = "That doesn't look like an email address. Check it and try again.";
    }
  } catch {
    // Offline, or the API is down: the page itself still works.
  }
  status.textContent = message;
  button?.removeAttribute("disabled");
});
