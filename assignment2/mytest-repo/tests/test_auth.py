import pytest
import time
from auth.token import create_token, decode_payload, encode_payload
from auth.validator import validate_token

SECRET = "super-secret-key-cs2680"

def test_valid_token_pass():
    """Test 1 (PASS): Valid unexpired token should validate successfully"""
    payload = {"user_id": 42, "role": "admin", "exp": 2000000000}
    token = create_token(payload, SECRET)
    
    result = validate_token(token, SECRET, current_time=1700000000)
    assert result["user_id"] == 42
    assert result["role"] == "admin"

def test_tampered_signature_pass():
    """Test 2 (PASS): Tampered signature should raise ValueError"""
    token = create_token({"user_id": 1}, SECRET)
    payload_b64, _ = token.split(".")
    tampered_token = f"{payload_b64}.fake_signature_hash"
    
    with pytest.raises(ValueError, match="Invalid token signature"):
        validate_token(tampered_token, SECRET)

def test_unpadded_base64_payload_fail():
    """Test 3 (INITIAL FAIL): Unpadded base64 payload string must decode successfully"""
    # This payload when encoded to base64url has a length not divisible by 4 (unpadded)
    payload = {"sub": "alice", "iss": "cs2680"}
    encoded_unpadded = encode_payload(payload)
    
    # decode_payload should pad properly to decode instead of crashing
    decoded = decode_payload(encoded_unpadded)
    assert decoded["sub"] == "alice"
    assert decoded["iss"] == "cs2680"

def test_expired_token_fail():
    """Test 4 (INITIAL FAIL): Expired token must raise PermissionError('Token has expired')"""
    expired_payload = {"user_id": 99, "exp": 1000}
    token = create_token(expired_payload, SECRET)
    
    # current_time = 1500 > exp = 1000 -> Should raise PermissionError
    with pytest.raises(PermissionError, match="Token has expired"):
        validate_token(token, SECRET, current_time=1500)
