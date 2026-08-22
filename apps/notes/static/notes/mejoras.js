/*
 * mejoras.js — lo poco del acabado que el CSS no puede hacer solo.
 *
 * Son tres cosas y ninguna es imprescindible: si este fichero no llega a
 * cargarse, la página se ve exactamente igual que antes de que existiera. Ese
 * es el trato, y por eso ningún estado de reposo depende de aquí: lo único que
 * hace el guion es AÑADIR clases, nunca quitar las que hacen falta para ver
 * algo.
 *
 *   1. Marcar en <html> que la página está desplazada, para que la barra
 *      superior se condense. Con CSS puro sería animation-timeline: scroll(),
 *      que en Safari todavía no existe y estos servicios se usan sobre todo
 *      desde el iPhone.
 *   2. La onda al pulsar un botón: hace falta saber DÓNDE se ha pulsado, y eso
 *      el CSS no lo sabe.
 *   3. Desvanecer las imágenes cuando terminan de bajar, que depende de un
 *      evento de red.
 *
 * Escribe los estilos siempre con style.setProperty y nunca con
 * setAttribute('style', …): lo primero es CSSOM y la CSP no lo mira, lo
 * segundo es un atributo en línea y en l-gym —cuya CSP no lleva
 * `style-src unsafe-inline`— lo descartaría el navegador.
 */
(function () {
  'use strict';

  var raiz = document.documentElement;
  var quieto = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ── 1. La barra al desplazar ──────────────────────────────────────────
   *
   * El listener va en passive porque no se llama a preventDefault: sin eso el
   * navegador tiene que esperar a que termine esta función antes de mover la
   * página, y el desplazamiento se nota a tirones en el móvil.
   *
   * El umbral es 4 px y no 0 para que el rebote elástico de iOS, que devuelve
   * valores de medio píxel arriba y abajo, no encienda y apague la barra.
   */
  var pedido = false;
  function miraElScroll() {
    pedido = false;
    var abajo = (window.scrollY || window.pageYOffset) > 4;
    if (abajo !== (raiz.dataset.desplazado === 'si')) {
      if (abajo) raiz.dataset.desplazado = 'si';
      else delete raiz.dataset.desplazado;
    }
  }
  window.addEventListener('scroll', function () {
    if (pedido) return;
    pedido = true;
    requestAnimationFrame(miraElScroll);
  }, { passive: true });
  miraElScroll();

  /* ── 2. La onda al pulsar ──────────────────────────────────────────────
   *
   * La misma lista de selectores que en la hoja de estilo. Si se toca una,
   * hay que tocar la otra: aquí se decide QUÉ botones la llevan y allí cómo
   * se ve.
   *
   * Va en pointerdown y no en click: la onda tiene que salir con el dedo
   * apoyado, no cuando se levanta. En click llegaría después de que la acción
   * ya hubiera pasado.
   */
  var CON_ONDA = '.boton, .btn, .boton-lino, .boton-grande, .boton-peligro,' +
    '.btn-suave, .btn-pequeno, .pestana, .menu-opcion, .menu-tema, .sel-boton,' +
    '.espacio-boton, .accion-juego, .btn-jugar, .boton-neon';

  document.addEventListener('pointerdown', function (ev) {
    if (quieto.matches) return;
    if (ev.button !== undefined && ev.button !== 0) return;

    var boton = ev.target.closest && ev.target.closest(CON_ONDA);
    if (!boton || boton.disabled) return;
    /* Un botón por onda: pulsar rápido dos veces no debe apilar círculos. */
    if (boton.querySelector(':scope > .m-onda')) return;

    var caja = boton.getBoundingClientRect();
    if (!caja.width) return;

    /* El radio es la diagonal entera, que es lo que garantiza que el círculo
       cubra el botón desde cualquier esquina donde se haya pulsado. */
    var radio = Math.hypot(caja.width, caja.height);

    var onda = document.createElement('span');
    onda.className = 'm-onda';
    onda.style.setProperty('--m-x', (ev.clientX - caja.left) + 'px');
    onda.style.setProperty('--m-y', (ev.clientY - caja.top) + 'px');
    onda.style.setProperty('--m-r', radio + 'px');

    boton.appendChild(onda);
    /* Se quita con el evento y con un plazo: si el botón se esconde a media
       animación —un menú que se cierra al pulsarlo— animationend no llega
       nunca y el <span> se quedaría dentro para siempre. */
    var fuera = function () { if (onda.parentNode) onda.remove(); };
    onda.addEventListener('animationend', fuera, { once: true });
    setTimeout(fuera, 900);
  }, true);

  /* ── 3. Las imágenes ───────────────────────────────────────────────────
   *
   * Solo se esconden las que TODAVÍA no han llegado. Una que ya está en la
   * caché del navegador tiene complete === true antes de que este guion
   * corra, y esconderla para desvanecerla acto seguido es un parpadeo gratis.
   */
  function preparaImagenes(raizBusqueda) {
    var imgs = raizBusqueda.querySelectorAll('img:not([data-m-vista])');
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        img.dataset.mVista = '1';
        if (img.complete || quieto.matches) return;

        /*
         * Si la página ya ha decidido la opacidad de esta imagen, no se toca.
         *
         * Esto atenúa y devuelve a 1, y eso es correcto para una imagen normal
         * —cuyo estado natural es «visible del todo»— pero no para una que
         * forma parte de una coreografía ajena. En la portada de
         * samuelarmastatto las fotos van al 58% y se turnan fundiendo entre
         * ellas; al meter aquí la mano, la que entraba subía hasta el 100% y
         * luego caía al 58, y ese bajón se ve como si la foto cambiara sola.
         *
         * La comprobación es de una línea y vale para cualquier caso parecido
         * sin tener que ir marcándolos uno a uno: quien tenga una opacidad
         * distinta de 1 es porque alguien la ha puesto ahí a propósito.
         */
        if (getComputedStyle(img).opacity !== '1') return;

        img.classList.add('m-cargando');
        var listo = function () { img.classList.remove('m-cargando'); };
        img.addEventListener('load', listo, { once: true });
        img.addEventListener('error', listo, { once: true });
        /* Red de seguridad: si por lo que sea no llega ni load ni error, la
           imagen tiene que acabar viéndose igual. Nada de este fichero puede
           dejar contenido invisible de forma permanente. */
        setTimeout(listo, 10000);
      })(imgs[i]);
    }
  }
  preparaImagenes(document);

  /* l-tcg y l-archivos repintan la vista entera desde JS sin recargar la
     página, así que las imágenes nuevas no pasan por el barrido de arriba.
     El observador se limita a eso: mirar qué nodos aparecen. Agrupado en un
     rAF para no recorrer el DOM una vez por cada <img> de una tanda. */
  if (window.MutationObserver) {
    var pendiente = false;
    new MutationObserver(function () {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(function () {
        pendiente = false;
        preparaImagenes(document);
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
