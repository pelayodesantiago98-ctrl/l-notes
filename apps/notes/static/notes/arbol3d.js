/* ─────────────────────────────────────────────────────────────────────────
   Árbol-QR en 3D — diorama isométrico en WebGL, sin dependencias.

   Reescrito después de ver el vídeo de referencia. La primera versión tenía
   la geometría al revés: ponía el QR en la copa. Va en el SUELO.

   La escena, de abajo arriba:

     · una losa cuadrada con canto visible, flotando sobre el fondo;
     · encima, el QR como pavimento — baldosa pálida para los módulos claros
       y baldosa de hierba para los oscuros. Ahí está el código;
     · matas de hierba en la banda del borde, que es lo que le da relieve al
       diorama y lo despega de ser un tablero;
     · un árbol en el centro: tronco de bloques que se estrecha, un eje que
       sigue subiendo por dentro de la copa, verticilos de ramas a varias
       alturas con sus bifurcaciones, y cientos de hojas colgadas en racimos
       del final de cada rama — no un volumen relleno alrededor del eje;
     · meteorología según la estación: pétalos, motas o lluvia.

   Tres cosas al azar en cada árbol, como pidió el usuario: la estación, el
   color de la copa y el modelo. Son independientes: en el vídeo hay un árbol
   de primavera con la copa roja y otro con la copa azul.

   Y la forma concreta la sigue firmando el QR: densidad de módulos y
   proporción de bordes deciden altura, grosor, ramas y lo tupida que va la
   copa, así que dos enlaces distintos dan dos árboles distintos.

   Cámara ORTOGRÁFICA, no en perspectiva. Es lo que hace que el diorama se lea
   como isométrico — y, mirando desde arriba, lo que hace que el QR salga sin
   deformar y se pueda escanear de verdad.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SIN_MOVIMIENTO = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ── Paletas ──────────────────────────────────────────────────────────── */

  /* Paleta medida sobre el vídeo de referencia, contando píxeles de sus
     vistas cenitales. Los valores dominantes que salieron:

        baldosa   #eeeeee / #eeeedd / #ffeeee   (~44 % del encuadre)
        hierba    #66bb33 · #77cc44 · #44aa22
        copas     #9955bb #cc3333 #66bbdd #ffaaaa #ffff44 #ffeeee

     Son los que se usan aquí tal cual, que es lo pedido. Ojo con una cosa,
     que está explicada en `paraElCodigo`: con estos colores el vídeo se
     queda en 1,5:1 de contraste, y un lector de QR necesita 3:1. */
  var ESTACIONES = {
    primavera: {
      nombre: 'Primavera',
      hierba: [0.400, 0.733, 0.200], hierbaAlta: [0.467, 0.800, 0.267],
      baldosa: [0.933, 0.933, 0.933], baldosaOscura: [0.800, 0.800, 0.780],
      clima: 'petalos'
    },
    verano: {
      nombre: 'Verano',
      hierba: [0.267, 0.667, 0.133], hierbaAlta: [0.400, 0.733, 0.200],
      baldosa: [0.933, 0.933, 0.867], baldosaOscura: [0.800, 0.790, 0.720],
      clima: 'motas'
    },
    otono: {
      nombre: 'Otoño',
      hierba: [0.800, 0.667, 0.200], hierbaAlta: [0.900, 0.780, 0.300],
      baldosa: [0.933, 0.933, 0.933], baldosaOscura: [0.790, 0.790, 0.800],
      clima: 'lluvia'
    }
  };

  // La fila de muestras del vídeo: el color de la copa va aparte de la
  // estación, y son estos seis.
  var COLORES = {
    rosa:     [1.000, 0.667, 0.667],   // #ffaaaa
    morado:   [0.600, 0.333, 0.733],   // #9955bb
    rojo:     [0.800, 0.200, 0.200],   // #cc3333
    ambar:    [1.000, 1.000, 0.267],   // #ffff44
    azul:     [0.400, 0.733, 0.867],   // #66bbdd
    blanco:   [1.000, 0.933, 0.933]    // #ffeeee
  };

  // Cada modelo es una función que dice, para una altura relativa (0 abajo de
  // la copa, 1 arriba), qué radio tiene ahí. Cambiar la silueta es cambiar
  // esta curva y nada más.
  /* Todas cumplen dos cosas: son llenas por el medio —de ahí las potencias
     por debajo de 1, que engordan la silueta en vez de dejarla afilada— y
     TODAS valen 0 en t=1, o sea que rematan en punta arriba en lugar de
     cortarse en plano.

     `radio` ya no rellena un volumen: ahora es la ENVOLVENTE que dice hasta
     dónde puede estirarse una rama a cada altura. Es lo que mantiene la
     silueta reconocible ahora que la copa la dibuja el ramaje.

     Y `rama` es la otra mitad del modelo: el perfil vertical de una rama
     madre, de 0 en su arranque a 1 en la punta. Ahí es donde se ve de verdad
     la diferencia entre un árbol y otro — un cerezo abre las ramas casi
     planas y un ciprés las lleva pegadas al eje, y eso no es cosa del
     contorno de la copa sino de por dónde va la madera. */
  var MODELOS = {
    redonda: {
      nombre: 'Redonda',
      alto: 1.00, ancho: 1.00,
      radio: function (t) {
        return Math.pow(Math.sin(Math.PI * Math.pow(t, 0.66)), 0.70);
      },
      // Sube deprisa al salir del tronco y se va tumbando: el arco de rama de
      // toda la vida.
      rama: function (q) { return Math.pow(q, 0.70); }
    },
    columnar: {
      nombre: 'Columnar',
      alto: 1.30, ancho: 0.74,
      radio: function (t) {
        return (0.66 + 0.34 * Math.sin(Math.PI * t)) * Math.pow(1 - t, 0.28);
      },
      // Ramas empinadas, casi pegadas al eje: es lo que hace la columna.
      rama: function (q) { return Math.pow(q, 0.42); }
    },
    capas: {
      nombre: 'En capas',
      alto: 1.08, ancho: 1.04,
      radio: function (t) {
        var onda = 0.84 + 0.16 * Math.abs(Math.cos(t * Math.PI * 2.4));
        return onda * Math.pow(1 - t, 0.26) * Math.pow(Math.min(1, t * 5), 0.5);
      },
      // Casi horizontales, que es lo que separa un piso del siguiente.
      rama: function (q) { return 0.30 * Math.pow(q, 1.45); }
    },
    llorona: {
      nombre: 'Llorona',
      alto: 1.00, ancho: 1.06,
      radio: function (t) {
        return Math.pow(1 - t, 0.36) * Math.pow(Math.min(1, t * 5), 0.5);
      },
      // Sale hacia arriba, hace cumbre a media rama y cae: en la punta vale
      // -0,2, o sea que la rama acaba por debajo de donde nació. Eso es el
      // sauce, y es el único modelo con rama de signo negativo. Con -0,4 el
      // follaje de los verticilos bajos llegaba al pavimento y tapaba el
      // tronco entero.
      rama: function (q) { return 1.35 * q - 1.55 * q * q; }
    }
  };

  /* ── Azar con semilla ─────────────────────────────────────────────────
     Todo el árbol se sortea con esto y no con Math.random, para que una nota
     tenga SIEMPRE el mismo árbol: al reabrirla, al cambiar de nota y volver,
     al redibujar. Sigue pareciendo aleatorio —dos notas dan dos árboles sin
     parecido— pero es estable, que es lo que se pidió. */
  var _sem = 1;

  function sembrar(texto) {
    var h = 2166136261;
    for (var i = 0; i < texto.length; i++) {
      h = Math.imul(h ^ texto.charCodeAt(i), 16777619);
    }
    _sem = (h >>> 0) || 1;
  }

  function azar() {
    _sem = (_sem + 0x6D2B79F5) | 0;
    var t = Math.imul(_sem ^ (_sem >>> 15), 1 | _sem);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function alAzarDe(obj) {
    var claves = Object.keys(obj);
    return claves[Math.floor(azar() * claves.length)];
  }

  /** Estación, color y modelo, los tres independientes y los tres sorteados
      a partir de la semilla — o sea, a partir de la nota. */
  function sorteo(semilla) {
    if (semilla !== undefined) sembrar(String(semilla));
    var e = alAzarDe(ESTACIONES), c = alAzarDe(COLORES), m = alAzarDe(MODELOS);
    return {
      estacion: e, color: c, modelo: m,
      est: ESTACIONES[e], hoja: COLORES[c], mod: MODELOS[m],
      nombre: ESTACIONES[e].nombre + ' · copa ' + c + ' · ' + MODELOS[m].nombre.toLowerCase()
    };
  }

  /* ── Matrices ─────────────────────────────────────────────────────────── */

  function multiplicar(a, b) {
    var o = new Float32Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        o[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] +
                       a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
      }
    }
    return o;
  }

  function ortografica(r, arriba, cerca, lejos) {
    var o = new Float32Array(16);
    o[0] = 1 / r; o[5] = 1 / arriba; o[10] = -2 / (lejos - cerca);
    o[14] = -(lejos + cerca) / (lejos - cerca); o[15] = 1;
    return o;
  }

  function mirarDesde(ojo, centro, arr) {
    var zx = ojo[0]-centro[0], zy = ojo[1]-centro[1], zz = ojo[2]-centro[2];
    var l = Math.hypot(zx, zy, zz) || 1; zx/=l; zy/=l; zz/=l;
    var xx = arr[1]*zz - arr[2]*zy, xy = arr[2]*zx - arr[0]*zz, xz = arr[0]*zy - arr[1]*zx;
    l = Math.hypot(xx, xy, xz) || 1; xx/=l; xy/=l; xz/=l;
    var yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;
    return new Float32Array([
      xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx*ojo[0]+xy*ojo[1]+xz*ojo[2]),
      -(yx*ojo[0]+yy*ojo[1]+yz*ojo[2]),
      -(zx*ojo[0]+zy*ojo[1]+zz*ojo[2]), 1
    ]);
  }

  /* ── Lo que el QR dice del árbol ──────────────────────────────────────── */

  function estadisticas(qr, n) {
    var oscuros = 0, cortes = 0;
    for (var f = 0; f < n; f++) {
      for (var c = 0; c < n; c++) {
        var d = qr.isDark(f, c);
        if (d) oscuros++;
        if (c + 1 < n && d !== qr.isDark(f, c + 1)) cortes++;
        if (f + 1 < n && d !== qr.isDark(f + 1, c)) cortes++;
      }
    }
    return { densidad: oscuros / (n * n), bordes: cortes / (2 * n * (n - 1)) };
  }

  var LADO = 3.0;   // lo que mide el pavimento del QR de lado a lado

  /* Las dos estadísticas del QR viven en una banda estrechísima: medido sobre
     400 enlaces, la densidad va de 0,470 a 0,523 y los bordes de 0,485 a
     0,523. Es lo esperable — un QR bien formado está diseñado para salir medio
     negro y bien mezclado, y si no lo estuviera sería un QR malo.

     Lo que significa es que multiplicarlas por un coeficiente y truncar, que
     es lo que se venía haciendo, daba SIEMPRE el mismo número: el ramaje no lo
     firmaba nadie por mucho que lo dijera el comentario. Estirando la banda a
     0..1 sí decide, que era la idea desde el principio. */
  function franja(v, min, max) {
    return Math.max(0, Math.min(1, (v - min) / (max - min)));
  }

  /* Proporciones medidas sobre el vídeo de referencia: la copa arranca a un
     cuarto de la altura total, sube hasta ~1,2 veces el ancho de la losa, y
     de ancho ocupa unos dos tercios del pavimento. */
  function parametros(est, sorteado) {
    var m = sorteado.mod;
    var dens = franja(est.densidad, 0.470, 0.523);
    var bord = franja(est.bordes, 0.485, 0.523);
    return {
      // Tronco limpio más alto y copa más ancha que alta, como en la
      // referencia: antes medía casi lo mismo de ancho que de alto y el
      // conjunto tiraba a arbusto.
      alturaTronco: 1.02 * m.alto,
      altoCopa: 2.30 * m.alto,
      // 0,46 y no más: a 0,52 el radio de la copa pasaba de la media losa y el
      // árbol se comía el diorama entero.
      anchoCopa: LADO * 0.46 * m.ancho * (0.90 + 0.20 * bord),
      /* Las capas son las alturas a las que puede posarse una hoja, y con 17
         sobre 2,2 de copa quedaban a 0,13 de distancia para hojas de 0,045 de
         grosor: se veían los pisos. A 26 la masa se cierra y el follaje se lee
         como follaje. Son ~4.000 vértices más, que en un canvas de 300 px no
         se notan. */
      capas: 26,
      /* El ramaje, que es lo que ahora dibuja la copa. Antes esto era un
         número de radios sueltos, todos a la misma altura; ahora son
         VERTICILOS repartidos por la altura de la copa, con varias ramas
         madre cada uno. Los dos números los sigue firmando el QR: un código
         denso ramifica más veces, y uno muy troceado abre más ramas por
         verticilo. */
      /* Con 3-5 verticilos las copas salían a lóbulos: cada verticilo hace un
         anillo de racimos a su altura, y si están lejos unos de otros se ven
         los anillos. Apretándolos a 5-7 el follaje se encadena en vertical y
         vuelve a ser una copa, pero grumosa — que es justo lo que se busca. */
      niveles: 5 + Math.round(2 * dens),
      porNivel: 2 + Math.round(2 * bord),
      // Lo tupida que va la copa la firma el QR, como todo lo demás.
      densidadCopa: 0.44 + 0.22 * dens,
      matas: Math.round(38 + 34 * bord)
    };
  }

  /* ── Construcción de la malla ─────────────────────────────────────────── */

  var CARAS = [
    { n: [0, 1, 0], v: [[0,1,0],[0,1,1],[1,1,1],[0,1,0],[1,1,1],[1,1,0]] },
    { n: [0,-1, 0], v: [[0,0,0],[1,0,0],[1,0,1],[0,0,0],[1,0,1],[0,0,1]] },
    { n: [0, 0, 1], v: [[0,0,1],[1,0,1],[1,1,1],[0,0,1],[1,1,1],[0,1,1]] },
    { n: [0, 0,-1], v: [[1,0,0],[0,0,0],[0,1,0],[1,0,0],[0,1,0],[1,1,0]] },
    { n: [1, 0, 0], v: [[1,0,1],[1,0,0],[1,1,0],[1,0,1],[1,1,0],[1,1,1]] },
    { n: [-1,0, 0], v: [[0,0,0],[0,0,1],[0,1,1],[0,0,0],[0,1,1],[0,1,0]] }
  ];

  function Malla() {
    this.pos = []; this.nor = []; this.col = []; this.colQR = []; this.cre = [];
  }

  /* `colorQR` es el color que tendrá la pieza mirada desde arriba, cuando lo
     que importa es leer el código. Si no se pasa, es el mismo de siempre —
     lo que hay fuera del pavimento no necesita contraste. */
  Malla.prototype.caja = function (x, y, z, sx, sy, sz, color, retardo, colorQR) {
    var cx = x + sx / 2, cz = z + sz / 2;
    var q = colorQR || color;
    for (var i = 0; i < 6; i++) {
      var cara = CARAS[i];
      for (var j = 0; j < 6; j++) {
        var v = cara.v[j];
        this.pos.push(x + v[0]*sx, y + v[1]*sy, z + v[2]*sz);
        this.nor.push(cara.n[0], cara.n[1], cara.n[2]);
        this.col.push(color[0], color[1], color[2]);
        this.colQR.push(q[0], q[1], q[2]);
        this.cre.push(cx, y, cz, retardo);   // crece desde su base
      }
    }
  };

  /** Un cuadrilátero suelto: la hoja, la brizna y la baldosa. */
  Malla.prototype.quad = function (c, ejeU, ejeV, color, retardo, baseY, colorQR) {
    var esquinas = [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]];
    var nx = ejeU[1]*ejeV[2] - ejeU[2]*ejeV[1];
    var ny = ejeU[2]*ejeV[0] - ejeU[0]*ejeV[2];
    var nz = ejeU[0]*ejeV[1] - ejeU[1]*ejeV[0];
    var l = Math.hypot(nx, ny, nz) || 1;
    var q = colorQR || color;
    for (var i = 0; i < 6; i++) {
      var u = esquinas[i][0], v = esquinas[i][1];
      this.pos.push(c[0] + ejeU[0]*u + ejeV[0]*v,
                    c[1] + ejeU[1]*u + ejeV[1]*v,
                    c[2] + ejeU[2]*u + ejeV[2]*v);
      this.nor.push(nx/l, ny/l, nz/l);
      this.col.push(color[0], color[1], color[2]);
      this.colQR.push(q[0], q[1], q[2]);
      this.cre.push(c[0], baseY === undefined ? c[1] : baseY, c[2], retardo);
    }
  };

  // Recorta a 0..1: sin esto, aclarar un color ya claro se sale de rango y el
  // realce no se nota (GL lo recortaría igual, pero callando).
  function tinte(c, f) {
    return [Math.min(1, c[0]*f), Math.min(1, c[1]*f), Math.min(1, c[2]*f)];
  }

  /* ── Contraste para que el código se lea ──────────────────────────────────

     Un lector de QR necesita que lo oscuro y lo claro se distingan de verdad:
     por debajo de 3:1 de luminancia deja de leer. Y los colores bonitos del
     jardín no dan eso — la hierba de primavera sobre baldosa clara se queda
     en 1,4:1, y una copa blanca sobre suelo claro, en nada.

     Y el vídeo de referencia TAMPOCO llega: midiendo sus propios píxeles, su
     baldosa está en 0,93 de luminancia y sus copas entre 0,33 y 0,73, lo que
     da 2,6:1 en el rojo, 2,1:1 en el morado y 1,5:1 en el azul. Con esos
     colores el código no se lee; es bonito, no funcional.

     La salida no es apagar el jardín: cada pieza lleva DOS colores, el suyo
     —el del vídeo, exacto— y una versión con el mismo tono pero más honda, y
     el shader mezcla de uno a otro según sube la cámara. De lado se ve el
     jardín del vídeo; desde arriba, un código que se puede escanear.

     El oscurecido escala el RGB en bloque, así que conserva el tono y la
     proporción de saturación: el morado del vídeo sigue siendo ese morado,
     más profundo. */

  // 3,05 y no 3,0: aterrizar justo en el mínimo deja el resultado en el filo,
  // y entre el redondeo del framebuffer y el brillo de cada pantalla ese filo
  // se cruza solo. Un pelín de margen cuesta nada de color.
  var CONTRASTE_MINIMO = 3.05;

  function luminancia(c) {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contraste(a, b) {
    var la = luminancia(a), lb = luminancia(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Oscurece `c` lo justo para alcanzar el contraste pedido contra `claro`,
      escalando en bloque para no cambiarle el tono. */
  function paraElCodigo(c, claro) {
    var objetivo = (luminancia(claro) + 0.05) / CONTRASTE_MINIMO - 0.05;
    var l = luminancia(c);
    if (l <= objetivo) return c;
    var f = Math.max(0, objetivo) / Math.max(l, 1e-6);
    return [c[0] * f, c[1] * f, c[2] * f];
  }

  /* ── El esqueleto ─────────────────────────────────────────────────────────

     Lo que hacía que el árbol se leyera como un palo con una nube encima eran
     dos cosas, y las dos están aquí:

       · las ramas eran radios sueltos, los tres a la MISMA altura, y además a
         la altura exacta en la que arranca la copa — o sea, enterrados bajo la
         primera capa de hojas. Desde fuera no se veía ni una;
       · y la copa era un sólido de revolución: un disco por capa, centrado en
         el eje, relleno con densidad uniforme. Un único bulto simétrico, sin
         nada que mirar fuera del centro.

     Ahora hay un esqueleto de verdad —eje que sube por dentro de la copa,
     verticilos de ramas madre a varias alturas, y dos bifurcaciones por rama—
     y las hojas cuelgan de ÉL, en racimos, en vez de rellenar un volumen. De
     ahí salen las dos cosas que faltaban: masa a los lados y huecos por los
     que se ve la madera.

     El QR sigue mandando sobre todo lo demás:

       · ningún trozo de rama ni ninguna hoja se posa sobre un módulo claro,
         que es lo que hace que el árbol sea transparente para el lector;
       · y el ángulo de cada rama madre no se reparte a compás: se ELIGE
         buscando la línea de módulos oscuros más continua que sale del
         tronco. Así la rama sale entera en vez de a trozos, y sale hacia
         donde el código tiene masa. Dos enlaces distintos ramifican distinto,
         que es lo que ya se venía haciendo con la altura y el grosor. */

  /** El índice de celda de una coordenada de mundo, o -1 si cae fuera. */
  function celda(v, mitad, paso, n) {
    var i = Math.floor((v + mitad) / paso);
    return (i < 0 || i >= n) ? -1 : i;
  }

  /** Qué parte de un radio que sale del tronco cae sobre módulos oscuros.
      Lo de fuera del pavimento cuenta como fallo: la copa puede volar sobre
      el canto de la losa, pero una rama que se va del tablero no dibuja nada
      —no hay celdas oscuras ahí— y sería una rama invisible. */
  function continuidad(qr, n, x0, z0, ang, largo, mitad, paso) {
    var dentro = 0, MUESTRAS = 10;
    for (var p = 1; p <= MUESTRAS; p++) {
      var d = largo * (p / MUESTRAS);
      var c = celda(x0 + Math.cos(ang) * d, mitad, paso, n);
      var f = celda(z0 + Math.sin(ang) * d, mitad, paso, n);
      if (c >= 0 && f >= 0 && qr.isDark(f, c)) dentro++;
    }
    return dentro / MUESTRAS;
  }

  /** Los ángulos de las ramas madre de un verticilo.

      Se puntúan muchos candidatos por continuidad y se cogen los mejores,
      pero exigiendo separación angular entre ellos: sin esa condición el
      código empuja todas las ramas hacia su zona más oscura y sale un árbol
      peinado a un lado, que es peor que el reparto a compás del que veníamos. */
  function angulos(qr, n, x0, z0, cuantas, largo, mitad, paso, sesgo) {
    var CAND = 32;
    var sep = (Math.PI * 2 / cuantas) * 0.58;
    var lista = [], i, j;
    for (i = 0; i < CAND; i++) {
      var a = sesgo + (i / CAND) * Math.PI * 2;
      lista.push({ a: a, v: continuidad(qr, n, x0, z0, a, largo, mitad, paso) });
    }
    // A igualdad de continuidad —que se da, y mucho: son décimas sobre diez
    // muestras— decide la semilla, no el orden del bucle. Sin esto los empates
    // se resuelven siempre por el ángulo más pequeño y los verticilos salen
    // todos alineados entre sí.
    for (i = 0; i < lista.length; i++) lista[i].v += azar() * 0.05;
    lista.sort(function (p, q) { return q.v - p.v; });

    var elegidos = [];
    for (i = 0; i < lista.length && elegidos.length < cuantas; i++) {
      var libre = true;
      for (j = 0; j < elegidos.length; j++) {
        var d = Math.abs(((lista[i].a - elegidos[j]) + Math.PI * 3) %
                         (Math.PI * 2) - Math.PI);
        if (d < sep) { libre = false; break; }
      }
      if (libre) elegidos.push(lista[i].a);
    }
    // Si el código es tan disperso que no quedan huecos, se completa a compás:
    // más vale una rama corta y a trozos que un verticilo a medias.
    while (elegidos.length < cuantas) {
      elegidos.push(sesgo + (elegidos.length / cuantas) * Math.PI * 2);
    }
    return elegidos;
  }

  /** Dibuja una rama desde `o` y devuelve dónde acaba.

      Se recorre en pasos cortos y el tramo que caería sobre un módulo claro
      sencillamente no se dibuja. Los huecos que deja quedan casi siempre bajo
      la hoja, y los que se ven se leen como el escalonado propio del diorama.
      La punta que devuelve es la geométrica, se haya dibujado o no: de ella
      cuelga el racimo, y el racimo sí encuentra celdas oscuras donde posarse.
      Pero se devuelve también CUÁNTO se ha dibujado, porque de una rama que
      no ha salido casi nada no debe colgar follaje: quedaba una mata flotando
      en el aire sin nada que la sujete, y eso se ve. */
  function rama(m, qr, n, o, ang, largo, subida, curva, anchoBase,
                color, colorQR, retardo, mitad, paso, puestas) {
    var pasos = Math.max(5, Math.round(largo / (paso * 0.62)));
    var cos = Math.cos(ang), sen = Math.sin(ang);
    var puntos = [], p;

    // Primero se recorre entera y se anota qué pasos pueden dibujarse.
    for (p = 1; p <= pasos; p++) {
      var q = p / pasos;
      var d = largo * q;
      var x = o.x + cos * d, z = o.z + sen * d;
      var y = o.y + subida * curva(q);
      var c = celda(x, mitad, paso, n), f = celda(z, mitad, paso, n);
      puntos.push({ x: x, y: y, z: z, q: q, c: c, f: f,
                    ok: c >= 0 && f >= 0 && qr.isDark(f, c) });
    }

    var fin = { x: puntos[pasos - 1].x, y: puntos[pasos - 1].y,
                z: puntos[pasos - 1].z, trozos: 0, pasos: pasos };

    /* Y sólo después se dibuja, descartando los pasos sueltos: un trozo de
       rama cuyos dos vecinos han caído sobre módulos claros no se lee como
       rama, se lee como una mota de tierra flotando en el aire. Con vecino
       sigue siendo un trazo escalonado, que es el aire del diorama. */
    for (p = 0; p < pasos; p++) {
      var pt = puntos[p];
      if (!pt.ok) continue;
      if (!(p > 0 && puntos[p - 1].ok) && !(p + 1 < pasos && puntos[p + 1].ok)) continue;
      // Una celda puede tocarle a dos pasos seguidos, y a dos ramas que se
      // cruzan. Sin esto se apilan cajas idénticas: vértices de más que no
      // pintan un píxel nuevo.
      var clave = 'r' + pt.c + ':' + pt.f + ':' + Math.round(pt.y / (paso * 0.5));
      if (puestas[clave]) continue;
      puestas[clave] = 1;
      fin.trozos++;
      var ancho = anchoBase * (1 - 0.52 * pt.q);
      m.caja(-mitad + pt.c * paso + (paso - ancho) / 2, pt.y,
             -mitad + pt.f * paso + (paso - ancho) / 2,
             ancho,
             Math.max(paso * 0.34, Math.abs(subida) / pasos + paso * 0.20),
             ancho, tinte(color, 0.84 + azar() * 0.22),
             retardo + p * 16, colorQR);
    }
    return fin;
  }

  function construirMalla(qr, n, s, par) {
    var m = new Malla();
    var paso = LADO / n;
    var mitad = LADO / 2;
    var borde = paso * 1.6;          // banda de hierba alrededor del QR
    var est = s.est;

    // ── La losa, con su canto ────────────────────────────────────────────
    var ext = mitad + borde;
    m.caja(-ext, -0.16, -ext, ext * 2, 0.16, ext * 2,
           tinte(est.baldosaOscura, 0.72), 0);

    // ── La banda de hierba del borde ─────────────────────────────────────
    m.caja(-ext, 0, -ext, ext * 2, 0.012, ext * 2, est.hierba, 40);

    // ── El pavimento: aquí vive el QR ────────────────────────────────────
    // Sólo la cara de arriba de cada baldosa. Los cantos miden dos
    // centésimas y no se ven desde ningún ángulo del diorama, pero eran el
    // 89 % de la malla: en cubos completos esto solo son 60.000 vértices que
    // no aportan un píxel.
    // El claro es la referencia; todo lo demás se oscurece contra él.
    var claroQR = est.baldosa;
    var hierbaQR = paraElCodigo(est.hierba, claroQR);

    // Media celda EXACTA: con 0.49 quedaba una junta por la que se veía la
    // banda de hierba de debajo, y desde arriba eso es una rejilla verde
    // encima del código que le come contraste.
    var mediaBaldosa = paso * 0.5;
    for (var f = 0; f < n; f++) {
      for (var c = 0; c < n; c++) {
        var oscuro = qr.isDark(f, c);
        var px = -mitad + c * paso + paso / 2;
        var pz = -mitad + f * paso + paso / 2;
        var d = Math.max(Math.abs(px), Math.abs(pz)) / mitad;
        var color = oscuro ? est.hierba : est.baldosa;
        // Un pelín de variación por baldosa: sin esto el suelo es un plano
        // liso y se le nota lo generado. En modo código NO se varía: cada
        // décima de luminancia cuenta cuando hay que garantizar un mínimo.
        var vib = 0.94 + azar() * 0.10;
        // Los ejes van en este orden y no al revés: su producto vectorial es
        // la normal, y con el orden contrario apuntaba hacia ABAJO — el suelo
        // se sombreaba como si le diera la luz desde el subsuelo.
        m.quad([px, oscuro ? 0.032 : 0.026, pz],
               [0, 0, mediaBaldosa], [mediaBaldosa, 0, 0],
               tinte(color, vib), 120 + d * 260, 0.012,
               oscuro ? hierbaQR : claroQR);
      }
    }

    // ── Matas de hierba, sobre todo en el borde ──────────────────────────
    for (var g = 0; g < par.matas; g++) {
      var lado = Math.floor(azar() * 4);
      var t = azar() * 2 - 1;
      var gx = lado < 2 ? t * ext * 0.96 : (lado === 2 ? -1 : 1) * (mitad + borde * 0.5);
      var gz = lado < 2 ? (lado === 0 ? -1 : 1) * (mitad + borde * 0.5) : t * ext * 0.96;
      var alto = 0.10 + azar() * 0.13;
      var col = tinte(est.hierbaAlta, 0.85 + azar() * 0.3);
      for (var k = 0; k < 2; k++) {
        var a = azar() * Math.PI;
        m.quad([gx, 0.012 + alto / 2, gz],
               [Math.cos(a) * 0.035, 0, Math.sin(a) * 0.035],
               [0, alto / 2, 0], col, 340 + azar() * 220, 0.012);
      }
    }

    // ── El tronco ────────────────────────────────────────────────────────
    // Va sobre la retícula, dos celdas de lado y centrado. Tapa cuatro
    // módulos: con corrección de errores H (30 %) el código lo absorbe sin
    // pestañear, y es lo que permite que se vea subir por dentro de la copa.
    var corteza = [0.34, 0.24, 0.18];
    var cortezaQR = paraElCodigo(corteza, claroQR);

    /* El tronco ocupa 2×2 celdas y desde arriba las tapa. Si alguna fuera
       clara, el código quedaría dañado justo en el centro. Así que se busca
       el 2×2 TODO oscuro más cercano al medio y el árbol se planta ahí: unas
       pocas celdas descentrado, y el QR intacto. */
    var medio = Math.floor(n / 2) - 1;
    var filaArbol = medio, colArbol = medio;
    buscarSitio: for (var r = 0; r < Math.floor(n / 3); r++) {
      for (var df = -r; df <= r; df++) {
        for (var dc = -r; dc <= r; dc++) {
          if (Math.max(Math.abs(df), Math.abs(dc)) !== r) continue;
          var f0 = medio + df, c0 = medio + dc;
          if (f0 < 1 || c0 < 1 || f0 + 1 >= n - 1 || c0 + 1 >= n - 1) continue;
          if (qr.isDark(f0, c0) && qr.isDark(f0 + 1, c0) &&
              qr.isDark(f0, c0 + 1) && qr.isDark(f0 + 1, c0 + 1)) {
            filaArbol = f0; colArbol = c0;
            break buscarSitio;
          }
        }
      }
    }
    // Centro del árbol en coordenadas de mundo (esquina del 2×2 del tronco).
    // Un pelín metido hacia dentro, como las hojas: si el tronco llegara justo
    // a la frontera de la celda, su borde se solaparía con la baldosa vecina.
    var margenTronco = paso * 0.03;
    var tx = -mitad + colArbol * paso + margenTronco;
    var tz = -mitad + filaArbol * paso + margenTronco;
    var lado2 = paso * 2 - margenTronco * 2;
    var hT = par.alturaTronco;
    var tramos = 10;
    for (var i = 0; i < tramos; i++) {
      var tt = i / tramos;
      var enc = paso * 0.16 * tt;          // se estrecha hacia arriba
      m.caja(tx + enc, 0.02 + hT * tt, tz + enc,
             lado2 - enc * 2, hT / tramos + 0.006, lado2 - enc * 2,
             tinte(corteza, 0.88 + azar() * 0.2), 420 + i * 30, cortezaQR);
    }

    // ── El eje, que sigue subiendo por dentro de la copa ─────────────────
    // En la referencia el tronco se ve entre las hojas casi hasta arriba, y es
    // lo que impide que la copa parezca una nube posada sobre un palo. Va
    // dentro del mismo 2×2 oscuro que el tronco, así que no hay que
    // comprobarle nada: por ancho que sea, no puede pisar un módulo claro.
    var xEje = tx + lado2 / 2, zEje = tz + lado2 / 2;
    var yCopa = 0.02 + hT;
    var mod = s.mod;
    var puestas = {};                 // para no apilar dos piezas en el mismo sitio
    var altoEje = par.altoCopa * 0.66;
    var tramosEje = 9;
    for (var e = 0; e < tramosEje; e++) {
      var te = e / tramosEje;
      var anchoEje = lado2 * (0.80 - 0.54 * te);
      m.caja(xEje - anchoEje / 2, yCopa + altoEje * te, zEje - anchoEje / 2,
             anchoEje, altoEje / tramosEje + 0.008, anchoEje,
             tinte(corteza, 0.86 + azar() * 0.2), 560 + e * 26, cortezaQR);
    }

    // ── Los verticilos de ramas ──────────────────────────────────────────
    // De cada rama madre cuelgan cinco racimos: tres escalonados por su tramo
    // exterior —para que la masa se encadene a lo largo de la rama en vez de
    // quedar un pompón en la punta— y uno en cada bifurcación.
    var racimos = [];
    for (var niv = 0; niv < par.niveles; niv++) {
      // Repartidos de la base de la copa a las tres cuartas partes de su
      // altura. Más arriba no hay verticilo: la envolvente ya no da para una
      // rama, y de rematar la punta se encarga el eje.
      var tn = 0.08 + (niv / Math.max(1, par.niveles - 1)) * 0.72;
      // Hasta dónde puede llegar la rama a esta altura. Es lo único que queda
      // del sólido de revolución, y a propósito: sin esta cota la silueta del
      // modelo se perdía —columnar y llorona salían igual de anchas— porque
      // ya nadie consultaba `radio`.
      var alcance = par.anchoCopa * Math.max(0.34, mod.radio(Math.min(0.98, tn)));
      // El verticilo de más arriba lleva una rama menos: es más estrecho.
      var cuantas = Math.max(2, par.porNivel - (niv >= par.niveles - 1 ? 1 : 0));
      var angs = angulos(qr, n, xEje, zEje, cuantas, alcance,
                         mitad, paso, azar() * Math.PI * 2);

      for (var b = 0; b < angs.length; b++) {
        var ang = angs[b];
        /* Cada rama del verticilo nace a su propia altura. Sin este temblor
           las tres salen del mismo punto exacto y sus racimos forman un anillo
           perfecto: se ve el andamio. */
        var tb = tn + (azar() - 0.5) * 0.11;
        var yn = yCopa + par.altoCopa * tb;
        var largo = alcance * (0.72 + azar() * 0.30);
        // Las de abajo suben más que las de arriba, que ya nacen altas.
        var subida = par.altoCopa * (0.16 + 0.12 * azar()) * (1 - tn * 0.5);
        /* Casi una celda entera de grueso, que es el máximo: la caja va
           centrada en su celda, y pasarse de `paso` la haría asomar sobre la
           celda vecina — que puede ser clara. Con paso*0.80 la rama era más
           fina que una hoja y desaparecía bajo el follaje. */
        var anchoR = paso * (0.96 - 0.22 * tn);
        var origen = { x: xEje, y: yn, z: zEje };
        var retardo = 700 + niv * 60 + b * 26;

        var madre = rama(m, qr, n, origen, ang, largo, subida, mod.rama,
                         anchoR, corteza, cortezaQR, retardo, mitad, paso,
                         puestas);

        /* Racimos escalonados por el tramo exterior de la rama madre.
           Empiezan en el 74 % y no en el 64 %, y son más pequeños: la mitad
           interior de cada rama se queda de madera desnuda, que es lo que hace
           que se lea el ramaje en vez de una masa continua. Es la diferencia
           entre un árbol y un brócoli. */
        var reparto = [0.68, 0.85, 1.00];
        for (var u = 0; u < reparto.length; u++) {
          var q = reparto[u];
          racimos.push({
            x: origen.x + Math.cos(ang) * largo * q,
            y: origen.y + subida * mod.rama(q),
            z: origen.z + Math.sin(ang) * largo * q,
            r: largo * (0.28 + 0.13 * q) + paso * 1.3,
            vivo: madre.trozos > madre.pasos * 0.34
          });
        }

        // Dos bifurcaciones, abiertas en abanico desde el tercio final: es lo
        // que hace que la copa tenga puntas y no bultos.
        var qBif = 0.62;
        var oBif = { x: origen.x + Math.cos(ang) * largo * qBif,
                     y: origen.y + subida * mod.rama(qBif),
                     z: origen.z + Math.sin(ang) * largo * qBif };
        for (var k = 0; k < 2; k++) {
          var aSub = ang + (k ? 1 : -1) * (0.40 + azar() * 0.34);
          var largoSub = largo * (0.34 + azar() * 0.24);
          var punta = rama(m, qr, n, oBif, aSub, largoSub, subida * 0.52,
                           mod.rama, anchoR * 0.62, corteza, cortezaQR,
                           retardo + 80 + k * 18, mitad, paso, puestas);
          racimos.push({
            x: punta.x, y: punta.y, z: punta.z,
            r: largoSub * 0.80 + paso * 1.3,
            // Una bifurcación que no ha llegado a dibujarse cuelga de la rama
            // madre, así que le vale con que ella haya salido.
            vivo: madre.trozos > madre.pasos * 0.34
          });
        }
      }
    }
    // Y la punta del eje, que si no la copa se queda descabezada.
    racimos.push({ x: xEje, y: yCopa + altoEje * 1.02, z: zEje,
                   r: par.anchoCopa * 0.30 + paso * 1.6, vivo: true });

    // ── Las hojas, colgadas de los racimos ───────────────────────────────
    //
    // Sigue en pie lo único que no se negocia, y es lo que obliga a que la
    // hoja sea CUADRADA y esté alineada a la retícula del QR:
    //
    //   una hoja sólo se posa sobre una celda OSCURA del código.
    //
    // Como nunca cae sobre una celda clara, mirando desde arriba la copa no
    // tapa ni un módulo blanco: el árbol se vuelve transparente para el
    // lector de QR. Lo que ves desde arriba sigue siendo el código, con las
    // hojas haciendo de módulos oscuros en vez de la hierba.
    //
    // Lo que ha cambiado es DÓNDE se buscan esas celdas: antes, todo el
    // volumen de un sólido de revolución centrado en el eje; ahora, la esfera
    // achatada de cada racimo. De ahí los huecos, y de ahí que haya masa
    // donde hay rama en vez de sólo en el medio.
    var claro = tinte(s.hoja, 1.12), medioT = s.hoja, oscura = tinte(s.hoja, 0.74);
    // Mirando el código, la copa entera va a un solo tono oscurecido: los
    // matices de luz son preciosos de lado y aquí sólo restan contraste.
    var hojaQR = paraElCodigo(s.hoja, claroQR);
    var tamHoja = paso * 0.96;
    var grosor = paso * 0.62;
    // Las capas siguen siendo el único sitio donde puede posarse una hoja: es
    // lo que las mantiene apiladas y no flotando a cualquier altura.
    var pasoCapa = par.altoCopa / (par.capas - 1);

    /* Las capas pueden bajar del arranque de la copa: un racimo que cuelga de
       una rama baja —y en el sauce, de una rama que cae— tiene follaje por
       debajo de yCopa, y recortarlo ahí dejaba la copa cortada en plano por
       abajo, como si se hubiera posado sobre una mesa.

       Pero sólo un tramo. Dejándolo bajar hasta el pavimento el follaje envolvía
       el tronco y el árbol volvía a ser un bulto sin nada dentro: lo que hace
       falta es que el borde de abajo ondule, no que se derrame. */
    var yMinHoja = Math.max(0.30, yCopa - 0.42);
    var capaMinAbs = Math.ceil((yMinHoja - yCopa) / pasoCapa);

    for (var ri = 0; ri < racimos.length; ri++) {
      var ra = racimos[ri];
      if (!ra.vivo) continue;      // rama que el código no dejó salir
      var capaIni = Math.max(capaMinAbs,
                             Math.ceil((ra.y - ra.r - yCopa) / pasoCapa));
      var capaFin = Math.min(par.capas - 1,
                             Math.floor((ra.y + ra.r - yCopa) / pasoCapa));
      for (var capa = capaIni; capa <= capaFin; capa++) {
        var hy = yCopa + capa * pasoCapa;
        // Achatado 1,45 a 1: un racimo es más ancho que alto, como la masa de
        // hoja que cuelga del final de una rama. Esférico se veía a bolas.
        var dv = (hy - ra.y) * 1.45;
        var rl2 = ra.r * ra.r - dv * dv;
        if (rl2 <= 0) continue;
        var rl = Math.sqrt(rl2);
        var alc = Math.ceil(rl / paso);
        var cCen = Math.floor((ra.x + mitad) / paso);
        var fCen = Math.floor((ra.z + mitad) / paso);
        var t = (hy - yCopa) / par.altoCopa;
        var col2 = t > 0.62 ? claro : (t > 0.28 ? medioT : oscura);

        for (var df = -alc; df <= alc; df++) {
          for (var dc = -alc; dc <= alc; dc++) {
            var ff = fCen + df, cc = cCen + dc;
            if (ff < 0 || ff >= n || cc < 0 || cc >= n) continue;
            if (!qr.isDark(ff, cc)) continue;        // ← sólo módulos oscuros
            var dx = (-mitad + cc * paso + paso / 2) - ra.x;
            var dz = (-mitad + ff * paso + paso / 2) - ra.z;
            var dr = Math.hypot(dx, dz);
            if (dr > rl) continue;
            // Más ralo según se sale del racimo: cortar en seco por el radio
            // se ve como una bola, y lo que queremos es una mata.
            if (azar() > par.densidadCopa * (0.34 + 0.78 * (1 - dr / rl))) continue;
            var clave = 'h' + capa + ':' + ff + ':' + cc;
            if (puestas[clave]) continue;   // dos racimos que se solapan
            puestas[clave] = 1;
            m.caja(-mitad + cc * paso + (paso - tamHoja) / 2, hy,
                   -mitad + ff * paso + (paso - tamHoja) / 2,
                   tamHoja, grosor, tamHoja,
                   tinte(col2, 0.9 + azar() * 0.2),
                   820 + t * 520 + azar() * 240, hojaQR);
          }
        }
      }
    }

    return m;
  }

  /* ── Meteorología ─────────────────────────────────────────────────────── */

  /* Hojas cayendo, en todas las estaciones — es lo que pidió el usuario y lo
     que da vida al diorama. En otoño, además, la lluvia de la referencia. */
  function construirClima(s, par, paso) {
    var m = new Malla();
    var tam = (paso || 0.07) * 0.8;
    var colHoja = tinte(s.hoja, 1.04);

    for (var i = 0; i < 70; i++) {
      var x = (azar() - 0.5) * 3.2;
      var z = (azar() - 0.5) * 3.2;
      var y = 0.5 + azar() * 2.6;
      // Cuadrada como las de la copa, y ladeada, que es como cae una hoja.
      var gir = azar() * Math.PI;
      m.quad([x, y, z],
             [Math.cos(gir) * tam, 0.22 * tam, Math.sin(gir) * tam],
             [-Math.sin(gir) * tam, 0.30 * tam, Math.cos(gir) * tam],
             tinte(colHoja, 0.86 + azar() * 0.28), 0, y);
    }

    if (s.est.clima === 'lluvia') {
      for (var j = 0; j < 80; j++) {
        var rx = (azar() - 0.5) * 3.4;
        var rz = (azar() - 0.5) * 3.4;
        var ry = 0.4 + azar() * 2.8;
        m.quad([rx, ry, rz], [0.006, 0, 0], [0, 0.13, 0],
               [0.74, 0.79, 0.87], 0, ry);
      }
    }

    return m;
  }

  /* ── WebGL ────────────────────────────────────────────────────────────── */

  var VS = [
    'attribute vec3 aPos;',
    'attribute vec3 aNor;',
    'attribute vec3 aCol;',
    'attribute vec3 aColQR;',      // el mismo color, oscurecido para leer el código
    'attribute vec4 aCre;',        // xyz = centro desde el que crece, w = retardo
    'uniform float uContraste;',   // 0 = jardín · 1 = modo código
    'uniform mat4 uMVP;',
    'uniform float uT;',
    'uniform float uDur;',
    'uniform float uCaida;',       // >0 = esto es meteorología y cae
    'uniform float uViento;',      // 0 = quieto; 1 = con viento
    'uniform float uSuelo;',       // altura del pavimento: ahí se posan
    'varying vec3 vCol;',
    'varying float vLuz;',
    'void main(){',
    '  float p = clamp((uT - aCre.w) / uDur, 0.0, 1.0);',
    '  p = p * p * (3.0 - 2.0 * p);',
    '  vec3 centro = aCre.xyz;',
    '  vec3 pos = centro + (aPos - centro) * p;',
    // Viento: el balanceo crece con el cuadrado de la altura, así el suelo no
    // se mueve nada y la copa es la que va. Dos frecuencias distintas en X y Z
    // para que sea un vaivén y no un desfile.
    '  float mecer = pos.y * pos.y * 0.0115 * uViento;',
    '  pos.x += sin(uT * 0.00105 + pos.z * 1.35) * mecer;',
    '  pos.z += cos(uT * 0.00082 + pos.x * 1.05) * mecer * 0.62;',
    '  if (uCaida > 0.0) {',
    // Caída continua con vuelta al principio: dos tiempos distintos por
    // partícula para que no bajen todas en formación.
    '    float ciclo = 3.2 + fract(centro.x * 7.31) * 2.4;',
    '    float caido = fract((uT * 0.001 + fract(centro.z * 3.77)) / ciclo) * ciclo;',
    '    float y = aPos.y - caido * 0.9;',
    // La hoja se POSA: al tocar el pavimento se queda ahí hasta que le toca
    // volver a empezar, en vez de seguir hundiéndose por debajo de la losa.
    '    float posado = step(y, uSuelo);',
    '    pos.y = max(uSuelo, y);',
    // Y una vez posada deja de revolotear, o se arrastraría por el suelo.
    '    pos.x = aPos.x + sin(uT * 0.0011 + centro.z * 4.0) * 0.10 * (1.0 - posado);',
    '  }',
    '  vCol = mix(aCol, aColQR, uContraste);',
    // El sombreado por cara también se aplana al ir a código: una hoja en
    // sombra es una hoja más clara o más oscura de lo que se ha calculado, y
    // ahí el margen de contraste ya está justo.
    '  float luz = 0.62 + 0.38 * max(0.0, dot(normalize(aNor), normalize(vec3(0.45, 1.0, 0.30))));',
    '  vLuz = mix(luz, 1.0, uContraste);',
    '  gl_Position = uMVP * vec4(pos, 1.0);',
    '}'
  ].join('\n');

  var FS = [
    'precision mediump float;',
    'varying vec3 vCol;',
    'varying float vLuz;',
    'void main(){ gl_FragColor = vec4(vCol * vLuz, 1.0); }'
  ].join('\n');

  function compilar(gl, tipo, fuente) {
    var s = gl.createShader(tipo);
    gl.shaderSource(s, fuente); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function subir(gl, prog, malla) {
    function buf(datos, tam, nombre) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(datos), gl.STATIC_DRAW);
      return { b: b, tam: tam, loc: gl.getAttribLocation(prog, nombre) };
    }
    return {
      partes: [buf(malla.pos, 3, 'aPos'), buf(malla.nor, 3, 'aNor'),
               buf(malla.col, 3, 'aCol'), buf(malla.colQR, 3, 'aColQR'),
               buf(malla.cre, 4, 'aCre')],
      vertices: malla.pos.length / 3
    };
  }

  function borrarLote(gl, lote) {
    if (!lote) return;
    for (var i = 0; i < lote.partes.length; i++) gl.deleteBuffer(lote.partes[i].b);
  }

  function dibujar(gl, lote) {
    for (var i = 0; i < lote.partes.length; i++) {
      var p = lote.partes[i];
      gl.bindBuffer(gl.ARRAY_BUFFER, p.b);
      gl.enableVertexAttribArray(p.loc);
      gl.vertexAttribPointer(p.loc, p.tam, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, lote.vertices);
  }

  /**
   * @param {HTMLCanvasElement} lienzo
   * @param {string} texto     lo que codifica el QR
   * @param {object} s         resultado de sorteo(); si falta, se sortea
   * @param {object} opciones  {fondo:[r,g,b], cenital:bool, girar:bool}
   */
  function crear(lienzo, texto, s, opciones) {
    opciones = opciones || {};
    s = s || sorteo();
    var gl = lienzo.getContext('webgl', { alpha: true, antialias: true }) ||
             lienzo.getContext('experimental-webgl', { alpha: true, antialias: true });
    if (!gl) return null;

    var prog = gl.createProgram();
    gl.attachShader(prog, compilar(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compilar(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Programa: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    var escena = null, clima = null, par = null, n = 0;

    /* Rehace la malla en el MISMO contexto. Crear un canvas nuevo por cada
       árbol agotaría el cupo de contextos WebGL del navegador (rondan los
       dieciséis) y a partir de ahí dejarían de dibujarse todos. */
    function montar(txt, nuevo) {
      s = nuevo || s;
      var qr = window.qrcode(0, 'H');
      qr.addData(txt); qr.make();
      n = qr.getModuleCount();
      par = parametros(estadisticas(qr, n), s);
      borrarLote(gl, escena); borrarLote(gl, clima);
      escena = subir(gl, prog, construirMalla(qr, n, s, par));
      clima = subir(gl, prog, construirClima(s, par, LADO / n));
    }
    montar(texto, s);

    var uMVP = gl.getUniformLocation(prog, 'uMVP');
    var uT = gl.getUniformLocation(prog, 'uT');
    var uDur = gl.getUniformLocation(prog, 'uDur');
    var uCaida = gl.getUniformLocation(prog, 'uCaida');
    var uViento = gl.getUniformLocation(prog, 'uViento');
    var uSuelo = gl.getUniformLocation(prog, 'uSuelo');
    var uContraste = gl.getUniformLocation(prog, 'uContraste');

    gl.enable(gl.DEPTH_TEST);
    var fondo = opciones.fondo;
    gl.clearColor(fondo ? fondo[0] : 0, fondo ? fondo[1] : 0,
                  fondo ? fondo[2] : 0, fondo ? 1 : 0);

    var t0 = performance.now(), raf = null, vivo = true;
    /* ── La transición, copiada del vídeo ──────────────────────────────────

       Mirando su grabación fotograma a fotograma (8 por segundo), el paso de
       árbol a código NO es una interpolación de ángulo. En el fotograma
       central la copa aparece ENORME y cortada por los bordes: la cámara se
       lanza hacia el árbol, pasa por encima girando, y sale hacia atrás para
       encuadrar la losa. Dura tres o cuatro fotogramas — medio segundo.

       Eso es lo que hace `sin(pi·p)` en el encuadre: un pico de acercamiento
       en mitad del recorrido que vuelve a abrirse al final. Sin él la cámara
       viaja en arco y se ve barata; con él, se lanza.

       Lo único suyo que no se reproduce es el desenfoque de movimiento, que
       en WebGL costaría un segundo pase de render entero. */

    var ISO = { elev: 0.58, giro: Math.PI / 4 };
    /* Cenital EXACTO, 90°, y giro 0.
       El giro, porque en diagonal la losa se ve en rombo. Y los 90° clavados
       porque es lo único que hace que la copa no emborrone el código: a 85°
       —apenas cinco grados de inclinación— una hoja a 2,5 de altura se
       proyecta casi tres celdas a un lado, y el centro del QR se convierte en
       una mancha. Recto del todo, cada hoja cae justo sobre su celda y el
       árbol se vuelve transparente para el lector. */
    var CENIT = { elev: Math.PI / 2, giro: 0 };
    var DUR_VUELO = 520;
    var PICADO = 0.58;                     // cuánto se acerca en el pico

    var cenital = !!opciones.cenital;

    function encuadre(esCen) {
      return esCen ? { media: 1.78, centroY: 0 }
                   : { media: 1.50 + par.altoCopa * 0.50,
                       centroY: 0.50 + par.altoCopa * 0.34 };
    }

    function destino(esCen) {
      var e = encuadre(esCen), a = esCen ? CENIT : ISO;
      return { elev: a.elev, giro: a.giro, media: e.media, centroY: e.centroY };
    }

    var actual = destino(cenital);
    actual.base = actual.media;
    var desde = { elev: actual.elev, giro: actual.giro,
                  media: actual.media, centroY: actual.centroY };
    var tVuelo = -1e9;

    /* Un replante EN ESPERA: la malla que hay que montar cuando el vuelo
       llegue a su pico. Se guarda aquí en vez de montarse en el acto porque
       rehacer la malla se ve, y en el pico no: ahí la copa desborda el
       encuadre y tapa el suelo entero. */
    var pendiente = null;

    function plantarPendiente(ahora) {
      var pl = pendiente;
      pendiente = null;
      texto = pl.texto;                  // para un `regenerar()` sin texto
      montar(pl.texto, pl.sorteo);
      if (pl.recrecer) t0 = ahora;
    }

    function medir() {
      var r = lienzo.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (lienzo.width !== w || lienzo.height !== h) { lienzo.width = w; lienzo.height = h; }
      gl.viewport(0, 0, lienzo.width, lienzo.height);
      return lienzo.width / Math.max(1, lienzo.height);
    }

    function fotograma(ahora) {
      if (!vivo) return;
      var t = SIN_MOVIMIENTO ? 1e6 : ahora - t0;
      var aspecto = medir();

      // El vuelo: p va de 0 a 1 en medio segundo, con arranque y frenada.
      var p = SIN_MOVIMIENTO ? 1 : Math.min(1, (ahora - tVuelo) / DUR_VUELO);
      // El replante va colgado del vuelo, y este es el enganche: pasado el
      // pico —donde `sin(pi·p)` es máximo y la copa llena la pantalla— la
      // malla se cambia sin que se vea.
      if (pendiente && p >= 0.5) plantarPendiente(ahora);
      var e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

      var hacia = destino(cenital);
      actual.elev = desde.elev + (hacia.elev - desde.elev) * e;
      actual.giro = desde.giro + (hacia.giro - desde.giro) * e;
      actual.centroY = desde.centroY + (hacia.centroY - desde.centroY) * e;
      // El pico de acercamiento: la cámara se echa encima del árbol a mitad
      // del recorrido y se vuelve a abrir. Es lo que se ve en su fotograma
      // central, con la copa desbordando el encuadre.
      // `base` es el encuadre sin el picado. Se guarda aparte porque es el
      // que hay que tomar como punto de partida si el vuelo se interrumpe a
      // media pulsación: arrancar del valor ya hundido encogería dos veces.
      actual.base = desde.media + (hacia.media - desde.media) * e;
      actual.media = actual.base * (1 - PICADO * Math.sin(Math.PI * p));

      var elev = actual.elev, giro = actual.giro, centroY = actual.centroY;
      var d = 9;
      var ojo = [Math.cos(elev) * Math.sin(giro) * d, centroY + Math.sin(elev) * d,
                 Math.cos(elev) * Math.cos(giro) * d];
      /* El "arriba" de la cámara, girado con ella. Con (0,1,0) fijo la cosa
         degenera al mirar recto hacia abajo, y cambiarlo de golpe a mitad de
         vuelo daba un tirón. Éste es siempre perpendicular a la dirección de
         vista y varía de forma continua, así que ni degenera ni salta. */
      var arriba = [-Math.sin(elev) * Math.sin(giro),
                    Math.cos(elev),
                    -Math.sin(elev) * Math.cos(giro)];
      var vista = mirarDesde(ojo, [0, centroY, 0], arriba);
      var proy = ortografica(actual.media * aspecto, actual.media, -20, 20);
      var mvp = multiplicar(vista, proy);

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uMVP, false, mvp);
      gl.uniform1f(uT, t);
      gl.uniform1f(uDur, 620);

      /* El viento se apaga al subir a cenital, y no por estética: si la copa
         se balancea, las hojas se salen de su celda, pisan módulos claros y
         el código deja de leerse. Quieto arriba, con viento de lado. */
      var cen01 = Math.min(1, Math.max(0, (elev - 0.58) / (1.5 - 0.58)));
      var viento = SIN_MOVIMIENTO ? 0 : (1 - cen01);

      // Justo encima de la baldosa oscura, que es lo más alto del pavimento.
      gl.uniform1f(uSuelo, 0.034);
      gl.uniform1f(uCaida, 0);
      gl.uniform1f(uViento, viento);
      // El paso al color de código va por delante de la cámara: para cuando
      // la losa se ve recta, el contraste ya está puesto.
      gl.uniform1f(uContraste, Math.min(1, cen01 * 1.4));
      dibujar(gl, escena);

      // Y por lo mismo, las hojas que caen no se dibujan sobre el código.
      if (!SIN_MOVIMIENTO && cen01 < 0.5) {
        gl.uniform1f(uCaida, 1.0);
        gl.uniform1f(uViento, viento * 0.5);
        gl.uniform1f(uContraste, 0);
        dibujar(gl, clima);
      }

      raf = requestAnimationFrame(fotograma);
    }
    raf = requestAnimationFrame(fotograma);

    lienzo.addEventListener('webglcontextlost', function (e) { e.preventDefault(); vivo = false; });

    return {
      get sorteo() { return s; },
      get parametros() { return par; },
      get modulos() { return n; },
      /** Sube a mirar el código desde arriba, o vuelve al diorama.
       *
       *  `opciones.texto` replanta el jardín con otro código, y lo monta en el
       *  PICO del vuelo en vez de antes de despegar. Hacerlo antes era lo que
       *  rompía la transición: la malla se rehace entera, y como la geometría
       *  la firma la matriz del QR, el árbol de partida desaparecía y otro
       *  distinto empezaba a brotar mientras la cámara giraba. Lo que se veía
       *  no era este árbol dándose la vuelta.
       *
       *  `opciones.sorteo` conserva estación, color y modelo: es el mismo
       *  sitio con otro código en el suelo, no otro jardín. Y conviene que sea
       *  el mismo por algo más que la estética — el encuadre sale de
       *  `altoCopa`, que depende sólo del modelo, así que mantenerlo es lo que
       *  garantiza que la cámara no pegue un salto al replantar a media
       *  transición.
       *
       *  `opciones.recrecer` reinicia además el crecimiento, para que el
       *  jardín vuelva a brotar de camino al rincón.
       *
       *  @param {boolean} si        true = cenital · false = diorama
       *  @param {object=} opciones  {texto, sorteo, recrecer}
       */
      cenital: function (si, opciones) {
        if (opciones && opciones.texto) {
          pendiente = {
            texto: opciones.texto,
            sorteo: opciones.sorteo || s,
            recrecer: !!opciones.recrecer
          };
        }
        if (!!si === cenital) {
          /* No hay vuelo del que colgarlo, así que se planta ya: dejarlo en la
             cola sería que el código nuevo apareciera en el clic siguiente,
             que es peor que verlo cambiar. */
          if (pendiente) plantarPendiente(performance.now());
          return;
        }
        cenital = !!si;
        // Se arranca desde DONDE ESTÁ la cámara, no desde el extremo: si se
        // pulsa a mitad de vuelo, da media vuelta en vez de dar un salto.
        desde.elev = actual.elev; desde.giro = actual.giro;
        desde.media = actual.base; desde.centroY = actual.centroY;
        tVuelo = performance.now();
      },
      esCenital: function () { return cenital; },
      /** Otro árbol, mismo lienzo.
       *
       *  Con `callada` el reloj del crecimiento NO se reinicia: la malla se
       *  cambia por debajo y las piezas nuevas se incorporan a la animación
       *  que ya iba corriendo, cada una en el punto que le toca por su
       *  retardo. Sirve para resembrar mientras la bóveda todavía carga —la
       *  ruta abierta va cambiando sola conforme llega `/api/notes/tree`, y
       *  con el reinicio puesto eso se veía como el árbol brotando dos o tres
       *  veces seguidas nada más entrar.
       *
       *  @param {string}  txt     lo que codifica el QR
       *  @param {object}  nuevo   sorteo; si falta, se sortea otro
       *  @param {boolean} callada true = sin reiniciar el crecimiento
       */
      regenerar: function (txt, nuevo, callada) {
        montar(txt || texto, nuevo || sorteo());
        if (!callada) t0 = performance.now();
      },
      /** Para el bucle cuando no se ve: un canvas girando de fondo gasta. */
      pausar: function (si) {
        if (si) {
          if (raf) { cancelAnimationFrame(raf); raf = null; }
        } else if (!raf && vivo) {
          raf = requestAnimationFrame(fotograma);
        }
      },
      destruir: function () {
        vivo = false;
        if (raf) cancelAnimationFrame(raf);
        borrarLote(gl, escena); borrarLote(gl, clima);
        var x = gl.getExtension('WEBGL_lose_context');
        if (x) x.loseContext();
      }
    };
  }

  window.Arbol3D = {
    crear: crear, sorteo: sorteo,
    estadisticas: estadisticas, parametros: parametros,
    ESTACIONES: ESTACIONES, COLORES: COLORES, MODELOS: MODELOS,
    /* Expuesto para poder probar la geometría y la cámara desde node: sin
       navegador, es el único sitio donde se puede ver que esto cuadra. */
    _interno: {
      multiplicar: multiplicar, ortografica: ortografica,
      mirarDesde: mirarDesde, construirMalla: construirMalla,
      construirClima: construirClima
    }
  };
})();
