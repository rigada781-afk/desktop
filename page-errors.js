// ─── Server error pages ──────────────────────────────────────────────────────
// The site answered a page with a server error (5xx) and a page that isn't
// its own: the proxy's or Cloudflare's, with no title bar, so the frameless
// window could no longer be moved, reduced or closed. `onForeignErrorPage`
// then gets its address (main.js shows offline.html?reason=server). The
// site's own error pages are left alone: they keep their title bar (its error
// boundaries) and are told apart by Next's flight data or the frame's
// data-app attribute.

const IS_SITE_PAGE =
  "typeof self.__next_f !== 'undefined' || document.documentElement.hasAttribute('data-app')";

/**
 * @param {Electron.WebContents} contents
 * @param {{ appUrl: string, onForeignErrorPage: (url: string, status: number) => void }} options
 * @returns {() => void} stops watching
 */
function watchServerErrorPages(contents, { appUrl, onForeignErrorPage }) {
  let lastStatus = 0;
  const onNavigate = (_event, _url, httpResponseCode) => {
    lastStatus = httpResponseCode;
  };
  const onLoad = () => {
    const status = lastStatus;
    if (status < 500 || contents.isDestroyed()) return;
    const url = contents.getURL();
    if (!url.startsWith(appUrl)) return;
    contents
      .executeJavaScript(IS_SITE_PAGE, true)
      .then((isSitePage) => {
        if (!isSitePage && !contents.isDestroyed()) onForeignErrorPage(url, status);
      })
      .catch(() => {});
  };
  contents.on("did-navigate", onNavigate);
  contents.on("did-finish-load", onLoad);
  return () => {
    contents.off("did-navigate", onNavigate);
    contents.off("did-finish-load", onLoad);
  };
}

module.exports = { watchServerErrorPages };
