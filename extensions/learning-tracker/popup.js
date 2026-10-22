const state = document.querySelector("#state");
const detail = document.querySelector("#detail");
const error = document.querySelector("#error");
const pause = document.querySelector("#pause");
const options = document.querySelector("#options");

function show(status) {
  if (!status?.ok) {
    state.textContent = "Could not read the tracker.";
    error.hidden = false;
    error.textContent = status?.error || "Unknown error.";
    return;
  }
  error.hidden = !status.lastError;
  error.textContent = status.lastError || "";
  if (!status.signedIn) {
    state.textContent = "Not signed in.";
  } else if (status.paused) {
    state.textContent = "Paused.";
  } else if (status.tracked) {
    const where = [status.tracked.siteLabel, status.tracked.courseLabel, status.tracked.lessonLabel]
      .filter(Boolean)
      .join(" · ");
    state.textContent = `Tracking ${where}`;
  } else {
    state.textContent = "Not on a tracked site.";
  }
  const queued = status.queued > 0 ? `${status.queued} waiting to send.` : "Nothing waiting to send.";
  const count = Array.isArray(status.sites) ? status.sites.length : 0;
  detail.textContent = `${count === 1 ? "1 site" : `${count} sites`} on the list. ${queued}`;
  pause.textContent = status.paused ? "Resume" : "Pause";
  pause.dataset.paused = status.paused ? "true" : "false";
}

function load() {
  chrome.runtime.sendMessage({ type: "getStatus" }, show);
}

pause.addEventListener("click", () => {
  pause.disabled = true;
  chrome.runtime.sendMessage({ type: "setPaused", paused: pause.dataset.paused !== "true" }, (status) => {
    pause.disabled = false;
    show(status);
  });
});

options.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

load();
