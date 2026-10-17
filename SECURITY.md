# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through
GitHub: open this repository's **Security** tab and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. You
will get an answer, and a fix will be released before the details are made public.

A problem in the Windows client belongs to
[Modlight App](https://github.com/Nimfek/Modlight-App/security); if you are not sure which
side it is on, report it here.

## In scope

Modlight hosts files for other people, so these matter most:

- reading, changing or deleting another account's files, folders or links
- getting past a file password, an expiry, a view limit or a one-time link
- using an API token beyond its scope (`upload`, `read`, `write`, `full`)
- serving uploaded content in a way that executes on the panel's origin (XSS)
- making the server fetch or read something it should not (SSRF, path traversal)
- the release channel the desktop app updates from
- bypassing rate limits on sign-in, file passwords or the registration key

## Hardening already in place

So that reports can focus on what is new:

- Uploaded HTML and SVG are served as plain text on raw links; rendered previews run in a
  sandbox with an opaque origin.
- API tokens carry scopes, and an unknown or missing scope is refused rather than widened.
- A release published for the desktop app records the installer's SHA-256, and the app
  refuses to run an installer that does not match it.
- The server container runs unprivileged, with every capability dropped and memory, CPU
  and process limits set.
