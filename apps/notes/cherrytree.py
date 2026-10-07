"""Lector de archivos CherryTree (.ctb) → árbol de notas Markdown.

CherryTree (≥1.0) almacena las bóvedas como SQLite. El esquema principal:

    node      — un nodo del árbol (nota o carpeta lógica) con su `txt` en XML.
    children  — aristas padre→hijo con un `sequence` que da el orden manual.
    codebox   — cajas de código que el XML no embebe (las inline sí van dentro).
    image     — imágenes referenciadas por el nodo (BINARIO + nombre + offset).
    grid      — celdas de tablas; `col_min=-1` marca el inicio de cada fila.

El campo `node.txt` es XML con este aspecto:

    <node>
      <rich_text>texto plano </rich_text>
      <rich_text weight="heavy">negrita</rich_text>
      <rich_text style="italic">cursiva</rich_text>
      <rich_text scale="h2">encabezado</rich_text>
      <rich_text link="webs https://ejemplo.com">link</rich_text>
      <rich_text link="codebox python">def hola():\n    print('hola')</rich_text>
      <rich_text link="image foto.png">alt</rich_text>
      <rich_text family="monospace">código</rich_text>
    </node>

La conversión es mejor-esfuerzo: aplica formato básico y los anclajes comunes
(webs, file, codebox, image). Las tablas (grid) las emitimos como una sección
al final de cada nota — Markdown no soporta justificación por celda, así que
perder ese detalle es aceptable.

Solo se admite .ctb (SQLite). El formato .ctd (XML antiguo) queda fuera.
"""
import logging
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

log = logging.getLogger(__name__)

CT_HEADER = b"SQLite format 3"
SCALE_LEVEL = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}


class CherryTreeError(ValueError):
    """Error al leer o procesar un .ctb, con mensaje apto para mostrar al usuario."""


@dataclass
class CTNode:
    node_id: int
    name: str
    level: int
    txt: str = ""
    syntax: str = ""
    tags: str = ""
    has_codebox: bool = False
    has_table: bool = False
    has_image: bool = False
    children: list = field(default_factory=list)


def _open_ro(path: Path) -> sqlite3.Connection:
    """Abre el .ctb como SQLite en modo sólo-lectura.

    Lo hacemos con `file:...?mode=ro` y `uri=True` para que CherryTree no pueda
    bloquear la DB ni el gunicorn quede esperando si el archivo está abierto
    por una sesión de escritorio.
    """
    with open(path, "rb") as f:
        head = f.read(16)
    if not head.startswith(CT_HEADER):
        raise CherryTreeError("El archivo no parece un .ctb (no es SQLite)")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.cursor()
    cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    )
    return cur.fetchone() is not None


def load(path: Path) -> tuple[dict[int, CTNode], dict[int, list[int]], list[int]]:
    """Lee el .ctb. Devuelve (nodos_por_id, hijos_por_padre, ids_raíz).

    CherryTree tiene un nodo "huérfano" raíz con `level=-1`; sus hijos directos
    son los nodos de nivel 0 (las raíces visibles del árbol de notas). Filtrar
    por ese nodo fantasma es lo que descarta el contenedor interno.
    """
    conn = _open_ro(path)
    try:
        cur = conn.cursor()
        nodes: dict[int, CTNode] = {}
        for row in cur.execute(
            "SELECT node_id, name, txt, syntax, tags, has_codebox, "
            "has_table, has_image, level FROM node"
        ):
            nodes[row[0]] = CTNode(
                node_id=row[0],
                name=row[1] or "(sin título)",
                txt=row[2] or "",
                syntax=row[3] or "",
                tags=row[4] or "",
                has_codebox=bool(row[5]),
                has_table=bool(row[6]),
                has_image=bool(row[7]),
                level=row[8],
            )

        children_by_father: dict[int, list[int]] = {}
        for node_id, father_id, sequence in cur.execute(
            "SELECT node_id, father_id, sequence FROM children "
            "ORDER BY father_id, sequence"
        ):
            children_by_father.setdefault(father_id, []).append(node_id)
    finally:
        conn.close()

    roots = [nid for nid, n in nodes.items() if n.level == -1]
    if not roots:
        # Algunas exportaciones de CherryTree no guardan una fila para el
        # nodo fantasma (level=-1): los nodos visibles de nivel 0 igualmente
        # cuelgan de father_id=0 en `children`, solo que no hay row en
        # `node` para ese id. Ese 0 nunca se busca en `nodes` (solo se usa
        # como clave de `children_by_father`), así que es seguro usarlo tal
        # cual como raiz sintetica.
        if 0 in children_by_father:
            roots = [0]
    if not roots:
        raise CherryTreeError("No se encontró el nodo raíz del .ctb")
    if len(roots) > 1:
        # CherryTree siempre tiene exactamente un nodo fantasma; si hay varios,
        # algo va mal y mejor pararse a preguntar.
        raise CherryTreeError(
            f"Se encontraron {len(roots)} raíces en el .ctb; se esperaba 1"
        )
    return nodes, children_by_father, roots


