"""Vistas del vault (sesión + CSRF): las consume el frontend de la web.

Aquí sólo vive la capa HTTP —validar lo que llega, traducir el resultado a
JSON—. Todo lo que toca el disco está en `vault.py` y la exportación a PDF en
`pdf.py`, para que la API v1 (`apps.api.views`) pueda reutilizar exactamente la
misma implementación sin pasar por estas vistas.
"""
import json
import re
import secrets
import shutil
import tempfile
from pathlib import Path
from urllib.parse import quote

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.contrib.auth.hashers import check_password, make_password
from django.core import signing
from django.http import FileResponse, Http404, HttpResponse, JsonResponse, StreamingHttpResponse
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from apps.accounts.models import AccesoBoveda
from apps.accounts.permissions import require_write
from apps.core import boveda
from apps.core.api import as_text, error_response as _err, json_body

# Envio de correo. Vive fuera del proyecto, en /usr/local/lib/lepayimio,
# porque lo comparten varios servicios; el venv lo encuentra por un .pth.
import correo

from . import cherrytree, pdf, vault
from .models import CarpetaCompartida, SharedNote
from .vault import VaultError


def _resolve(root: Path, rel):
    """`(ruta, None)`, o `(None, respuesta de error)` si la ruta no es válida."""
    try:
        return vault.safe_path(root, rel), None
    except VaultError as exc:
        return None, _err(str(exc), exc.status)


# ════════════ Vault ════════════


def _rama_de(root, ruta: Path) -> Path:
    """La carpeta de una nota que tiene hijos; la propia ruta si no los tiene.

    Una nota con subnotas vive en `X/X.md`, y lo que hay que mover, renombrar o
    borrar es `X/` entera. Sin esto, mover la nota dejaba a sus hijos atrás.
    """
    try:
        if ruta.is_file() and ruta.suffix.lower() == ".md" and vault.es_contenedor(root, ruta):
            return ruta.parent
    except (OSError, ValueError):
        pass
    return ruta


@login_required
def index(request):
    boveda.raiz(request)  # crea su bóveda la primera vez que entra
    return render(request, "notes/notes.html", {})


@login_required
@require_GET
def tree(request):
    root = boveda.raiz(request)
    return JsonResponse({"tree": vault.build_tree(root, root)})


@login_required
@require_GET
def file_get(request):
    root = boveda.raiz(request)
    target, err = _resolve(root, request.GET.get("path", ""))
    if err:
        return err
    if not target.exists() or target.suffix.lower() != ".md":
        return _err("Nota no encontrada", 404)
    return JsonResponse({
        "path": vault.rel_of(root, target),
        "name": target.stem,
        "content": target.read_text(encoding="utf-8"),
    })


@login_required
@require_write
@require_POST
@json_body
def file_save(request):
    root = boveda.raiz(request)
    content = request.data.get("content")
    if content is None:
        content = ""
    if not isinstance(content, str):
        return _err("'content' debe ser texto")
    if len(content.encode("utf-8")) > vault.MAX_NOTE_BYTES:
        return _err("Nota demasiado grande (máx. 5 MB)")
    target, err = _resolve(root, as_text(request.data.get("path")).strip())
    if err:
        return err
    if target.suffix.lower() != ".md":
        return _err("Solo se permiten archivos .md")
    target.parent.mkdir(parents=True, exist_ok=True)
    vault.write_text_atomic(target, content)
    return JsonResponse({"success": True, "path": vault.rel_of(root, target),
                         "updated": int(target.stat().st_mtime)})


@login_required
@require_write
@require_POST
@json_body
def create(request):
    root = boveda.raiz(request)
    name = vault.sanitize_name(request.data.get("name"))
    if not name:
        return _err("Nombre inválido")
    parent_dir, err = _resolve(root, as_text(request.data.get("parent")).strip())
    if err:
        return err

    # El padre puede ser una nota, no solo una carpeta: es lo que permite
    # colgar una subnota de otra nota. Se convierte en contenedor al vuelo
    # —pasa de Tema.md a Tema/Tema.md— y los hijos van dentro.
    if parent_dir.is_file() and parent_dir.suffix.lower() == ".md":
        try:
            parent_dir = vault.convertir_en_contenedor(root, parent_dir).parent
        except (ValueError, OSError) as exc:
            return _err(str(exc) or "No he podido preparar la nota para tener subnotas")

    parent_dir.mkdir(parents=True, exist_ok=True)

    if request.data.get("type", "note") == "folder":
        target = parent_dir / name
        if target.exists():
            return _err("Ya existe una carpeta con ese nombre")
        target.mkdir()
        return JsonResponse({"success": True, "path": vault.rel_of(root, target),
                             "type": "folder"})

    fname = name if name.endswith(".md") else name + ".md"
    target = vault.free_path(parent_dir, Path(fname).stem, ".md")
    vault.write_text_atomic(target, "")
    return JsonResponse({"success": True, "path": vault.rel_of(root, target), "type": "note"})


