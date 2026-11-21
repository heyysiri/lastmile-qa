import os
from pathlib import Path
from settings import *  # noqa: F403 - explicitly extend the pinned upstream sandbox.

ROOT = Path(__file__).resolve().parents[2]
OSCAR_SOURCE_ROOT = Path(os.environ.get('OSCAR_ROOT', ROOT / '.local-work/p2/oscar-upstream')).resolve()
DATABASES['default']['NAME'] = os.environ.get('OSCAR_DATABASE_PATH', str(ROOT / '.data/oscar.sqlite'))  # noqa: F405
DATABASES['default']['OPTIONS'] = {'timeout': 20}
INSTALLED_APPS += ['qa_bridge']  # noqa: F405
MIDDLEWARE.insert(0, 'qa_bridge.middleware.TestBridge')  # noqa: F405
LASTMILE_TEST_ENABLED = os.environ.get('ENABLE_TEST_API') == 'true'
LASTMILE_TEST_TOKEN = os.environ.get('TEST_API_TOKEN', '')
SECRET_KEY = os.environ.get('OSCAR_SESSION_SECRET', 'local-oscar-fixture-not-for-production')
EMAIL_BACKEND = 'django.core.mail.backends.locmem.EmailBackend'
SESSION_COOKIE_NAME = 'oscar_sessionid'
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
ALLOWED_HOSTS = ['127.0.0.1', 'localhost', 'testserver']
LANGUAGE_CODE = 'en-gb'
LANGUAGES = [('en-gb', 'English')]
INTERNAL_IPS = []
SILENCED_SYSTEM_CHECKS = ['templates.W003']
HAYSTACK_SIGNAL_PROCESSOR = 'haystack.signals.BaseSignalProcessor'