def _extract_images(path: Path) -> dict[int, list[tuple[str, bytes, str]]]:
    """{node_id: [(filename, png_bytes, link), ...]} — orden estable por offset."""
    conn = _open_ro(path)
    try:
        out: dict[int, list[tuple[str, bytes, str]]] = {}
        if not _has_table(conn, "image"):
            return out
        cur = conn.cursor()
        for node_id, offset, _anchor, png, filename, link in cur.execute(
            "SELECT node_id, offset, anchor, png, filename, link "
            "FROM image ORDER BY node_id, offset"
        ):
            if not png:
                continue
            name = filename or f"cherrytree-{node_id}-{offset}.png"
            out.setdefault(node_id, []).append((name, png, link or ""))
    finally:
        conn.close()
    return out


def _extract_codeboxes(path: Path) -> dict[int, list[tuple[int, str, str]]]:
    """{node_id: [(ord, syntax, content), ...]} — orden estable por ord.

    CherryTree suele embebir las cajas inline (con `link="codebox LANG"`) en el
    XML, así que esta tabla es sólo para cajas "huérfanas" (raras, pero
    posibles en versiones antiguas). Las juntamos al final de la nota.
    """
    conn = _open_ro(path)
    try:
        out: dict[int, list[tuple[int, str, str]]] = {}
        if not _has_table(conn, "codebox"):
            return out
        cur = conn.cursor()
        # CherryTree >=1.0 llama a estas columnas `ord`/`content`; versiones
        # mas viejas del esquema SQLite usan `offset`/`txt` para lo mismo.
        cols = {row[1] for row in cur.execute("PRAGMA table_info(codebox)")}
        ord_col = "ord" if "ord" in cols else "offset"
        content_col = "content" if "content" in cols else "txt"
        for node_id, ord_, syntax, content in cur.execute(
            f"SELECT node_id, {ord_col}, syntax, {content_col} FROM codebox "
            f"ORDER BY node_id, {ord_col}"
        ):
            out.setdefault(node_id, []).append((ord_, syntax or "", content or ""))
    finally:
        conn.close()
    return out


