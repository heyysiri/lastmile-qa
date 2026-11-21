#!/usr/bin/env python3
import os
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = Path(os.environ.get('OSCAR_ROOT', ROOT / '.local-work/p2/oscar-upstream')).resolve()
sys.path.insert(0, str(UPSTREAM / 'src'))
sys.path.insert(0, str(UPSTREAM / 'sandbox'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'lastmile_settings')
if __name__ == '__main__':
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)
