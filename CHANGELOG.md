# Changelog

Every release of Galena, newest first. Each one says what changed and what to do when you upgrade
to it. To upgrade, run `npx @astrlme/galena@<version> deploy`, or check out the release's tag and
run `pnpm galena deploy`; see
[Upgrading](https://galena.astrl.me/docs/getting-started/self-hosting/#upgrading).

## 0.1.1

A new deployment's status page is published as soon as first-run setup finishes. Before, it
answered 403 until the hourly heartbeat at 35 past the hour. The database drops the `rate_limit`
table, unused since sign-in limits are counted in memory.

### Upgrade notes

- Nothing to do by hand: `galena deploy` runs the migration `0016_drop_rate_limit`. Once it has
  run, `galena deploy` from a checkout of 0.1.0 is refused, since that checkout lacks it.

## 0.1.0

The first release with a version. A deployment records the release it runs and the last
migration its database ran; `galena deploy` refuses older code than either, and `galena doctor`
compares the release with the CLI's and the latest one.

It includes the status page, detection from three regions, incidents opened from monitors with
approval in the dashboard or Slack, maintenance windows, email, Slack and webhook subscribers,
alert ingest from Alertmanager or any JSON source, Statuspage-compatible `/api/v2` files, API
keys, and the `galena` CLI.

### Upgrade notes

- A deployment made before this release has no version recorded; `galena deploy` records it.
- API keys now carry a tag only your deployment makes, so a key made by older code is refused
  with `invalid_api_key`. Make it again in Settings and delete the old one, which still counts
  toward the limit of 50.
- A deployment from before background jobs moved into AWS keeps a stack with an IAM user and its
  key: [remove them by hand](https://galena.astrl.me/docs/decisions/background-jobs/#upgrading-an-older-deployment).
