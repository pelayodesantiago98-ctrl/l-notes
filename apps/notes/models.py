"""Notes vault — el contenido vive en disco (archivos .md).

Esta app es 'view-only' para Django ORM en cuanto al contenido: las notas son
archivos Markdown bajo settings.VAULT_ROOT/. El único modelo que sí
definimos es metadata de enlaces públicos (no contenido)."""
from django.db import models


class SharedNote(models.Model):
    """Enlace público a una nota concreta (`path` del vault).

    `token` es la parte pública de la URL (`/s/<token>/`); una nota sólo puede
    tener un enlace activo a la vez (`path` es único), así que reabrir el
    modal de "Compartir" reutiliza el mismo token en vez de invalidar enlaces
    ya repartidos. `password_hash` vacío = acceso libre; con contraseña, el
    hash se guarda con el mismo hasher que usa Django para las cuentas.
    """

    token = models.CharField(max_length=32, primary_key=True, editable=False)
    path = models.CharField(max_length=600, unique=True)
    password_hash = models.CharField(max_length=128, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.path} ({self.token})"


class CarpetaCompartida(models.Model):
    """Enlace público de sólo lectura a una CARPETA del vault.

    Los cuatro alcances que ofrece el QR se reducen a dos primitivas, porque
    una nota con subnotas vive en `X/X.md` y lo que la contiene es `X/`:

        subnota          → `SharedNote`, un .md suelto
        toda la nota     → esta tabla, la carpeta `X/`
        toda la carpeta  → esta tabla
        todas las carpetas → esta tabla, la carpeta raíz de la bóveda

    `path` va relativo a la raíz GLOBAL del vault, igual que en `SharedNote`:
    su primer tramo es el identificador del dueño, y por eso el token basta
    para saber qué bóveda se está enseñando sin guardar una clave ajena.

    Sólo lectura, a propósito: escribir exige cuenta y va por `AccesoBoveda`
    con su `ambito`, que es donde ya se decide quién puede escribir.
    """

    token = models.CharField(max_length=32, primary_key=True, editable=False)
    path = models.CharField(max_length=600, unique=True)
    password_hash = models.CharField(max_length=128, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notes_carpetacompartida"

    def __str__(self):
        return f"{self.path}/ ({self.token})"
