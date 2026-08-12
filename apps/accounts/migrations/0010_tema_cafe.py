from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0009_sso_id'),
    ]

    operations = [
        migrations.AlterField(
            model_name='user',
            name='theme',
            field=models.CharField(choices=[('dark', 'Oscuro'), ('light', 'Claro'), ('dracula', 'Drácula'), ('pink', 'Rosa'), ('gold', 'Dorado'), ('cristal', 'Cristal'), ('dark-cristal', 'Dark Cristal'), ('cafe', 'Café')], default='dark', max_length=16),
        ),
    ]
