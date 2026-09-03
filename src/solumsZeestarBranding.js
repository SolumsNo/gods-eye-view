/**
 * Solums Skynet Spysat branding patch for God's Eye View.
 *
 * Rebrands the UI to:
 *   SOLUMS SKYNET SPYSAT · LEVEL 114534345,6
 *   ASTRO · AIR · SEA · SPACE
 *
 * It also swaps the little turquoise globe motif for a neon eye icon when it
 * can find the original brand row. If it cannot, it adds a tasteful fallback
 * top-left brand badge so the rebrand is still visible.
 */

const STYLE_ID = 'solums-zeestar-brand-style';
const FALLBACK_BADGE_ID = 'solums-zeestar-brand-badge';

const BRAND_TITLE = 'SOLUMS SKYNET SPYSAT · LEVEL 114534345,6';
const BRAND_SUBTITLE = 'ASTRO · AIR · SEA · SPACE';
const WINDOW_TITLE = 'Solums Skynet Spysat · Level 114534345,6';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[c]));
}

function normalizedText(node) {
  return String(node?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function isVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 20 && r.height > 10;
}

function eyeSvgMarkup() {
  return `
    <svg viewBox="0 0 96 64" aria-hidden="true" class="solums-zeestar-eye-svg">
      <defs>
        <filter id="solumsZeestarGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="2.8" result="b"/>
          <feMerge>
            <feMergeNode in="b"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <g filter="url(#solumsZeestarGlow)">
        <path d="M6 32 C18 12, 34 6, 48 6 C62 6, 78 12, 90 32 C78 52, 62 58, 48 58 C34 58, 18 52, 6 32Z"
          fill="rgba(17,34,46,.25)" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/>
        <circle cx="48" cy="32" r="14" fill="none" stroke="currentColor" stroke-width="3.0"/>
        <circle cx="48" cy="32" r="5.5" fill="currentColor"/>
        <path d="M48 15 L48 49 M31 32 L65 32" stroke="currentColor" stroke-width="1.5" opacity=".72"/>
        <circle cx="60" cy="20" r="2.4" fill="#ffffff" opacity=".92"/>
      </g>
    </svg>`;
}

function ensureStyles() {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .solums-zeestar-brand-text {
      display:flex !important;
      align-items:center;
      gap:10px;
      white-space:nowrap;
      min-width:0;
    }
    .solums-zeestar-eye {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      width:30px;
      height:22px;
      color:#5feaff;
      flex:0 0 auto;
      text-shadow:0 0 16px rgba(95,234,255,.42);
      filter:drop-shadow(0 0 8px rgba(95,234,255,.30));
    }
    .solums-zeestar-eye-svg {
      width:100%;
      height:100%;
      display:block;
    }
    .solums-zeestar-lines {
      display:flex;
      flex-direction:column;
      min-width:0;
      line-height:1.02;
    }
    .solums-zeestar-title {
      color:#dffbff;
      font-weight:800;
      letter-spacing:.18em;
      text-transform:uppercase;
      font-size:11px;
      text-shadow:0 0 12px rgba(95,234,255,.10);
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .solums-zeestar-subtitle {
      margin-top:4px;
      color:rgba(116,232,255,.88);
      letter-spacing:.16em;
      text-transform:uppercase;
      font-size:8px;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }

    #${FALLBACK_BADGE_ID} {
      position:fixed;
      left:16px;
      top:14px;
      z-index:2085;
      display:flex;
      align-items:center;
      gap:10px;
      padding:10px 12px;
      border-radius:12px;
      border:1px solid rgba(90,220,255,.26);
      background:
        radial-gradient(circle at 14% 20%, rgba(49,156,198,.16), transparent 32%),
        linear-gradient(180deg, rgba(5,13,22,.86), rgba(4,9,15,.82));
      backdrop-filter: blur(12px);
      box-shadow: 0 12px 30px rgba(0,0,0,.28), inset 0 0 18px rgba(90,220,255,.04);
      max-width:min(540px, calc(100vw - 26px));
      pointer-events:none;
    }
    #${FALLBACK_BADGE_ID}[hidden] { display:none !important; }
    #${FALLBACK_BADGE_ID} .solums-zeestar-eye {
      width:38px; height:28px;
    }
    #${FALLBACK_BADGE_ID} .solums-zeestar-title {
      font-size:12px;
    }
    #${FALLBACK_BADGE_ID} .solums-zeestar-subtitle {
      font-size:8px;
    }
    @media (max-width: 820px) {
      #${FALLBACK_BADGE_ID} {
        left:10px; top:10px; max-width:calc(100vw - 20px);
      }
      #${FALLBACK_BADGE_ID} .solums-zeestar-title {
        font-size:10px;
      }
    }
  `;
  document.head.appendChild(style);
}

function brandMarkup() {
  return `
    <span class="solums-zeestar-eye">${eyeSvgMarkup()}</span>
    <span class="solums-zeestar-lines">
      <span class="solums-zeestar-title">${escapeHtml(BRAND_TITLE)}</span>
      <span class="solums-zeestar-subtitle">${escapeHtml(BRAND_SUBTITLE)}</span>
    </span>`;
}

function likelyBrandContainer(el) {
  if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
  const text = normalizedText(el);
  if (!text) return false;
  const hasGodsEye = (
    text.includes("GOD'S EYE")
    || text.includes('GODS EYE')
    || text.includes("GOD'S EYE VIEW")
    || text.includes('GODS EYE VIEW')
  );
  if (!hasGodsEye) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 60 || rect.width > window.innerWidth * 0.65) return false;
  if (rect.height > 180) return false;

  // Avoid catching giant app panels that merely contain the text somewhere deep.
  const directText = normalizedText(el).length;
  const descendantCount = el.querySelectorAll('*').length;
  if (descendantCount > 90) return false;
  if (directText > 220) return false;

  return true;
}

function findBestBrandContainer() {
  const all = [...document.querySelectorAll('body *')]
    .filter((el) => likelyBrandContainer(el))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });

  return all[0] || null;
}

function replaceBrandIn(container) {
  if (!(container instanceof HTMLElement)) return false;
  if (container.dataset.solumsZeestarBranded === 'true') return true;

  // Hide small original globe-ish media if present.
  const medias = container.querySelectorAll('svg, img, canvas');
  medias.forEach((node) => {
    const r = node.getBoundingClientRect();
    if (r.width <= 40 && r.height <= 40) {
      node.style.display = 'none';
    }
  });

  container.dataset.solumsZeestarOriginalHtml ??= container.innerHTML;
  container.classList.add('solums-zeestar-brand-text');
  container.innerHTML = brandMarkup();
  container.dataset.solumsZeestarBranded = 'true';
  return true;
}

function ensureFallbackBadge() {
  let badge = document.getElementById(FALLBACK_BADGE_ID);
  if (!badge) {
    badge = document.createElement('div');
    badge.id = FALLBACK_BADGE_ID;
    badge.hidden = true;
    badge.innerHTML = brandMarkup();
    document.body.appendChild(badge);
  }
  return badge;
}

function patchTextsInPlace() {
  const phrases = [
    "God's Eye View",
    "Gods Eye View",
    "God's Eye",
    "Gods Eye",
  ];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    const value = String(current.nodeValue || '');
    if (!value.trim()) continue;
    if (phrases.some((p) => value.includes(p))) nodes.push(current);
  }
  for (const textNode of nodes) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest('.solums-zeestar-brand-text, #' + FALLBACK_BADGE_ID)) continue;
    const next = phrases.reduce((acc, phrase) => acc.replaceAll(phrase, 'Solums Skynet Spysat'), textNode.nodeValue);
    textNode.nodeValue = next;
  }
}

export function initSolumsZeestarBranding() {
  ensureStyles();
  const badge = ensureFallbackBadge();
  let observer = null;
  let raf = 0;
  let brandedContainer = null;

  function applyBranding() {
    raf = 0;
    document.title = WINDOW_TITLE;

    const container = findBestBrandContainer();
    if (container) {
      replaceBrandIn(container);
      badge.hidden = true;
      brandedContainer = container;
    } else {
      badge.hidden = false;
      brandedContainer = null;
    }

    // Also rename any lingering plain-text occurrences.
    patchTextsInPlace();
  }

  function requestApply() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(applyBranding);
  }

  observer = new MutationObserver(requestApply);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });

  requestApply();
  setTimeout(requestApply, 150);
  setTimeout(requestApply, 700);
  setTimeout(requestApply, 1800);

  return Object.freeze({
    refresh: requestApply,
    getTitle() { return BRAND_TITLE; },
    destroy() {
      observer?.disconnect();
      observer = null;
      if (raf) cancelAnimationFrame(raf);
      badge?.remove();
      document.getElementById(STYLE_ID)?.remove();
      if (brandedContainer?.dataset?.solumsZeestarOriginalHtml) {
        brandedContainer.innerHTML = brandedContainer.dataset.solumsZeestarOriginalHtml;
        delete brandedContainer.dataset.solumsZeestarOriginalHtml;
        delete brandedContainer.dataset.solumsZeestarBranded;
      }
    },
  });
}

export default initSolumsZeestarBranding;