def _extract_grids(path: Path) -> dict[int, list[list[str]]]:
    """{node_id: [[cell, ...], ...]} — filas listas para Markdown.

    CherryTree marca el inicio de cada fila con `col_min=-1`. Las celdas que
    siguen a ese marcador (con `col_min >= 0` o cualquier otro valor distinto)
    pertenecen a esa fila hasta el próximo `-1`. No nos fiamos de que `col_min`
    tenga siempre `>=0` después del primero: hay bóvedas donde CherryTree mete
    `col_min` reales (anchos mínimos) y eso nos obliga a recorrer en orden.
    """
    conn = _open_ro(path)
    try:
        rows_by_node: dict[int, list[list[str]]] = {}
        if not _has_table(conn, "grid"):
            return rows_by_node
        cur = conn.cursor()
        # Mismo cambio de nombre que en codebox: `ord` en vaults nuevos,
        # `offset` en vaults viejos.
        cols = {row[1] for row in cur.execute("PRAGMA table_info(grid)")}
        ord_col = "ord" if "ord" in cols else "offset"
        for node_id, _ord, col_min, txt in cur.execute(
            f"SELECT node_id, {ord_col}, col_min, txt FROM grid ORDER BY node_id, {ord_col}"
        ):
            txt = txt or ""
            rows_by_node.setdefault(node_id, [])
            if col_min == -1 or not rows_by_node[node_id]:
                # Marca de fila nueva (o es la primera celda que vemos).
                rows_by_node[node_id].append([txt])
            else:
                rows_by_node[node_id][-1].append(txt)
    finally:
        conn.close()
    return rows_by_node


# ── Conversión de XML a Markdown ─────────────────────────────────────────────


def _strip_ns(tag: str) -> str:
    """`{ns}rich_text` → `rich_text` (ET no lo quita, y los .ctb viejos lo usan)."""
    return tag.rsplit("}", 1)[-1]


def _convert_rich_text(elem: ET.Element) -> str:
    """Convierte un <rich_text> a su equivalente Markdown inline.

    Aplica el formato de fuera hacia adentro: si el nodo tiene `link`, lo
    resolvemos primero (porque `link` reemplaza toda la cadena), luego bold,
    cursiva, etc., que se pueden anidar.
    """
    if _strip_ns(elem.tag) != "rich_text":
        # Etiquetas desconocidas: emitir su texto y el de sus hijos sin formato.
        text = elem.text or ""
        for child in elem:
            text += _convert_rich_text(child)
            if child.tail:
                text += child.tail
        return text

    attrs = elem.attrib
    inner_parts: [str] = []
    if elem.text:
        inner_parts.append(elem.text)
    for child in elem:
        inner_parts.append(_convert_rich_text(child))
        if child.tail:
            inner_parts.append(child.tail)
    inner = "".join(inner_parts)

    if "link" in attrs:
        link = attrs["link"]
        if link.startswith("webs "):
            url = link[5:].strip()
            label = inner or url
            return f"[{label}]({url})"
        if link.startswith("file "):
            target = link[5:].strip()
            label = inner or Path(target).name or target
            return f"[{label}]({target})"
        if link.startswith("codebox "):
            lang = link[len("codebox "):].strip()
            return f"\n```{lang}\n{inner}\n```\n"
        if link.startswith("image "):
            filename = link[len("image "):].strip()
            return f"![[{filename}]]"
        if link.startswith("node "):
            target = link[len("node "):].strip()
            return f"[[{target}]]"

    if "scale" in attrs:
        level = SCALE_LEVEL.get(attrs["scale"])
        if level is not None:
            return f"\n\n{'#' * level} {inner}\n\n"

    if attrs.get("weight") == "heavy":
        inner = f"**{inner}**"
    style = attrs.get("style")
    if style == "italic":
        inner = f"*{inner}*"
    elif style == "strikethrough":
        inner = f"~~{inner}~~"
    elif style == "underline":
        inner = f"<u>{inner}</u>"
    if attrs.get("family") == "monospace":
        inner = f"`{inner}`"

    return inner


