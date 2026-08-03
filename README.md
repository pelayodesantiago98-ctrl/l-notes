<p align="center">
  <img src="assets/logo.png" width="120" alt="L-notes">
</p>

<h1 align="center">L-notes</h1>
<p align="center">Bóveda de notas en Markdown, autoalojada y minimalista.</p>
<p align="center"><a href="https://maalfer.github.io/cogny/">maalfer.github.io/cogny</a></p>
<p align="center">
  <a href="https://github.com/Maalfer/cogny/releases"><img src="https://img.shields.io/badge/versi%C3%B3n-0.1.0-06b6d4" alt="Versión"></a>
</p>

<p align="center"><img src="assets/screenshots/lnotes-boveda.png" width="850" alt="Bóveda de notas"></p>

> **Despliegue en producción.** Esta instancia corre en `l-notes.lepayimio.es`
> bajo gunicorn en `127.0.0.1:8002`, detrás de nginx y Cloudflare. La
> configuración del servidor (vhost, unit de systemd, certificados) vive en el
> repositorio privado `lepayimio-infra`, no aquí.

## Descripción

L-notes es una aplicación web de notas al estilo Obsidian construida con Django. Las notas viven como archivos Markdown en disco, organizadas en carpetas, sin depender de una base de datos para el contenido. Incluye editor con resaltado de código, fórmulas, diagramas, adjuntos y exportación a PDF con fidelidad completa.

## Capturas

<table>
<tr>
<td width="50%"><img src="assets/screenshots/lnotes-diagramas.png" alt="Diagramas"><br><sub>Los diagramas se escriben en texto y se dibujan solos.</sub></td>
<td width="50%"><img src="assets/screenshots/lnotes-formulas.png" alt="Fórmulas"><br><sub>Fórmulas con KaTeX, en bloque y en línea.</sub></td>
</tr>
<tr>
<td><img src="assets/screenshots/lnotes-busqueda.png" alt="Búsqueda"><br><sub>Búsqueda instantánea por nombre y por contenido.</sub></td>
<td><img src="assets/screenshots/lnotes-temas.png" alt="Temas"><br><sub>Siete temas; el elegido queda guardado en la cuenta.</sub></td>
</tr>
<tr>
<td><img src="assets/screenshots/lnotes-cristal.png" alt="Tema cristal"><br><sub>El tema cristal, en claro.</sub></td>
<td><img src="assets/screenshots/lnotes-movil.png" alt="En el móvil"><br><sub>En el móvil, instalable como aplicación.</sub></td>
</tr>
</table>

<sub>Capturas de esta instancia, con una bóveda de ejemplo.</sub>

## Características

- Notas en Markdown organizadas en carpetas, guardadas como archivos en disco.
- Editor con resaltado de sintaxis, fórmulas (KaTeX), diagramas (Mermaid) y callouts.
- Exportación de notas a PDF, con imágenes y estilos incrustados.
- Búsqueda instantánea por nombre y por contenido.
- Optimización de imágenes a WebP, al subirlas o en bloque para toda la bóveda, con backup ZIP previo opcional.
- Importación y exportación de la bóveda completa en un único ZIP.
- Progressive Web App instalable, con caché de estáticos para uso offline.

## Stack

- **Backend**: Django + gunicorn (WSGI).
- **Datos**: SQLite para cuentas de usuario; las notas y adjuntos son archivos en disco.
- **Frontend**: JavaScript nativo, sin framework ni paso de compilación.
- **Exportación a PDF**: Chromium headless.

## Desarrollo local

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # completa DJANGO_SECRET_KEY y las rutas de datos
python manage.py migrate
python manage.py runserver
```

### Con Docker

```bash
docker compose up --build
```

Levanta L-notes en `http://localhost:8000`. Las notas, avatares y la base de datos
se persisten en `./data`. Para crear el primer usuario:

```bash
docker compose exec web python manage.py createsuperuser
```

## Despliegue

`scripts/l-notes.service` es la referencia de la unidad systemd usada en producción (gunicorn detrás de un proxy inverso con TLS). Tras cualquier cambio en los estáticos, ejecuta `collectstatic`, sube `ASSET_VERSION` en `.env` y reinicia el servicio para invalidar la caché.

## Créditos

L-notes está basado en **[cogny](https://github.com/Maalfer/cogny)**, de
**[Maalfer](https://github.com/Maalfer)** — el proyecto original del que parte
todo este código. Gracias por publicarlo.

Esta versión cambia la marca y añade, sobre aquella base, la entrada por SSO
desde el portal, los temas cristal y algunos ajustes de interfaz. El diseño, la
arquitectura y el grueso de la aplicación son suyos.
