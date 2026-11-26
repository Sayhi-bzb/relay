# Relay deployment

The collector exports managed Markdown. [The publisher](../../deploy/publish.mjs) creates a workspace for each Release or Changelog with a body and admits articles after `relay export --document` passes. The publisher swaps the active site only after Astro builds the new articles and product pages.

Install `processing/`, `reading/`, and `deploy/` together. The example [publisher service](../../deploy/relay-publish.service) reads `publish.env` in the service account's `~/.local/share/relay-site` directory. Use [the environment template](../../deploy/.env.example) to set the site URL, cutoff and editor path. The collector export root defaults to `/srv/ai-news-radar/obsidian-vault`. Set `RELAY_SOURCE_VAULT` for a different installation. The service account needs read access to that vault or permission to use the configured noninteractive export command.

[The publisher timer](../../deploy/relay-publish.timer) runs every 15 minutes. Drafts resume on the next run, and completed drafts require no model call. Point the reverse proxy at [the loopback site service](../../deploy/relay-site.service).

## Editor runtime

Install Practicum separately, configure its `relay-editor` role, and set `RELAY_EDITOR_DIR` to the directory containing its installation and role state. The publisher supplies a read-only snapshot of completed workspaces at `/work/shared`. See the [editor workspace contract](../../processing/runtime/README.md) for the task mount and CLI.

Run `journalctl --user -u relay-publish.service -n 50` to inspect a cycle. Start a cycle with `systemctl --user start relay-publish.service`.
