// Shared by the classic content script and the bundled background worker.
globalThis.FAPASSWORD_PAGE_POLICY = Object.freeze({
  allows(url) {
    return url.protocol === "https:" || (url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" || url.hostname.endsWith(".localhost")));
  },
});
