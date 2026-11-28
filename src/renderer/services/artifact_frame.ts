
// The script the app adds to an html artifact before it is displayed (MessageItemHtmlBlock.vue).
//
// The artifact runs in a frame with an opaque origin: the app cannot read its document and it
// cannot read the app's, the two only exchange messages. An opaque origin cannot be named as a
// postMessage target, hence '*' on both sides; each side checks event.source instead.
// The height is reported at fixed moments and not from a ResizeObserver: the app sets the frame
// height from these reports, and a page sized in vh would then grow on every report, without end.
// For the same reason a resize is only reported when the width changed.

export const kFrameHeightMessage = 'witsy-artifact-height'
export const kFrameSnapshotRequestMessage = 'witsy-artifact-snapshot-request'
export const kFrameSnapshotMessage = 'witsy-artifact-snapshot'

/**
 * @param frameId the channel id of the preview: the app ignores the messages that do not carry it
 * @returns the script element to put in the page of the artifact
 */
export const buildFrameBridge = (frameId: string): string => `
<script data-witsy-bridge>
(() => {
  const id = '${frameId}';
  const post = (message) => window.parent.postMessage(message, '*');
  const reportHeight = () => post({ type: '${kFrameHeightMessage}', id, height: document.documentElement.offsetHeight });
  const snapshot = () => {
    const root = document.documentElement.cloneNode(true);
    const canvases = document.querySelectorAll('canvas');
    root.querySelectorAll('canvas').forEach((canvas, index) => {
      try {
        const image = document.createElement('img');
        image.src = canvases[index].toDataURL('image/png');
        image.style.cssText = canvas.style.cssText;
        if (!image.style.width) image.style.width = canvases[index].width + 'px';
        if (!image.style.height) image.style.height = canvases[index].height + 'px';
        canvas.replaceWith(image);
      } catch (e) { /* tainted canvas */ }
    });
    return root.outerHTML;
  };
  let width = window.innerWidth;
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === 'update' && document.body) {
      document.body.innerHTML = event.data.body;
      reportHeight();
    } else if (event.data.type === '${kFrameSnapshotRequestMessage}' && event.data.id === id) {
      post({ type: '${kFrameSnapshotMessage}', id, html: snapshot() });
    }
  });
  window.addEventListener('load', () => {
    reportHeight();
    setTimeout(reportHeight, 100); // what the page renders in its own load handlers
  });
  let resizeTimeout;
  window.addEventListener('resize', () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(reportHeight, 100);
  });
})();
</script>
`

/**
 * Puts the bridge in the head of the page, or right behind the doctype and the html tag when
 * there is no head, so that the page keeps its rendering mode.
 */
export const injectFrameBridge = (htmlContent: string, frameBridge: string): string => {
  const headEndIndex = htmlContent.search(/<\/head\s*>/i)
  if (headEndIndex !== -1) {
    return htmlContent.substring(0, headEndIndex) + frameBridge + htmlContent.substring(headEndIndex)
  }

  // no head: stay behind the doctype and the html tag so the page keeps its rendering mode
  const prefix = htmlContent.match(/^\s*(<!doctype[^>]*>)?\s*(<html[^>]*>)?/i)?.[0] ?? ''
  return prefix + frameBridge + htmlContent.substring(prefix.length)
}
