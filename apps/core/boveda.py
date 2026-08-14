"""Qué bóveda se está mirando y con qué permiso.

Único sitio donde se responde a esa pregunta. Antes no hacía falta: había una
bóveda y el permiso era el rol de la cuenta. Ahora cada cual tiene la suya y
puede estar mirando la de otro, así que hay que preguntarlo en cada petición.

La bóveda elegida viaja en la sesión de Django, no en la URL: así no se puede
colar otra cambiando un número, y al volver mañana sigues donde estabas.
"""
from apps.accounts.models import AccesoBoveda
from apps.notes import vault

CLAVE = "boveda_activa"


def _id(usuario):
    """El identificador estable de una cuenta: el del portal si lo tiene."""
    return str(getattr(usuario, "sso_id", None) or usuario.pk)


def activa(request):
    """Devuelve (dueño, es_propia, puede_escribir) de la bóveda que se mira."""
    usuario = request.user
    elegida = request.session.get(CLAVE)

    if not elegida or elegida == _id(usuario):
        # La propia: aquí siempre se escribe. El rol de la cuenta no pinta
        # nada en tus notas; solo dice quién administra la instancia.
        return usuario, True, True

    acceso = (AccesoBoveda.objects
              .select_related("dueno")
              .filter(invitado=usuario, dueno__sso_id=elegida)
              .first())
    if acceso is None:
        # Le han quitado el acceso mientras la tenía abierta: a la suya.
        request.session.pop(CLAVE, None)
        return usuario, True, True

    return acceso.dueno, False, acceso.puede_escribir


def raiz(request):
    """La carpeta de la bóveda que se está mirando."""
    dueno, _, _ = activa(request)
    return vault.root(_id(dueno))


def puede_escribir(request):
    return activa(request)[2]
