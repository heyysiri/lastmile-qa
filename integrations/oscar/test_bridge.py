"""Adapter acceptance: real Oscar ORM, no model or browser involved."""
import json
from django.test import TestCase, override_settings
from oscar.core.loading import get_model

@override_settings(LASTMILE_TEST_TOKEN='test-token', LASTMILE_TEST_ENABLED=True)
class BridgeTests(TestCase):
    def call(self, path, body=None, token='test-token'):
        kwargs={'HTTP_AUTHORIZATION': 'Bearer '+token}
        if body is None:
            return self.client.get(path, **kwargs)
        return self.client.post(path, data=json.dumps(body), content_type='application/json', **kwargs)

    def account(self, key='a', fixture='returning-customer'):
        r=self.call('/api/test/accounts/session', {'accountKey':key,'fixtureId':fixture})
        self.assertEqual(r.status_code,200,r.content)
        return r.json()

    def test_gate_and_stable_account_fresh_sessions(self):
        self.assertEqual(self.call('/api/test/build',token='wrong').status_code,401)
        a=self.account(); b=self.account()
        self.assertEqual(a['namespaceId'],b['namespaceId'])
        self.assertNotEqual(a['cookie']['value'],b['cookie']['value'])
        with override_settings(LASTMILE_TEST_ENABLED=False):
            self.assertEqual(self.call('/api/test/build').status_code,404)

    def test_checkpoints_clone_real_customer_state_without_mutating_original(self):
        a=self.account(); key=a['namespaceId']
        r=self.call('/api/test/checkpoints',{'namespaceId':key,'requestId':'capture'})
        self.assertEqual(r.status_code,200,r.content)
        snapshot=r.json(); self.assertEqual(snapshot['state']['basket']['quantity'],4)
        clone=self.call('/api/test/checkpoints/'+snapshot['id']+'/clone',{'cloneKey':'try-1'}).json()
        retry=self.call('/api/test/checkpoints/'+snapshot['id']+'/clone',{'cloneKey':'try-1'}).json()
        self.assertNotEqual(key,clone['namespaceId'])
        self.assertEqual(clone['namespaceId'],retry['namespaceId'])
        from qa_bridge.models import TestAccount
        account=TestAccount.objects.get(pk=clone['namespaceId'])
        get_model('basket','Line').objects.filter(basket__owner=account.user).update(quantity=1)
        original=self.call('/api/test/state?namespaceId='+key).json()
        self.assertEqual(original['basket']['quantity'],4)
        self.assertEqual(clone['digest'],snapshot['digest'])
        cloned_state=self.call('/api/test/state?namespaceId='+clone['namespaceId']).json()
        self.assertNotEqual(cloned_state['profile']['email'],original['profile']['email'])
        self.client.cookies[clone['cookie']['name']]=clone['cookie']['value']
        saved=self.client.post('/en-gb/accounts/profile/edit/',{'first_name':'Clone','last_name':'River','email':cloned_state['profile']['email']})
        self.assertEqual(saved.status_code,302)
        self.assertNotIn('password',json.dumps(snapshot))

    def test_profile_is_real_oscar_and_preserves_basket(self):
        a=self.account()
        self.client.cookies[a['cookie']['name']]=a['cookie']['value']
        state=self.call('/api/test/state?namespaceId='+a['namespaceId']).json()
        r=self.client.post('/en-gb/accounts/profile/edit/',{'first_name':'Mango','last_name':'Seller','email':state['profile']['email']})
        self.assertEqual(r.status_code,302,r.content[:200])
        state=self.call('/api/test/state?namespaceId='+a['namespaceId']).json()
        self.assertEqual(state['profile']['firstName'],'Mango')
        self.assertEqual(state['basket']['quantity'],4)

    def test_invalid_fixture_conflicting_retry_and_unknown_state(self):
        self.assertEqual(self.call('/api/test/accounts/session',{'accountKey':'x','fixtureId':'unknown'}).status_code,400)
        self.account('same','returning-customer')
        self.assertEqual(self.call('/api/test/accounts/session',{'accountKey':'same','fixtureId':'new-customer'}).status_code,409)
        self.assertEqual(self.call('/api/test/state?namespaceId=missing').status_code,404)

    def test_seeded_profile_regression_depends_on_saved_customer_state(self):
        from unittest.mock import patch
        for fixture, expected in [('returning-customer',4),('new-customer',1)]:
            a=self.account('seed-'+fixture,fixture)
            self.client.cookies[a['cookie']['name']]=a['cookie']['value']
            original=self.call('/api/test/state?namespaceId='+a['namespaceId']).json()
            self.assertEqual(original['basket']['quantity'],expected)
            with patch.dict('os.environ', {'OSCAR_DEMO_DEFECT':'reset-basket-on-profile-save'}):
                result=self.client.post('/en-gb/accounts/profile/edit/',{'first_name':'Updated','last_name':'River','email':original['profile']['email']})
            self.assertEqual(result.status_code,302)
            actual=self.call('/api/test/state?namespaceId='+a['namespaceId']).json()
            self.assertEqual(actual['basket']['quantity'],1)

    def test_checkpoint_tampering_is_refused(self):
        from qa_bridge.models import Checkpoint
        a=self.account()
        snapshot=self.call('/api/test/checkpoints',{'namespaceId':a['namespaceId'],'requestId':'immutable'}).json()
        Checkpoint.objects.filter(pk=snapshot['id']).update(digest='0'*64)
        self.assertEqual(self.call('/api/test/checkpoints/'+snapshot['id']+'/clone',{'cloneKey':'attempt'}).status_code,409)