@login_required
@require_write
@require_POST
@json_body
def rename(request):
    root = boveda.raiz(request)
    new_name = vault.sanitize_name(request.data.get("name"))
    if not new_name:
        return _err("Nombre inválido")
    src, err = _resolve(root, as_text(request.data.get("path")).strip())
    if err:
        return err
    if not src.exists():
        return _err("No existe", 404)

    # ── Nota con subnotas ───────────────────────────────────────────────────
    # Hay dos cosas que se llaman igual —la carpeta y el .md de dentro— y las
    # dos tienen que cambiar de nombre a la vez. Si solo cambiara el texto,
    # dejaría de llamarse como su carpeta, la nota perdería la condición de
    # contenedor y sus hijos aparecerían sueltos un nivel más arriba.
    if src.is_file() and src.suffix.lower() == ".md" and vault.es_contenedor(root, src):
        base = new_name[:-3] if new_name.endswith(".md") else new_name
        carpeta = src.parent
        nueva_carpeta = carpeta.parent / base

        if nueva_carpeta.exists() and nueva_carpeta != carpeta:
            return _err("Ya existe con ese nombre")

        old_rel_carpeta = vault.rel_of(root, carpeta)
        old_rel_nota = vault.rel_of(root, src)

        # Primero la carpeta y luego el texto de dentro: al revés, el .md
        # renombrado dejaría de coincidir con su carpeta durante un instante y
        # cualquier lectura entre medias vería la nota rota.
        carpeta.rename(nueva_carpeta)
        dentro_viejo = nueva_carpeta / src.name
        dentro_nuevo = nueva_carpeta / (base + ".md")
        if dentro_viejo.exists():
            dentro_viejo.rename(dentro_nuevo)

        vault.rename_in_order(carpeta.parent, carpeta.name, nueva_carpeta.name)
        # Los enlaces públicos: el de la propia nota y el de todo lo que cuelga.
        vault.move_shares(old_rel_carpeta, vault.rel_of(root, nueva_carpeta), True)
        vault.move_shares(old_rel_nota, vault.rel_of(root, dentro_nuevo), False)
        return JsonResponse({"success": True, "path": vault.rel_of(root, dentro_nuevo)})

    if src.is_file() and src.suffix.lower() == ".md" and not new_name.endswith(".md"):
        new_name += ".md"
    dst = src.parent / new_name
    if dst.exists() and dst != src:
        return _err("Ya existe con ese nombre")
    old_rel, was_dir = vault.rel_of(root, src), src.is_dir()
    src.rename(dst)
    vault.rename_in_order(src.parent, src.name, dst.name)
    new_rel = vault.rel_of(root, dst)
    vault.move_shares(old_rel, new_rel, was_dir)
    return JsonResponse({"success": True, "path": new_rel})


@login_required
@require_write
@require_POST
@json_body
def move(request):
    """Mueve una nota/carpeta/archivo a otra carpeta (drag & drop del árbol).

    Solo reubica en el filesystem; el orden dentro de la carpeta destino lo
    fija el frontend con una llamada aparte a `reorder` (conoce la posición
    exacta donde se soltó, cosa que este endpoint no necesita saber).
    """
    root = boveda.raiz(request)
    src, err = _resolve(root, as_text(request.data.get("path")).strip())
    if err:
        return err
    dst_dir, err = _resolve(root, as_text(request.data.get("target")).strip())
    if err:
        return err
    # Si la nota tiene subnotas, lo que se mueve es su carpeta entera.
    src = _rama_de(root, src)

    if not src.exists() or src == root:
        return _err("No existe", 404)
    if src == root / vault.ATTACHMENTS_DIR:
        # Los adjuntos cuelgan SIEMPRE de esta ruta fija: moverla no rompe nada
        # (los embeds resuelven por nombre en todo el vault), pero la próxima
        # subida crearía una "Adjuntos" nueva y vacía en la raíz, duplicando la
        # carpeta. El frontend ya no deja arrastrarla; esto cierra el endpoint.
        return _err("La carpeta de adjuntos no se puede mover")
    # Soltar sobre una nota la convierte en contenedor y mete dentro lo que se
    # arrastró. Es lo que hace que el árbol se comporte como el de CherryTree:
    # arrastras una nota encima de otra y queda anidada, sin tener que crear
    # antes una carpeta a mano.
    if dst_dir.is_file() and dst_dir.suffix.lower() == ".md":
        if dst_dir == src:
            return _err("Una nota no puede colgar de sí misma")
        try:
            dst_dir = vault.convertir_en_contenedor(root, dst_dir).parent
        except (ValueError, OSError) as exc:
            return _err(str(exc) or "No he podido preparar la nota de destino")
        # La conversión mueve el .md destino, así que si lo que se arrastraba
        # estaba dentro hay que volver a mirar dónde ha quedado.
        if not src.exists():
            src = dst_dir / src.name

    if not dst_dir.exists() or not dst_dir.is_dir():
        return _err("Carpeta destino no encontrada", 404)
    if src.is_dir():
        try:
            dst_dir.relative_to(src)
            return _err("No se puede mover una carpeta dentro de sí misma")
        except ValueError:
            pass  # dst_dir no es src ni un descendiente: ok
    if dst_dir == src.parent:
        return JsonResponse({"success": True, "path": vault.rel_of(root, src)})
    dst = dst_dir / src.name
    if dst.exists():
        return _err("Ya existe un elemento con ese nombre en el destino")
    old_rel, was_dir = vault.rel_of(root, src), src.is_dir()
    shutil.move(str(src), str(dst))
    vault.remove_from_order(src.parent, src.name)
    new_rel = vault.rel_of(root, dst)
    vault.move_shares(old_rel, new_rel, was_dir)
    return JsonResponse({"success": True, "path": new_rel})


