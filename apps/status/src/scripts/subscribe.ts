// The subscribe form works as a plain post. With this script (and sheet.ts, which opens it in a
// dialog) it stays on the page and says what happened in place; when the API can't be reached it
// says so instead of showing an error page.
const form = document.querySelector<HTMLFormElement>("[data-subscribe]");
const status = form?.querySelector<HTMLElement>("[data-subscribe-status]");

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
