import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

# argon2id with the library defaults: time_cost=3, memory_cost=64 MiB,
# parallelism=4. Memory hard, so GPU and ASIC cracking is expensive in a way no
# SHA family hash is. The salt is random per password and is stored inside the
# encoded hash string, as are the parameters — which is what lets
# check_needs_rehash() transparently upgrade old hashes when we raise the cost.
password_hasher = PasswordHasher()

# Verifying against this when the email is unknown keeps login timing roughly
# constant, so the endpoint does not leak which addresses are registered.
DUMMY_HASH = password_hasher.hash("watts-timing-equalisation-placeholder")

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 200

# A composition rule ("must contain a symbol") pushes people toward Passw0rd!.
# Rejecting the passwords that actually appear in credential dumps is the thing
# that helps. Short list on purpose; it is the tail of the distribution that a
# self hosted app of this size realistically faces.
COMMON_PASSWORDS = frozenset(
    {
        "password",
        "password1",
        "password123",
        "passw0rd",
        "password1234",
        "12345678",
        "123456789",
        "1234567890",
        "qwertyuiop",
        "1q2w3e4r5t",
        "letmein123",
        "iloveyou1",
        "welcome123",
        "admin12345",
        "abc12345678",
        "trustno1234",
        "qwerty12345",
        "monkey12345",
        "football123",
        "baseball123",
        "sunshine123",
        "princess123",
        "starwars123",
        "cyclist123",
        "changeme123",
    }
)


class PasswordPolicyError(ValueError):
    pass


def validate_password(password: str) -> None:
    """Raise PasswordPolicyError with a message safe to show the user."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise PasswordPolicyError(f"Password must be at most {MAX_PASSWORD_LENGTH} characters.")
    if password.strip().lower() in COMMON_PASSWORDS:
        raise PasswordPolicyError("That password is too common. Choose something less guessable.")


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """Constant time comparison via the library. Never compare hash strings with ==."""
    try:
        password_hasher.verify(stored_hash, password)
        return True
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    try:
        return password_hasher.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return True


def new_session_token() -> str:
    """256 bits of urandom, url safe. This value goes in the cookie and nowhere else."""
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    """What we store. A database leak yields no usable live sessions."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


RESET_CODE_LENGTH = 6


def new_reset_code() -> str:
    """A uniformly random six digit code, zero padded — 000123 is a valid code.

    Short enough to read off a phone and type with one hand. The entropy is only
    ~20 bits, so what makes it safe is the attempt cap on the row, not the code
    itself: five guesses against a fifteen minute window is a 1 in 200,000 shot.
    """
    return f"{secrets.randbelow(10 ** RESET_CODE_LENGTH):0{RESET_CODE_LENGTH}d}"


def hash_reset_code(code: str, user_id, pepper: str) -> str:
    """Keyed hash, not a bare digest.

    A plain sha256 of six digits is a million element rainbow table, so anyone
    with a read-only copy of the database could reverse a live code and take the
    account over despite argon2 on the passwords. HMAC with a secret held only in
    the environment means reversing it needs the application host too. The user
    id goes into the message so a row can only ever satisfy its own account.
    """
    message = f"{user_id}:{code}".encode("utf-8")
    return hmac.new(pepper.encode("utf-8"), message, hashlib.sha256).hexdigest()
