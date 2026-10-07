/* ─────────────────────────────────────────────────────────────────────────
   LineSidebar — port a JavaScript puro del componente de React Bits.

   El original es React. Aquí no hay React en ninguna de las dos apps, así que
   se porta la mecánica, que en realidad es pequeña:

     · cada elemento lleva una variable CSS --ls-effect entre 0 y 1
     · un único bucle rAF la acerca a su objetivo con suavizado exponencial
     · todo lo demás (color, desplazamiento, escala de la línea) sale de esa
       misma variable en el CSS, así que va siempre en bloque y no hay
       transiciones que se desincronicen

   Diferencias con el original, todas a propósito:

   1. No repinta la lista. Se engancha a la que ya pinta la app y le añade la
      línea de cada fila. Un MutationObserver se encarga de las filas que
      aparecen después: desplegar una carpeta, buscar, crear una nota.
      Así el árbol conserva carpetas, búsqueda, menú contextual y arrastrar y
      soltar, que un reemplazo literal se habría llevado por delante.

   2. Cachea la geometría. El original llama a offsetTop de cada elemento en
      cada pointermove; con un árbol de cientos de filas eso es recalcular la
      maquetación entera a cada píxel del ratón. Aquí se mide una vez y se
      vuelve a medir sólo cuando algo cambia (mutación, scroll, resize).

   3. Mide en coordenadas de ventana (getBoundingClientRect) en vez de
      offsetTop, que se rompe en cuanto el contenedor tiene scroll propio —y
      los dos contenedores lo tienen.

   4. Respeta prefers-reduced-motion: las líneas se dibujan, el efecto de
      proximidad no se activa.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CURVAS = {
    linear: function (p) { return p; },
    smooth: function (p) { return p * p * (3 - 2 * p); },
    sharp: function (p) { return p * p * p; }
  };

  var SIN_MOVIMIENTO = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function crear(raiz, op) {
    if (!raiz) return null;
    op = op || {};

    var selector = op.selector;
    var claseActiva = op.claseActiva || 'active';
    var radio = op.radio || 110;
    var suavizado = op.suavizado || 110;
    var curva = CURVAS[op.caida] || CURVAS.smooth;
    var conIndice = !!op.indice;

    var items = [];       // los elementos, en orden
    var centros = [];     // centro vertical de cada uno, en coordenadas de ventana
    var objetivos = [];   // a dónde va el --ls-effect de cada uno
    var actuales = [];    // dónde está ahora
    var sucio = true;     // hay que volver a medir
    var raf = null;
    var ultimo = 0;

    function ensuciar() { sucio = true; }

    /* Añade la línea (y el número, si toca) a las filas que aún no la tengan.
       Comprueba que la línea siga ahí en vez de fiarse de una marca puesta la
       primera vez: la app reescribe el innerHTML de una fila al renombrarla, y
       con una marca fija esa fila se quedaría sin línea para siempre. */
    function decorar() {
      var lista = raiz.querySelectorAll(selector);
      for (var i = 0; i < lista.length; i++) {
        var el = lista[i];
        var marca = el.querySelector(':scope > .ls-marker');
        if (!marca) {
          marca = document.createElement('span');
          marca.className = 'ls-marker';
          marca.setAttribute('aria-hidden', 'true');
          el.insertBefore(marca, el.firstChild);
        }
        if (conIndice && !el.querySelector(':scope > .ls-index')) {
          var num = document.createElement('span');
          num.className = 'ls-index';
          num.setAttribute('aria-hidden', 'true');
          el.insertBefore(num, marca.nextSibling);
        }
        /* El número se reescribe siempre: el orden cambia al crear, borrar o
           reordenar, y un índice fijo se quedaría mintiendo. */
        if (conIndice) {
          var caja = el.querySelector(':scope > .ls-index');
          if (caja) caja.textContent = String(i + 1).replace(/^(\d)$/, '0$1');
        }
      }
    }

    /* Sólo cuentan las filas visibles: dentro de una carpeta plegada hay
       elementos con geometría cero que si no se filtran atraen el efecto
       hacia sitios donde no se ve nada. */
    function medir() {
      var lista = raiz.querySelectorAll(selector);
      items = [];
      centros = [];
      for (var i = 0; i < lista.length; i++) {
        var r = lista[i].getBoundingClientRect();
        if (!r.height) continue;
        items.push(lista[i]);
        centros.push(r.top + r.height / 2);
      }
      objetivos.length = items.length;
      actuales.length = items.length;
      for (var j = 0; j < items.length; j++) {
        if (typeof objetivos[j] !== 'number') objetivos[j] = 0;
        if (typeof actuales[j] !== 'number') actuales[j] = 0;
      }
      sucio = false;
    }

    function frame(ahora) {
      var dt = Math.min((ahora - ultimo) / 1000, 0.05);
      ultimo = ahora;
      var tau = Math.max(suavizado, 1) / 1000;
      var k = 1 - Math.exp(-dt / tau);

      var moviendo = false;
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        if (!el || !el.isConnected) continue;
        var activo = el.classList.contains(claseActiva) ? 1 : 0;
        var objetivo = Math.max(objetivos[i] || 0, activo);
        var actual = actuales[i] || 0;
        var siguiente = actual + (objetivo - actual) * k;
        var quieto = Math.abs(objetivo - siguiente) < 0.0015;
        var valor = quieto ? objetivo : siguiente;
        actuales[i] = valor;
        el.style.setProperty('--ls-effect', valor.toFixed(4));
        if (!quieto) moviendo = true;
      }
      raf = moviendo ? requestAnimationFrame(frame) : null;
    }

    function arrancar() {
      if (SIN_MOVIMIENTO) return;
      if (raf != null) cancelAnimationFrame(raf);
      ultimo = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function alMover(e) {
      if (SIN_MOVIMIENTO) return;
      if (sucio) medir();
      for (var i = 0; i < items.length; i++) {
        var distancia = Math.abs(e.clientY - centros[i]);
        objetivos[i] = curva(Math.max(0, 1 - distancia / radio));
      }
      arrancar();
    }

    function alSalir() {
      if (SIN_MOVIMIENTO) return;
      for (var i = 0; i < objetivos.length; i++) objetivos[i] = 0;
      arrancar();
    }

    raiz.addEventListener('pointermove', alMover);
    raiz.addEventListener('pointerleave', alSalir);
    raiz.addEventListener('scroll', ensuciar, { passive: true });
    window.addEventListener('resize', ensuciar);

    var obs = new MutationObserver(function () {
      decorar();
      ensuciar();
      arrancar();   // repinta el estado activo de las filas nuevas
    });
    obs.observe(raiz, { childList: true, subtree: true });

    decorar();
    medir();
    arrancar();

    return {
      refrescar: function () { decorar(); ensuciar(); arrancar(); },
      destruir: function () {
        obs.disconnect();
        raiz.removeEventListener('pointermove', alMover);
        raiz.removeEventListener('pointerleave', alSalir);
        raiz.removeEventListener('scroll', ensuciar);
        window.removeEventListener('resize', ensuciar);
        if (raf != null) cancelAnimationFrame(raf);
      }
    };
  }

  window.LineSidebar = { crear: crear };

  /* ── Arranque por app ──────────────────────────────────────────────────
     El mismo fichero sirve en l-notes y en l-list; cada uno engancha con el
     contenedor que exista. */
  function iniciar() {
    var arbol = document.getElementById('vault-tree');
    if (arbol) {
      crear(arbol, {
        selector: '.tree-row',
        claseActiva: 'active',
        radio: 40,
        suavizado: 60,
        caida: 'linear',
        indice: false        // el árbol va anidado: numerar filas no dice nada
      });
    }

    var listas = document.getElementById('listas');
    if (listas) {
      crear(listas, {
        selector: '.lista-enlace',
        claseActiva: 'activa',
        radio: 40,
        suavizado: 60,
        caida: 'linear',
        indice: true         // lista plana: aquí el número sí ordena
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
