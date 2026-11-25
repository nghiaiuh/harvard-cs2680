"""
Module auth/token.py: Token generation and decoding with payload.signature format
"""
import base64
import hashlib
import hmac
import json

def encode_payload(data: dict) -> str:
    """Encode dictionary to base64url string (strip '=' padding)"""
    json_bytes = json.dumps(data, separators=(",", ":")).encode("utf-8")
    b64_str = base64.urlsafe_b64encode(json_bytes).decode("utf-8")
    return b64_str.rstrip("=")

def decode_payload(payload_str: str) -> dict:
    """
    Decode base64url string to dictionary.
    BUG: Unpadded base64 strings with length not divisible by 4
    cause binascii.Error: Incorrect padding.
    """
    decoded_bytes = base64.urlsafe_b64decode(payload_str.encode("utf-8"))
    return json.loads(decoded_bytes.decode("utf-8"))

def sign_data(data_str: str, secret_key: str) -> str:
    """Generate HMAC-SHA256 signature for data string"""
    sig = hmac.new(
        secret_key.encode("utf-8"),
        data_str.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    return sig

def create_token(payload: dict, secret_key: str) -> str:
    """Create complete token: payload_b64.signature"""
    payload_b64 = encode_payload(payload)
    sig = sign_data(payload_b64, secret_key)
    return f"{payload_b64}.{sig}"
