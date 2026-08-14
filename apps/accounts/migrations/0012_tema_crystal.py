"""Renombrado del tema cristal -> crystal.

Cambia las opciones del campo y traduce lo ya guardado. Las dos cosas hacen
falta: sin la traducción, a quien tuviera el tema puesto le quedaría un valor
que ya no está entre las opciones y la ficha dejaría de validar.
"""
from django.db import migrations, models


def a_crystal(apps, schema_editor):
    U = apps.get_model("accounts", "User")
    U.objects.filter(theme="cristal").update(theme="crystal")
    U.objects.filter(theme="dark-cristal").update(theme="dark-crystal")


def a_cristal(apps, schema_editor):
    """Vuelta atrás, para que la migración se pueda deshacer."""
    U = apps.get_model("accounts", "User")
    U.objects.filter(theme="crystal").update(theme="cristal")
    U.objects.filter(theme="dark-crystal").update(theme="dark-cristal")


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0011_accesos_boveda"),
    ]

    operations = [
        migrations.AlterField(
            model_name="user",
            name="theme",
            field=models.CharField(
                choices=[
                    ("dark", "Oscuro"),
                    ("light", "Claro"),
                    ("dracula", "Dr\u00e1cula"),
                    ("pink", "Rosa"),
                    ("gold", "Dorado"),
                    ("crystal", "Crystal"),
                    ("dark-crystal", "Dark Crystal"),
                    ("cafe", "Caf\u00e9"),
                ],
                default="dark",
                max_length=16,
            ),
        ),
        migrations.RunPython(a_crystal, a_cristal),
    ]
