See the open issues and pull requests of your repositories inside bb. Hand one to an agent with one click.

## What you get

- A GitHub panel with Issues and Pull requests tabs across every tracked repository. It has a repository filter and a New issue form.
- Filter by comment author with `commenter:@me` or a username, including exclusions. Comment authors sync from GitHub conversation comments; no separate following list is needed.
- Issue details: body, comments, a comment box, and editing of status, assignee, and labels.
- Send agent on an issue, or Review with agent on a pull request. bb starts a thread in the repository's project and links it from the item.
- Mentions. Type `@` or `#` in any composer to attach an issue or pull request. Its title, body, and state go to the agent at send time.

## How it works

The plugin tracks every bb project whose checkout has a GitHub `origin` remote. Add more repositories in the Extra repositories setting as a comma-separated `owner/repo` list. Choose a Default project for repositories that are not attached to a project. A background service refreshes the cache at startup, then waits 15 minutes after each completed sync to reduce background GitHub traffic. Press Refresh in the panel to update now.

## For agents

The `bb github-fred` command lists cached data. Use `bb github-fred repos`, `bb github-fred issues [owner/repo]`, `bb github-fred prs [owner/repo]`, or `bb github-fred sync`. Every command accepts `--json`, and `bb github-fred --help` or `bb github-fred <command> --help` prints the arguments and options and exits 0.

## Requirements

The GitHub CLI must be installed and signed in with `gh auth login`. See https://cli.github.com for installation. The plugin uses your `gh` session and stores no tokens. Until `gh auth status` passes, the plugin reports that it needs configuration.
