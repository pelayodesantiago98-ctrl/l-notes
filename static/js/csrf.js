/* CSRF global: añade la cabecera X-CSRFToken a toda llamada fetch() del mismo
   origen que no sea segura. Evita repetirla en cada template y arregla los 403
   de los fetch de JSON/FormData.

   Se carga SIN defer y antes que ningún otro script: si el envoltorio se
   instalara después, las primeras peticiones de la página (el árbol del vault,
   por ejemplo) saldrían sin token.

   El token se busca en dos sitios y sirve cualquiera de los dos:

     - la cookie, que el navegador mantiene siempre al día;
     - window.LNOTES.csrf, que la plantilla incrusta al renderizar.

   Antes solo se miraba lo segundo, y encima una única vez al cargar: si el HTML
   llegaba sin token —una copia servida por el service worker, por ejemplo— este
   envoltorio se desactivaba entero con un `return`, y a partir de ahí TODOS los
   POST salían sin cabecera. Django los rechazaba con 403 y "CSRF token missing",
   así que no se podía crear ni una nota y la página no decía por qué.

   Por eso ahora se lee en cada petición y no al arrancar: la cookie puede rotar
   con la pestaña abierta, y un token incrustado al cargar se queda viejo. */
(function () {
  if (!window.fetch) return;

  // Tiene que coincidir con CSRF_COOKIE_NAME de config/settings/base.py.
  var COOKIE = 'lnotes_csrftoken';
  var SEGUROS = { GET: 1, HEAD: 1, OPTIONS: 1, TRACE: 1 };

  function deCookie() {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function token() {
    return deCookie() || (window.LNOTES && window.LNOTES.csrf) || '';
  }

  var origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    var sameOrigin = url.startsWith('/') || url.startsWith(location.origin);

    if (sameOrigin && !SEGUROS[method]) {
      var t = token();
      if (t) {
        var headers = new Headers(init.headers || {});
        if (!headers.has('X-CSRFToken')) headers.set('X-CSRFToken', t);
        init.headers = headers;
        if (!init.credentials) init.credentials = 'same-origin';
      } else {
        // Quedarse callado aquí fue justo lo que costó encontrar el fallo.
        console.warn('[csrf] no hay token ni en la cookie ni en la página: ' +
                     method + ' ' + url + ' saldrá sin cabecera y Django lo rechazará');
      }
    }

    return origFetch(input, init);
  };
})();
