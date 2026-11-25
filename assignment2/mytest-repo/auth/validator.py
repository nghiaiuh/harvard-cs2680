"""
Module auth/validator.py: Validate signature and token expiration
"""
import time
from auth.token import decode_payload, sign_data

def validate_token(token: str, secret_key: str, current_time: float = None) -> dict:
    """
    Validate token:
    1. Split payload and signature
    2. Verify HMAC signature
    3. Check expiration claim ('exp')
    """
    if "." not in token:
        raise ValueError("Malformed token: missing dot delimiter")

    payload_b64, signature = token.split(".", 1)

    # 1. Verify signature
    expected_sig = sign_data(payload_b64, secret_key)
    if not hmac_compare(signature, expected_sig):
        raise ValueError("Invalid token signature")

    # 2. Decode payload
    payload = decode_payload(payload_b64)

    # 3. Check expiration
    # BUG: Used '<' instead of '>=' or '>' when comparing current_time against exp,
    # causing expired tokens (current_time > exp) not to raise PermissionError("Token has expired")
    if current_time is None:
        current_time = time.time()

    if "exp" in payload and current_time < payload["exp"]:
        raise PermissionError("Token has expired")

    return payload

def hmac_compare(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks"""
    import hmac
    return hmac.compare_digest(a, b)
