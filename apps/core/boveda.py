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


def _resuelve(request):
    """(dueño, es_propia, puede_escribir, ámbito) de la bóveda que se mira.

    El ámbito es la carpeta a la que está acotado el acceso ('' = entera).
    Se decide TODO aquí, en una única consulta, para que `activa()` y `raiz()`
    no puedan contestar cosas distintas sobre el mismo acceso.
    """
    usuario = request.user
    elegida = request.session.get(CLAVE)

    if not elegida or elegida == _id(usuario):
        # La propia: aquí siempre se escribe. El rol de la cuenta no pinta
        # nada en tus notas; solo dice quién administra la instancia.
        return usuario, True, True, ""

    acceso = (AccesoBoveda.objects
              .select_related("dueno")
              .filter(invitado=usuario, dueno__sso_id=elegida)
              .first())
    if acceso is None:
        # Le han quitado el acceso mientras la tenía abierta: a la suya.
        request.session.pop(CLAVE, None)
        return usuario, True, True, ""

    ambito = acceso.ambito or ""
    if ambito:
        # La carpeta acotada puede haber desaparecido (el dueño la borró o la
        # renombró). Se trata igual que un acceso retirado —a su bóveda— y no
        # cayendo a la bóveda entera, que sería ampliar el permiso callando.
        try:
            if not vault.safe_path(vault.root(_id(acceso.dueno)), ambito).is_dir():
                request.session.pop(CLAVE, None)
                return usuario, True, True, ""
        except vault.VaultError:
            request.session.pop(CLAVE, None)
            return usuario, True, True, ""

    return acceso.dueno, False, acceso.puede_escribir, ambito


def activa(request):
    """Devuelve (dueño, es_propia, puede_escribir) de la bóveda que se mira."""
    return _resuelve(request)[:3]


def raiz(request):
    """La carpeta de la bóveda que se está mirando.

    Si el acceso está acotado a una carpeta, devuelve ESA carpeta. A partir de
    ahí no hay nada más que comprobar en las vistas: todas resuelven sus rutas
    con `vault.safe_path(raiz, ...)`, que rechaza cualquier cosa que se salga
    de la base, así que el acotado vale igual para leer que para escribir.
    """
    dueno, _, _, ambito = _resuelve(request)
    base = vault.root(_id(dueno))
    return vault.safe_path(base, ambito) if ambito else base


def puede_escribir(request):
    return activa(request)[2]
