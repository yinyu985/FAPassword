// relay the stored hidePasskeys flag to the MAIN-world guard via a window event (it cant read chrome.storage)
(() => {
  const push = (on) =>
    dispatchEvent(new Event(on ? "fapassword:hide-passkeys-on" : "fapassword:hide-passkeys-off"));
  chrome.storage?.local?.get({ hidePasskeys: false }, (d) => push(!!d.hidePasskeys));
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.hidePasskeys) push(!!changes.hidePasskeys.newValue);
  });
})();
