/* ─────────────────────────────────────────────────────────────────────────
   El botón del árbol y su diálogo.

   Vive en la esquina inferior derecha de la bóveda. Al pulsarlo pregunta dos
   cosas —con qué permiso y qué parte— y devuelve el enlace dibujado como un
   árbol (ver arbolqr.js).

   El diálogo se construye aquí, en JavaScript, y no en notes.html: así el
   único cambio en la plantilla son las dos etiquetas que cargan esto, y la
   vuelta atrás es borrar dos líneas.

   La ruta de lo que se comparte sale de la fila activa del árbol de la
   izquierda (`.tree-row.active`), no de una variable de notes.js: es lo que
   permite no tocar ese fichero de 113 KB para nada.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var ALCANCES = [
    { id: 'subnota', et: 'Sólo esta nota',    ayuda: 'El fichero suelto, sin sus subnotas.' },
    { id: 'nota',    et: 'La nota entera',    ayuda: 'La nota y todas sus subnotas.' },
    { id: 'carpeta', et: 'Toda la carpeta',   ayuda: 'La carpeta que la contiene, entera.' },
    { id: 'boveda',  et: 'Todas las carpetas', ayuda: 'La bóveda completa.' }
  ];

  var estado = { permiso: 'lectura', alcance: 'nota', ocupado: false, vista: '3d' };
  var caja = null;
  var escena3d = null;   // la escena WebGL del diálogo, mientras está abierto

  function rutaActiva() {
    var fila = document.querySelector('#vault-tree .tree-row.active');
    return fila ? (fila.dataset.path || '') : '';
  }

  /* Escritura sobre un fichero suelto no existe: el acceso acotado se define
     por la carpeta que hace de raíz, y un .md no puede ser raíz de nada. El
     servidor lo rechaza igual; esto solo evita que se pueda pedir. */
  function combinacionValida(permiso, alcance) {
    if (permiso === 'escritura' && alcance === 'subnota') return false;
    return true;
  }

  function necesitaRuta(alcance) { return alcance !== 'boveda'; }

  /* ── El ajuste de Compartir, guardado ─────────────────────────────────────

     Antes `estado` vivía sólo en memoria: al recargar volvía a "la nota
     abierta, en lectura", y el árbol de la esquina repartía eso aunque en la
     ruedita hubieras elegido otra cosa hace un minuto. Un ajuste que se olvida
     al recargar no es un ajuste.

     Va en localStorage y no en el servidor porque no es un dato de la bóveda:
     es una preferencia de este aparato, como el tema. */
  var CLAVE_AJUSTES = 'l-notes.qr.compartir';
  var PERMISOS = ['lectura', 'escritura'];

  function esAlcance(v) {
    return ALCANCES.some(function (a) { return a.id === v; });
  }

  function cargarAjustes() {
    var g;
    // Se valida contra las listas en vez de aceptar lo que venga: lo guardado
    // puede ser de una versión anterior con otros alcances, o de una
    // combinación que entonces valía y ahora no.
    try { g = JSON.parse(localStorage.getItem(CLAVE_AJUSTES) || '{}'); }
    catch (e) { return; }        // localStorage capado, o JSON de otra época
    if (PERMISOS.indexOf(g.permiso) >= 0) estado.permiso = g.permiso;
    if (esAlcance(g.alcance)) estado.alcance = g.alcance;
    if (!combinacionValida(estado.permiso, estado.alcance)) estado.alcance = 'nota';
  }

  function guardarAjustes() {
    try {
      localStorage.setItem(CLAVE_AJUSTES, JSON.stringify({
        permiso: estado.permiso, alcance: estado.alcance
      }));
    } catch (e) { /* modo privado o cuota llena: no es motivo para romper nada */ }
  }

  /* Qué se acaba de repartir, en una línea.

     El árbol de la esquina no enseña el enlace en texto —sólo se escanea—, así
     que sin esto no queda ni una pista de si lo que ha salido es de lectura o
     una invitación de editor. Va al rótulo del botón. */
  function etiquetaReparto(necesitaCuenta) {
    var a = ALCANCES.filter(function (x) { return x.id === estado.alcance; })[0];
    return (a ? a.et : estado.alcance) + ' · ' +
           (necesitaCuenta ? 'lectura y escritura' : 'sólo lectura');
  }

  function svgArbolito() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' +
      '<path d="M12 21v-5"/>' +
      '<path d="M12 16c-3.3 0-6-2.5-6-5.6C6 6.9 8.7 4 12 4s6 2.9 6 6.4c0 3.1-2.7 5.6-6 5.6z"/>' +
      '<path d="M9.5 10.5 12 12l2.5-1.5"/></svg>';
  }

  /* ── El jardín de la esquina ──────────────────────────────────────────────
     En reposo es DECORATIVO: un jardín con su árbol y un QR genérico que sólo
     está ahí para dar forma al pavimento. No codifica nada tuyo y no crea
     ningún enlace — mirar la esquina no comparte nada.

     Al pulsarlo sí: se pide al servidor el enlace de verdad, con el alcance y
     el permiso que tengas en Ajustes → Compartir (por defecto, la nota
     abierta en lectura), se replanta el jardín con ESE código y la cámara
     sube a enseñarlo.

     El jardín conserva su estación, su color y su modelo al replantarse con
     el código: es el mismo sitio, con el enlace bueno en el suelo.

     Pero NO es siempre el mismo jardín. Cambia al recargar la página y al
     pasar a otra nota o carpeta, así que uno se encuentra estaciones y
     copas distintas a lo largo del día. La semilla junta las dos cosas: un
     número de esta carga y la ruta abierta. */
  var SESION = String(Math.random()).slice(2);

  function semillaJardin() {
    return SESION + '|' + (rutaActiva() || 'boveda');
  }

  /* Lo que codifica el QR decorativo. Cambia con la semilla para que cambie
     también la GEOMETRÍA del árbol —que la firma la matriz—, y no sólo el
     color. No es un enlace: si alguien lo escanea, sale este texto. */
  function textoJardin() {
    return 'l-notes · jardín · ' + semillaJardin();
  }

  /* ── Esperar a que la ruta se asiente ─────────────────────────────────────

     Al entrar en la bóveda, `rutaActiva()` no vale todavía lo que va a valer:
     empieza vacía y va cambiando sola —a la nota que estaba abierta, y a lo
     que la bóveda vaya restaurando— conforme llega `/api/notes/tree`. Como la
     semilla del jardín cuelga de ella, plantar en el primer instante obligaba
     a replantar dos o tres veces seguidas, y cada replante reiniciaba el
     crecimiento: el árbol brotaba, se borraba y volvía a brotar.

     Así que no se planta hasta que la ruta lleva un rato sin moverse. Cuesta
     algo más de un segundo y no se pierde nada por el camino: el botón se
     queda mientras con su icono plano y con el atajo de compartir puesto, así
     que si alguien lo pulsa en ese rato responde igual. */
  var ESPERA = 300, ESTABLES = 3, TOPE = 12;   // 0,9 s de calma, 3,6 s de tope

  function alAsentarseLaRuta(hacer) {
    var previa = rutaActiva(), quieta = 0, vueltas = 0;
    var reloj = setInterval(function () {
      var ahora = rutaActiva();
      if (ahora !== previa) { previa = ahora; quieta = 0; } else { quieta++; }
      /* El tope es por si la ruta no se asienta nunca —una bóveda vacía, o el
         árbol de la izquierda que no llega a pintarse—: más vale un jardín
         plantado sobre la ruta que haya que quedarse sin jardín. */
      if (quieta >= ESTABLES || ++vueltas >= TOPE) {
        clearInterval(reloj);
        hacer();
      }
    }, ESPERA);
  }

  function montarEsquina(boton) {
    if (!window.Arbol3D || !window.qrcode) return false;

    var lienzo = document.createElement('canvas');
    lienzo.className = 'aq-lienzo3d';
    lienzo.setAttribute('aria-hidden', 'true');
    boton.appendChild(lienzo);

    // El sorteo vigente se guarda: al replantar con el código real se le pasa
    // el mismo, así que el jardín no cambia de estación ni de color a mitad
    // de la transición. Se renueva sólo al cambiar de nota.
    var jardin = window.Arbol3D.sorteo(semillaJardin());
    var escena;
    try {
      // Sin fondo: el diorama se recorta sobre la página, no sobre un cuadro.
      escena = window.Arbol3D.crear(lienzo, textoJardin(), jardin, {});
      if (!escena) { lienzo.remove(); return false; }
    } catch (e) {
      // Sin WebGL, o con un driver que se atraganta: el botón se queda con su
      // icono plano y todo lo demás sigue funcionando igual.
      lienzo.remove();
      return false;
    }

    boton.classList.add('con3d');
    var pidiendo = false;
    var fase = 0;   // 0 rincón · 1 centrado con el jardín · 2 enseñando el QR

    /* Mover del rincón al centro animando `width`/`top` sale a tirones y deja
       el canvas borroso mientras dura. Esto es FLIP: se pone YA la posición
       final, se mide, y se aplica al vuelo la transformación inversa para
       devolverlo visualmente al sitio de partida; al soltarla, el navegador
       anima sólo el `transform` —que va en la GPU— y al terminar el canvas ya
       está en su tamaño real, así que se redibuja nítido en vez de escalado. */
    function mover(alCentro) {
      var antes = boton.getBoundingClientRect();
      boton.classList.toggle('centrado', alCentro);
      var luego = boton.getBoundingClientRect();

      boton.style.transition = 'none';
      boton.style.transformOrigin = 'top left';
      boton.style.transform = 'translate(' +
        (antes.left - luego.left) + 'px,' + (antes.top - luego.top) + 'px) scale(' +
        (antes.width / luego.width) + ',' + (antes.height / luego.height) + ')';
      void boton.offsetWidth;                       // fuerza el reflow
      boton.style.transition = 'transform .55s cubic-bezier(.22,.9,.28,1)';
      boton.style.transform = '';
    }

    // Un velo detrás del jardín ampliado: enfoca, y da una salida evidente.
    var velo = document.createElement('div');
    velo.className = 'aq-velo-jardin';
    document.body.appendChild(velo);

    var reparto = '';   // qué se acaba de repartir, para el rótulo de la fase 2

    function rotular() {
      boton.title = fase === 0 ? 'Abrir el jardín'
                  : fase === 1 ? 'Generar el QR para compartir'
                  : 'Volver al rincón' + (reparto ? ' · ' + reparto : '');
      boton.setAttribute('aria-label', boton.title);
    }
    rotular();

    function alRincon() {
      fase = 0;
      /* El enlace deja de estar a la vista de quien pase por delante, y por lo
         mismo que a la ida va colgado del vuelo: en el pico la copa ya tapa el
         suelo, así que ese es el último fotograma en que el código se ve. */
      escena.cenital(false, { texto: textoJardin(), sorteo: jardin, recrecer: true });
      mover(false);
      velo.classList.remove('visible');
      reparto = '';
      rotular();
    }

    /* Otra nota, otro jardín. Se mira por sondeo y no con un MutationObserver
       sobre el árbol de la izquierda porque ahí cambian clases sin parar
       —hover, arrastre, plegado— y esto sólo necesita enterarse de una cosa:
       que la nota abierta ya no es la de antes. */
    var ultima = rutaActiva();
    /* La ruta ya viene quieta: `alAsentarseLaRuta` no deja llegar aquí hasta
       que lleva casi un segundo sin moverse, que es lo que evita la tanda de
       replantes de la carga.

       Pero quieta no es lo mismo que definitiva —la bóveda puede restaurar
       algo con retraso, o el tope de espera puede haber saltado antes de
       tiempo—, así que se conserva la red: durante los dos primeros pases la
       resiembra va CALLADA, cambiando el jardín por debajo sin volver a
       crecer. Después ya brota con cada cambio, que es lo que tiene que hacer
       al pasar de una nota a otra.

       El tercer argumento de `regenerar` es el que lleva eso, y hasta ahora no
       existía en arbol3d.js: la función tomaba dos parámetros y reiniciaba el
       crecimiento siempre. Escrito estaba; conectado, no. */
    var asentado = false;
    var quieta = 0;
    setInterval(function () {
      if (document.hidden || fase !== 0) return;   // no en mitad del QR
      var ahora = rutaActiva();
      if (ahora !== ultima) {
        ultima = ahora;
        quieta = 0;
        jardin = window.Arbol3D.sorteo(semillaJardin());
        escena.regenerar(textoJardin(), jardin, !asentado);
        return;
      }
      if (!asentado && ++quieta >= 2) asentado = true;
    }, 600);

    velo.addEventListener('click', function () { if (fase) alRincon(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && fase) alRincon();
    });

    boton.addEventListener('click', function () {
      if (pidiendo) return;

      if (fase === 0) {                    // rincón → centro, todavía jardín
        fase = 1;
        mover(true);
        velo.classList.add('visible');
        rotular();
        return;
      }

      if (fase === 2) return alRincon();   // ya enseñó el código

      // fase 1 → el enlace de verdad, y ahí sí la transición a cenital.
      pidiendo = true;
      boton.classList.add('pidiendo');
      pedirEnlace()
        .then(function (j) {
          /* Mismo jardín, ahora con el código bueno en el suelo — y el cambio
             va COLGADO del vuelo: se monta en su pico, con la copa tapando el
             suelo, en vez de antes de despegar. Ver `cenital` en arbol3d.js.

             Hacerlo antes era lo que rompía la transición: la malla se rehace
             entera con el código nuevo, y como la geometría la firma la matriz
             —altura, ramas, lo tupida que va la copa—, el árbol del rincón
             desaparecía y otro distinto empezaba a brotar mientras la cámara
             giraba. Lo que se veía no era este árbol dándose la vuelta. */
          escena.cenital(true, { texto: j.url, sorteo: jardin });
          fase = 2;
          reparto = etiquetaReparto(j.necesita_cuenta);
          rotular();
        })
        .catch(function (e) {
          // No se puede compartir con lo que hay configurado (por ejemplo,
          // alcance "nota" y ninguna abierta): se enseña el diálogo con los
          // ajustes, que es donde se arregla.
          abrir(true);
          fallo(e.message);
        })
        .finally(function () {
          pidiendo = false;
          boton.classList.remove('pidiendo');
        });
    });

    // Con la pestaña de fondo, el bucle de dibujo se para del todo: un canvas
    // meciéndose donde nadie mira es batería tirada.
    document.addEventListener('visibilitychange', function () {
      escena.pausar(document.hidden);
    });

    return true;
  }

  function construirDialogo() {
    var d = document.createElement('div');
    d.className = 'aq-velo';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Compartir con un código QR');

    d.innerHTML =
      '<div class="aq-panel">' +
        '<button class="aq-cerrar" aria-label="Cerrar">&times;</button>' +
        '<h2 class="aq-titulo" id="aq-titulo">Compartir con un árbol</h2>' +

        '<div class="aq-grupo">' +
          '<div class="aq-et">Permiso</div>' +
          '<div class="aq-ops" id="aq-permisos">' +
            '<button type="button" data-v="lectura" class="aq-op">Lectura</button>' +
            '<button type="button" data-v="escritura" class="aq-op">Lectura y escritura</button>' +
          '</div>' +
          '<p class="aq-nota" id="aq-nota-permiso"></p>' +
        '</div>' +

        '<div class="aq-grupo">' +
          '<div class="aq-et">Qué se comparte</div>' +
          '<div class="aq-ops aq-ops-col" id="aq-alcances"></div>' +
        '</div>' +

        '<div class="aq-acciones">' +
          '<button type="button" class="aq-generar" id="aq-generar">Generar el árbol</button>' +
        '</div>' +

        '<p class="aq-cargando" id="aq-cargando" hidden>Plantando el árbol…</p>' +

        '<div class="aq-salida" id="aq-salida" hidden>' +
          '<div class="aq-escena" id="aq-escena">' +
            '<canvas id="aq-3d"></canvas>' +
            '<div class="aq-plano" id="aq-plano" hidden></div>' +
          '</div>' +
          '<div class="aq-vistas">' +
            '<button type="button" class="aq-vista activa" data-vista="3d">Árbol</button>' +
            '<button type="button" class="aq-vista" data-vista="cenital">Cenital</button>' +
            '<button type="button" class="aq-vista" data-vista="plano">Plano</button>' +
          '</div>' +
          '<p class="aq-aviso" id="aq-aviso"></p>' +
          '<div class="aq-estacion" id="aq-estacion"></div>' +
          '<div class="aq-url"><input type="text" id="aq-enlace" readonly>' +
            '<button type="button" id="aq-copiar">Copiar</button></div>' +
          '<button type="button" class="aq-descargar" id="aq-descargar">Descargar SVG</button>' +
          '<p class="aq-pista" id="aq-pista">¿Otro alcance u otro permiso? ' +
            'Están en la ruedita de la bóveda, en <b>Compartir</b>.</p>' +
        '</div>' +

        '<p class="aq-error" id="aq-error" hidden></p>' +
      '</div>';

    var alcances = d.querySelector('#aq-alcances');
    ALCANCES.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'aq-op';
      b.dataset.v = a.id;
      b.innerHTML = '<span>' + a.et + '</span><small>' + a.ayuda + '</small>';
      alcances.appendChild(b);
    });

    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.closest('.aq-cerrar')) cerrar();
    });
    d.querySelector('#aq-permisos').addEventListener('click', function (e) {
      var b = e.target.closest('.aq-op'); if (!b) return;
      estado.permiso = b.dataset.v; pintarSeleccion(); guardarAjustes();
    });
    alcances.addEventListener('click', function (e) {
      var b = e.target.closest('.aq-op'); if (!b || b.disabled) return;
      estado.alcance = b.dataset.v; pintarSeleccion(); guardarAjustes();
    });
    d.querySelector('#aq-generar').addEventListener('click', generar);
    d.querySelector('#aq-copiar').addEventListener('click', copiar);
    d.querySelector('#aq-descargar').addEventListener('click', descargar);
    d.querySelector('.aq-vistas').addEventListener('click', function (e) {
      var b = e.target.closest('.aq-vista');
      if (b) cambiarVista(b.dataset.vista);
    });
    // Como en la referencia: se toca el árbol y la cámara sube a ver el QR.
    d.querySelector('#aq-3d').addEventListener('click', function () {
      if (!escena3d) return;
      cambiarVista(escena3d.esCenital() ? '3d' : 'cenital');
    });

    return d;
  }

  /* Tres vistas, y la diferencia entre ellas no es estética:

       árbol   — en perspectiva. Bonito, y un QR en perspectiva NO se escanea.
       cenital — la cámara justo encima: la matriz se ve recta y ya se lee.
       plano   — el SVG de siempre, que es el que escanea sin discusión y el
                 que se descarga.

     Por eso el aviso cambia con la vista: si alguien va a acercar el móvil,
     tiene que saber a cuál. */
  function cambiarVista(cual) {
    if (!caja) return;
    estado.vista = cual;
    caja.querySelectorAll('.aq-vista').forEach(function (b) {
      b.classList.toggle('activa', b.dataset.vista === cual);
    });

    var plano = caja.querySelector('#aq-plano');
    var lienzo3d = caja.querySelector('#aq-3d');
    var esPlano = cual === 'plano';
    plano.hidden = !esPlano;
    lienzo3d.hidden = esPlano;

    if (escena3d && !esPlano) escena3d.cenital(cual === 'cenital');

    caja.querySelector('#aq-aviso').textContent = cual === '3d'
      ? 'Toca el árbol para ver el QR desde arriba.'
      : 'Esta vista sí se escanea.';
  }

  function pintarSeleccion() {
    if (!caja) return;
    caja.querySelectorAll('#aq-permisos .aq-op').forEach(function (b) {
      b.classList.toggle('activa', b.dataset.v === estado.permiso);
    });

    caja.querySelectorAll('#aq-alcances .aq-op').forEach(function (b) {
      var ok = combinacionValida(estado.permiso, b.dataset.v);
      b.disabled = !ok;
      b.classList.toggle('vetada', !ok);
      b.classList.toggle('activa', ok && b.dataset.v === estado.alcance);
    });

    // Si la combinación elegida deja de valer, se cae a la más parecida — y se
    // guarda la corrección, o al recargar volvería la combinación imposible.
    if (!combinacionValida(estado.permiso, estado.alcance)) {
      estado.alcance = 'nota';
      guardarAjustes();
      return pintarSeleccion();
    }

    var nota = caja.querySelector('#aq-nota-permiso');
    nota.textContent = estado.permiso === 'escritura'
      ? 'Quien escanee tendrá que iniciar sesión: escribir exige cuenta.'
      : 'Enlace público. Quien escanee lo abre sin cuenta, y sólo puede leer.';
  }

  function fallo(msg) {
    var p = caja.querySelector('#aq-error');
    p.textContent = msg;
    p.hidden = !msg;
  }

  /* Pide al servidor el enlace con lo que haya configurado ahora mismo:
     alcance y permiso salen de `estado`, que es lo que toca la ruedita. Lo
     usan los dos sitios que comparten —el diálogo y el jardín de la esquina—
     para que no haya dos versiones de la misma regla. */
  function pedirEnlace() {
    var ruta = rutaActiva();
    if (necesitaRuta(estado.alcance) && !ruta) {
      return Promise.reject(new Error(
        'Abre antes una nota, o elige aquí compartir la bóveda entera.'));
    }
    return fetch('/api/notes/qr/crear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alcance: estado.alcance, permiso: estado.permiso, path: ruta
      })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j.success) {
          throw new Error(res.j.error || 'No se pudo crear el enlace');
        }
        return res.j;
      });
  }

  function generar() {
    if (estado.ocupado) return;
    fallo('');
    estado.ocupado = true;
    var boton = caja.querySelector('#aq-generar');
    boton.disabled = true;
    boton.textContent = 'Generando…';
    // En el camino rápido el botón está oculto, así que sin esto el diálogo
    // se queda un instante en blanco y parece que no ha hecho nada.
    caja.querySelector('#aq-cargando').hidden = false;

    pedirEnlace()
      .then(function (j) { pintarArbol(j.url, j.necesita_cuenta); })
      .catch(function (e) { fallo(e.message); })
      .finally(function () {
        estado.ocupado = false;
        boton.disabled = false;
        boton.textContent = 'Generar el árbol';
        caja.querySelector('#aq-cargando').hidden = true;
      });
  }

  function pintarArbol(url, necesitaCuenta) {
    var pal = window.ArbolQR.paletaAlAzar();

    // El plano: el SVG de siempre. Es el que escanea seguro y el que se baja.
    var plano = caja.querySelector('#aq-plano');
    plano.textContent = '';
    plano.appendChild(window.ArbolQR.construir(url, pal));

    caja.querySelector('#aq-salida').hidden = false;   // hay que verlo para medirlo

    if (escena3d) { escena3d.destruir(); escena3d = null; }
    var lienzo3d = caja.querySelector('#aq-3d');
    var hay3d = false;
    try {
      // El crema del fondo es el mismo del diorama de referencia: sobre el
      // panel oscuro del tema, la losa necesita su propia luz para no
      // quedarse flotando en negro.
      // Sembrado con la propia URL: el mismo enlace da siempre el mismo
      // árbol, aquí y en cualquier otro sitio donde se dibuje.
      escena3d = window.Arbol3D &&
        window.Arbol3D.crear(lienzo3d, url, window.Arbol3D.sorteo(url),
                             { fondo: [0.965, 0.945, 0.906] });
      hay3d = !!escena3d;
    } catch (e) { escena3d = null; }

    // Sin WebGL no hay vistas que elegir: se queda el plano y se dice.
    caja.querySelector('.aq-vistas').hidden = !hay3d;
    cambiarVista(hay3d ? '3d' : 'plano');
    if (!hay3d) {
      caja.querySelector('#aq-aviso').textContent =
        'Este navegador no trae WebGL, así que el árbol va en plano.';
    }

    // Con 3D manda su sorteo (estación, color de copa y modelo, los tres al
    // azar y los tres independientes); sin 3D, el del SVG.
    var pie = hay3d ? escena3d.sorteo.nombre
                    : pal.estacion.nombre + ' · tono ' + pal.tono;
    caja.querySelector('#aq-estacion').textContent =
      pie + (necesitaCuenta ? ' · pide iniciar sesión' : ' · enlace público');
    caja.querySelector('#aq-enlace').value = url;
  }

  function copiar() {
    var campo = caja.querySelector('#aq-enlace');
    campo.select();
    var hecho = function () {
      var b = caja.querySelector('#aq-copiar');
      b.textContent = 'Copiado';
      setTimeout(function () { b.textContent = 'Copiar'; }, 1600);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(campo.value).then(hecho, function () {});
    } else {
      try { document.execCommand('copy'); hecho(); } catch (e) {}
    }
  }

  function descargar() {
    // Siempre el plano: es el que escanea, y un PNG del canvas 3D en
    // perspectiva sería un adorno que no sirve para lo que se descarga.
    var svg = caja.querySelector('#aq-plano svg');
    if (!svg) return;
    var texto = new XMLSerializer().serializeToString(svg);
    var url = URL.createObjectURL(new Blob([texto], { type: 'image/svg+xml' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'arbol-qr.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /**
   * @param {boolean} conAjustes  true = se ven los selectores (viene de la
   *   ruedita); false = sólo el resultado (viene del árbol de la esquina).
   */
  function abrir(conAjustes) {
    if (!caja) {
      caja = construirDialogo();
      document.body.appendChild(caja);
    }
    caja.classList.toggle('solo-resultado', !conAjustes);
    caja.querySelector('#aq-titulo').textContent = conAjustes
      ? 'Compartir con un árbol'
      : 'Tu árbol';
    caja.querySelector('#aq-salida').hidden = true;
    caja.querySelector('#aq-cargando').hidden = true;
    fallo('');
    pintarSeleccion();
    caja.classList.add('abierto');
    document.addEventListener('keydown', alEscape);
  }

  /* El camino del árbol de la esquina cuando no hay WebGL: se comparte con lo
     que haya en Ajustes → Compartir, y a generar sin preguntar nada.

     Antes forzaba aquí "la nota abierta, en lectura" pasara lo que pasara, por
     miedo a repartir escritura por inercia. Ahora manda el ajuste, que es lo
     que se pidió — y hay que saber lo que eso implica: con "Lectura y
     escritura" seleccionado, un toque en el árbol crea una invitación de
     editor sin más confirmación. El rótulo del botón dice lo que ha salido, y
     el permiso se cambia en la ruedita de la bóveda, en Compartir.

     La comprobación de la ruta va contra el alcance y no a secas: compartir la
     bóveda entera no necesita ninguna nota abierta, y exigirla era mandar al
     usuario a un error que no tenía. Cuando sí hace falta y no la hay, se
     enseñan los ajustes: es la única forma de que pueda elegir la bóveda
     entera en vez de quedarse mirando el error. */
  function abrirRapido() {
    if (necesitaRuta(estado.alcance) && !rutaActiva()) {
      abrir(true);
      fallo('Abre antes una nota, o elige aquí compartir la bóveda entera.');
      return;
    }
    abrir(false);
    generar();
  }

  function cerrar() {
    if (!caja) return;
    caja.classList.remove('abierto');
    document.removeEventListener('keydown', alEscape);
    // Un canvas con su bucle rAF detrás de un diálogo cerrado es batería
    // tirada. Se vuelve a montar al generar el siguiente.
    if (escena3d) { escena3d.destruir(); escena3d = null; }
  }

  function alEscape(e) { if (e.key === 'Escape') cerrar(); }

  function iniciar() {
    // Sólo en la bóveda: en la nota compartida pública no pinta nada.
    if (!document.getElementById('vault-tree')) return;

    // Lo primero, porque de esto depende lo que reparta el árbol de la esquina
    // y el árbol de la esquina puede pulsarse antes de que se abra el diálogo.
    cargarAjustes();

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'aq-boton';
    b.title = 'Compartir con un código QR';
    b.setAttribute('aria-label', 'Compartir con un código QR');
    b.innerHTML = svgArbolito();
    document.body.appendChild(b);

    /* Con 3D, el clic hace la transición al QR y nada más — lo pone
       `montarEsquina`. Sin 3D el botón se quedaría muerto, así que ahí sí vale
       como atajo para compartir.

       Y mientras se espera a que la ruta se asiente, el atajo va puesto
       también: el botón está en pantalla desde el primer momento y no puede
       quedarse un segundo sin hacer nada al pulsarlo. */
    b.addEventListener('click', abrirRapido);
    alAsentarseLaRuta(function () {
      b.removeEventListener('click', abrirRapido);
      if (!montarEsquina(b)) b.addEventListener('click', abrirRapido);
    });

    // "Compartir" en la ruedita de la bóveda: el mismo diálogo, pero con los
    // selectores a la vista. El menú lo cierra `notes.js` con esa clase, así
    // que se hace igual aquí en vez de tocar aquel fichero.
    var enMenu = document.getElementById('vsm-compartir');
    if (enMenu) {
      enMenu.addEventListener('click', function () {
        var menu = document.getElementById('vault-settings-menu');
        if (menu) menu.classList.add('hidden');
        var rueda = document.getElementById('btn-img-dir');
        if (rueda) rueda.setAttribute('aria-expanded', 'false');
        abrir(true);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
