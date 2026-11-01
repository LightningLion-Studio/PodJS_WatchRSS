/**
 * Returns Douyin's login QR data image while the simple scan screen is active.
 * Verification flows deliberately return null so the interactive page remains visible.
 */
export const DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT = `
(function() {
 try {
  const secondVerify = document.getElementById('uc-second-verify');
  if (secondVerify && secondVerify.tagName.toLowerCase() === 'div') return null;

  const allImages = document.querySelectorAll('img');
  for (const img of allImages) {
    if (img.getAttribute('aria-label') !== '二维码') continue;
    const src = img.getAttribute('src');
    if (src && src.startsWith('data:image/jpeg;base64,')) return null;
  }
  for (const img of allImages) {
    if (img.getAttribute('aria-label') !== '二维码') continue;
    const src = img.getAttribute('src');
    if (src && src.startsWith('data:image/png;base64,')) return src;
  }
  return null;
 } catch (_) { return null; }
})();
`
