"""Trusted local adapter. Browser actors cannot access these bearer-gated routes."""
import hashlib
import hmac
import json
import os
import uuid
from pathlib import Path
from decimal import Decimal
from django.conf import settings
from django.contrib.auth import get_user_model, SESSION_KEY, BACKEND_SESSION_KEY, HASH_SESSION_KEY
from django.contrib.sessions.backends.db import SessionStore
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import JsonResponse
from oscar.core.loading import get_class, get_model
from .models import TestAccount, Checkpoint, CheckpointClone

FIXTURES = ('returning-customer', 'new-customer')

class Invalid(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status

def key(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise Invalid('A nonblank identity of up to 200 characters is required')
    return value

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def build_id():
    root = settings.OSCAR_SOURCE_ROOT
    files = sorted((root / 'src/oscar').rglob('*.py')) + sorted((root / 'src/oscar/templates').rglob('*.html'))
    values = [(str(p.relative_to(root)), hashlib.sha256(p.read_bytes()).hexdigest()) for p in files]
    bridge = Path(__file__).resolve().parents[1]
    values += [(str(p.relative_to(bridge)), hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(bridge.rglob('*.py')) if not p.name.startswith('test_')]
    requirements = root / '.lastmile/requirements.md'
    if requirements.is_file():
        values.append(('requirements', hashlib.sha256(requirements.read_bytes()).hexdigest()))
    values.append(('defect', os.environ.get('OSCAR_DEMO_DEFECT', '')))
    return digest(values)

def product():
    Product = get_model('catalogue', 'Product')
    item = Product.objects.filter(upc='LASTMILE-TRAVEL-MUG').first()
    if item:
        return item
    ProductClass = get_model('catalogue', 'ProductClass')
    Partner = get_model('partner', 'Partner')
    cls, _ = ProductClass.objects.get_or_create(name='Travel accessories', slug='travel-accessories', defaults={'requires_shipping': True, 'track_stock': True})
    item = Product.objects.create(title='Trail travel mug', upc='LASTMILE-TRAVEL-MUG', product_class=cls)
    partner, _ = Partner.objects.get_or_create(code='lastmile-supplier', defaults={'name': 'Trail Supply'})
    get_model('partner', 'StockRecord').objects.create(product=item, partner=partner, partner_sku='TRAIL-MUG', price_currency='GBP', price=Decimal('18.00'), num_in_stock=1000)
    return item

def basket_for(user):
    Basket = get_model('basket', 'Basket')
    basket, _ = Basket.objects.get_or_create(owner=user, status=Basket.OPEN)
    basket.strategy = get_class('partner.strategy', 'Selector')().strategy(user=user)
    return basket

def create_account(account_key, fixture):
    if fixture not in FIXTURES:
        raise Invalid('Unsupported customer fixture')
    existing = TestAccount.objects.filter(account_key=account_key).first()
    if existing:
        if existing.fixture != fixture:
            raise Invalid('Account already has another starting fixture', 409)
        return existing
    identity = uuid.uuid4()
    user = get_user_model().objects.create_user(username='qa-'+identity.hex, email=identity.hex+'@example.test', first_name='Alex', last_name='River')
    account = TestAccount.objects.create(id=identity, account_key=account_key, fixture=fixture, user=user)
    basket_for(user).add_product(product(), quantity=4 if fixture == 'returning-customer' else 1)
    return account

def cookie(account):
    session = SessionStore()
    session[SESSION_KEY] = str(account.user_id)
    session[BACKEND_SESSION_KEY] = 'django.contrib.auth.backends.ModelBackend'
    session[HASH_SESSION_KEY] = account.user.get_session_auth_hash()
    session.save()
    return {'namespaceId': str(account.pk), 'cookie': {'name': settings.SESSION_COOKIE_NAME, 'value': session.session_key, 'path': '/'}}

def state(account):
    basket = basket_for(account.user)
    lines = list(basket.lines.order_by('id').values('product_id', 'quantity'))
    addresses = list(get_model('address', 'UserAddress').objects.filter(user=account.user).order_by('id').values('title','first_name','last_name','line1','line2','line3','line4','state','postcode','country_id','phone_number','notes','is_default_for_shipping','is_default_for_billing'))
    for address in addresses:
        address['phone_number'] = str(address['phone_number'])
    return {'namespaceId': str(account.pk), 'profile': {'firstName': account.user.first_name, 'lastName': account.user.last_name, 'email': account.user.email}, 'basket': {'quantity': sum(line['quantity'] for line in lines), 'lines': lines}, 'addresses': addresses, 'orderCount': get_model('order','Order').objects.filter(user=account.user).count()}

def get_account(identity):
    try:
        return TestAccount.objects.select_related('user').get(pk=identity)
    except (TestAccount.DoesNotExist, ValidationError):
        raise Invalid('Customer account not found', 404)

def capture(payload):
    request_id = key(payload.get('requestId'))
    account = get_account(key(payload.get('namespaceId')))
    checkpoint = Checkpoint.objects.filter(request_id=request_id).first()
    if checkpoint and checkpoint.account_id != account.pk:
        raise Invalid('Checkpoint request already belongs to another account', 409)
    if not checkpoint:
        saved = state(account)
        checkpoint = Checkpoint.objects.create(account=account, request_id=request_id, state=saved, digest=digest(saved))
    return {'id': str(checkpoint.pk), 'digest': checkpoint.digest, 'state': checkpoint.state}

def clone(identity, payload):
    try:
        checkpoint = Checkpoint.objects.get(pk=identity)
    except (Checkpoint.DoesNotExist, ValidationError):
        raise Invalid('Checkpoint not found', 404)
    if digest(checkpoint.state) != checkpoint.digest:
        raise Invalid('Checkpoint integrity failed', 409)
    clone_key = key(payload.get('cloneKey'))
    existing = CheckpointClone.objects.select_related('account__user').filter(clone_key=clone_key).first()
    if existing:
        if existing.checkpoint_id != checkpoint.pk:
            raise Invalid('Clone request already belongs to another checkpoint', 409)
        return {**cookie(existing.account), 'digest': checkpoint.digest}
    saved = checkpoint.state
    if saved['orderCount']:
        raise Invalid('Cloning accounts with orders is outside this adapter checkpoint', 409)
    account = create_account('clone:'+uuid.uuid4().hex, checkpoint.account.fixture)
    user = account.user
    user.first_name = saved['profile']['firstName']; user.last_name = saved['profile']['lastName']
    user.email = saved['profile']['email']
    user.save(update_fields=['first_name','last_name','email'])
    basket = basket_for(user)
    basket.lines.all().delete()
    for line in saved['basket']['lines']:
        basket.add_product(get_model('catalogue','Product').objects.get(pk=line['product_id']), quantity=line['quantity'])
    for address in saved['addresses']:
        get_model('address','UserAddress').objects.create(user=user, **address)
    CheckpointClone.objects.create(clone_key=clone_key, checkpoint=checkpoint, account=account)
    return {**cookie(account), 'digest': checkpoint.digest}

class TestBridge:
    def __init__(self, get_response):
        self.get_response = get_response
        self.served_build = build_id()

    def __call__(self, request):
        if not request.path.startswith('/api/test/'):
            return self.get_response(request)
        if not settings.LASTMILE_TEST_ENABLED:
            return JsonResponse({'message':'Not found'}, status=404)
        token = settings.LASTMILE_TEST_TOKEN
        if not token or not hmac.compare_digest(request.headers.get('Authorization',''), 'Bearer '+token):
            return JsonResponse({'message':'Unauthorized'}, status=401)
        try:
            payload = json.loads(request.body or '{}')
            if not isinstance(payload, dict):
                raise Invalid('Expected an object')
            with transaction.atomic():
                path = request.path
                if request.method == 'GET' and path == '/api/test/build':
                    current = build_id()
                    if current != self.served_build:
                        raise Invalid('Source changed; restart the Oscar release before testing', 503)
                    result = {'buildId': current}
                elif request.method == 'GET' and path == '/api/test/state':
                    result = state(get_account(key(request.GET.get('namespaceId'))))
                elif request.method == 'POST' and path in ('/api/test/sessions','/api/test/accounts/session'):
                    account_key = key(payload.get('accountKey')) if path.endswith('/accounts/session') else 'fresh:'+uuid.uuid4().hex
                    result = cookie(create_account(account_key, payload.get('fixtureId')))
                elif request.method == 'POST' and path == '/api/test/checkpoints':
                    result = capture(payload)
                elif request.method == 'POST' and path.startswith('/api/test/checkpoints/') and path.endswith('/clone'):
                    result = clone(path.split('/')[-2], payload)
                else:
                    raise Invalid('Not found',404)
            response = JsonResponse(result)
            response['Cache-Control'] = 'no-store'
            return response
        except Invalid as error:
            return JsonResponse({'message':error.message}, status=error.status)
        except (ValueError, TypeError, UnicodeDecodeError):
            return JsonResponse({'message':'Invalid request'}, status=400)
