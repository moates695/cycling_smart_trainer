"""Outbound email — password reset codes and the notice that a password changed.

Deliberately small and provider agnostic. The settings are plain SMTP, so moving
off Gmail later is an env change rather than a code change, and there is no
vendor SDK to keep current.

Two rules hold this together:

- **Sending never fails a request.** Every entry point is called from a
  FastAPI background task and swallows its own exceptions. A rider whose mail
  provider is having a bad afternoon still gets a 204, and the reset row is
  already committed by the time we try to send — the flow degrades to "no code
  arrived, ask for another", never to a 500 that leaks whether the account
  exists.
- **With SMTP unconfigured the message is logged instead.** That is the default
  in development and in the test suite, so no test and no local run touches the
  network. The log line includes the code on purpose: it is how you drive the
  flow locally. Production always has SMTP configured and so never reaches it.
"""

import logging
import smtplib
from email.message import EmailMessage

from app.config import Settings, get_settings

log = logging.getLogger("watts.email")

# Gmail's SMTP wants STARTTLS on 587 and implicit TLS on 465. Everything else
# in the sending path is identical.
IMPLICIT_TLS_PORT = 465


def send(to: str, subject: str, body: str, settings: Settings | None = None) -> bool:
    """Send one message. Returns whether it actually went out."""
    settings = settings or get_settings()

    # Addresses reach us through pydantic's EmailStr, which cannot contain a
    # newline; this is belt and braces against a header injection in a subject
    # or address that arrives from somewhere else later.
    if any(ch in to + subject for ch in ("\r", "\n")):
        log.error("refusing to send a message with a line break in its headers")
        return False

    if not settings.smtp_configured:
        if settings.is_production:
            # Never the body: it carries a live reset code, and application logs
            # are read by more people and shipped to more places than a mailbox.
            log.error("SMTP is not configured; dropped %r to %s", subject, to)
        else:
            log.info("email not configured; would have sent to %s: %s\n%s", to, subject, body)
        return False

    message = EmailMessage()
    message["From"] = settings.mail_from
    message["To"] = to
    message["Subject"] = subject
    if settings.smtp_reply_to:
        message["Reply-To"] = settings.smtp_reply_to
    message.set_content(body)

    try:
        if settings.smtp_port == IMPLICIT_TLS_PORT:
            with smtplib.SMTP_SSL(
                settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds
            ) as smtp:
                smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds
            ) as smtp:
                smtp.starttls()
                smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
    except Exception:  # noqa: BLE001 - never propagate into a request
        # No message body in the log: it carries the reset code.
        log.exception("could not send mail to %s", to)
        return False

    log.info("sent %r to %s", subject, to)
    return True


def send_reset_code(to: str, code: str, ttl_minutes: int, settings: Settings | None = None) -> bool:
    body = (
        f"Your WATTS password reset code is:\n\n"
        f"    {code}\n\n"
        f"Enter it in the app, on the screen that asked for it. It expires in "
        f"{ttl_minutes} minutes and can be used once.\n\n"
        f"If you did not ask to reset your password, you can ignore this email — "
        f"nothing has changed and your password still works.\n"
    )
    return send(to, "Your WATTS password reset code", body, settings)


def send_password_changed(to: str, settings: Settings | None = None) -> bool:
    """The only signal a rider gets if somebody else got in. Worth the email."""
    body = (
        "The password on your WATTS account was just changed, and every other "
        "device has been signed out.\n\n"
        "If that was you, there is nothing to do.\n\n"
        "If it was not, reset your password now — and if you used that password "
        "anywhere else, change it there too.\n"
    )
    return send(to, "Your WATTS password was changed", body, settings)
