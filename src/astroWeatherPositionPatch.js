/**
 * God's Eye — Astro Weather placement v4
 *
 * Targets ONLY the separate Astro Weather bar:
 *   ASTRO WEATHER · NORGE ... WX OFF / WX ON ... ▲
 *
 * v4 keeps the transparent look from v3 and raises the complete bar
 * (including WX and arrow controls) so it sits immediately above the
 * LOCATION / microphone / VISUAL PRESETS bottom controls.
 */

const STYLE_ID = 'gev-astro-weather-position-style';
const TARGET_ATTR = 'data-gev-astro-weather-bar-positioned';

function txt(node) {
  return String(node?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function visible(el) {
  if (!(el instanceof HTMLElement)) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width >= 200 && r.height >= 35;
}

function hasAstroWeatherText(el) {
  const t = txt(el);
  return t.includes('ASTRO WEATHER') && t.includes('NORGE');
}

function hasWxControl(el) {
  return [...el.querySelectorAll('button,[role="button"],input,label,span,div')]
    .some((node) => {
      const t = txt(node);
      return t === 'WX OFF' || t === 'WX ON'
        || t.startsWith('WX OFF ') || t.startsWith('WX ON ');
    });
}

function looksLikeExactWeatherBar(el) {
  if (!visible(el) || !hasAstroWeatherText(el) || !hasWxControl(el)) return false;

  if (
    el.id === 'gev-astro-mode-panel'
    || el.id === 'gev-space-launch-mode'
    || el.id === 'gev-weather3d-panel'
    || el.id === 'gev-cinematic-tracking-hud'
  ) return false;

  const t = txt(el);
  const rect = el.getBoundingClientRect();

  if (rect.height > 180) return false;
  if (rect.width > Math.max(1500, window.innerWidth * 0.78)) return false;

  if (
    t.includes('DATA LAYER')
    || t.includes('LIVE FLIGHTS')
    || t.includes('SATELLITES')
    || t.includes('EARTHQUAKES')
    || t.includes('ACTIVE FIRES')
  ) return false;

  return true;
}

function findExactWeatherBar() {
  const nodes = [...document.querySelectorAll('button,[role="button"],span,div')];
  const wxNodes = nodes.filter((node) => {
    const t = txt(node);
    return (t === 'WX OFF' || t === 'WX ON'
      || t.startsWith('WX OFF ') || t.startsWith('WX ON '))
      && visible(node.closest('div,section,aside,header') || node);
  });

  const candidates = [];

  for (const wx of wxNodes) {
    let current = wx instanceof HTMLElement ? wx : wx.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (looksLikeExactWeatherBar(current)) {
        candidates.push(current);
        break;
      }
    }
  }

  if (!candidates.length) {
    for (const el of [...document.querySelectorAll('body div, body section, body aside, body header')]) {
      if (looksLikeExactWeatherBar(el)) candidates.push(el);
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (ar.width * ar.height) - (br.width * br.height);
  });

  return candidates[0];
}

function clearOldPlacement() {
  document.querySelectorAll('[data-gev-astro-weather-positioned="true"]')
    .forEach((el) => el.removeAttribute('data-gev-astro-weather-positioned'));

  document.querySelectorAll(`[${TARGET_ATTR}="true"]`)
    .forEach((el) => el.removeAttribute(TARGET_ATTR));
}

function ensureStyle() {
  document.getElementById(STYLE_ID)?.remove();

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /*
     * Keep the translucent Astro Weather bar, but raise it clear of the
     * built-in bottom controls. Screenshot tuning:
     * v3 = bottom 10px
     * v4 = bottom 82px
     */
    [${TARGET_ATTR}="true"] {
      position: fixed !important;
      right: auto !important;
      left: 50% !important;
      top: auto !important;
      bottom: 82px !important;

      width: min(760px, calc(100vw - 520px)) !important;
      min-width: 560px !important;
      max-width: 900px !important;

      margin: 0 !important;
      transform: translateX(-50%) !important;
      box-sizing: border-box !important;

      z-index: 2044 !important;
    }

    /*
     * Leave WEATHER 3D and LAUNCH MODE where they currently work well.
     */
    #gev-space-launch-button {
      position: fixed !important;
      right: 18px !important;
      left: auto !important;
      top: auto !important;
      bottom: 138px !important;
      z-index: 2060 !important;
    }

    #gev-weather3d-button {
      position: fixed !important;
      right: 18px !important;
      left: auto !important;
      top: auto !important;
      bottom: 182px !important;
      z-index: 2060 !important;
    }

    @media (max-width: 1100px) {
      [${TARGET_ATTR}="true"] {
        left: 50% !important;
        bottom: 88px !important;
        width: min(700px, calc(100vw - 80px)) !important;
        min-width: 0 !important;
        max-width: calc(100vw - 80px) !important;
      }
    }

    @media (max-width: 820px) {
      [${TARGET_ATTR}="true"] {
        left: 50% !important;
        bottom: 92px !important;
        width: calc(100vw - 24px) !important;
        min-width: 0 !important;
        max-width: calc(100vw - 24px) !important;
      }

      #gev-space-launch-button {
        right: 12px !important;
        bottom: 154px !important;
      }

      #gev-weather3d-button {
        right: 12px !important;
        bottom: 198px !important;
      }
    }
  `;
  document.head.appendChild(style);
}

export function initAstroWeatherPositionPatch() {
  clearOldPlacement();
  ensureStyle();

  let panel = null;
  let observer = null;
  let raf = 0;

  function layout() {
    raf = 0;

    if (!panel || !document.body.contains(panel) || !looksLikeExactWeatherBar(panel)) {
      panel?.removeAttribute(TARGET_ATTR);
      panel = findExactWeatherBar();
      if (panel) panel.setAttribute(TARGET_ATTR, 'true');
    }
  }

  function requestLayout() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(layout);
  }

  observer = new MutationObserver(requestLayout);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });

  window.addEventListener('resize', requestLayout);

  requestLayout();
  setTimeout(requestLayout, 150);
  setTimeout(requestLayout, 600);
  setTimeout(requestLayout, 1500);
  setTimeout(requestLayout, 3000);

  return Object.freeze({
    refresh: requestLayout,
    getTarget() { return panel || null; },
    destroy() {
      observer?.disconnect();
      observer = null;
      window.removeEventListener('resize', requestLayout);
      if (raf) cancelAnimationFrame(raf);
      panel?.removeAttribute(TARGET_ATTR);
      document.getElementById(STYLE_ID)?.remove();
      panel = null;
    },
  });
}

export default initAstroWeatherPositionPatch;
