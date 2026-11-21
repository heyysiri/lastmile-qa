"""Add a labeled, disabled-by-default local defect to pinned upstream source."""
import os
from pathlib import Path
root = Path(os.environ.get('OSCAR_ROOT', Path(__file__).resolve().parents[2] / '.local-work/p2/oscar-upstream'))
path = root / 'src/oscar/apps/customer/views.py'
source = path.read_text()
marker = '# LASTMILE DEMO REGRESSION: not an upstream Oscar defect.'
if marker not in source:
    start = source.index('class ProfileUpdateView(')
    prefix, view = source[:start], source[start:]
    needle = '        form.save()\n'
    addition = '''        form.save()
        # LASTMILE DEMO REGRESSION: not an upstream Oscar defect.
        import os
        if os.environ.get("OSCAR_DEMO_DEFECT") == "reset-basket-on-profile-save":
            self.request.user.baskets.filter(status="Open").first().lines.update(quantity=1)
'''
    if needle not in view:
        raise RuntimeError('Pinned source changed; refusing to seed a different implementation')
    path.write_text(prefix + view.replace(needle, addition, 1))
