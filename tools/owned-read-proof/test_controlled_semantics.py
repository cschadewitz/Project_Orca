"""Crypto/JSON negative controls only; no synthetic bootstrap acceptance."""
import base64
import json
import unittest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from controlled_semantics import decode, parse


class AuthenticationControls(unittest.TestCase):
    def envelope(self):
        key = bytes(range(32))
        nonce = bytes(range(12))
        raw = AESGCM(key).encrypt(nonce, b'{"value":1}', b'orca:protected-execution:v1:private-execution:test.payload.json')
        obj = {'version': 1, 'algorithm': 'aes-256-gcm', 'nonce': base64.b64encode(nonce).decode(),
               'ciphertext': base64.b64encode(raw[:-16]).decode(), 'tag': base64.b64encode(raw[-16:]).decode()}
        return key, obj

    def test_authenticated_json_roundtrip_has_no_authority(self):
        key, obj = self.envelope()
        self.assertEqual(decode('test.payload.json', json.dumps(obj), key), {'value': 1})

    def test_wrong_record_identity_and_key_refuse(self):
        key, obj = self.envelope()
        for name, supplied in [('other.payload.json', key), ('test.payload.json', bytes(32))]:
            with self.assertRaises(InvalidTag):
                decode(name, json.dumps(obj), supplied)

    def test_ciphertext_or_tag_corruption_refuses(self):
        for field in ('ciphertext', 'tag'):
            key, obj = self.envelope()
            data = bytearray(base64.b64decode(obj[field])); data[0] ^= 1
            obj[field] = base64.b64encode(data).decode()
            with self.assertRaises(InvalidTag):
                decode('test.payload.json', json.dumps(obj), key)

    def test_unknown_envelope_fields_or_nonce_bounds_refuse(self):
        for change in ({'extra': True}, {'version': 2}, {'nonce': 'eA=='}, {'algorithm': 'unknown'}):
            key, obj = self.envelope(); obj.update(change)
            with self.assertRaises(RuntimeError):
                decode('test.payload.json', json.dumps(obj), key)

    def test_duplicate_json_keys_refuse(self):
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            parse('{"kind":"original","kind":"replacement"}')

class CredentialIdentityControls(unittest.TestCase):
    def test_exact_two_distinct_designated_credentials(self):
        from controlled_semantics import designated_credentials
        original = [{'principal': 'controlled-test-operator', 'id': 'operator'},
                    {'principal': 'controlled-test-reviewer', 'id': 'reviewer'}]
        self.assertEqual(len(designated_credentials(original)), 2)
        for records in [original + [dict(original[0], id='extra')],
                        [original[0], dict(original[0], id='extra')],
                        [original[0], dict(original[1], id='operator')], [], original[:1]]:
            with self.subTest(records=records), self.assertRaises(RuntimeError):
                designated_credentials(records)
