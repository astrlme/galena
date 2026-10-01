# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security**
tab and choose **Report a vulnerability**. Don't open a public issue or pull request for them.

Include what you found, where (file, route or resource), how to reproduce it, and what an
attacker could do with it. A minimal proof of concept helps.

Only the latest commit on `main` is supported until the first release.

## What's in scope

Galena deploys into the operator's own AWS account, so reports about this code and the
infrastructure it creates are in scope, for example:

- the API's authentication, roles and rate limits;
- the SSRF guard that every outbound URL passes (monitor checks, Slack, webhooks);
- how credentials are stored: sealed Slack URLs and webhook secrets, signed subscription links;
- the static status page, its subscription forms and its CloudFront configuration;
- IAM policies and the GitHub Actions deploy role.

Misconfiguration in a particular deployment, and problems in AWS, trigger.dev or other services
themselves, are out of scope; report those to the operator or the vendor.
