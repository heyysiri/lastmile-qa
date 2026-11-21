import uuid
from django.conf import settings
from django.db import models

class TestAccount(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account_key = models.CharField(max_length=200, unique=True)
    fixture = models.CharField(max_length=80)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)

class Checkpoint(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account = models.ForeignKey(TestAccount, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200, unique=True)
    digest = models.CharField(max_length=64)
    state = models.JSONField()

class CheckpointClone(models.Model):
    clone_key = models.CharField(max_length=200, unique=True)
    checkpoint = models.ForeignKey(Checkpoint, on_delete=models.PROTECT)
    account = models.OneToOneField(TestAccount, on_delete=models.PROTECT)
