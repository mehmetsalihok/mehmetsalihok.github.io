/* Keep menu scroll position when navigating between static GitHub Pages. */
(() => {
 'use strict';
 const nav = document.querySelector('.kz-header .kz-nav');
 if (!nav) return;
 const key = 'kuzgun_nav_scroll_v2';
 const save = () => {
  try { sessionStorage.setItem(key, String(nav.scrollLeft)); } catch (_) {}
 };
 const restore = () => {
  let saved = null;
  try { saved = sessionStorage.getItem(key); } catch (_) {}
  const behavior = nav.style.scrollBehavior;
  nav.style.scrollBehavior = 'auto';
  if (saved !== null && Number.isFinite(Number(saved))) {
   nav.scrollLeft = Number(saved);
  } else {
   const active = nav.querySelector('[aria-current="page"]');
   if (active) nav.scrollLeft = Math.max(0, active.offsetLeft - nav.offsetLeft - 12);
  }
  nav.style.scrollBehavior = behavior;
 };
 restore();
 nav.addEventListener('scroll', save, {passive:true});
 nav.addEventListener('click', save);
 window.addEventListener('pagehide', save);
 window.addEventListener('pageshow', restore);
 window.addEventListener('pagereveal', restore);
})();