@login_required
@require_write
@require_POST
@json_body
def reorder(request):
    """Fija el orden manual de los hijos directos de una carpeta."""
    root = boveda.raiz(request)
    order = request.data.get("order")
    if not isinstance(order, list) or not all(isinstance(n, str) for n in order):
        return _err("Orden inválido")
    folder, err = _resolve(root, as_text(request.data.get("folder")).strip())
    if err:
        return err
    if not folder.exists() or not folder.is_dir():
        return _err("Carpeta no encontrada", 404)
    vault.set_order(folder, order)
    return JsonResponse({"success": True})


@login_required
@require_write
@require_POST
@json_body
def delete(request):
    root = boveda.raiz(request)
    target, err = _resolve(root, as_text(request.data.get("path")).strip())
    if err:
        return err
    # Una nota con subnotas se borra entera, con su carpeta y su descendencia.
    # El aviso de cuántas se van a llevar por delante lo da el cliente, que ya
    # tiene el árbol y sabe contarlas sin preguntar.
    target = _rama_de(root, target)

    if not target.exists() or target == root:
        return _err("No existe", 404)
    parent, name = target.parent, target.name
    rel_path, was_dir = vault.rel_of(root, target), target.is_dir()
    if was_dir:
        shutil.rmtree(target)
    else:
        target.unlink()
    vault.remove_from_order(parent, name)
    vault.drop_shares(rel_path, was_dir)
    return JsonResponse({"success": True})


@login_required
@require_GET
def search(request):
    root = boveda.raiz(request)
    terms = [t.lower() for t in (request.GET.get("q") or "").split() if t]
    if not terms:
        return JsonResponse({"results": []})
    return JsonResponse({"results": [
        {"path": vault.rel_of(root, f), "name": f.stem, "snippet": snippet,
         "updated": int(f.stat().st_mtime)}
        for f, snippet in vault.search_notes(root, terms, limit=50,
                                             snippet_before=40, snippet_after=80)
    ]})


@login_required
@require_GET
def storage(request):
    """Estadísticas de la bóveda: total, desglose por tipo y conteos."""
    return JsonResponse({"success": True, **vault.stats(boveda.raiz(request))})


