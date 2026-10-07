/* Comportamiento común a todas las páginas: menú lateral y service worker.
   Va con `defer`, así que corre con el DOM ya parseado. */

/* ── Menú hamburguesa (móvil) ── */
(function () {
  const toggle = document.getElementById('hb-toggle');
  if (!toggle) return;
  const drawer = document.getElementById('hb-drawer');
  const overlay = document.getElementById('hb-overlay');
  const closeBtn = document.getElementById('hb-close');

  function open() {
    drawer.classList.add('open');
    overlay.classList.add('show');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    drawer.classList.remove('open');
    overlay.classList.remove('show');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  toggle.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();

/* ── Service worker ── */
if ('serviceWorker' in navigator) {
  /* Si ESTA carga ya venía controlada por un service worker, un cambio de
     controlador significa que hay otro nuevo con la caché purgada, y ahí sí
     conviene recargar para que la página venga fresca (el caso del login con
     el CSRF caduco).

     Si venía SIN controlar, no. El `clients.claim()` del `activate` reclama la
     página en cuanto el worker arranca, y eso pasa en CADA entrada: ahí no hay
     nada viejo que refrescar, la página se acaba de pedir a la red.

     La guarda de antes no lo evitaba porque vivía en la página, y
     `location.reload()` estrena página con la guarda otra vez a cero. Cada
     entrada costaba dos arranques enteros de la aplicación. */
  const habiaControl = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!habiaControl) return;
    location.reload();
  });
}
