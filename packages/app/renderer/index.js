// Placeholder renderer script: call the bridge once and print what the daemon said.
const status = document.getElementById("status");
const out = document.getElementById("hello");
window.orca.hello().then((r) => {
  status.textContent = r.ok ? "Connected." : `Not connected: ${r.error.code}`;
  out.textContent = JSON.stringify(r, null, 2);
});