@login_required
@require_write
@require_POST
def optimize_images(request):
    """Recodifica las imágenes de la bóveda a WebP, in-place.

    Responde NDJSON (una línea JSON por evento) para que el frontend pinte la
    barra de progreso en tiempo real. Los eventos los define `vault.optimize_images`.
    """
    def stream():
        for event in vault.optimize_images(boveda.raiz(request)):
            yield (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")

    resp = StreamingHttpResponse(stream(), content_type="application/x-ndjson")
    resp["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp["X-Accel-Buffering"] = "no"   # nginx: no bufferizar (flush inmediato)
    return resp


# ════════════ Adjuntos ════════════

@login_required
@require_write
@require_POST
def upload(request):
    """Sube un adjunto a la bóveda (imagen u otro archivo)."""
    f = request.FILES.get("file")
    if not f:
        return _err("Falta archivo")
    root = boveda.raiz(request)
    target = vault.save_upload(root, f)
    return JsonResponse({"success": True, "name": target.name,
                         "path": vault.rel_of(root, target)})


@login_required
@require_GET
def asset(request):
    root = boveda.raiz(request)
    try:
        target = vault.safe_path(root, request.GET.get("path", ""))
    except VaultError:
        raise Http404
    if not target.exists() or target.is_dir():
        raise Http404
    return FileResponse(open(target, "rb"))


# ════════════ Export / import ════════════

@login_required
@require_GET
def export_vault(request):
    tmp, size = vault.export_zip(boveda.raiz(request))
    resp = FileResponse(tmp, content_type="application/zip")
    fname = vault.sanitize_name(request.user.username) or "vault"
    resp["Content-Disposition"] = f'attachment; filename="vault-{fname}.zip"'
    resp["Content-Length"] = str(size)
    return resp


@login_required
@require_write
@require_POST
def import_vault(request):
    f = request.FILES.get("file")
    if not f:
        return _err("Falta archivo")
    try:
        vault.import_zip(boveda.raiz(request), f, request.POST.get("mode", "merge"))
    except VaultError as exc:
        return _err(str(exc), exc.status)
    return JsonResponse({"success": True})


@login_required
@require_write
@require_POST
def import_cherrytree(request):
    """Sube un .ctb y lo importa al vault del usuario autenticado.

    Body (multipart/form-data):
        file:   el .ctb (obligatorio)
        target: ruta destino dentro del vault, p.ej. "Importado" (opcional)

    Si `target` no existe, se crea. Si ya hay notas con el mismo nombre, los
    nuevos se numeran al estilo del resto del vault (no se sobrescribe nada).
    """
    f = request.FILES.get("file")
    if not f:
        return _err("Falta archivo")
    if not (f.name or "").lower().endswith(".ctb"):
        return _err("El archivo debe ser un .ctb de CherryTree")

    target_rel = (request.POST.get("target") or "").strip().strip("/")
    root = boveda.raiz(request)
    target_dir = root
    if target_rel:
        try:
            target_dir = vault.safe_path(root, target_rel)
        except VaultError as exc:
            return _err(str(exc), exc.status)
        if target_dir.exists() and not target_dir.is_dir():
            return _err("La ruta destino no es una carpeta")
        target_dir.mkdir(parents=True, exist_ok=True)

    # Volcamos el upload a un tempfile en disco. El parser abre el .ctb con
    # sqlite3 en modo ro y necesita una ruta real; pasarle el UploadedFile de
    # Django obliga a drenarlo a memoria, que en bóvedas grandes se nota.
    try:
        with tempfile.NamedTemporaryFile(
            prefix="lnotes-ctb-", suffix=".ctb", delete=False, dir="/tmp"
        ) as tmp:
            for chunk in f.chunks():
                tmp.write(chunk)
            tmp_path = Path(tmp.name)
        try:
            summary = cherrytree.import_ctb(target_dir, tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)
    except cherrytree.CherryTreeError as exc:
        return _err(str(exc), 400)
    except VaultError as exc:
        return _err(str(exc), exc.status)
    except OSError as exc:
        return _err(f"No se pudo escribir la bóveda: {exc}", 500)

    return JsonResponse({"success": True, "summary": summary})

# ════════════ Exportar nota a PDF ════════════

@login_required
@require_POST
@json_body
def notes_pdf(request):
    """PDF de la nota que el cliente manda ya renderizada (ver `pdf.py`)."""
    body_html = pdf.sanitize_html(request.data.get("html") or "")
    if not body_html.strip():
        return _err("Nada que exportar")
    title = vault.sanitize_name(request.data.get("title") or "nota") or "nota"
    try:
        pdf_bytes = pdf.render(body_html, dark=bool(request.data.get("dark")))
    except pdf.PdfError as exc:
        return _err(str(exc), exc.status)
    resp = HttpResponse(pdf_bytes, content_type="application/pdf")
    resp["Content-Disposition"] = f'attachment; filename="{title}.pdf"'
    resp["Content-Length"] = str(len(pdf_bytes))
    return resp


# ════════════ Compartir nota (enlace público, con contraseña opcional) ════════

@login_required
@require_write
@require_POST
@json_body
def share_create(request):
    """Crea (o actualiza) el enlace público de una nota.

    Reutiliza el token existente si la nota ya se había compartido antes, para
    que el enlace no cambie cada vez que se reabre el modal de "Compartir".
    `password` vacío/ausente quita la contraseña; con valor, la (re)establece.
    """
    root = boveda.raiz(request)
    password = request.data.get("password") or ""
    if not isinstance(password, str):
        return _err("'password' debe ser texto")
    target, err = _resolve(root, as_text(request.data.get("path")).strip())
    if err:
        return err
    if not target.exists() or target.suffix.lower() != ".md":
        return _err("Nota no encontrada", 404)
    # Relativo a la carpeta madre y no a la bóveda: con una bóveda por
    # cuenta, «Historia.md» a secas ya no identifica una nota.
    share, _created = SharedNote.objects.get_or_create(
        path=vault.rel_of(vault.root(), target),
        defaults={"token": secrets.token_urlsafe(16)},
    )
    share.password_hash = make_password(password) if password else ""
    share.save(update_fields=["password_hash", "updated_at"])
    return JsonResponse({
        "success": True, "token": share.token,
        "url": request.build_absolute_uri(f"/s/{share.token}/"),
        "has_password": bool(share.password_hash),
    })


@login_required
@require_GET
def share_status(request):
    """Estado actual del enlace público de una nota (o `shared: false`)."""
    root = boveda.raiz(request)
    target, err = _resolve(root, request.GET.get("path", ""))
    if err:
        return err
    share = SharedNote.objects.filter(path=vault.rel_of(vault.root(), target)).first()
    if not share:
        return JsonResponse({"shared": False})
    return JsonResponse({
        "shared": True, "token": share.token,
        "url": request.build_absolute_uri(f"/s/{share.token}/"),
        "has_password": bool(share.password_hash),
    })


@login_required
@require_GET
def share_list(request):
    """Todos los enlaces públicos activos (panel "Enlaces compartidos")."""
    return JsonResponse({"shares": [
        {
            "path": s.path,
            "name": Path(s.path).stem,
            "token": s.token,
            "url": request.build_absolute_uri(f"/s/{s.token}/"),
            "has_password": bool(s.password_hash),
        }
        for s in SharedNote.objects.all().order_by("-updated_at")
    ]})


@login_required
@require_write
@require_POST
@json_body
def share_revoke(request):
    """Deja de compartir una nota (borra el enlace público)."""
    root = boveda.raiz(request)
    target, err = _resolve(root, as_text(request.data.get("path")).strip())
    if err:
        return err
    SharedNote.objects.filter(path=vault.rel_of(vault.root(), target)).delete()
    return JsonResponse({"success": True})


@login_required
@require_write
@require_POST
@json_body
def share_send(request):
    """Manda por correo el enlace público de una nota.

    El enlace se construye AQUÍ a partir de la nota, no se acepta una URL del
    cliente: si se aceptara, esta ruta sería una forma de enviar correo con
    cualquier contenido desde el dominio, bastaría con llamarla con otra
    dirección.

    Se manda el ENLACE y no el texto de la nota a propósito. Una nota puede
    llevar imágenes y adjuntos que no viajan en el cuerpo, puede tener
    contraseña, y sobre todo un enlace se puede retirar después: lo que ya está
    en el buzón de otro, no.
    """
    root = boveda.raiz(request)
    para = as_text(request.data.get("para")).strip()
    nota_extra = as_text(request.data.get("nota")).strip()[:500]

    target, err = _resolve(root, as_text(request.data.get("path")).strip())
    if err:
        return err
    if not target.exists() or target.suffix.lower() != ".md":
        return _err("Nota no encontrada", 404)
    if not correo.valida(para):
        return _err("Esa dirección no es válida")

    rel = vault.rel_of(vault.root(), target)
    try:
        compartida = SharedNote.objects.get(path=rel)
    except SharedNote.DoesNotExist:
        return _err("Esa nota no está compartida todavía. Crea el enlace antes de enviarlo.")

    url = request.build_absolute_uri(f"/s/{compartida.token}/")
    titulo = target.stem

    lineas = [f"Te comparto la nota «{titulo}»:", "", url, ""]
    if nota_extra:
        lineas += [nota_extra, ""]
    if compartida.password_hash:
        lineas.append("El enlace pide contraseña: te la paso por otro medio.")
    lineas.append("Quien tenga el enlace puede leerla sin necesidad de cuenta.")

    try:
        envio = correo.enviar(para, f"Te comparto la nota «{titulo}»", texto="\n".join(lineas))
    except correo.ErrorCorreo as e:
        return _err(str(e), 502)

    return JsonResponse({"success": True, "id": envio})


# ── Vista pública (sin login) de una nota compartida ─────────────────────────

# Sólo imágenes y PDFs se resuelven en la vista pública: los embeds a OTRAS
# notas (![[OtraNota]]) no se exponen (evita que compartir una nota filtre el
# resto de la bóveda por transclusión) y se muestran como "no disponible".
_SHARE_ASSET_EXTS = vault.IMAGE_EXTS | {".pdf"}
_EMBED_REF_RE = re.compile(
    r'!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)\s]+)\)|<img\s[^>]*src=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_SHARE_ASSET_SALT = "cogny.notes.share_asset"


def _extract_asset_refs(content: str) -> set:
    refs = set()
    for m in _EMBED_REF_RE.finditer(content or ""):
        ref = (m.group(1) or m.group(2) or m.group(3) or "").strip()
        if ref and not re.match(r"^(https?:|data:|mailto:)", ref, re.IGNORECASE):
            refs.add(ref)
    return refs


def _resolve_asset_ref(root: Path, ref: str):
    """Resuelve una referencia de embed a un archivo del vault (o None).

    Misma semántica que `findFileByName` del cliente: ruta exacta primero,
    si no por nombre de archivo en cualquier parte del vault.
    """
    cleaned = ref.replace("\\", "/").split("#")[0].strip().lstrip("./")
    if not cleaned:
        return None
    try:
        direct = vault.safe_path(root, cleaned)
        if direct.is_file() and direct.suffix.lower() in _SHARE_ASSET_EXTS:
            return direct
    except VaultError:
        pass
    base = cleaned.rsplit("/", 1)[-1].lower()
    base_noext = re.sub(r"\.[^.]+$", "", base)
    for p in root.rglob("*"):
        try:
            if not p.is_file() or p.suffix.lower() not in _SHARE_ASSET_EXTS:
                continue
        except OSError:
            continue
        if p.name.lower() == base or p.stem.lower() == base_noext:
            return p
    return None


def _build_share_assets(root: Path, token: str, content: str, prefijo: str = "s") -> dict:
    """`{ref_original: url_firmada}` sólo para las imágenes/PDFs referenciados
    por ESTA nota — nunca la bóveda entera.

    `prefijo` es la rama de URL que sirve el adjunto: `s` para una nota suelta
    y `c` para una nota dentro de una carpeta compartida. La firma es la misma
    en los dos casos; lo único que cambia es quién valida el token.
    """
    out = {}
    for ref in _extract_asset_refs(content):
        hit = _resolve_asset_ref(root, ref)
        if hit:
            rel = vault.rel_of(root, hit)
            sig = quote(signing.dumps({"t": token, "p": rel}, salt=_SHARE_ASSET_SALT), safe="")
            out[ref] = f"/{prefijo}/{token}/asset?p={sig}"
    return out


def _asset_firmado(request, token: str):
    """El fichero que pide una URL firmada de adjunto, o 404.

    La firma lleva dentro el token, así que un enlace de una nota no sirve
    para sacar adjuntos de otra aunque se copie el parámetro.
    """
    try:
        data = signing.loads(request.GET.get("p", ""), salt=_SHARE_ASSET_SALT,
                             max_age=60 * 60 * 24 * 90)
    except signing.BadSignature:
        raise Http404
    if data.get("t") != token:
        raise Http404
    try:
        target = vault.safe_path(settings.VAULT_ROOT.resolve(), data.get("p", ""))
    except VaultError:
        raise Http404
    if not target.exists() or target.is_dir():
        raise Http404
    return FileResponse(open(target, "rb"))


def _share_gate_key(token: str) -> str:
    return f"shared_verified_{token}"


def shared_note_view(request, token):
    share = SharedNote.objects.filter(token=token).first()
    if not share:
        raise Http404
    root = settings.VAULT_ROOT.resolve()
    try:
        target = vault.safe_path(root, share.path)
    except VaultError:
        raise Http404
    if not target.exists() or target.suffix.lower() != ".md":
        raise Http404

    gate_key = _share_gate_key(token)
    error = ""
    if share.password_hash:
        if request.method == "POST":
            if check_password(request.POST.get("password", ""), share.password_hash):
                request.session[gate_key] = True
            else:
                error = "Contraseña incorrecta"
        if not request.session.get(gate_key):
            return render(request, "notes/shared_gate.html", {"error": error})

    content = target.read_text(encoding="utf-8")
    return render(request, "notes/shared.html", {
        "note_name": target.stem,
        "content": content,
        "assets": _build_share_assets(root, token, content),
    })


@require_GET
def shared_note_asset(request, token):
    share = SharedNote.objects.filter(token=token).first()
    if not share:
        raise Http404
    if share.password_hash and not request.session.get(_share_gate_key(token)):
        raise Http404
    return _asset_firmado(request, token)


@require_GET
def carpeta_compartida_asset(request, token):
    """El mismo adjunto firmado, pero para una carpeta compartida."""
    enlace = CarpetaCompartida.objects.filter(token=token).first()
    if not enlace:
        raise Http404
    if enlace.password_hash and not request.session.get(_share_gate_key(token)):
        raise Http404
    return _asset_firmado(request, token)


# ── Enlaces del QR ───────────────────────────────────────────────────────────

ALCANCES = ("subnota", "nota", "carpeta", "boveda")
PERMISOS_QR = ("lectura", "escritura")


def _objetivo_del_alcance(root: Path, alcance: str, target: Path) -> Path:
    """Qué se comparte de verdad según el alcance pedido.

    Los cuatro alcances se reducen a dos formas: un .md suelto (subnota) o una
    carpeta (el resto). Una nota con subnotas vive en `X/X.md`, así que "toda
    la nota" es la carpeta `X/` — y una nota sin subnotas no tiene carpeta que
    valga, así que "toda la nota" es la nota misma.
    """
    if alcance == "boveda":
        return root
    if alcance == "subnota":
        return target
    if alcance == "carpeta":
        return target if target.is_dir() else target.parent
    # "nota"
    if target.is_dir():
        return target
    return _rama_de(root, target)


@login_required
@require_POST
@json_body
def qr_crear(request):
    """El enlace que codifica el QR: alcance + permiso, en una sola llamada.

    Sólo sobre la bóveda propia. Estando dentro de la de otra persona no se
    reparten enlaces a sus notas, ni aunque se tenga permiso de escritura:
    repartir es cosa del dueño.
    """
    dueno, propia, _ = boveda.activa(request)
    if not propia:
        return _err("Sólo puedes repartir enlaces de tu propia bóveda", 403)

    alcance = as_text(request.data.get("alcance")).strip()
    permiso = as_text(request.data.get("permiso")).strip()
    if alcance not in ALCANCES:
        return _err("El alcance es 'subnota', 'nota', 'carpeta' o 'boveda'")
    if permiso not in PERMISOS_QR:
        return _err("El permiso es 'lectura' o 'escritura'")

    root = boveda.raiz(request)
    ruta = as_text(request.data.get("path")).strip()
    if alcance != "boveda" and not ruta:
        return _err("Falta la nota o la carpeta que se comparte")

    target, err = _resolve(root, ruta)
    if err:
        return err
    if alcance != "boveda" and not target.exists():
        return _err("No existe esa nota o carpeta", 404)

    objetivo = _objetivo_del_alcance(root, alcance, target)

    if permiso == "escritura":
        # Escribir exige cuenta: el enlace es una invitación, y quien la abre
        # se identifica antes de tocar nada. Y exige carpeta, porque el acceso
        # acotado se define por la carpeta que hace de raíz — un .md suelto no
        # puede ser la raíz de nada.
        if not objetivo.is_dir():
            return _err(
                "Una nota suelta no se puede compartir con escritura: no hay "
                "carpeta que acotar. Comparte 'toda la nota' o su carpeta.")
        propia_raiz = vault.root(str(request.user.sso_id or request.user.pk))
        ambito = "" if objetivo == propia_raiz else vault.rel_of(propia_raiz, objetivo)
        invitacion, _c = AccesoBoveda.objects.get_or_create(
            dueno=request.user, invitado=None,
            permiso=AccesoBoveda.EDITOR, ambito=ambito,
            defaults={"token": secrets.token_urlsafe(16)[:32]},
        )
        return JsonResponse({
            "success": True, "alcance": alcance, "permiso": permiso,
            "necesita_cuenta": True,
            "url": request.build_absolute_uri("/b/%s" % invitacion.token),
        })

    # Lectura: enlace público, sin cuenta.
    rel_global = vault.rel_of(vault.root(), objetivo)
    if objetivo.is_dir():
        enlace, _c = CarpetaCompartida.objects.get_or_create(
            path=rel_global, defaults={"token": secrets.token_urlsafe(16)[:32]})
        url = request.build_absolute_uri(f"/c/{enlace.token}/")
    else:
        if objetivo.suffix.lower() != ".md":
            return _err("Sólo se comparten notas .md")
        enlace, _c = SharedNote.objects.get_or_create(
            path=rel_global, defaults={"token": secrets.token_urlsafe(16)})
        url = request.build_absolute_uri(f"/s/{enlace.token}/")

    return JsonResponse({
        "success": True, "alcance": alcance, "permiso": permiso,
        "necesita_cuenta": False, "url": url,
    })


def _arbol_publico(base: Path, directorio: Path, nivel: int = 0) -> list:
    """El árbol de una carpeta compartida, aplanado y sólo con notas.

    Plano y no anidado porque las plantillas de Django no recorren estructuras
    recursivas sin pelearse; con el nivel en cada fila, sangrar en el HTML es
    una multiplicación y se acabó. Se ocultan los ocultos y todo lo que no sea
    `.md`: los adjuntos ya llegan por su URL firmada desde dentro de la nota.
    """
    items = []
    for hijo in sorted(directorio.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if hijo.name.startswith("."):
            continue
        if hijo.is_dir():
            items.append({"nombre": hijo.name, "tipo": "carpeta",
                          "nivel": nivel, "ruta": ""})
            items.extend(_arbol_publico(base, hijo, nivel + 1))
        elif hijo.suffix.lower() == ".md":
            items.append({"nombre": hijo.stem, "tipo": "nota",
                          "nivel": nivel, "ruta": vault.rel_of(base, hijo)})
    return items


def carpeta_compartida_view(request, token):
    """Vista pública de una carpeta compartida en sólo lectura.

    Sin `?n=` enseña el índice; con `?n=` abre una nota de dentro. La nota se
    resuelve SIEMPRE contra la carpeta compartida, así que `?n=../../otra` no
    llega a ningún sitio: `safe_path` lo rechaza antes.
    """
    enlace = CarpetaCompartida.objects.filter(token=token).first()
    if not enlace:
        raise Http404
    try:
        base = vault.safe_path(settings.VAULT_ROOT.resolve(), enlace.path)
    except VaultError:
        raise Http404
    if not base.is_dir():
        raise Http404

    gate_key = _share_gate_key(token)
    error = ""
    if enlace.password_hash:
        if request.method == "POST":
            if check_password(request.POST.get("password", ""), enlace.password_hash):
                request.session[gate_key] = True
            else:
                error = "Contraseña incorrecta"
        if not request.session.get(gate_key):
            return render(request, "notes/shared_gate.html", {"error": error})

    pedida = request.GET.get("n", "").strip()
    if pedida:
        try:
            nota = vault.safe_path(base, pedida)
        except VaultError:
            raise Http404
        if not nota.is_file() or nota.suffix.lower() != ".md":
            raise Http404
        contenido = nota.read_text(encoding="utf-8")
        return render(request, "notes/shared.html", {
            "note_name": nota.stem,
            "content": contenido,
            "assets": _build_share_assets(settings.VAULT_ROOT.resolve(),
                                          token, contenido, prefijo="c"),
            "volver": f"/c/{token}/",
        })

    return render(request, "notes/shared_folder.html", {
        "titulo": base.name,
        "token": token,
        "arbol": _arbol_publico(base, base),
    })


# ── Bóvedas compartidas ──────────────────────────────────────────────────────

def _ficha_boveda(usuario, propia, permiso):
    return {"id": str(usuario.sso_id or usuario.pk), "nombre": usuario.username,
            "propia": propia, "permiso": permiso}


@login_required
@require_GET
def boveda_estado(request):
    """Qué bóveda se está mirando, cuáles hay a mano y qué se ha repartido."""
    dueno, propia, escribir = boveda.activa(request)

    disponibles = [_ficha_boveda(
        request.user, True,
        "editor" if getattr(request.user, "can_write", False) else "viewer")]
    for a in (AccesoBoveda.objects.filter(invitado=request.user)
              .select_related("dueno")):
        disponibles.append(_ficha_boveda(a.dueno, False, a.permiso))

    repartidos = [{
        "id": a.pk,
        "invitado": a.invitado.username if a.invitado else None,
        "permiso": a.permiso,
        "url": request.build_absolute_uri("/b/%s" % a.token) if not a.invitado else None,
    } for a in (AccesoBoveda.objects.filter(dueno=request.user)
                .select_related("invitado").order_by("-creado"))]

    return JsonResponse({
        "success": True,
        "activa": _ficha_boveda(dueno, propia, "editor" if escribir else "viewer"),
        "disponibles": disponibles,
        "repartidos": repartidos,
    })


@login_required
@require_POST
@json_body
def boveda_invitar(request):
    """Un enlace que da acceso a mi bóveda. Sirve para quien lo abra.

    Con `ambito` el acceso queda acotado a esa carpeta: quien entra la ve como
    si fuera su bóveda y no puede salirse de ella. Sin `ambito`, la entera,
    que es como funcionaba antes.
    """
    permiso = (request.data.get("permiso") or "").strip()
    if permiso not in (AccesoBoveda.EDITOR, AccesoBoveda.VIEWER):
        return _err("El permiso es 'editor' o 'viewer'")

    ambito = as_text(request.data.get("ambito")).strip()
    if ambito:
        propia = vault.root(str(request.user.sso_id or request.user.pk))
        carpeta, err = _resolve(propia, ambito)
        if err:
            return err
        if not carpeta.is_dir():
            return _err("El ámbito tiene que ser una carpeta", 404)
        # Se guarda normalizado: lo que llegó puede traer barras de más y
        # luego no casaría con lo que compruebe `boveda.raiz()`.
        ambito = vault.rel_of(propia, carpeta)

    # Una invitación abierta por permiso y ámbito: repartir dos enlaces
    # iguales no aporta nada y luego no se sabe cuál revocar.
    invitacion, _ = AccesoBoveda.objects.get_or_create(
        dueno=request.user, invitado=None, permiso=permiso, ambito=ambito,
        defaults={"token": secrets.token_urlsafe(16)[:32]},
    )
    return JsonResponse({
        "success": True, "permiso": permiso, "ambito": ambito,
        "url": request.build_absolute_uri("/b/%s" % invitacion.token),
    })


@login_required
@require_POST
@json_body
def boveda_revocar(request):
    """Retira un acceso concedido o una invitación sin usar."""
    try:
        cual = int(request.data.get("id") or 0)
    except (TypeError, ValueError):
        return _err("Identificador inválido")

    borrados, _ = AccesoBoveda.objects.filter(pk=cual, dueno=request.user).delete()
    if not borrados:
        return _err("No existe ese acceso", 404)
    return JsonResponse({"success": True})


@login_required
@require_POST
@json_body
def boveda_cambiar(request):
    """Cambia de bóveda. Se guarda en la sesión, no en la URL."""
    cual = (request.data.get("boveda") or "").strip()
    mia = str(request.user.sso_id or request.user.pk)

    if not cual or cual == mia:
        request.session.pop(boveda.CLAVE, None)
        return JsonResponse({"success": True, "activa": mia})

    if not AccesoBoveda.objects.filter(invitado=request.user,
                                       dueno__sso_id=cual).exists():
        return _err("No tienes acceso a esa bóveda", 403)

    request.session[boveda.CLAVE] = cual
    return JsonResponse({"success": True, "activa": cual})


@login_required
def boveda_aceptar(request, token):
    """Abrir el enlace de una invitación: te la quedas y entras en esa bóveda.

    La invitación no se gasta: sigue valiendo para el siguiente. Lo que se
    crea es tu acceso, que ya es tuyo y solo lo quita el dueño.
    """
    invitacion = AccesoBoveda.objects.filter(
        token=token, invitado__isnull=True).select_related("dueno").first()
    if invitacion is None or invitacion.dueno_id == request.user.pk:
        return redirect("/")

    acceso, creado = AccesoBoveda.objects.get_or_create(
        dueno=invitacion.dueno, invitado=request.user,
        defaults={"permiso": invitacion.permiso,
                  "ambito": invitacion.ambito,
                  "token": secrets.token_urlsafe(16)[:32]},
    )
    if not creado and (acceso.permiso != invitacion.permiso
                       or acceso.ambito != invitacion.ambito):
        # Si el dueño reparte ahora un enlace distinto, manda el nuevo: tanto
        # para dar más (de lectura a escritura, de una carpeta a la bóveda)
        # como para dar menos, que es la única forma de recortar un acceso ya
        # concedido sin quitarlo del todo.
        acceso.permiso = invitacion.permiso
        acceso.ambito = invitacion.ambito
        acceso.save(update_fields=["permiso", "ambito"])

    invitacion.usado = timezone.now()
    invitacion.save(update_fields=["usado"])

    request.session[boveda.CLAVE] = str(invitacion.dueno.sso_id or invitacion.dueno.pk)
    return redirect("/")
