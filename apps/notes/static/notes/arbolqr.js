/* ─────────────────────────────────────────────────────────────────────────
   Árbol-QR — el enlace de una nota, dibujado como un árbol que crece.

   Inspirado en tree.icqr.com, escrito de cero: aquel es un bundle de 1 MB
   minificado y sin licencia, así que no hay nada suyo aquí dentro. Lo único
   de terceros es el generador de QR (qrcode.js, de Kazuhiko Arase, MIT), que
   vive en /static/vendor/.

   LO QUE NO SE NEGOCIA: el QR tiene que escanear. De ahí tres decisiones que
   mandan sobre lo bonito:

     · La copa ES la matriz del QR, con su zona de silencio de 4 módulos. El
       tronco y las ramas se dibujan POR DEBAJO, nunca encima del código.
     · Los tres patrones de detección van como cuadrados macizos, no como
       hojas sueltas: son lo que busca primero cualquier lector.
     · El color es aleatorio en el TONO, no en la luminosidad. El módulo
       oscuro se fija al 26 % y el papel al 96 %, así que el contraste está
       garantizado salga el tono que salga.

   Corrección de errores H (30 %): deja margen de sobra para que el follaje y
   las esquinas redondeadas no rompan la lectura.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SIN_MOVIMIENTO = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* Cada estación es un arco de tono. Dentro del arco, el tono es al azar:
     dos árboles de la misma estación no salen del mismo verde. */
  var ESTACIONES = [
    { id: 'primavera', nombre: 'Primavera', tono: [320, 355], sat: 52, hoja: 'flor' },
    { id: 'verano',    nombre: 'Verano',    tono: [95, 150],  sat: 45, hoja: 'redonda' },
    { id: 'otono',     nombre: 'Otoño',     tono: [18, 45],   sat: 62, hoja: 'redonda' },
    { id: 'invierno',  nombre: 'Invierno',  tono: [196, 224], sat: 30, hoja: 'copo' }
  ];

  function alAzar(min, max) { return min + Math.random() * (max - min); }

  function paletaAlAzar() {
    var e = ESTACIONES[Math.floor(Math.random() * ESTACIONES.length)];
    var h = Math.round(alAzar(e.tono[0], e.tono[1]));
    var tonoCorteza = Math.round(20 + h / 40);
    return {
      estacion: e,
      tono: h,
      sat: e.sat,
      tonoCorteza: tonoCorteza,
      // El par que decide si el QR se lee. No se toca.
      papel: 'hsl(' + h + ',30%,96%)',
      modulo: 'hsl(' + h + ',' + e.sat + '%,26%)',
      // Y el par que solo decora.
      fronda: 'hsl(' + h + ',' + e.sat + '%,88%)',
      corteza: 'hsl(' + tonoCorteza + ',28%,34%)'
    };
  }

  /* ── El dibujo ────────────────────────────────────────────────────────── */

  var NS = 'http://www.w3.org/2000/svg';

  function el(nombre, attrs) {
    var n = document.createElementNS(NS, nombre);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* Los tres cuadrados de detección, macizos. Devuelve una función que dice
     si una celda cae dentro de alguno, para no dibujarle una hoja encima. */
  function patronesDeteccion(g, n, x0, y0, paso, pal) {
    var esquinas = [[0, 0], [n - 7, 0], [0, n - 7]];
    esquinas.forEach(function (c) {
      var cx = x0 + c[0] * paso, cy = y0 + c[1] * paso;
      g.appendChild(el('rect', {
        x: cx, y: cy, width: paso * 7, height: paso * 7,
        rx: paso * 1.6, fill: pal.modulo, class: 'aq-ojo'
      }));
      g.appendChild(el('rect', {
        x: cx + paso, y: cy + paso, width: paso * 5, height: paso * 5,
        rx: paso * 1.1, fill: pal.papel, class: 'aq-ojo'
      }));
      g.appendChild(el('rect', {
        x: cx + paso * 2, y: cy + paso * 2, width: paso * 3, height: paso * 3,
        rx: paso * .7, fill: pal.modulo, class: 'aq-ojo'
      }));
    });
    return function dentro(f, c) {
      return esquinas.some(function (e) {
        return c >= e[0] && c < e[0] + 7 && f >= e[1] && f < e[1] + 7;
      });
    };
  }

  function hoja(g, cx, cy, r, pal, retardo) {
    var forma;
    if (pal.estacion.hoja === 'copo') {
      // Invierno: rombo, que da la sensación de escarcha sin dejar de ser un
      // módulo compacto y centrado.
      forma = el('rect', {
        x: cx - r, y: cy - r, width: r * 2, height: r * 2,
        rx: r * .3, fill: pal.modulo,
        transform: 'rotate(45 ' + cx + ' ' + cy + ')'
      });
    } else if (pal.estacion.hoja === 'flor') {
      forma = el('circle', { cx: cx, cy: cy, r: r, fill: pal.modulo });
    } else {
      forma = el('rect', {
        x: cx - r, y: cy - r, width: r * 2, height: r * 2,
        rx: r * .85, fill: pal.modulo
      });
    }
    forma.setAttribute('class', 'aq-hoja');
    forma.style.setProperty('--d', retardo + 'ms');
    g.appendChild(forma);
  }

  /**
   * Dibuja el árbol-QR.
   * @param {string} texto  Lo que codifica el QR (la URL del enlace).
   * @param {object} pal    Paleta de `paletaAlAzar()`.
   * @returns {SVGElement}
   */
  function construir(texto, pal) {
    var qr = window.qrcode(0, 'H');       // 0 = que elija él el tamaño
    qr.addData(texto);
    qr.make();
    var n = qr.getModuleCount();

    var ANCHO = 400, ALTO = 520;
    var silencio = 4;
    var lado = 300;
    var paso = lado / (n + silencio * 2);
    var x0 = (ANCHO - lado) / 2 + silencio * paso;
    var y0 = 26 + silencio * paso;

    var svg = el('svg', {
      viewBox: '0 0 ' + ANCHO + ' ' + ALTO,
      xmlns: NS, class: 'aq-svg',
      role: 'img',
      'aria-label': 'Código QR del enlace, dibujado como un árbol de ' +
                    pal.estacion.nombre.toLowerCase()
    });

    // Sombra en el suelo.
    svg.appendChild(el('ellipse', {
      cx: ANCHO / 2, cy: 498, rx: 76, ry: 11,
      fill: pal.corteza, opacity: '.16', class: 'aq-sombra'
    }));

    // Tronco y ramas. Van ANTES que la copa: la copa los tapa por arriba, que
    // es justo lo que hace que el árbol se lea como un árbol.
    var ramas = [
      'M200 496 C 198 450, 202 410, 200 356',
      'M200 430 C 176 412, 158 396, 143 372',
      'M200 408 C 226 394, 244 380, 258 362'
    ];
    ramas.forEach(function (d, i) {
      var p = el('path', {
        d: d, fill: 'none', stroke: pal.corteza,
        'stroke-width': i === 0 ? 13 : 7,
        'stroke-linecap': 'round', class: 'aq-rama'
      });
      p.style.setProperty('--d', (i * 110) + 'ms');
      svg.appendChild(p);
    });

    var copa = el('g', { class: 'aq-copa' });

    // La fronda: una mancha detrás del papel. Solo decora — el papel es
    // opaco y va encima, así que no toca el contraste del código.
    copa.appendChild(el('rect', {
      x: (ANCHO - lado) / 2 - 14, y: 12, width: lado + 28, height: lado + 28,
      rx: 78, fill: pal.fronda, class: 'aq-fronda'
    }));

    // El papel: la zona de silencio del QR. Sin esto no escanea.
    copa.appendChild(el('rect', {
      x: (ANCHO - lado) / 2, y: 26, width: lado, height: lado,
      rx: 26, fill: pal.papel, class: 'aq-papel'
    }));

    var dentroDeOjo = patronesDeteccion(copa, n, x0, y0, paso, pal);

    // Las hojas brotan de abajo arriba, que es como crece un árbol.
    /* El radio de la hoja, en fracción del paso de la retícula.
     *
     * Con .42 la hoja ocupaba el 84 % de su celda y no llegaba a tocar a sus
     * vecinas. Bonito, y en el filo de lo legible: a tamaño grande —el QR
     * ocupando la pantalla, dieciséis píxeles por módulo— un lector ve puntos
     * sueltos en vez de módulos y no encuentra la retícula. Medido con jsQR
     * sobre el SVG servido, a tres tamaños y en las cuatro estaciones:
     *
     *        .42   falla las tres de hoja redonda a tamaño completo
     *        .44   falla primavera
     *        .46   leen las cuatro, a los tres tamaños
     *
     * Invierno se salvaba ya con .42 porque su rombo va girado 45° y su
     * diagonal mide 1,19 veces el paso: tocaba a sus vecinas por las puntas.
     *
     * .46 es el mínimo que lee entero, y son cuatro centésimas de paso: las
     * hojas siguen siendo hojas sueltas y no un QR con las esquinas redondas.
     * Subirlo hasta .50 también lee, pero ahí ya se tocan y se pierde el
     * follaje, que es lo único que distingue esto de un QR normal. */
    var r = paso * .46;
    for (var f = 0; f < n; f++) {
      for (var c = 0; c < n; c++) {
        if (!qr.isDark(f, c) || dentroDeOjo(f, c)) continue;
        var retardo = 240 + (n - f) * 9 + Math.abs(c - n / 2) * 4;
        hoja(copa, x0 + c * paso + paso / 2, y0 + f * paso + paso / 2,
             r, pal, retardo);
      }
    }

    svg.appendChild(copa);
    if (SIN_MOVIMIENTO) svg.classList.add('aq-quieto');
    return svg;
  }

  window.ArbolQR = { construir: construir, paletaAlAzar: paletaAlAzar };
})();
