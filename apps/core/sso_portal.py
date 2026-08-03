"""Sesión única de lepayimio.es dentro de Django.

El portal firma un token y lo deja en una cookie del dominio padre. Aquí se
comprueba esa firma y se traduce a un usuario de Django, que es lo que espera
el resto del proyecto: nada de lo que ya hay tiene que enterarse de que la
sesión viene de fuera.

Es la versión en Python de /usr/local/lib/lepayimio/sso.js, y tiene que
mantenerse en paralelo con él: mismo formato de token, misma clave. El formato
es deliberadamente simple —cuerpo en base64url, punto, HMAC-SHA256— para que
esa duplicación sean veinte líneas y no una librería.
"""
import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import time

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout

log = logging.getLogger(__name__)

COOKIE = "lepayimio_sesion"
CLAVE_FILE = os.environ.get("SSO_KEY_FILE", "/etc/lepayimio/sso.key")

_clave = None


def _clave_de_firma():
    global _clave
    if _clave is None:
        with open(CLAVE_FILE, "rb") as f:
            _clave = f.read()
    return _clave


def _b64url(dato: str) -> bytes:
    """base64url sin relleno, que es como lo emite Node."""
    resto = len(dato) % 4
    if resto:
        dato += "=" * (4 - resto)
    return base64.urlsafe_b64decode(dato)


def verificar(token):
    """Datos de la sesión, o None. No lanza: un token roto es 'no hay sesión'."""
    try:
        cuerpo, firma = str(token).split(".", 1)
    except (ValueError, AttributeError):
        return None

    try:
        esperada = hmac.new(_clave_de_firma(), cuerpo.encode("ascii"), hashlib.sha256).digest()
        recibida = _b64url(firma)
        # compare_digest y no ==: comparar byte a byte permitiría adivinar la
        # firma midiendo lo que tarda en decir que no.
        if not hmac.compare_digest(esperada, recibida):
            return None
        datos = json.loads(_b64url(cuerpo).decode("utf-8"))
    except (ValueError, TypeError, binascii.Error, OSError) as err:
        log.debug("token de sesión no válido: %s", err)
        return None

    exp = datos.get("exp")
    if not exp or time.time() * 1000 > exp:
        return None
    return datos


class SesionDelPortalMiddleware:
    """Mantiene la sesión de Django a la par que la del portal.

    Va después de AuthenticationMiddleware porque necesita request.user ya
    resuelto para saber si hay que hacer algo o no.

    Los dos sentidos importan. Si el portal dice que has entrado, aquí se te da
    la sesión sin preguntar nada. Y si el portal dice que ya no —porque has
    cerrado sesión allí—, aquí también se cierra: si solo se mirase el primer
    caso, cerrar sesión en el portal dejaría este servicio abierto, que es
    justo lo contrario de tener un login único.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        datos = verificar(request.COOKIES.get(COOKIE))
        actual = request.user if hasattr(request, "user") else None

        if datos and (datos.get("id") or datos.get("u")):
            # El ID manda; el nombre es solo la etiqueta que se muestra.
            sso_id = str(datos.get("id") or datos["u"])
            nombre = str(datos.get("u") or sso_id)
            if not (actual and actual.is_authenticated
                    and getattr(actual, "sso_id", None) == sso_id):
                usuario = self._usuario(sso_id, nombre)
                if usuario is not None:
                    login(request, usuario, backend="apps.core.sso_portal.BackendDelPortal")
        elif actual is not None and actual.is_authenticated:
            # Sesión de Django viva sin respaldo del portal: se cierra.
            logout(request)

        return self.get_response(request)

    @staticmethod
    def _usuario(sso_id, nombre):
        U = get_user_model()
        # Primero por ID, que es lo que no cambia.
        usuario = U.objects.filter(sso_id=sso_id).first()

        if usuario is None:
            # Cuenta anterior a los ID: se reconoce por el nombre —que entonces
            # hacía de identidad— y se le pone el ID para que a partir de ahora
            # el enlace sea ese. Sin esto se crearía una cuenta nueva y el vault
            # se quedaría colgando de la vieja.
            usuario = U.objects.filter(username__iexact=sso_id).first()
            if usuario is not None:
                usuario.sso_id = sso_id
                usuario.save(update_fields=["sso_id"])
                log.info("cuenta %s enlazada al ID %s", usuario.username, sso_id)

        if usuario is not None:
            # El nombre visible sigue al del portal.
            if nombre and usuario.username != nombre and not U.objects.filter(
                    username__iexact=nombre).exclude(pk=usuario.pk).exists():
                usuario.username = nombre
                usuario.save(update_fields=["username"])
            return usuario

        # No existía de antes: cuenta nueva, con su ID desde el principio.
        usuario = U.objects.create_user(username=nombre)
        usuario.sso_id = sso_id
        # Contraseña inutilizable: por aquí no se entra con contraseña, y dejar
        # una vacía sería dejar una puerta.
        usuario.set_unusable_password()
        # El primero en llegar manda; los demás, cuentas normales.
        if U.objects.count() == 1:
            usuario.is_staff = True
            usuario.is_superuser = True
        usuario.save()
        log.info("creado el usuario %s (ID %s) desde el portal", nombre, sso_id)
        return usuario


class BackendDelPortal:
    """Backend mínimo para que login() acepte al usuario.

    No autentica nada: cuando se llama a login() la firma ya se ha comprobado.
    Existe porque Django exige que el usuario venga de un backend declarado y
    guarda cuál en la sesión.
    """

    def authenticate(self, request, **kwargs):
        return None

    def get_user(self, user_id):
        U = get_user_model()
        try:
            return U.objects.get(pk=user_id)
        except U.DoesNotExist:
            return None