def _xml_to_markdown(txt: str) -> str:
    """Convierte el XML de `node.txt` a Markdown.

    CherryTree a veces mete saltos de línea literales dentro de los
    `<rich_text>`. Normalizamos los espacios múltiples que aparecen cuando
    CherryTree justifica texto, y devolvemos párrafos separados por líneas
    en blanco.
    """
    if not txt or not txt.strip():
        return ""
    try:
        root = ET.fromstring(txt)
    except ET.ParseError as exc:
        log.warning("XML inválido en un nodo CherryTree: %s", exc)
        # Si el XML está roto, mejor emitir el texto literal que perder la nota.
        return _strip_xml(txt).strip()

    parts: [str] = []
    if root.text and root.text.strip():
        parts.append(root.text)
    for child in root:
        parts.append(_convert_rich_text(child))
        if child.tail and child.tail.strip():
            parts.append(child.tail)
    return _normalize_blocks("\n\n".join(p for p in parts if p and p.strip()))


_XML_TAGS = re.compile(r"<[^>]+>")


def _strip_xml(txt: str) -> str:
    """Fallback: tira las etiquetas y deja el texto."""
    return _XML_TAGS.sub("", txt)


_BLOCK_SEP = re.compile(r"\n{3,}")


def _normalize_blocks(text: str) -> str:
    """Colapsa triples saltos de línea y arregla espacios sobrantes."""
    text = _BLOCK_SEP.sub("\n\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


# ── Conversión de tablas (grids) ──────────────────────────────────────────────


def _grid_to_markdown(rows: list[list[str]]) -> str:
    """Convierte filas de CherryTree a una tabla Markdown.

    `rows` es una lista de filas, cada fila una lista de celdas en texto plano.
    CherryTree permite justificación por celda que Markdown no soporta: emitimos
    celdas alineadas a la izquierda, que es lo más cercano.
    """
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    head, *body = rows
    out = ["| " + " | ".join(head) + " |"]
    out.append("|" + "|".join(["---"] * width) + "|")
    for row in body:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def build_note_markdown(
    txt: str,
    codeboxes_by_node: dict[int, list[tuple[int, str, str]]],
    grids_by_node: dict[int, list[list[str]]],
    node_id: int,
    image_names: list[str] | None = None,
) -> str:
    """Markdown final de un nodo: contenido + secciones extra al final.

    `image_names` son los nombres FINALES (ya resueltos contra colisiones)
    de las imagenes del nodo en Adjuntos/. En vaults de CherryTree con
    esquema viejo (offset-based) las imagenes no llevan marca inline en el
    XML -las inserta el propio CherryTree por offset de caracter, que no
    reconstruimos aqui-, asi que van en su propia seccion al final, igual
    que las cajas de codigo huerfanas y las tablas.
    """
    md = _xml_to_markdown(txt)
    extra: [str] = []
    codeboxes = codeboxes_by_node.get(node_id) or []
    if codeboxes:
        extra.append("\n## Cajas de código\n")
        for _ord, syntax, content in codeboxes:
            lang = syntax or ""
            extra.append(f"```{lang}\n{content.rstrip()}\n```\n")
    grids = grids_by_node.get(node_id) or []
    if grids:
        extra.append("\n## Tablas\n")
        extra.append(_grid_to_markdown(grids))
        extra.append("")
    if image_names:
        extra.append("\n## Imágenes\n")
        for name in image_names:
            extra.append(f"![[{name}]]\n")
    if md and extra:
        return md + "\n" + "".join(extra)
    return md or "\n".join(extra)


def extract_all(path: Path) -> dict:
    """Carga .ctb completo: nodos, imágenes, codeboxes, grids.

    Devuelve un dict con los componentes separados para que el importador
    decida qué hacer con cada uno (escribir notas, volcar imágenes a
    Adjuntos/, etc.) sin reabrir la DB.
    """
    nodes, children, roots = load(path)
    return {
        "nodes": nodes,
        "children": children,
        "roots": roots,
        "images": _extract_images(path),
        "codeboxes": _extract_codeboxes(path),
        "grids": _extract_grids(path),
    }


# ── Importador ───────────────────────────────────────────────────────────────
#
# El importador es el que decide cómo aterriza el árbol de CherryTree en el
# vault de l-notes, que tiene dos convenciones importantes:
#
#   1. Las notas son archivos `.md`. Las imágenes, en `Adjuntos/`.
#   2. Una nota con subnotas vive en `X/X.md`, no en `X.md` — la carpeta
#      lleva su mismo nombre y sus hijos cuelgan de ahí.
#
# Por eso, cuando un nodo de CherryTree tiene hijos, lo convertimos en carpeta
# (`X/X.md`); cuando no, en un `.md` suelto. Si en el destino ya existía algo
# con ese nombre, lo renombramos con ` 2`, ` 3`... usando `free_path`.


def _unique_image_name(attachments_dir: Path, original: str, ext: str) -> str:
    """Devuelve un nombre libre dentro de `attachments_dir`.

    CherryTree guarda imágenes con el nombre original del fichero (`imagen.png`,
    `captura 2025-01-02.png`...) y, si dos imágenes tenían el mismo nombre, las
    acaba numerando. Aquí aplicamos la misma idea: si el nombre ya existe,
    añadimos ' 2', ' 3'...
    """
    stem = re.sub(r"[<>:|\"*?]", "_", original).strip(". ") or "imagen"
    candidate = attachments_dir / f"{stem}{ext}"
    n = 2
    while candidate.exists():
        candidate = attachments_dir / f"{stem} {n}{ext}"
        n += 1
    return candidate.name


def _image_filename_in_md(name: str, ext: str, n: int) -> str:
    """Nombre de archivo que pondremos en `![[ ... ]]` dentro del Markdown."""
    return f"{name}{ext}" if n == 1 else f"{name} {n}{ext}"


def _safe_node_name(name: str) -> str:
    """Nombre de nodo CherryTree apto como nombre de archivo/carpeta.

    CherryTree permite casi cualquier carácter; el vault de l-notes, no.
    `sanitize_name` del módulo `vault` lo recortará aún más, pero aquí
    limpiamos lo obvio para que el árbol se entienda de un vistazo.
    """
    name = (name or "(sin título)").strip()
    return re.sub(r"[<>:|\"*?\\/\x00-\x1f]", "_", name).strip(". ") or "(sin título)"


def _write_note_and_extract_images(
    node_dir: Path,
    node_id: int,
    name: str,
    txt: str,
    images: list[tuple[str, bytes, str]],
    codeboxes: dict[int, list[tuple[int, str, str]]],
    grids: dict[int, list[list[str]]],
    attachments_dir: Path,
    image_filename_map: dict[str, str],
) -> None:
    """Escribe la nota `.md` de un nodo en `node_dir/<safe_name>.md`.

    Pre-reserva los nombres finales de las imágenes en `Adjuntos/` para que el
    Markdown que escribimos ya pueda referenciarlas con `![[nombre_final]]`,
    sin tener que volver a tocar el fichero después. El volcado real del binario
    ocurre al final, una sola vez por imagen única.
    """
    safe_name = _safe_node_name(name)
    note_path = node_dir / f"{safe_name}.md"
    if note_path.exists():
        # Colisión: numeramos al estilo del resto de operaciones del vault.
        n = 2
        while note_path.exists():
            note_path = node_dir / f"{safe_name} {n}.md"
            n += 1

    # Reservar nombre de archivo final para cada imagen del nodo. Si dos
    # imágenes de nodos distintos tenían el mismo nombre, acabarán en disco con
    # sufijos ' 2', ' 3'…, igual que en `free_path`.
    for original_name, _data, _link in images:
        if original_name in image_filename_map:
            continue
        ext = Path(original_name).suffix.lower() or ".png"
        stem = Path(original_name).stem or "imagen"
        image_filename_map[original_name] = _unique_image_name(
            attachments_dir, stem, ext
        )

    image_names = [image_filename_map[orig] for orig, _data, _link in images]
    md = build_note_markdown(txt, codeboxes, grids, node_id, image_names)
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(md, encoding="utf-8")


def import_ctb(
    base: Path,
    file_path: Path,
    attachments_dir_name: str = "Adjuntos",
) -> dict:
    """Importa un .ctb en la bóveda `base`. Devuelve un resumen.

    Estructura del resumen:
        {
          "notes": int,           # notas escritas
          "images": int,          # imágenes volcadas a Adjuntos/
          "codeboxes": int,       # codeboxes embebidos (los huérfanos, no inline)
          "grids": int,           # tablas emitidas
          "folders": int,         # carpetas creadas por notas-con-hijos
          "root_names": [str,...] # nombres de los nodos raíz creados
        }

    Levanta `CherryTreeError` con mensaje legible si el .ctb no se puede leer
    o no contiene nada importable.
    """
    data = extract_all(file_path)
    nodes: dict[int, CTNode] = data["nodes"]
    children: dict[int, list[int]] = data["children"]
    images: dict[int, list[tuple[str, bytes, str]]] = data["images"]
    codeboxes: dict[int, list[tuple[int, str, str]]] = data["codeboxes"]
    grids: dict[int, list[list[str]]] = data["grids"]
    roots: list[int] = data["roots"]

    attachments_dir = base / attachments_dir_name
    attachments_dir.mkdir(parents=True, exist_ok=True)

    notes_written = 0
    images_written = 0
    folders_created = 0
    root_names: list[str] = []
    image_filename_map: dict[str, str] = {}

    def _walk(node_id: int, parent_dir: Path) -> None:
        nonlocal notes_written, folders_created
        node = nodes[node_id]
        kids = children.get(node_id, [])
        safe_name = _safe_node_name(node.name)

        if kids:
            folder = parent_dir / safe_name
            folder.mkdir(parents=True, exist_ok=True)
            folders_created += 1
            _write_note_and_extract_images(
                node_dir=folder,
                node_id=node_id,
                name=safe_name,
                txt=node.txt,
                images=images.get(node_id, []),
                codeboxes=codeboxes,
                grids=grids,
                attachments_dir=attachments_dir,
                image_filename_map=image_filename_map,
            )
            notes_written += 1
            for child_id in kids:
                _walk(child_id, folder)
        else:
            _write_note_and_extract_images(
                node_dir=parent_dir,
                node_id=node_id,
                name=safe_name,
                txt=node.txt,
                images=images.get(node_id, []),
                codeboxes=codeboxes,
                grids=grids,
                attachments_dir=attachments_dir,
                image_filename_map=image_filename_map,
            )
            notes_written += 1

    for root_id in roots:
        for top_id in children.get(root_id, []):
            _walk(top_id, base)
            root_names.append(_safe_node_name(nodes[top_id].name))

    # Volcado de TODAS las imágenes de la tabla `image` a Adjuntos/. Las que
    # aparecen en el XML con `link="image …"` ya tienen su `![[nombre]]`
    # apuntando al nombre real con el que han aterrizado en Adjuntos/. Las
    # huérfanas (en la tabla pero sin anclaje en el XML) quedan en Adjuntos/
    # sin referenciar: el usuario las enlaza a mano si las quiere.
    seen: set[str] = set()
    for _node_id, img_list in images.items():
        for orig_name, data_bytes, _link in img_list:
            final_name = image_filename_map.get(orig_name)
            if final_name is None:
                ext = Path(orig_name).suffix.lower() or ".png"
                stem = Path(orig_name).stem or "imagen"
                final_name = _unique_image_name(attachments_dir, stem, ext)
            if final_name in seen:
                continue
            (attachments_dir / final_name).write_bytes(data_bytes)
            seen.add(final_name)
            images_written += 1

    return {
        "notes": notes_written,
        "images": images_written,
        "codeboxes": sum(len(v) for v in codeboxes.values()),
        "grids": sum(len(v) for v in grids.values()),
        "folders": folders_created,
        "root_names": root_names,
    }